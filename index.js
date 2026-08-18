/**
 * 📱 织梦OS
 *
 * 模拟手机:在酒馆里和角色线上聊天。以后社交、直播都挂在这一部手机里。
 * 织梦者(zhimengzhe)的子模块之一,但独立成扩展,单独装单独更。
 *
 * 顺序是道长定的(2026-08-18):**先做前端,再接数据**。
 * 理由不是"想早点看到东西",而是**手机长什么样决定了数据怎么存**:
 * 有几个会话、一条消息带哪些字段、联系人怎么表示,不看见屏幕就只能猜。
 *
 * 所以这一版是**能看能点的壳**,里面是示例数据,还不会真的发消息。
 */

import { extension_settings, writeExtensionField } from '../../../extensions.js';
import { getContext } from '../../../st-context.js';
import { saveSettingsDebounced, getRequestHeaders, characters, getThumbnailUrl, chat_metadata, saveMetadata } from '../../../../script.js';
import { eventSource, event_types } from '../../../events.js';
import { uploadFileAttachment } from '../../../chats.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { writeSecret, SECRET_KEYS } from '../../../secrets.js';
import { uuidv4 } from '../../../utils.js';

/** 跟 manifest.json 的 version 手动保持一致,靠这行在控制台辨认在跑哪一版 */
const VERSION = '0.9.0';

/** 必须和仓库名、文件夹名一致,理由见织梦者里那段注释 */
const MODULE_NAME = 'zhimengos';

/** 第三方扩展「API Config Manager」的地盘。探得到就顺带列出来,探不到当它不存在。 */
const ACM_KEY = 'api-config-manager';

/** 悬浮入口的两张图,道长自己出的。加载不到就退回画出来的那个,不会开天窗。
 *  平时是黑屏那张,**有新消息时换成亮屏那张**,这是她定的提示方式。 */
const BALL_DIR = '/scripts/extensions/third-party/zhimengos/assets';
const BALL_IMAGE_IDLE = `${BALL_DIR}/phone.png`;
const BALL_IMAGE_NEW = `${BALL_DIR}/phone-new.png`;
/** 单独抠出来的铃铛,有新消息时叠在手机上摇 */
const BALL_IMAGE_BELL = `${BALL_DIR}/bell.png`;

const defaultSettings = {
    /** 手机用哪条连接。形如 st:<id> 或 acm:<名字>,空字符串 = 跟主线用同一个 */
    connId: '',
    /** 每条连接各自的默认模型:{ [connId]: 模型名 } */
    models: {},
    /** 悬浮入口藏起来了没有。**屏幕上的常驻元素必须能关**,这是道长定的规矩 */
    ballHidden: false,
    /** 悬浮入口被拖到哪儿了:{ left, top },单位像素 */
    ballPos: null,
    /** 联系人存档文件的地址。**只存一个路径,几十字节**,真正的数据在那个文件里 */
    storePath: '',
    /** 手机窗口被拖到哪儿了:{ left, top }。空 = 居中 */
    phonePos: null,
};

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    const settings = extension_settings[MODULE_NAME];
    if (!settings.models || typeof settings.models !== 'object') settings.models = {};
    return settings;
}

function escapeHtml(text) {
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

/* ==========================================================================
 * 连接:借现成的,自己不存 key
 *
 * 由来(2026-08-17 道长):公益站大多不让脱离酒馆使用。而对话请求本来就是
 * 酒馆服务端发出去的,所以只要走酒馆自己的通道,对面看到的**就是**酒馆在发,
 * 不是"像"酒馆。浏览器直连则三个硬伤:key 暴露在前端、CORS 挡死、来源是浏览器。
 *
 * **自己绝不存 key**:①key 会进 settings.json,这插件要分发,
 * 等于每个用户的 key 躺在一个会被备份、同步、截图的文件里;
 * ②酒馆本来就有专门存密钥的地方,再造一个只是多一个泄漏面。
 *
 * 两个来源都列(2026-08-18 道长:"我所有的内容都是存在这里的,很少存在酒馆官方的"):
 *   一、酒馆自带的「连接配置」connection-manager,人人都有
 *   二、第三方扩展 API Config Manager,她自己在用,没装的人自动看不到这一组
 * 我们只读它记录的**密钥 id**,不碰它明文存下来的那份 key。
 * ========================================================================== */

/** 连接管理器是酒馆自带扩展,但用户可以禁用它 */
function isConnectionManagerAvailable() {
    const disabled = extension_settings.disabledExtensions || [];
    return !disabled.includes('connection-manager') && Boolean(extension_settings.connectionManager);
}

/**
 * @typedef {object} Conn
 * @property {string} id       st:<id> 或 acm:<名字>
 * @property {string} name
 * @property {string} group    下拉里的分组标题
 * @property {string} url
 * @property {string} secretId 酒馆密钥仓库里的 id
 * @property {string} model    这条连接自带的模型名,当默认值用
 * @property {string} blocked  不为空就是不能用,内容是原因
 */

/** @returns {Conn[]} 两个来源合到一起 */
function listConnections() {
    /** @type {Conn[]} */
    const list = [];

    if (isConnectionManagerAvailable()) {
        const profiles = extension_settings.connectionManager?.profiles || [];

        for (const p of profiles) {
            // mode 是 cc 的才是对话补全,手机聊天只能用这种
            if (!p?.id || p.mode !== 'cc') continue;

            list.push({
                id: `st:${p.id}`,
                name: p.name || '(没名字)',
                group: '酒馆自带的连接配置',
                url: p['api-url'] || '',
                secretId: p['secret-id'] || '',
                model: p.model || '',
                blocked: '',
            });
        }
    }

    const acm = extension_settings[ACM_KEY];
    const acmConfigs = Array.isArray(acm?.configs) ? acm.configs : [];

    for (const c of acmConfigs) {
        if (!c?.name) continue;

        const secretId = c.secretIds?.[SECRET_KEYS.CUSTOM] || '';

        list.push({
            id: `acm:${c.name}`,
            name: c.name,
            group: 'API 管理器里的配置',
            url: c.customUrl || c.url || '',
            secretId,
            model: c.model || '',
            // 没有密钥 id 就必须挡住。酒馆在 secret_id 为空时会**默默改用当前默认的那把 key**,
            // 静默用错钥匙比明说不能用糟糕得多。
            blocked: secretId ? '' : '这条没记下密钥 id,去 API 管理器里重新保存一次就能用',
        });
    }

    return list;
}

/** @returns {Conn|null} */
function findConnection(id) {
    if (!id) return null;
    return listConnections().find(c => c.id === id) || null;
}

/**
 * 把用户填的那一条写进酒馆:密钥进酒馆的密钥仓库,地址进酒馆的连接配置。
 * 我们这边一个字都不留。
 *
 * ⚠️ 酒馆的 createConnectionProfile 没有导出,而且它的做法是**把当前选中的连接
 * 整个快照下来**(connection-manager/index.js:258),不是填表,所以调不了,
 * 只能自己按它的字段结构拼一条。字段名抄自同文件的 FANCY_NAMES(:72)。
 * **只拼最少的几个字段**,其余留空让酒馆用默认,字段越少,酒馆改结构时要跟的面越小。
 *
 * @returns {Promise<string|null>} 新配置的 id
 */
async function createProfile({ name, url, key, model }) {
    // 先写密钥拿到 id 再拼配置。反过来的话密钥写失败会留下一条连不上的配置
    const secretId = await writeSecret(SECRET_KEYS.CUSTOM, key, name);

    if (!secretId) {
        console.error('[织梦OS] 密钥没写进去');
        return null;
    }

    const profile = {
        id: uuidv4(),
        mode: 'cc',
        api: 'custom',
        exclude: [],
        name,
        'api-url': url,
        'secret-id': secretId,
        model,
    };

    extension_settings.connectionManager.profiles.push(profile);
    saveSettingsDebounced();

    return `st:${profile.id}`;
}

/* ==========================================================================
 * 模型清单
 *
 * 这不是探活。**拉模型列表是任何客户端连上去都会做的正常动作**,酒馆自己
 * 每次切换连接也会拉一次;而"发一条假消息去试通不通"是造出来的探测请求,
 * 会让公益站把用户拉黑(2026-08-18 道长明确否掉了测试按钮)。两者别混。
 * ========================================================================== */

/** @returns {Promise<string[]>} 模型名列表 */
async function fetchModels(conn) {
    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: conn.url,
            secret_id: conn.secretId,
        }),
    });

    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (data?.error) {
        throw new Error(typeof data.error === 'string' ? data.error : '对面返回了一个错误');
    }

    return (Array.isArray(data?.data) ? data.data : [])
        .map(m => String(m?.id || m || '').trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
}

/* ==========================================================================
 * 手机壳
 *
 * 竖屏只写一次(2026-08-18 道长定):电脑版也保持竖屏。理由不只是省事,
 * **直播的信息结构(画面 + 弹幕流 + 礼物)本来就是竖屏原生的**,
 * 横屏得重排三栏,等于两套布局两套 bug。
 *
 * 宽度用 min(94vw, 90dvh * 9 / 16) 算,高度靠 aspect-ratio 推出来。
 * 这样窄屏按宽度收、矮屏按高度收,两边都不会把比例压变形。
 * ========================================================================== */

/** 现在停在哪一屏:home / chat_list / chat_room */
let screen = 'home';
/** 打开的是哪个会话 */
let openChatId = null;
/** 状态栏时钟的定时器,关手机时要停掉 */
let clockTimer = null;

/** 主屏上的图标。done 为假的先摆着,点了只说还没做,别给个死链接 */
const APPS = [
    { id: 'chat', name: '聊天', icon: '💬', done: true },
    { id: 'moments', name: '朋友圈', icon: '🌤️', done: false },
    { id: 'weibo', name: '微博', icon: '📰', done: false },
    { id: 'live', name: '直播', icon: '📺', done: false },
    { id: 'contacts', name: '通讯录', icon: '👥', done: false },
    { id: 'wallet', name: '钱包', icon: '💰', done: false },
];

/* ==========================================================================
 * 联系人:存在全局一个文件里,不进 settings.json
 *
 * 由来(2026-08-18 道长):"我倾向于存在全局某个地方,但是不要进 setting,
 * 因为有些人可能喜欢跨角色聊天。"
 *
 * 落点是酒馆的 /api/files/upload(src/endpoints/files.js:43),它写进
 * **当前用户自己的数据目录** data/<用户>/user/files/,返回一个能直接 fetch 的地址。
 * 正好对上三条:跟聊天无关、跟角色卡无关、不会把 settings.json 撑大。
 *
 * **代价说在前面**:这份数据不跟着角色卡走。发卡给别人,对方手机里是空的。
 * 所以另有一条「写进角色卡」的路给创作者用,那条走 data.extensions.zhimengos。
 *
 * 联系人自带一段**线上人设**,和角色卡里那个线下人设分开
 * (道长:"线上的人设不一定和角色卡里线下的是一样的")。
 * ========================================================================== */

const STORE_FILE = 'zhimengos-contacts.json';
/** 聊天元数据里给我们留的那个键 */
const META_KEY = 'zhimengos';

/**
 * @typedef {object} Contact
 * @property {string} id
 * @property {string} avatarKey 绑定的角色卡,用头像文件名当稳定 id
 * @property {string} nick      手机里显示的名字,可以和卡名不一样
 * @property {string} avatar    自定义头像地址。空 = 借角色卡的头像
 * @property {string} persona   线上人设。空 = 用角色卡自己的设定
 * @property {boolean} global   运行时标记,不落盘。真 = 这条来自常驻名单
 * @property {Array<{from: string, text: string, time: string}>} messages
 */

/** @type {Contact[]} 只在这个聊天里的,存在聊天文件的元数据里 */
let localContacts = [];
/** @type {Contact[]} 常驻名单,存在全局那个文件里,哪个聊天都出现 */
let globalContacts = [];

/** 界面只认这一份:本聊天的排前面,常驻的排后面 */
function allContacts() {
    return [
        ...localContacts.map(c => ({ ...c, global: false })),
        ...globalContacts.map(c => ({ ...c, global: true })),
    ];
}

/** 改数据要找到它真正待的那个数组,不能改 allContacts 复制出来的那份 */
function bucketOf(id) {
    if (localContacts.some(c => c.id === id)) return localContacts;
    if (globalContacts.some(c => c.id === id)) return globalContacts;
    return null;
}

function contactById(id) {
    return localContacts.find(c => c.id === id) || globalContacts.find(c => c.id === id) || null;
}

function isGlobal(id) {
    return globalContacts.some(c => c.id === id);
}

function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    // 一次性 apply 整个数组在长文件上会爆栈,分块来
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/* ---------- 本聊天那一份:存在聊天文件里 ---------- */

function loadLocal() {
    const data = chat_metadata?.[META_KEY];
    localContacts = Array.isArray(data?.contacts) ? data.contacts : [];
}

async function saveLocal() {
    if (!chat_metadata) return;

    if (!chat_metadata[META_KEY]) chat_metadata[META_KEY] = {};
    chat_metadata[META_KEY].contacts = localContacts;

    await saveMetadata();
}

/* ---------- 常驻那一份:存在用户自己的文件目录 ---------- */

async function loadGlobal() {
    const path = getSettings().storePath || `user/files/${STORE_FILE}`;

    try {
        // 加个时间戳破缓存,否则改完刷新还是旧的
        const response = await fetch(`/${path}?t=${new Date().getTime()}`, { cache: 'no-cache' });
        if (!response.ok) {
            globalContacts = [];
            return;
        }

        const data = await response.json();
        globalContacts = Array.isArray(data?.contacts) ? data.contacts : [];
    } catch {
        // 头一回用的时候本来就没有这个文件,不是错
        globalContacts = [];
    }
}

async function saveGlobal() {
    const json = JSON.stringify({ version: 1, contacts: globalContacts }, null, 2);
    const path = await uploadFileAttachment(STORE_FILE, utf8ToBase64(json));

    if (!path) {
        console.error('[织梦OS] 常驻名单没存进去');
        return false;
    }

    getSettings().storePath = path;
    saveSettingsDebounced();
    return true;
}

/** 改完哪一边就存哪一边,别每次两个文件都写一遍 */
async function saveWhere(id) {
    if (isGlobal(id)) await saveGlobal();
    else await saveLocal();
}

/* ---------- 卡里那一份:创作者烤进去的,发卡时跟着走 ----------
 *
 * 存在角色卡的 data.extensions.zhimengos,那是角色卡规范里给扩展留的位置,
 * 导出 png 或 json 时会跟着走(写入用 public/scripts/extensions.js:2061 的
 * writeExtensionField)。
 *
 * **和"存在聊天里"是两码事**,道长在这儿绕过一次:
 *   聊天  = data/<用户>/chats/... 只在自己机器上,跟着这一局走
 *   角色卡 = 那个 png/json 文件本身,是发给别人的东西
 * 所以创作者要让手机内容跟着卡走,必须显式写进卡,不是存在聊天里就自动有了。
 */

/** 当前打开的是哪张角色卡。没开卡或者开的是群聊时返回 null */
function currentCard() {
    const context = getContext();
    const id = context.characterId;

    if (id === undefined || id === null || id === '') return null;
    return { id, card: characters[id] || null };
}

/** @returns {Contact[]} 当前这张卡自带的联系人 */
function cardContacts() {
    const here = currentCard();
    const data = here?.card?.data?.extensions?.[META_KEY];
    return Array.isArray(data?.contacts) ? data.contacts : [];
}

/** 头像:自己设过就用自己的,没设过就借角色卡的 */
function avatarOf(contact) {
    if (contact.avatar) return contact.avatar;
    if (contact.avatarKey) return getThumbnailUrl('avatar', contact.avatarKey);
    return '';
}

function nowClock() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderHome() {
    const icons = APPS.map(app => `
        <div class="zos_app ${app.done ? '' : 'zos_app_todo'}" data-app="${escapeHtml(app.id)}">
            <div class="zos_app_icon">${app.icon}</div>
            <div class="zos_app_name">${escapeHtml(app.name)}</div>
        </div>`).join('');

    return `
        <div class="zos_home">
            <div class="zos_home_grid">${icons}</div>
            <div class="zos_home_note">灰的那些还没做。这一版是壳,聊天里是示例数据。</div>
        </div>`;
}

function renderChatList() {
    const list = allContacts();

    const rows = list.map(c => {
        const last = c.messages?.length ? c.messages[c.messages.length - 1] : null;
        const avatar = avatarOf(c);

        return `
        <div class="zos_chat_row" data-chat="${escapeHtml(c.id)}">
            <div class="zos_avatar">${avatar
                ? `<img src="${escapeHtml(avatar)}" alt="">`
                : escapeHtml((c.nick || '?').slice(0, 1))}</div>
            <div class="zos_chat_mid">
                <div class="zos_chat_name">${escapeHtml(c.nick || '(没名字)')}${c.global ? '<span class="zos_tag">常驻</span>' : ''}</div>
                <div class="zos_chat_last">${escapeHtml(last ? last.text : '还没聊过')}</div>
            </div>
            <div class="zos_chat_right">
                <div class="zos_chat_time">${escapeHtml(last ? last.time : '')}</div>
            </div>
        </div>`;
    }).join('');

    const empty = `
        <div class="zos_empty">
            <div class="zos_empty_big">还没有联系人</div>
            <div>点右上角的加号,从你的角色列表里挑一个加进来。</div>
        </div>`;

    return `
        <div class="zos_appbar">
            <div class="zos_back" data-to="home">‹</div>
            <div class="zos_appbar_title">聊天</div>
            <div class="zos_appbar_right"><div class="zos_add" title="加联系人">+</div></div>
        </div>
        <div class="zos_list">${list.length ? rows : empty}</div>`;
}

function renderChatRoom() {
    const chat = contactById(openChatId);
    if (!chat) return renderChatList();

    const bubbles = (chat.messages || []).map(m => `
        <div class="zos_msg zos_msg_${m.from === 'me' ? 'me' : 'them'}">
            <div class="zos_bubble">${escapeHtml(m.text)}</div>
            <div class="zos_msg_time">${escapeHtml(m.time || '')}</div>
        </div>`).join('');

    const empty = `<div class="zos_empty">还没有消息。<br>发消息这条路还没接上,先把人和设定配好。</div>`;

    return `
        <div class="zos_appbar">
            <div class="zos_back" data-to="chat_list">‹</div>
            <div class="zos_appbar_title">${escapeHtml(chat.nick || '')}</div>
            <div class="zos_appbar_right"><div class="zos_more" title="联系人设置">⋯</div></div>
        </div>
        <div class="zos_msgs">${chat.messages?.length ? bubbles : empty}</div>
        <div class="zos_composer">
            <input class="zos_input" type="text" placeholder="还没接上,先看形态" disabled>
            <div class="zos_send zos_send_off">发送</div>
        </div>`;
}

/* 联系人设置:昵称、头像、以及**线上人设**
 *
 * 线上人设单列一栏是道长的要求(2026-08-18):
 * "线上的人设不一定和角色卡里线下的是一样的"。
 * 留空就用角色卡自己的设定,填了就在手机里盖过它。 */
function renderContactEdit() {
    const c = contactById(openChatId);
    if (!c) return renderChatList();

    const avatar = avatarOf(c);
    const cardName = characters.find(x => x.avatar === c.avatarKey)?.name || '(卡已经不在了)';

    return `
        <div class="zos_appbar">
            <div class="zos_back" data-to="chat_room">‹</div>
            <div class="zos_appbar_title">联系人设置</div>
            <div class="zos_appbar_right"></div>
        </div>
        <div class="zos_form">
            <div class="zos_form_avatar">
                <div class="zos_avatar zos_avatar_big">${avatar
                    ? `<img src="${escapeHtml(avatar)}" alt="">`
                    : escapeHtml((c.nick || '?').slice(0, 1))}</div>
                <div>
                    <div class="zos_form_hint">绑的角色卡:${escapeHtml(cardName)}</div>
                    <label class="zos_upload">换头像<input id="zos_avatar_file" type="file" accept="image/*"></label>
                    ${c.avatar ? '<div id="zos_avatar_reset" class="zos_link">用回角色卡的头像</div>' : ''}
                </div>
            </div>

            <label class="zos_form_row">
                <span>昵称</span>
                <input id="zos_edit_nick" type="text" value="${escapeHtml(c.nick || '')}">
            </label>

            <label class="zos_form_row">
                <span>线上人设</span>
                <textarea id="zos_edit_persona" rows="7" placeholder="留空就用角色卡自己的设定。&#10;填了的话,他在手机里就按这一段来,和线下那份分开。">${escapeHtml(c.persona || '')}</textarea>
            </label>
            <div class="zos_form_hint">线上和线下未必是同一个人,这一栏就是为这个留的。</div>

            <div class="zos_form_row">
                <span>这个人待在哪</span>
                <div class="zos_form_hint">${c.global
                    ? '<b>常驻</b>。哪个聊天都能看到他,聊天记录也是同一份,换角色卡也带得走。'
                    : '<b>只在这个聊天里</b>。换个开场白、换个聊天就没有他,和这一局的剧情绑在一起。'}</div>
                <div id="zos_edit_move" class="zos_btn_ghost">${c.global ? '收回到这个聊天' : '挪到常驻'}</div>
            </div>

            <div class="zos_form_row">
                <span>发给别人</span>
                <div class="zos_form_hint">上面两种都<b>只在你自己机器上</b>。
                    要让别人拿到卡就自带这个人,得把他写进角色卡文件本身。</div>
                <div id="zos_edit_tocard" class="zos_btn_ghost">写进角色卡</div>
            </div>

            <div class="zos_form_btns">
                <div id="zos_edit_save" class="zos_btn_main">保存</div>
                <div id="zos_edit_del" class="zos_btn_danger">删掉这个联系人</div>
            </div>
        </div>`;
}

function renderScreen() {
    let body = '';

    if (screen === 'home') body = renderHome();
    else if (screen === 'chat_list') body = renderChatList();
    else if (screen === 'chat_room') body = renderChatRoom();
    else if (screen === 'contact_edit') body = renderContactEdit();

    $('#zos_screen').html(body);
    $('#zos_phone').attr('data-screen', screen);
}

function goto(next, chatId = null) {
    screen = next;
    if (chatId) openChatId = chatId;
    renderScreen();
}

function buildPhone() {
    if (document.getElementById('zos_phone_wrap')) return;

    // 外面一圈白壳,里面一块黑屏,状态栏和刘海都在黑屏里面,照道长给的那张实物图来。
    // **配色写死,不跟酒馆主题走**(2026-08-18 她的话:"不要跟随系统的美化,现在显得怪怪的")。
    const html = `
    <div id="zos_phone_wrap" class="zos_hidden">
        <div id="zos_backdrop"></div>
        <div id="zos_phone">
            <div class="zos_btn zos_btn_mute"></div>
            <div class="zos_btn zos_btn_up"></div>
            <div class="zos_btn zos_btn_down"></div>
            <div class="zos_btn zos_btn_power"></div>
            <div class="zos_screen_area">
                <div class="zos_notch">
                    <span class="zos_speaker"></span>
                    <span class="zos_cam"></span>
                </div>
                <div class="zos_statusbar">
                    <div id="zos_clock">${nowClock()}</div>
                    <div class="zos_status_right">
                        <span class="zos_sig"></span><span class="zos_bat"></span>
                    </div>
                </div>
                <div id="zos_screen"></div>
                <div class="zos_homebar" title="回主屏"></div>
            </div>
        </div>
    </div>`;

    $('body').append(html);

    // 点手机外面的暗底关掉。点手机本身不关,不然误触就没了
    $('#zos_backdrop').on('click', () => closePhone());
    $('.zos_homebar').on('click', () => goto('home'));

    bindPhoneDrag();

    $('#zos_screen').on('click', '.zos_app', function () {
        const app = String($(this).data('app'));
        const meta = APPS.find(a => a.id === app);

        if (!meta?.done) {
            toastr.info(`「${meta?.name || app}」还没做`, '织梦OS');
            return;
        }

        if (app === 'chat') goto('chat_list');
    });

    $('#zos_screen').on('click', '.zos_chat_row', function () {
        goto('chat_room', String($(this).data('chat')));
    });

    $('#zos_screen').on('click', '.zos_back', function () {
        goto(String($(this).data('to')));
    });

    $('#zos_screen').on('click', '.zos_add', () => onAddContact());
    $('#zos_screen').on('click', '.zos_more', () => goto('contact_edit'));
    $('#zos_screen').on('click', '#zos_edit_save', () => onSaveContact());
    $('#zos_screen').on('click', '#zos_edit_del', () => onDeleteContact());
    $('#zos_screen').on('click', '#zos_avatar_reset', () => onResetAvatar());
    $('#zos_screen').on('click', '#zos_edit_move', () => onMoveContact());
    $('#zos_screen').on('click', '#zos_edit_tocard', () => onWriteToCard());
    $('#zos_screen').on('change', '#zos_avatar_file', function () {
        onPickAvatar(this.files?.[0]);
    });
}

/* ---------- 联系人的增删改 ---------- */

/** 从酒馆的角色列表里挑一个加进手机 */
async function onAddContact() {
    // 已经加过的不再列出来,免得重复
    const taken = new Set(allContacts().map(c => c.avatarKey));
    const pool = characters.filter(c => c?.avatar && !taken.has(c.avatar));

    if (!pool.length) {
        await callGenericPopup(
            `<div class="zos_popup">${characters.length ? '你的角色都已经加进来了。' : '酒馆里还没有角色卡。'}</div>`,
            POPUP_TYPE.TEXT, '', { okButton: '知道了' });
        return;
    }

    const options = pool
        .map(c => `<option value="${escapeHtml(c.avatar)}">${escapeHtml(c.name || c.avatar)}</option>`)
        .join('');

    const html = `<div class="zos_popup">
        <div>把谁加进手机?</div>
        <select id="zos_pick_char" class="text_pole" style="width:100%;margin-top:8px">${options}</select>
        <div class="zos_hint" style="margin-top:6px">加进来之后可以单独改昵称、头像和线上人设,不会动你的角色卡。</div>
    </div>`;

    const ok = await callGenericPopup(html, POPUP_TYPE.CONFIRM, '', { okButton: '加进来', cancelButton: '算了' });
    if (!ok) return;

    const avatarKey = String($('#zos_pick_char').val() || '');
    const card = pool.find(c => c.avatar === avatarKey);
    if (!card) return;

    // 默认只加进这个聊天。不同开场白就是不同聊天,手机内容本来就该分开
    // (2026-08-18 道长:"有些作者不同的开场白会有不同的聊天消息")。
    // 要带到别的对话去,进联系人设置点「挪到常驻」。
    localContacts.push({
        id: uuidv4(),
        avatarKey,
        nick: card.name || '',
        avatar: '',
        persona: '',
        messages: [],
    });

    await saveLocal();
    renderScreen();
}

async function onSaveContact() {
    const c = contactById(openChatId);
    if (!c) return;

    c.nick = String($('#zos_edit_nick').val() || '').trim();
    c.persona = String($('#zos_edit_persona').val() || '');

    await saveWhere(c.id);
    goto('chat_room');
}

async function onDeleteContact() {
    const c = contactById(openChatId);
    if (!c) return;

    const ok = await callGenericPopup(
        `<div class="zos_popup">把「${escapeHtml(c.nick || '')}」从手机里删掉?<br>
        <b>聊天记录也会一起没。</b>你的角色卡不受影响。</div>`,
        POPUP_TYPE.CONFIRM, '', { okButton: '删', cancelButton: '算了' });

    if (!ok) return;

    if (isGlobal(c.id)) {
        globalContacts = globalContacts.filter(x => x.id !== c.id);
        await saveGlobal();
    } else {
        localContacts = localContacts.filter(x => x.id !== c.id);
        await saveLocal();
    }

    openChatId = null;
    goto('chat_list');
}

/**
 * 在「只在这个聊天」和「常驻」之间搬。
 *
 * 由来(2026-08-18 道长):"手机内容跟随聊天,然后有一个入口可以把角色挪到全局里去,
 * 就可以带到别的对话里面了。"
 * 所以默认是隔离的,共享是显式动作,不是默认行为。
 *
 * **人和聊天记录一起搬**,只搬人不搬记录的话,带到别的对话里只有个空壳。
 */
async function onMoveContact() {
    const c = contactById(openChatId);
    if (!c) return;

    const toGlobal = !isGlobal(c.id);

    const ok = await callGenericPopup(
        toGlobal
            ? `<div class="zos_popup">把「${escapeHtml(c.nick || '')}」挪到常驻?<br>
               <b>他和这段聊天记录会一起挪过去</b>,以后哪个聊天、哪张角色卡都能看到他,
               而且大家续的是同一段记录。</div>`
            : `<div class="zos_popup">把「${escapeHtml(c.nick || '')}」收回到当前这个聊天?<br>
               <b>别的聊天里就看不到他了</b>,记录跟着一起收回来。</div>`,
        POPUP_TYPE.CONFIRM, '', { okButton: toGlobal ? '挪过去' : '收回来', cancelButton: '算了' });

    if (!ok) return;

    if (toGlobal) {
        localContacts = localContacts.filter(x => x.id !== c.id);
        globalContacts.push(c);
    } else {
        globalContacts = globalContacts.filter(x => x.id !== c.id);
        localContacts.push(c);
    }

    // 两边都动了,所以两边都得存
    await saveLocal();
    await saveGlobal();
    renderScreen();
}

/**
 * 把这个联系人写进当前角色卡,发卡时跟着走。
 *
 * ⚠️ 这是**唯一一个会改动用户角色卡文件的动作**,所以必须问过再写,
 * 而且要说清写的是哪张卡。
 */
async function onWriteToCard() {
    const c = contactById(openChatId);
    const here = currentCard();

    if (!c) return;

    if (!here?.card) {
        await callGenericPopup(
            '<div class="zos_popup">现在没有打开任何角色卡,写不进去。<br>群聊也不行,得先进一张卡的对话。</div>',
            POPUP_TYPE.TEXT, '', { okButton: '知道了' });
        return;
    }

    const count = c.messages?.length || 0;

    const html = `<div class="zos_popup">
        把「${escapeHtml(c.nick || '')}」写进角色卡<b>${escapeHtml(here.card.name || '')}</b>?
        <div class="zos_hint" style="margin-top:6px"><b>这会改动你的角色卡文件。</b>
        写进去之后,别人拿到这张卡就自带这个联系人。</div>
        <label class="checkbox_label" style="margin-top:8px">
            <input id="zos_with_msgs" type="checkbox" ${count ? 'checked' : ''} ${count ? '' : 'disabled'}>
            <span>连聊天记录一起写(现在有 ${count} 条)</span>
        </label>
        <div class="zos_hint">带上记录的话,玩家一开局手机里就已经聊过这些。卡也会大一点。</div>
    </div>`;

    const ok = await callGenericPopup(html, POPUP_TYPE.CONFIRM, '', { okButton: '写进去', cancelButton: '算了' });
    if (!ok) return;

    const withMessages = Boolean($('#zos_with_msgs').prop('checked'));

    const existing = cardContacts().filter(x => x.id !== c.id);
    const payload = {
        id: c.id,
        avatarKey: c.avatarKey,
        nick: c.nick,
        // 头像不写进去:它是本机文件的地址,发到别人那儿就是死链接,让它退回用卡自己的头像
        avatar: '',
        persona: c.persona,
        messages: withMessages ? (c.messages || []) : [],
    };

    await writeExtensionField(here.id, META_KEY, { version: 1, contacts: [...existing, payload] });

    // 顺手把说明文字给创作者,免得她自己想怎么写(2026-08-18 道长提的)
    const notice = `本卡自带「织梦OS」手机数据,需要先安装织梦OS 插件才能看到:
https://github.com/DaoZhang-AI/zhimengos
没装的话不影响正常聊天,只是手机里那部分内容不会出现。`;

    await callGenericPopup(
        `<div class="zos_popup">写进去了。<br>
        <div class="zos_hint" style="margin-top:6px">建议把下面这段贴到卡的说明里,不然玩家不知道要装插件:</div>
        <div class="zos_reason">${escapeHtml(notice)}</div></div>`,
        POPUP_TYPE.TEXT, '', { okButton: '好', wide: true });
}

/**
 * 这张卡自带联系人、而这个聊天还没导入过的话,问一句。
 *
 * **不自动导入**:自动的话等于任何一张卡都能往玩家手机里塞东西,
 * 而且玩家会搞不清这个人是哪来的。问一句更贵一点,但边界清楚。
 */
async function offerCardImport() {
    const fromCard = cardContacts();
    if (!fromCard.length) return;

    // 问过一次就记下来,别每次开手机都弹
    if (chat_metadata?.[META_KEY]?.cardAsked) return;

    const names = fromCard.map(c => c.nick || '(没名字)').join('、');

    const ok = await callGenericPopup(
        `<div class="zos_popup">这张角色卡自带手机联系人:<b>${escapeHtml(names)}</b>
        <div class="zos_hint" style="margin-top:6px">要不要加进这个聊天的手机里?
        加进来之后就是你自己的了,改昵称改设定都不会动到卡。</div></div>`,
        POPUP_TYPE.CONFIRM, '', { okButton: '加进来', cancelButton: '这次不用' });

    if (!chat_metadata[META_KEY]) chat_metadata[META_KEY] = {};
    chat_metadata[META_KEY].cardAsked = true;

    if (ok) {
        const taken = new Set(allContacts().map(x => x.avatarKey));
        for (const c of fromCard) {
            if (taken.has(c.avatarKey)) continue;
            // 换个 id,免得和卡里那份共用一个身份,以后各改各的
            localContacts.push({ ...c, id: uuidv4() });
        }
    }

    await saveLocal();
    renderScreen();
}

/** 换头像:图也走酒馆那个文件接口,和联系人存在同一个地方 */
async function onPickAvatar(file) {
    const c = contactById(openChatId);
    if (!c || !file) return;

    try {
        const buffer = await file.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }

        // 文件名带上联系人 id,换头像时会原地覆盖,不会越攒越多
        const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
        const path = await uploadFileAttachment(`zhimengos-avatar-${c.id}.${ext}`, btoa(binary));

        if (!path) return;

        // 带时间戳,不然换了图浏览器还拿旧的那张
        c.avatar = `/${path}?t=${new Date().getTime()}`;
        await saveWhere(c.id);
        renderScreen();
    } catch (error) {
        console.error('[织梦OS] 换头像失败', error);
    }
}

async function onResetAvatar() {
    const c = contactById(openChatId);
    if (!c) return;

    c.avatar = '';
    await saveWhere(c.id);
    renderScreen();
}

async function openPhone() {
    buildPhone();
    renderScreen();

    // 每次开都重读一遍:常驻那份是全局的,别的标签页可能改过
    loadLocal();
    await loadGlobal();
    renderScreen();

    await offerCardImport();

    $('#zos_phone_wrap').removeClass('zos_hidden');
    applyPhonePosition();

    // 时钟只在手机开着时走,关了就停,别让它常驻烧定时器
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(() => $('#zos_clock').text(nowClock()), 20000);
}

/* ---------- 手机窗口可以拖 ----------
 *
 * 手柄只认**白色边框和顶部状态栏**,不是整机:屏幕里要点图标、要滑列表,
 * 整机可拖会和这些打架。抓边框和状态栏,跟抓一台真手机的手感也对得上。
 *
 * 拖过之后改成绝对定位;没拖过就保持原来的居中,别让没拖过的人也吃到定位的坑。
 */

/** 这次按下去的地方算不算手柄 */
function isPhoneHandle(target) {
    if (!target) return false;
    if (target.id === 'zos_phone') return true;
    return Boolean(target.closest('.zos_btn, .zos_statusbar, .zos_notch'));
}

function applyPhonePosition() {
    const phone = document.getElementById('zos_phone');
    if (!phone) return;

    const pos = getSettings().phonePos;

    if (!pos) {
        // 没拖过就交回给外层的居中,把内联样式清干净
        phone.style.position = '';
        phone.style.left = '';
        phone.style.top = '';
        phone.style.margin = '';
        return;
    }

    const safe = clampToViewport(pos.left, pos.top, phone.offsetWidth, phone.offsetHeight);

    phone.style.position = 'absolute';
    phone.style.margin = '0';
    phone.style.left = `${safe.left}px`;
    phone.style.top = `${safe.top}px`;
}

function bindPhoneDrag() {
    const phone = document.getElementById('zos_phone');
    if (!phone) return;

    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    phone.addEventListener('pointerdown', (event) => {
        if (!isPhoneHandle(event.target)) return;

        // 拖之前先固定住当前位置,不然从居中切到绝对定位的那一瞬间会跳一下
        const rect = phone.getBoundingClientRect();
        phone.style.position = 'absolute';
        phone.style.margin = '0';
        phone.style.left = `${rect.left}px`;
        phone.style.top = `${rect.top}px`;

        dragging = true;
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
        phone.setPointerCapture(event.pointerId);
    });

    phone.addEventListener('pointermove', (event) => {
        if (!dragging) return;

        const safe = clampToViewport(
            event.clientX - offsetX,
            event.clientY - offsetY,
            phone.offsetWidth,
            phone.offsetHeight);

        phone.style.left = `${safe.left}px`;
        phone.style.top = `${safe.top}px`;
    });

    phone.addEventListener('pointerup', (event) => {
        if (!dragging) return;
        dragging = false;
        phone.releasePointerCapture(event.pointerId);

        getSettings().phonePos = { left: phone.offsetLeft, top: phone.offsetTop };
        saveSettingsDebounced();
    });

    // 双击边框回到正中间,免得拖到犄角旮旯之后找不回来
    phone.addEventListener('dblclick', (event) => {
        if (!isPhoneHandle(event.target)) return;
        getSettings().phonePos = null;
        saveSettingsDebounced();
        applyPhonePosition();
    });
}

function isPhoneOpen() {
    const wrap = document.getElementById('zos_phone_wrap');
    return Boolean(wrap) && !wrap.classList.contains('zos_hidden');
}

/** 再点一次悬浮球就收回去(2026-08-18 道长要的) */
function togglePhone() {
    if (isPhoneOpen()) closePhone();
    else openPhone();
}

function closePhone() {
    $('#zos_phone_wrap').addClass('zos_hidden');

    if (clockTimer) {
        clearInterval(clockTimer);
        clockTimer = null;
    }
}

/* ==========================================================================
 * 悬浮入口
 *
 * **屏幕上的常驻元素必须能关**(2026-08-18 道长定的通用规矩):
 * 所以设置里有开关,藏了之后从设置里还能放出来。
 *
 * 图标用道长自己画的透明底 png,放在 assets/phone.png。
 * **加载不到就退回画出来的那个**,所以图没放也不会开天窗。
 * ========================================================================== */

/** 按下去到松开,移动没超过这个像素就算点击,不算拖动 */
const DRAG_SLOP = 5;

function clampToViewport(left, top, width, height) {
    return {
        left: Math.min(Math.max(left, 0), Math.max(window.innerWidth - width, 0)),
        top: Math.min(Math.max(top, 0), Math.max(window.innerHeight - height, 0)),
    };
}

function applyBallPosition() {
    const ball = document.getElementById('zos_ball');
    if (!ball) return;

    // 页面还没量好尺寸时 innerWidth 可能是 0,这时候摆会把球钉在左上角。
    // 等一帧再来,别在这一刻算(2026-08-18 抓到过)
    if (!window.innerWidth || !window.innerHeight) {
        requestAnimationFrame(() => applyBallPosition());
        return;
    }

    const settings = getSettings();
    const width = ball.offsetWidth || 38;
    const height = ball.offsetHeight || 70;

    // 没拖过就放右下角,别挡住输入框
    const pos = settings.ballPos || {
        left: window.innerWidth - width - 14,
        top: window.innerHeight - height - 120,
    };

    const safe = clampToViewport(pos.left, pos.top, width, height);
    ball.style.left = `${safe.left}px`;
    ball.style.top = `${safe.top}px`;
}

function buildBall() {
    if (document.getElementById('zos_ball')) return;

    const html = `
    <div id="zos_ball" title="织梦OS(可以拖)">
        <img id="zos_ball_img" src="${BALL_IMAGE_IDLE}" alt="">
        <div id="zos_ball_fallback" class="zos_hidden">
            <div class="zos_ball_phone"><div class="zos_ball_screen"></div></div>
        </div>
        <img id="zos_ball_bell" src="${BALL_IMAGE_BELL}" class="zos_hidden" alt="">
    </div>`;

    $('body').append(html);

    // 图没放进去就换成画出来的,不留一个破图标
    document.getElementById('zos_ball_img').addEventListener('error', () => {
        $('#zos_ball_img').addClass('zos_hidden');
        $('#zos_ball_fallback').removeClass('zos_hidden');
    });

    // 铃铛还没抠出来的话,退回"整张换成亮屏那张"
    document.getElementById('zos_ball_bell').addEventListener('error', () => {
        bellReady = false;
        $('#zos_ball_bell').addClass('zos_hidden');
        if (unreadNow) document.getElementById('zos_ball_img').src = BALL_IMAGE_NEW;
    });

    const ball = document.getElementById('zos_ball');
    let dragging = false;
    let moved = false;
    let offsetX = 0;
    let offsetY = 0;

    ball.addEventListener('pointerdown', (event) => {
        dragging = true;
        moved = false;
        offsetX = event.clientX - ball.offsetLeft;
        offsetY = event.clientY - ball.offsetTop;
        ball.setPointerCapture(event.pointerId);
    });

    ball.addEventListener('pointermove', (event) => {
        if (!dragging) return;

        const left = event.clientX - offsetX;
        const top = event.clientY - offsetY;

        if (Math.abs(left - ball.offsetLeft) > DRAG_SLOP || Math.abs(top - ball.offsetTop) > DRAG_SLOP) {
            moved = true;
        }

        const safe = clampToViewport(left, top, ball.offsetWidth, ball.offsetHeight);
        ball.style.left = `${safe.left}px`;
        ball.style.top = `${safe.top}px`;
    });

    ball.addEventListener('pointerup', (event) => {
        if (!dragging) return;
        dragging = false;
        ball.releasePointerCapture(event.pointerId);

        if (moved) {
            // 拖完记住位置,下次开页面还在原地
            getSettings().ballPos = { left: ball.offsetLeft, top: ball.offsetTop };
            saveSettingsDebounced();
            return;
        }

        togglePhone();
    });

    // 窗口大小变了要拉回可视范围,不然球会跑到屏幕外面再也点不着。手机同理
    window.addEventListener('resize', () => {
        applyBallPosition();
        if (isPhoneOpen()) applyPhonePosition();
    });

    applyBallPosition();
}

function applyBall() {
    const hidden = getSettings().ballHidden;

    buildBall();
    $('#zos_ball').toggleClass('zos_hidden', Boolean(hidden));
}

/** bell.png 在不在。加载失败一次就记着,别每次都重试 */
let bellReady = true;
/** 现在是不是有未读 */
let unreadNow = false;

/**
 * 有没有新消息。有就在手机上叠一个铃铛,**一阵一阵地摇**。
 *
 * 为什么是摇不是闪(2026-08-18 道长):一闪一闪的东西挂在屏幕上几分钟就烦人,
 * 而摇是一阵一阵的,响一下停两秒,读起来是"来消息了"而不是"有个东西在闪"。
 * 想换成闪只要改 style.css 里 zos_shake 那段。
 *
 * **不要红点、不要辉光**,这两样她都明确不要。
 *
 * 现在只有设置里那个预览开关会调它;等真消息接上了,由收到消息的地方调。
 * **不存进设置**:未读是运行时状态,存下来会出现"刷新之后还亮着但点进去什么都没有"。
 *
 * @param {boolean} unread
 */
function setBallUnread(unread) {
    const img = document.getElementById('zos_ball_img');
    if (!img) return;

    unreadNow = Boolean(unread);

    if (bellReady) {
        // 有新消息:底图换成亮屏那张,铃铛叠上去摇(2026-08-18 道长:"phone new 加铃铛")
        img.src = unreadNow ? BALL_IMAGE_NEW : BALL_IMAGE_IDLE;
        $('#zos_ball_bell').toggleClass('zos_hidden', !unreadNow);
        return;
    }

    // 铃铛没抠出来,退回整张换图
    img.src = unreadNow ? BALL_IMAGE_NEW : BALL_IMAGE_IDLE;
}

/* ==========================================================================
 * 自己更新自己
 *
 * 由来(2026-08-18 道长):"在用户下载其他插件之后,也应该能在插件本身那里点更新,
 * 而不是只能在织梦者里。" 装了织梦者的人两条路都有,没装的人也不至于没法更新。
 *
 * ⚠️ /api/extensions/version 对"不是 git 仓库"的目录会返回 200 加一串空字符串,
 * 而且 isUpToDate 给的是 true。所以判断能不能更新要看 currentCommitHash 有没有值,
 * **不能看 isUpToDate**,否则手动解压装的会显示"已是最新",点更新又必然失败。
 * ========================================================================== */

/** 自己是装在全局目录还是用户目录 */
async function selfType() {
    try {
        const response = await fetch('/api/extensions/discover');
        if (!response.ok) return 'global';

        const list = await response.json();
        const hit = (Array.isArray(list) ? list : [])
            .find(x => String(x?.name || '').toLowerCase() === `third-party/${MODULE_NAME}`);

        return hit?.type || 'global';
    } catch {
        return 'global';
    }
}

async function checkSelfUpdate() {
    const $out = $('#zos_self_out');
    $out.html('<div class="zos_hint">正在查...</div>');

    try {
        const type = await selfType();
        const response = await fetch('/api/extensions/version', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ extensionName: MODULE_NAME, global: type === 'global' }),
        });

        const data = response.ok ? await response.json() : null;
        const hash = String(data?.currentCommitHash || '');

        if (!hash) {
            $out.html('<div class="zos_hint zos_bad">这份是手动放进去的,没有 git,更新不了。' +
                '<br>要能一键更新的话,用酒馆的「安装扩展」重装一次即可。</div>');
            return;
        }

        const branch = escapeHtml(String(data?.currentBranchName || '?'));
        const short = escapeHtml(hash.slice(0, 7));

        $out.html(data?.isUpToDate
            ? `<div class="zos_hint">${branch} · ${short} · 已是最新</div>
               <div class="zos_buttons"><div id="zos_self_update" class="menu_button" data-global="${type === 'global'}">还是更新一下</div></div>`
            : `<div class="zos_hint">${branch} · ${short} · <b>有新版</b></div>
               <div class="zos_buttons"><div id="zos_self_update" class="menu_button" data-global="${type === 'global'}">更新</div></div>`);
    } catch (error) {
        $out.html(`<div class="zos_hint zos_bad">查不了:${escapeHtml(String(error?.message || error))}</div>`);
    }
}

async function doSelfUpdate() {
    const isGlobal = String($('#zos_self_update').data('global')) === 'true';
    $('#zos_self_update').text('更新中...');

    try {
        const response = await fetch('/api/extensions/update', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ extensionName: MODULE_NAME, global: isGlobal }),
        });

        const text = await response.text();

        if (!response.ok) {
            // 把酒馆的原话给她,别自己编
            await callGenericPopup(
                `<div class="zos_popup"><div class="zos_bad">更新失败。</div>
                <div class="zos_hint">酒馆的原话:</div>
                <div class="zos_reason">${escapeHtml(text || response.statusText)}</div></div>`,
                POPUP_TYPE.TEXT, '', { okButton: '知道了', wide: true });
            return;
        }

        await callGenericPopup(
            '<div class="zos_popup">更新完了。<br><b>要刷新一次页面</b>才会跑新代码。</div>',
            POPUP_TYPE.TEXT, '', { okButton: '知道了' });
    } finally {
        await checkSelfUpdate();
    }
}

/* ==========================================================================
 * 设置面板
 * ========================================================================== */

/** 选中的那条连接现在用哪个模型:自己设过就用自己的,没设过就用连接自带的 */
function currentModelOf(conn) {
    if (!conn) return '';
    return getSettings().models[conn.id] || conn.model || '';
}

function renderConnectionOptions() {
    const settings = getSettings();
    const conns = listConnections();

    // 选中的那条被删了或者改了名就退回主线,别留一个指向空气的 id
    if (settings.connId && !conns.some(c => c.id === settings.connId)) {
        settings.connId = '';
        saveSettingsDebounced();
    }

    const groups = new Map();
    for (const c of conns) {
        if (!groups.has(c.group)) groups.set(c.group, []);
        groups.get(c.group).push(c);
    }

    const parts = [`<option value="" ${settings.connId ? '' : 'selected'}>跟主线用同一个连接</option>`];

    for (const [group, items] of groups) {
        parts.push(`<optgroup label="${escapeHtml(group)}">`);
        for (const c of items) {
            const selected = c.id === settings.connId ? 'selected' : '';
            const mark = c.blocked ? ' (不能用)' : '';
            parts.push(`<option value="${escapeHtml(c.id)}" ${selected}>${escapeHtml(c.name)}${mark}</option>`);
        }
        parts.push('</optgroup>');
    }

    $('#zos_conn').html(parts.join(''));
    renderConnectionDetail();
}

/** 选中一条之后下面那块:地址、模型、以及不能用时的原因 */
function renderConnectionDetail() {
    const conn = findConnection(getSettings().connId);

    if (!conn) {
        $('#zos_conn_detail').html('<div class="zos_hint">手机会跟主线用同一个连接和模型。</div>');
        $('#zos_model_row').hide();
        return;
    }

    if (conn.blocked) {
        $('#zos_conn_detail').html(`<div class="zos_hint zos_bad">${escapeHtml(conn.blocked)}</div>`);
        $('#zos_model_row').hide();
        return;
    }

    const model = currentModelOf(conn);

    $('#zos_conn_detail').html(
        `<div class="zos_hint">地址:${escapeHtml(conn.url || '(没填)')}</div>` +
        `<div class="zos_hint">当前模型:<b>${escapeHtml(model || '还没选')}</b></div>`);

    $('#zos_model_row').show();

    // 每换一条连接就把模型下拉清空,免得把上一条的模型看成这一条的
    $('#zos_model').html(`<option value="">${model ? escapeHtml(model) : '还没加载'}</option>`).val('');
}

async function onLoadModels() {
    const conn = findConnection(getSettings().connId);
    if (!conn || conn.blocked) return;

    const $button = $('#zos_load_models');
    $button.text('加载中...');

    try {
        const models = await fetchModels(conn);

        if (!models.length) {
            await callGenericPopup(
                '<div class="zos_popup">对面没返回任何模型。有的站点不提供模型列表,那就自己在下面手填一个。</div>',
                POPUP_TYPE.TEXT, '', { okButton: '知道了' });
            return;
        }

        const current = currentModelOf(conn);
        const options = models.map(m =>
            `<option value="${escapeHtml(m)}" ${m === current ? 'selected' : ''}>${escapeHtml(m)}</option>`);

        $('#zos_model').html(options.join(''))
            .val(current && models.includes(current) ? current : models[0])
            .trigger('change');

        $('#zos_model_count').text(`拉到 ${models.length} 个模型`);
    } catch (error) {
        await callGenericPopup(
            `<div class="zos_popup"><div class="zos_bad">拉不到模型列表。</div>
            <div class="zos_hint">酒馆的原话:</div>
            <div class="zos_reason">${escapeHtml(String(error?.message || error))}</div>
            <div class="zos_hint">有的站点本来就不给模型列表,这不代表这条连接不能用,自己手填模型名即可。</div></div>`,
            POPUP_TYPE.TEXT, '', { okButton: '知道了', wide: true });
    } finally {
        $button.text('加载模型');
    }
}

function onPickModel() {
    const settings = getSettings();
    const conn = findConnection(settings.connId);
    const model = String($('#zos_model').val() || '').trim();

    if (!conn || !model) return;

    settings.models[conn.id] = model;
    saveSettingsDebounced();
    renderConnectionDetail();
}

function onTypeModel() {
    const settings = getSettings();
    const conn = findConnection(settings.connId);
    const model = String($('#zos_model_manual').val() || '').trim();

    if (!conn) return;

    if (!model) {
        delete settings.models[conn.id];
    } else {
        settings.models[conn.id] = model;
    }

    saveSettingsDebounced();
    $('#zos_model_manual').val('');
    renderConnectionDetail();
}

async function onAddProfile() {
    const name = String($('#zos_new_name').val() || '').trim();
    const url = String($('#zos_new_url').val() || '').trim();
    const key = String($('#zos_new_key').val() || '').trim();
    const model = String($('#zos_new_model').val() || '').trim();

    if (!name || !url || !key) {
        await callGenericPopup(
            '<div class="zos_popup">名字、接口地址、密钥这三样都要填。</div>',
            POPUP_TYPE.TEXT, '', { okButton: '知道了' });
        return;
    }

    if (!/^https?:\/\//i.test(url)) {
        await callGenericPopup(
            '<div class="zos_popup">接口地址要以 http:// 或者 https:// 开头。</div>',
            POPUP_TYPE.TEXT, '', { okButton: '知道了' });
        return;
    }

    if (!isConnectionManagerAvailable()) {
        await callGenericPopup(
            '<div class="zos_popup">酒馆自带的「连接管理器」被禁用了,加不了连接。<br>去扩展面板把 connection-manager 打开再来。</div>',
            POPUP_TYPE.TEXT, '', { okButton: '知道了' });
        return;
    }

    const $button = $('#zos_add_profile');
    $button.text('加进去...');

    try {
        const id = await createProfile({ name, url, key, model });

        if (!id) {
            await callGenericPopup(
                '<div class="zos_popup"><div class="zos_bad">没加成功。</div>密钥没能写进酒馆,所以地址和密钥都没有被保存。</div>',
                POPUP_TYPE.TEXT, '', { okButton: '知道了' });
            return;
        }

        getSettings().connId = id;
        saveSettingsDebounced();

        // 填完立刻清空,尤其密钥那格,别让它留在页面上
        $('#zos_new_name, #zos_new_url, #zos_new_key, #zos_new_model').val('');

        renderConnectionOptions();

        await callGenericPopup(
            `<div class="zos_popup">加好了,手机已经切到「${escapeHtml(name)}」。
            <br>这条连接<b>存在酒馆自己那儿</b>,在酒馆的连接配置界面里也看得到、能改、能删。
            <br>模型没填的话,现在可以点「加载模型」挑一个。</div>`,
            POPUP_TYPE.TEXT, '', { okButton: '好' });
    } finally {
        $button.text('加进酒馆');
    }
}

function renderPanel() {
    const settings = getSettings();

    const html = `
    <div id="zos_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>📱 织梦OS</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <div class="zos_hint">当前版本 v${VERSION}</div>
                <div class="zos_buttons">
                    <div id="zos_self_check" class="menu_button">查看更新</div>
                </div>
                <div id="zos_self_out"></div>

                <hr>
                <b>入口</b>
                <div class="zos_buttons">
                    <div id="zos_open" class="menu_button">打开手机</div>
                </div>
                <label class="checkbox_label">
                    <input id="zos_ball_hidden" type="checkbox" ${settings.ballHidden ? 'checked' : ''}>
                    <span>把悬浮的手机图标藏起来</span>
                </label>
                <label class="checkbox_label">
                    <input id="zos_ball_preview" type="checkbox">
                    <span>预览「有新消息」的样子</span>
                </label>
                <div class="zos_hint">图标可以拖,位置会记住。藏起来之后用上面那个按钮照样能开。
                    两张图分别是 <code>assets/phone.png</code>(平时)和 <code>assets/phone-new.png</code>(有新消息),
                    想换自己替掉就行,文件不在会退回画出来的图标加一个小红点。
                    <b>预览那个开关只是给你看效果的</b>,真消息接上之后会自动切。</div>

                <hr>
                <b>手机用哪个连接</b>
                <div class="zos_hint">手机可以用和主线不同的模型,回一条消息不需要好模型,便宜的就够。
                    下面列的是<b>你已经有的连接</b>,酒馆自带的和 API 管理器里的都在,分组显示。
                    改名或删掉之后这里跟着变。</div>
                <select id="zos_conn" class="text_pole"></select>
                <div id="zos_conn_detail"></div>

                <div id="zos_model_row">
                    <div class="zos_field">
                        <span>模型</span>
                        <select id="zos_model" class="text_pole"></select>
                    </div>
                    <div class="zos_buttons">
                        <div id="zos_load_models" class="menu_button">加载模型</div>
                    </div>
                    <div id="zos_model_count" class="zos_hint"></div>
                    <div class="zos_hint">拉模型列表是正常的连接动作,不是探活。
                        有的站点不给列表,那就在下面手填。</div>
                    <label class="zos_field">
                        <span>手填模型名(填完按回车)</span>
                        <input id="zos_model_manual" type="text" class="text_pole" placeholder="留空并回车 = 恢复用这条连接自带的模型">
                    </label>
                </div>

                <hr>
                <b>加一条新连接</b>
                <div class="zos_hint">不想去别处来回切的话,在这里填也一样。
                    <b>填完是存进酒馆的</b>:密钥进酒馆的密钥仓库,地址进酒馆的连接配置,本插件一个字都不留。</div>

                <label class="zos_field">
                    <span>起个名字</span>
                    <input id="zos_new_name" type="text" class="text_pole" placeholder="比如:手机专用">
                </label>

                <label class="zos_field">
                    <span>接口地址</span>
                    <input id="zos_new_url" type="text" class="text_pole" placeholder="https://例子.com/v1">
                </label>

                <label class="zos_field">
                    <span>密钥</span>
                    <input id="zos_new_key" type="password" class="text_pole" autocomplete="off" placeholder="sk-...">
                </label>

                <label class="zos_field">
                    <span>模型名(可以先空着)</span>
                    <input id="zos_new_model" type="text" class="text_pole" placeholder="留空的话加完再点「加载模型」挑">
                </label>

                <div class="zos_buttons">
                    <div id="zos_add_profile" class="menu_button">加进酒馆</div>
                </div>

                <div class="zos_hint zos_bad">这里<b>不做连通性测试</b>。
                    探测性的请求会让公益站把你拉黑,所以能不能用请你自己判断。</div>
            </div>
        </div>
    </div>`;

    $('#extensions_settings').append(html);

    $('#zos_open').on('click', () => togglePhone());
    $('#zos_self_check').on('click', () => checkSelfUpdate());
    // 更新按钮是查完才画出来的,所以委托在容器上
    $('#zos_self_out').on('click', '#zos_self_update', () => doSelfUpdate());

    $('#zos_ball_hidden').on('input', function () {
        getSettings().ballHidden = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
        applyBall();
    });

    $('#zos_ball_preview').on('input', function () {
        setBallUnread(Boolean($(this).prop('checked')));
    });

    $('#zos_conn').on('change', function () {
        getSettings().connId = String($(this).val() || '');
        saveSettingsDebounced();
        renderConnectionDetail();
        $('#zos_model_count').text('');
    });

    $('#zos_model').on('change', () => onPickModel());
    $('#zos_load_models').on('click', () => onLoadModels());
    $('#zos_add_profile').on('click', () => onAddProfile());

    $('#zos_model_manual').on('keydown', function (event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            onTypeModel();
        }
    });

    renderConnectionOptions();
}

jQuery(async () => {
    getSettings();
    renderPanel();
    applyBall();

    // 换聊天就换一部手机。切走时若手机开着,把它关掉,免得看着上一局的联系人
    eventSource.on(event_types.CHAT_CHANGED, () => {
        loadLocal();
        if (!$('#zos_phone_wrap').hasClass('zos_hidden')) closePhone();
    });

    loadLocal();

    if (!isConnectionManagerAvailable()) {
        console.warn('[织梦OS] 酒馆自带的连接管理器不可用,只能用 API 管理器里的配置或者跟主线走');
    }

    console.log(`[织梦OS] v${VERSION} 已加载。可用连接 ${listConnections().length} 条`);
});
