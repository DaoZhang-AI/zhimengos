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
import {
    saveSettingsDebounced, getRequestHeaders, characters, getThumbnailUrl, chat_metadata, saveMetadata,
    selectCharacterById, openCharacterChat, getPastCharacterChats, setActiveCharacter, setActiveGroup,
    setExtensionPrompt, extension_prompt_types, extension_prompt_roles,
} from '../../../../script.js';
import { user_avatar } from '../../../personas.js';
import { groups, openGroupById, openGroupChat } from '../../../group-chats.js';
import { eventSource, event_types } from '../../../events.js';
import { uploadFileAttachment } from '../../../chats.js';
import { ConnectionManagerRequestService } from '../../shared.js';
// ⚠️ 这两个 import 后面的 ?v= 要跟着版本号一起改。
// manifest 里的 ?v= 只管 index.js,管不到它 import 进来的文件,
// 不带的话改了库文件浏览器还喂旧的那份。
import { fuzzyAgo, fuzzyRange, displayTime } from './lib/fuzzy-time.js?v=0.14.2';
import { maintain, buildMemoryText, describe, DEFAULTS as MEM_DEFAULTS } from './lib/rolling-summary.js?v=0.14.2';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { writeSecret, SECRET_KEYS } from '../../../secrets.js';
import { uuidv4 } from '../../../utils.js';

/** 跟 manifest.json 的 version 手动保持一致,靠这行在控制台辨认在跑哪一版 */
const VERSION = '0.14.2';

/** 必须和仓库名、文件夹名一致,理由见织梦者里那段注释 */
const MODULE_NAME = 'zhimengos';

/** 换行符。单独拿出来是因为这个文件被脚本改过很多轮,转义序列容易在中途被吃掉 */
const LF = String.fromCharCode(10);

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
    /** 分层摘要的三个数字,含义见 lib/rolling-summary.js */
    memory: { ...MEM_DEFAULTS },
    /** 一次回几条。**给模型的是范围里随机抽的一个具体数字**,不是范围本身:
     *  给具体数字的遵守度比给范围高得多,而随机由我们掌握,效果一样。 */
    replyMin: 2,
    replyMax: 4,
    /** 回复一条一条往外冒,像真人在打字。嫌慢的人可以关掉 */
    typing: true,
    /** 她停手这么多秒之后对方才回。**允许连发好几条再等回复**(道长 9/17:不要强制一问一答) */
    replyDelay: 3,
    /** 手机里的线上聊天要不要进主线上下文(道长 9/17:这是最早定的需求,线上线下要联动) */
    linkMain: true,
};

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    const settings = extension_settings[MODULE_NAME];
    if (!settings.models || typeof settings.models !== 'object') settings.models = {};
    // 补齐后来新增的键,老用户升级时不至于缺
    settings.memory = { ...MEM_DEFAULTS, ...(settings.memory || {}) };
    for (const k of ['replyDelay', 'linkMain']) {
        if (!(k in settings)) settings[k] = defaultSettings[k];
    }
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
    // 道长 9/17:API 设置那些整体挪进手机自己的设置里,别让人去扩展抽屉里翻
    { id: 'settings', name: '设置', icon: '⚙️', done: true },
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
 * @property {Array<{from: string, text: string, t: number}>} messages 时间存**绝对时间戳**,
 *           模糊化只在喂给模型之前做,理由见 lib/fuzzy-time.js
 * @property {Array} summaries 分层摘要,结构见 lib/rolling-summary.js
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

    if (takePending()) {
        saveLocal();
        toastr.info('上次等回复时切走了,那几条回复已经补回这一局', '织梦OS');
    }
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

/* ---------- 等回复时切走了聊天:先寄存,回到那一局再补进去 ----------
 *
 * 由来(2026-09-13 查「关窗口聊天就没了」时发现):发出去之后模型要想好几秒,
 * 这期间切到别的聊天,回复回来时 chat_metadata 已经是另一局的了。
 * 原来的写法会把回复塞进一个已经不在任何名单里的对象,再把**新那一局**存一遍,
 * 回复就这样凭空没了。
 *
 * 不去改那个没打开的聊天文件:那要整份读出来再整份写回去,她的聊天有几 MB,
 * 而且万一她这时又切回去,两边同时写就是真毁档。
 * 所以先寄存在这台设备的 localStorage,回到那一局时补进去。只是个中转,补完就删。
 */

const PENDING_KEY = 'zhimengos-pending';

/** 现在打开的是哪一局。没开聊天时是空字符串 */
function currentChatKey() {
    return String(getContext()?.chatId || '');
}

function readPending() {
    try {
        return JSON.parse(localStorage.getItem(PENDING_KEY) || '{}') || {};
    } catch {
        return {};
    }
}

function writePending(data) {
    try {
        if (Object.keys(data).length) localStorage.setItem(PENDING_KEY, JSON.stringify(data));
        else localStorage.removeItem(PENDING_KEY);
    } catch {
        // 存不了就算了,至多是这一次的回复补不回来,不影响别的
    }
}

/**
 * 存一个联系人,但先确认他还在他出发时那一局里。
 * @param {Contact} contact
 * @param {string} chatKey 发消息那一刻的聊天
 * @returns {Promise<boolean>} 真 = 存进去了;假 = 已经切走,寄存起来了
 */
async function saveContactFrom(contact, chatKey) {
    if (isGlobal(contact.id)) {
        await saveGlobal();
        return true;
    }

    if (currentChatKey() === chatKey) {
        // 切走又切回来的话,名单是重新读盘读出来的,里面那个同 id 的对象不是手上这个,
        // 手上这个比它多了这几秒新到的回复,换成手上这个再存
        const index = localContacts.findIndex(c => c.id === contact.id);
        if (index !== -1) {
            localContacts[index] = contact;
            await saveLocal();
            return true;
        }
    }

    if (!chatKey) return false;

    const pending = readPending();
    pending[chatKey] = { ...(pending[chatKey] || {}), [contact.id]: contact };
    writePending(pending);
    return false;
}

/** 打开一局时,把之前寄存的回复补进去。@returns 补了几个联系人 */
function takePending() {
    const chatKey = currentChatKey();
    const pending = readPending();
    const here = pending[chatKey];

    if (!chatKey || !here) return 0;

    let count = 0;

    for (const saved of Object.values(here)) {
        const index = localContacts.findIndex(c => c.id === saved.id);
        // 这个人在这局里已经被删了,那就尊重删除,不复活
        if (index === -1) continue;
        // 寄存的那份是从这局读出去再往后长的,条数不会比盘上少;少了说明盘上后来又变过,不去盖
        if ((saved.messages?.length || 0) < (localContacts[index].messages?.length || 0)) continue;

        localContacts[index] = saved;
        count++;
    }

    delete pending[chatKey];
    writePending(pending);
    return count;
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

/* ==========================================================================
 * 收藏夹:没打开聊天时,手机里显示的就是它
 *
 * 由来(2026-09-13 道长定):手机记录跟着酒馆聊天走,一个角色有无数个聊天,
 * 重开浏览器停在欢迎页时手机里什么都没有,她以为聊天丢了。
 * 所以没开聊天时给一个收藏夹:**按角色分组,一条就是这个角色的一个酒馆聊天**(分支也算),
 * 点一下酒馆就切到那一局,手机打开那一局的记录。备注名可以改。
 *
 * **归属按酒馆聊天属于谁**:在 Char1 的聊天里把 Char2 拉进手机,收藏后出现在 Char1 组下
 * (道长:逻辑是"在这个角色的聊天里把别的角色拉进来聊天")。
 *
 * 存在 user/files 自己的文件里,不进 settings.json。
 * ========================================================================== */

const FAV_FILE = 'zhimengos-favorites.json';

/**
 * @typedef {object} Favorite
 * @property {string} avatar 角色卡的头像文件名。群聊时为空
 * @property {string} group  酒馆群聊的 id。角色卡时为空
 * @property {string} file   聊天名,不带 .jsonl,和 getContext().chatId 同一个口径
 * @property {string} remark 备注名。空 = 显示聊天名
 */

/** @type {Favorite[]} */
let favorites = [];

/** 从收藏夹跳过去的途中会触发换聊天事件,这时候别把手机关掉 */
let jumping = false;

function stripJsonl(name) {
    return String(name || '').replace(/\.jsonl$/i, '');
}

async function loadFavorites() {
    try {
        const response = await fetch(`/user/files/${FAV_FILE}?t=${new Date().getTime()}`, { cache: 'no-cache' });
        if (!response.ok) {
            favorites = [];
            return;
        }

        const data = await response.json();
        favorites = Array.isArray(data?.items) ? data.items : [];
    } catch {
        // 头一回用还没有这个文件
        favorites = [];
    }
}

async function saveFavorites() {
    const json = JSON.stringify({ version: 1, items: favorites }, null, 2);
    const path = await uploadFileAttachment(FAV_FILE, utf8ToBase64(json));
    if (!path) console.error('[织梦OS] 收藏夹没存进去');
}

/** @returns {Favorite|null} 现在打开的这一局,还没开聊天时为 null */
function currentPlace() {
    const context = getContext();
    const file = currentChatKey();
    if (!file) return null;

    if (context.groupId) return { avatar: '', group: String(context.groupId), file, remark: '' };

    const card = characters[context.characterId];
    if (!card?.avatar) return null;
    return { avatar: card.avatar, group: '', file, remark: '' };
}

function favoriteIndexOf(place) {
    if (!place) return -1;
    return favorites.findIndex(f => f.avatar === place.avatar && f.group === place.group && f.file === place.file);
}

/** 收藏夹里组名:角色卡名或群名 */
function ownerName(f) {
    if (f.group) return groups.find(g => g.id === f.group)?.name || '(群聊已经不在了)';
    return characters.find(c => c.avatar === f.avatar)?.name || '(角色卡已经不在了)';
}

/** 「Char1 @备注名」这种写法,列表和顶上那行共用 */
function placeLabel(f) {
    return `${ownerName(f)} @${f.remark || f.file}`;
}

async function onToggleFavorite() {
    const place = currentPlace();
    if (!place) return;

    const index = favoriteIndexOf(place);

    if (index === -1) {
        favorites.push(place);
        toastr.success('收藏了这一局。没打开聊天时,手机里点它就能跳回来', '织梦OS');
    } else {
        // 只是拿掉一个快捷方式,聊天和手机记录都不动,所以不用问
        favorites.splice(index, 1);
    }

    await saveFavorites();
    renderScreen();
}

async function onRenameFavorite(index) {
    const f = favorites[index];
    if (!f) return;

    // 留住引用再读,理由见 onAddContact
    const container = document.createElement('div');
    container.className = 'zos_popup';

    const title = document.createElement('div');
    title.textContent = `给「${ownerName(f)}」这一局起个备注名`;

    const input = document.createElement('input');
    input.className = 'text_pole';
    input.style.width = '100%';
    input.style.marginTop = '8px';
    input.value = f.remark || '';
    input.placeholder = f.file;

    const hint = document.createElement('div');
    hint.className = 'zos_hint';
    hint.style.marginTop = '6px';
    hint.textContent = '留空就显示酒馆里的聊天名。只改手机里显示的名字,不动酒馆的聊天文件。';

    container.append(title, input, hint);

    const ok = await callGenericPopup(container, POPUP_TYPE.CONFIRM, '', { okButton: '好', cancelButton: '算了' });
    if (!ok) return;

    f.remark = String(input.value || '').trim();
    await saveFavorites();
    renderScreen();
}

/** 这一局打不开时问一句要不要从收藏夹拿掉。不自动拿,万一只是卡还没加载出来 */
async function offerRemoveFavorite(index, why) {
    const ok = await callGenericPopup(
        `<div class="zos_popup">这一局打不开:${escapeHtml(why)}
        <div class="zos_hint" style="margin-top:6px">可能是聊天被删了。要把它从收藏夹里拿掉吗?
        只是拿掉快捷方式,别的什么都不动。</div></div>`,
        POPUP_TYPE.CONFIRM, '', { okButton: '拿掉', cancelButton: '先留着' });

    if (!ok) return;

    favorites.splice(index, 1);
    await saveFavorites();
    renderScreen();
}

/**
 * 从收藏夹跳到那一局。照抄酒馆欢迎页「最近聊天」的打开顺序
 * (public/scripts/welcome-screen.js 的 openRecentCharacterChat / openRecentGroupChat):
 * 先选中角色或群,不是那一局再切聊天。
 */
async function onOpenFavorite(index) {
    const f = favorites[index];
    if (!f) return;

    jumping = true;

    try {
        if (f.group) {
            const group = groups.find(g => g.id === f.group);
            if (!group) return await offerRemoveFavorite(index, '这个群聊已经不在了');
            if (!group.chats?.includes(f.file)) return await offerRemoveFavorite(index, '群里没有这个聊天了');

            await openGroupById(f.group);

            // 酒馆在生成中、存档中会拒绝切换,这时候绝不能接着切聊天,不然切的是别人的
            if (String(getContext().groupId) !== f.group) {
                toastr.info('酒馆现在忙,等它生成完或存完再点', '织梦OS');
                return;
            }

            setActiveGroup(f.group);
            if (currentChatKey() !== f.file) await openGroupChat(f.group, f.file);
        } else {
            const id = characters.findIndex(c => c.avatar === f.avatar);
            if (id === -1) return await offerRemoveFavorite(index, '这张角色卡已经不在了');

            const chats = await getPastCharacterChats(id);
            if (!chats.some(c => stripJsonl(c.file_name) === f.file)) {
                return await offerRemoveFavorite(index, '这张卡下面没有这个聊天了');
            }

            await selectCharacterById(id);

            // 同上。openCharacterChat 是往"当前选中的角色"身上切,选中失败时往下走会切错人
            if (String(getContext().characterId) !== String(id)) {
                toastr.info('酒馆现在忙,等它生成完或存完再点', '织梦OS');
                return;
            }

            setActiveCharacter(f.avatar);
            if (currentChatKey() !== f.file) await openCharacterChat(f.file);
        }

        saveSettingsDebounced();
    } finally {
        jumping = false;
    }

    loadLocal();
    goto('chat_list');
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
            <div class="zos_home_note">灰的那些还没做。</div>
        </div>`;
}

/** 没打开聊天时:收藏夹按角色分组,底下是常驻联系人(他们不挑聊天,在哪都能聊) */
function renderFavorites() {
    /** @type {Map<string, number[]>} 组 → 收藏夹里的下标 */
    const owners = new Map();

    favorites.forEach((f, i) => {
        const key = f.group ? `g:${f.group}` : `c:${f.avatar}`;
        if (!owners.has(key)) owners.set(key, []);
        owners.get(key).push(i);
    });

    const blocks = [...owners.values()].map(indexes => {
        const name = ownerName(favorites[indexes[0]]);

        const rows = indexes.map(i => {
            const f = favorites[i];
            return `
            <div class="zos_chat_row zos_fav_row" data-fav="${i}">
                <div class="zos_chat_mid">
                    <div class="zos_chat_name">${escapeHtml(name)} <span class="zos_fav_at">@${escapeHtml(f.remark || f.file)}</span></div>
                </div>
                <div class="zos_fav_rename" data-fav="${i}" title="改备注名">✎</div>
            </div>`;
        }).join('');

        return `<div class="zos_group_head">${escapeHtml(name)}</div>${rows}`;
    }).join('');

    const residents = globalContacts.length
        ? `<div class="zos_group_head">常驻联系人</div>${globalContacts.map(c => renderContactRow({ ...c, global: true })).join('')}`
        : '';

    const empty = `
        <div class="zos_empty">
            <div class="zos_empty_big">还没打开聊天</div>
            <div>手机记录是跟着酒馆聊天存的,先在酒馆里打开一个聊天就能看到。</div>
            <div>想以后一点就回到某一局:进那个聊天后,在这一屏右上角点 ☆ 收藏。</div>
        </div>`;

    return `
        <div class="zos_appbar">
            <div class="zos_back" data-to="home">‹</div>
            <div class="zos_appbar_title">收藏夹</div>
            <div class="zos_appbar_right"></div>
        </div>
        <div class="zos_list">${blocks || residents ? blocks + residents : empty}</div>`;
}

function renderChatList() {
    const place = currentPlace();
    if (!place) return renderFavorites();

    const list = allContacts();
    const starred = favoriteIndexOf(place) !== -1;
    const rows = list.map(renderContactRow).join('');

    const empty = `
        <div class="zos_empty">
            <div class="zos_empty_big">还没有联系人</div>
            <div>点右上角的加号,从你的角色列表里挑一个加进来。</div>
        </div>`;

    // 顶上写明这是哪一局的手机,切了聊天手机跟着换,不写的话会以为东西丢了
    const current = favorites[favoriteIndexOf(place)] || place;

    return `
        <div class="zos_appbar">
            <div class="zos_back" data-to="home">‹</div>
            <div class="zos_appbar_title">聊天</div>
            <div class="zos_appbar_right">
                <div class="zos_star ${starred ? 'zos_star_on' : ''}" title="${starred ? '取消收藏这一局' : '收藏这一局'}">${starred ? '★' : '☆'}</div>
                <div class="zos_add" title="加联系人">+</div>
            </div>
        </div>
        <div class="zos_list_where">这是「${escapeHtml(placeLabel(current))}」这一局的手机</div>
        <div class="zos_list">${list.length ? rows : empty}</div>`;
}

function renderContactRow(c) {
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
                <div class="zos_chat_time">${escapeHtml(last ? displayTime(last.t) : '')}</div>
            </div>
        </div>`;
}

function renderChatRoom() {
    const chat = contactById(openChatId);
    if (!chat) return renderChatList();

    const bubbles = (chat.messages || []).map(m => renderBubble(m, chat)).join('');

    const empty = `<div class="zos_empty">还没有消息。<br>说点什么吧。</div>`;
    const delay = Number(getSettings().replyDelay) || 0;

    return `
        <div class="zos_appbar">
            <div class="zos_back" data-to="chat_list">‹</div>
            <div class="zos_appbar_title">${escapeHtml(chat.nick || '')}</div>
            <div class="zos_appbar_right"><div class="zos_more" title="联系人设置">⋯</div></div>
        </div>
        <div class="zos_msgs">${chat.messages?.length ? bubbles : empty}</div>
        <div class="zos_plus_panel zos_hidden">
            <div class="zos_plus_item" data-kind="sticker"><div class="zos_plus_icon">😊</div>表情</div>
            <div class="zos_plus_item" data-kind="image"><div class="zos_plus_icon">🖼️</div>图片</div>
            <div class="zos_plus_item" data-kind="gift"><div class="zos_plus_icon">🎁</div>送礼</div>
            <div class="zos_plus_item" data-kind="location"><div class="zos_plus_icon">📍</div>位置</div>
            <div class="zos_plus_item zos_plus_wide" data-kind="offline_during"><div class="zos_plus_icon">🎬</div>一键线下:补写发消息时他在干嘛</div>
            <div class="zos_plus_item zos_plus_wide" data-kind="offline_after"><div class="zos_plus_icon">🚶</div>一键线下:接着最后一条往下写</div>
        </div>
        <div class="zos_composer">
            <div class="zos_plus" title="表情、图片、送礼、位置、一键线下">+</div>
            <input class="zos_input" type="text" placeholder="${delay ? `可以连发几条,停手 ${delay} 秒他才回` : '说点什么'}">
            <div class="zos_send" title="输入框空着点一下 = 让他马上回">发送</div>
        </div>`;
}

/** 消息里的特殊种类:发出去的是带方括号标记的文字,模型看得懂,界面上换成图标 */
const KIND_MARKS = { sticker: '表情', image: '图片', gift: '礼物', location: '位置' };
const KIND_ICONS = { 表情: '😊', 图片: '🖼️', 礼物: '🎁', 位置: '📍' };

function kindOf(text) {
    const m = String(text || '').match(/^\[(表情|图片|礼物|位置)\]\s*([\s\S]*)$/);
    return m ? { mark: m[1], body: m[2] } : null;
}

/* ---------- 「+」菜单:表情、图片、送礼、位置、一键线下 ---------- */

const PLUS_HINTS = {
    sticker: '发个什么表情?比如:捂脸笑、翻白眼的猫',
    image: '图片里是什么?比如:刚拍的晚霞、桌上那碗面',
    gift: '送什么?比如:一杯奶茶、一束白玫瑰',
    location: '发哪儿的位置?比如:老城区地铁站 B 口',
};

async function onPlusItem(kind) {
    $('.zos_plus_panel').addClass('zos_hidden');
    const contact = contactById(openChatId);
    if (!contact) return;

    if (kind === 'offline_during' || kind === 'offline_after') {
        return goOffline(contact, kind === 'offline_during' ? 'during' : 'after');
    }

    // 都用文字代替:发出去是「[图片] 窗外在下雨」这样,模型看得懂,界面上画成卡片
    const text = await callGenericPopup(`<div class="zos_popup">${escapeHtml(PLUS_HINTS[kind] || '')}</div>`,
        POPUP_TYPE.INPUT, '', { okButton: '发送', cancelButton: '算了' });
    if (!text || !String(text).trim()) return;
    await pushMine(contact, `[${KIND_MARKS[kind]}] ${String(text).trim()}`);
}

/* ---------- 一键线下:按手机里这段聊天,让主线生成一层正文 ----------
 *
 * 道长 9/17 定的两种:
 *   during = 补写发这些消息的时候,他那一头人在哪、在干嘛
 *   after  = 以最后一条为起点,写他接下来做了什么
 * 做法:把聊天和要求挂成一条一次性的注入(用户位、深度 0,末条还是用户),
 * 让酒馆用主线的连接和预设正常生成一层,生成完就撤掉。走的是酒馆自己的生成,公益站看到的就是酒馆。
 */
const KEY_OFFLINE = 'zhimengos_offline';
/** 主线正在生成。这时候点一键线下,那条注入会被上一轮的结束事件撤掉,所以直接拦住 */
let mainGenerating = false;

function contactRealName(contact) {
    const card = characters.find(c => c.avatar === contact.avatarKey);
    return card?.name || contact.nick || '对方';
}

function buildOfflinePrompt(contact, mode) {
    const userName = getContext().name1 || '我';
    const charName = contactRealName(contact);
    const nick = contact.nick || charName;
    const lines = (contact.messages || []).slice(-30)
        .map(m => `[${displayTime(m.t)}] ${m.from === 'me' ? userName : nick}:${m.text}`);

    const head = [
        '[这一层写线下正文]',
        `下面是${userName}和${charName}刚才在手机上的一段文字聊天(${charName}在手机上叫「${nick}」)。这段聊天已经真实发生过了。`,
        '',
        ...lines,
        '',
    ];

    const ask = mode === 'during'
        ? [
            `这一层请写:发这些消息的那段时间里,${charName}那一头人在哪、在做什么、是什么神情和小动作。`,
            '按消息的时间顺序写,可以写他拿起手机、打字、停下来、删了又重写、放下手机又拿起来。',
            '消息原文照录,一个字不许改。',
            '写到最后一条消息为止,不要往后推进剧情。',
        ]
        : [
            `这一层请写:以最后一条消息为起点,${charName}接下来做了什么。`,
            '聊天本身已经发生过了,不要在正文里重写或复述这段聊天。',
        ];

    return [...head, ...ask, `不要替${userName}做任何动作、说任何话。`].join(LF);
}

async function goOffline(contact, mode) {
    if (!contact.messages?.length) {
        toastr.info('这段聊天还是空的,没东西可以写成线下', '织梦OS');
        return;
    }
    if (!currentChatKey()) {
        toastr.warning('先在酒馆里打开一个聊天,线下正文要写进那一局', '织梦OS');
        return;
    }
    if (mainGenerating) {
        toastr.info('主线正在生成,等它写完再点', '织梦OS');
        return;
    }

    const context = getContext();
    setExtensionPrompt(KEY_OFFLINE, buildOfflinePrompt(contact, mode),
        extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.USER);
    closePhone();

    try {
        await context.executeSlashCommandsWithOptions('/trigger await=true');
    } catch (error) {
        toastr.error('没生成出来:' + String(error?.message || error), '织梦OS');
    } finally {
        setExtensionPrompt(KEY_OFFLINE, '', extension_prompt_types.IN_CHAT, 0);
    }
}

/* ---------- 线上线下联动:手机里的聊天进主线上下文 ----------
 *
 * 道长 9/17:这是最早定的需求(2026-08-17 第二条「双向可见」),之前一行没写,现在补上。
 * 只进**这一局**的联系人(存在聊天元数据里的那些);常驻联系人跨局共用,进了会串到别的故事里。
 * 设置里关掉就当场撤掉,不等下一轮。
 */
const KEY_LINK = 'zhimengos_link';

function refreshLink() {
    const settings = getSettings();
    const clear = () => setExtensionPrompt(KEY_LINK, '', extension_prompt_types.IN_CHAT, 0);

    if (!settings.linkMain || !currentChatKey()) return clear();

    const now = Date.now();
    const userName = getContext().name1 || '我';
    const blocks = [];

    // 和手机自己记得的一模一样:全部摘要 + 全部还没摘要的正文(道长 9/18:线上线下都要保留全部记忆)
    for (const c of localContacts) {
        const recent = c.messages || [];
        if (!recent.length) continue;
        const nick = c.nick || '对方';
        const memory = buildMemoryText(c, (from, to) => fuzzyRange(from, to, now));
        blocks.push([
            `— 和「${nick}」:`,
            memory ? `(更早的:${memory.replace(/\s*\n\s*/g, ' ')})` : '',
            ...recent.map(m => `[${fuzzyAgo(m.t, now) || displayTime(m.t)}] ${m.from === 'me' ? userName : nick}:${m.text}`),
        ].filter(Boolean).join(LF));
    }

    if (!blocks.length) return clear();

    const text = [
        '[手机上的线上聊天]',
        `下面是${userName}在手机上和别人的文字聊天,都是真实发生过的事。`,
        '聊天另一方记得自己在手机上说过什么,线下可以接着这些事往下走,也可以提起;没参与这段聊天的人不知道内容。',
        '「」里是对方在手机上的名字。',
        '',
        ...blocks,
    ].join(LF);

    setExtensionPrompt(KEY_LINK, text, extension_prompt_types.IN_CHAT, 4, false, extension_prompt_roles.SYSTEM);
}

/** 两边头像常驻(道长 9/17):对方在左,自己在右 */
function renderBubble(m, contact) {
    const mine = m.from === 'me';
    const src = mine ? (user_avatar ? getThumbnailUrl('persona', user_avatar) : '') : avatarOf(contact);
    const fallback = mine ? '我' : (contact.nick || '?').slice(0, 1);
    const avatar = `<div class="zos_msg_avatar">${src ? `<img src="${escapeHtml(src)}" alt="">` : escapeHtml(fallback)}</div>`;
    const kind = kindOf(m.text);
    const inner = kind
        ? `<div class="zos_bubble zos_bubble_card"><span class="zos_card_icon">${KIND_ICONS[kind.mark]}</span><span><span class="zos_card_mark">${kind.mark}</span>${escapeHtml(kind.body)}</span></div>`
        : `<div class="zos_bubble">${escapeHtml(m.text)}</div>`;

    return `
        <div class="zos_msg_row zos_msg_row_${mine ? 'me' : 'them'}">
            ${mine ? '' : avatar}
            <div class="zos_msg zos_msg_${mine ? 'me' : 'them'}">
                ${inner}
                <div class="zos_msg_time">${escapeHtml(displayTime(m.t))}</div>
            </div>
            ${mine ? avatar : ''}
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

    const stat = describe(c, getSettings().memory);
    const memoryLine = `${stat.rawCount} 条正文,${stat.summaryCount} 段摘要。`
        + (stat.untilSummary ? `再聊 ${stat.untilSummary} 条会写一段新摘要。` : '下次发消息就会写一段新摘要。');

    // 摘要可以手动改:模型写歪了、或者你想补一句,直接在这儿动
    const now = Date.now();
    const summaryBlocks = (c.summaries || []).map((sum, i) => `
        <div class="zos_sum">
            <div class="zos_sum_head">
                <span>${escapeHtml(fuzzyRange(sum.from, sum.to, now) || '时间不详')}</span>
                <span class="zos_sum_del" data-index="${i}">删掉</span>
            </div>
            <textarea class="zos_sum_text" data-index="${i}" rows="4">${escapeHtml(sum.text || '')}</textarea>
        </div>`).join('');

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
                <span>记忆</span>
                <div class="zos_form_hint">${escapeHtml(memoryLine)}</div>
                ${summaryBlocks || '<div class="zos_form_hint">还没有摘要。聊够了会自动写,写完可以在这里改。</div>'}
            </div>

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
    else if (screen === 'settings') body = renderSettings();

    $('#zos_screen').html(body);
    $('#zos_phone').attr('data-screen', screen);

    // 设置页里的下拉要按当前连接现填
    if (screen === 'settings') renderConnectionOptions();
}

function goto(next, chatId = null) {
    screen = next;
    if (chatId) openChatId = chatId;
    renderScreen();

    // 进聊天窗默认看最新的那条,和真手机一样
    if (next === 'chat_room') scrollMessagesToEnd();
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
        if (app === 'settings') goto('settings');
    });

    $('#zos_screen').on('click', '.zos_chat_row[data-chat]', function () {
        goto('chat_room', String($(this).data('chat')));
    });

    $('#zos_screen').on('click', '.zos_fav_row', function () {
        onOpenFavorite(Number($(this).data('fav')));
    });
    $('#zos_screen').on('click', '.zos_fav_rename', function (event) {
        // 别让点铅笔同时触发整行的"跳过去"
        event.stopPropagation();
        onRenameFavorite(Number($(this).data('fav')));
    });
    $('#zos_screen').on('click', '.zos_star', () => onToggleFavorite());

    $('#zos_screen').on('click', '.zos_back', function () {
        goto(String($(this).data('to')));
    });

    $('#zos_screen').on('click', '.zos_send', () => onSend());
    $('#zos_screen').on('keydown', '.zos_input', function (event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            onSend();
        }
    });

    $('#zos_screen').on('click', '.zos_add', () => onAddContact());
    $('#zos_screen').on('click', '.zos_more', () => goto('contact_edit'));
    $('#zos_screen').on('click', '#zos_edit_save', () => onSaveContact());
    $('#zos_screen').on('click', '#zos_edit_del', () => onDeleteContact());
    $('#zos_screen').on('click', '#zos_avatar_reset', () => onResetAvatar());
    $('#zos_screen').on('click', '#zos_edit_move', () => onMoveContact());
    $('#zos_screen').on('click', '.zos_sum_del', function () {
        onDeleteSummary(Number($(this).data('index')));
    });
    $('#zos_screen').on('click', '#zos_edit_tocard', () => onWriteToCard());
    $('#zos_screen').on('change', '#zos_avatar_file', function () {
        onPickAvatar(this.files?.[0]);
    });
}

/* ---------- 联系人的增删改 ---------- */

/** 联系人默认存在当前聊天里,所以必须先有个聊天。没有的话明说,别静默落空 */
async function hasOpenChat() {
    const context = getContext();
    if (context?.chatId) return true;

    await callGenericPopup(
        `<div class="zos_popup">得先打开一个聊天才能加联系人。
        <div class="zos_hint" style="margin-top:6px">因为联系人是<b>存在这个聊天里</b>的,
        换个开场白就是另一部手机。<br>
        <b>不必是那个角色本人的聊天</b>,随便哪个都行,加进来的人可以是任意一张卡。</div></div>`,
        POPUP_TYPE.TEXT, '', { okButton: '知道了' });

    return false;
}

/** 从酒馆的角色列表里挑一个加进手机 */
async function onAddContact() {
    if (!await hasOpenChat()) return;

    // 已经加过的不再列出来,免得重复
    const taken = new Set(allContacts().map(c => c.avatarKey));
    const pool = characters.filter(c => c?.avatar && !taken.has(c.avatar));

    if (!pool.length) {
        await callGenericPopup(
            `<div class="zos_popup">${characters.length ? '你的角色都已经加进来了。' : '酒馆里还没有角色卡。'}</div>`,
            POPUP_TYPE.TEXT, '', { okButton: '知道了' });
        return;
    }

    // ⚠️ 这里必须自己建 DOM 并**留住引用**,不能等弹窗关了再用选择器去找。
    // 酒馆关弹窗时会 content.innerHTML='' 再 dlg.remove()(public/scripts/popup.js:523),
    // 那时候再 $('#...').val() 只会读到空,于是这个函数静默 return,表现就是"点了没反应"。
    // 留住引用的话,元素即使被摘下来,它自己的 value 还在。
    const container = document.createElement('div');
    container.className = 'zos_popup';

    const title = document.createElement('div');
    title.textContent = '把谁加进手机?';

    const select = document.createElement('select');
    select.className = 'text_pole';
    select.style.width = '100%';
    select.style.marginTop = '8px';

    for (const c of pool) {
        const option = document.createElement('option');
        option.value = c.avatar;
        option.textContent = c.name || c.avatar;
        select.appendChild(option);
    }

    const hint = document.createElement('div');
    hint.className = 'zos_hint';
    hint.style.marginTop = '6px';
    hint.textContent = '加进来之后可以单独改昵称、头像和线上人设,不会动你的角色卡。';

    container.append(title, select, hint);

    const ok = await callGenericPopup(container, POPUP_TYPE.CONFIRM, '', { okButton: '加进来', cancelButton: '算了' });
    if (!ok) return;

    const avatarKey = String(select.value || '');
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
        summaries: [],
    });

    await saveLocal();
    renderScreen();
}

async function onSaveContact() {
    const c = contactById(openChatId);
    if (!c) return;

    c.nick = String($('#zos_edit_nick').val() || '').trim();
    c.persona = String($('#zos_edit_persona').val() || '');

    // 摘要是可以手改的,保存时一并收回来
    $('.zos_sum_text').each(function () {
        const index = Number($(this).data('index'));
        if (c.summaries?.[index]) c.summaries[index].text = String($(this).val() || '');
    });

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

    // 同上:留住引用再读,别等弹窗关了去找
    const container = document.createElement('div');
    container.className = 'zos_popup';
    container.innerHTML = `把「${escapeHtml(c.nick || '')}」写进角色卡<b>${escapeHtml(here.card.name || '')}</b>?
        <div class="zos_hint" style="margin-top:6px"><b>这会改动你的角色卡文件。</b>
        写进去之后,别人拿到这张卡就自带这个联系人。</div>`;

    const label = document.createElement('label');
    label.className = 'checkbox_label';
    label.style.marginTop = '8px';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = Boolean(count);
    check.disabled = !count;

    const span = document.createElement('span');
    span.textContent = `连聊天记录一起写(现在有 ${count} 条)`;

    label.append(check, span);

    const tail = document.createElement('div');
    tail.className = 'zos_hint';
    tail.textContent = '带上记录的话,玩家一开局手机里就已经聊过这些。卡也会大一点。';

    container.append(label, tail);

    const ok = await callGenericPopup(container, POPUP_TYPE.CONFIRM, '', { okButton: '写进去', cancelButton: '算了' });
    if (!ok) return;

    const withMessages = check.checked;

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

/** 删一段摘要。**那一段覆盖的正文早就没了,删掉就是真忘了**,所以要问一句 */
async function onDeleteSummary(index) {
    const c = contactById(openChatId);
    if (!c?.summaries?.[index]) return;

    const ok = await callGenericPopup(
        `<div class="zos_popup">删掉这一段摘要?<br>
        <b>它覆盖的那些正文早就不在了</b>,删掉等于这段经历真的忘了,找不回来。</div>`,
        POPUP_TYPE.CONFIRM, '', { okButton: '删', cancelButton: '算了' });

    if (!ok) return;

    c.summaries.splice(index, 1);
    await saveWhere(c.id);
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

    // 每次开都重读一遍:常驻那份和收藏夹是全局的,别的标签页可能改过
    loadLocal();
    await Promise.all([loadGlobal(), loadFavorites()]);
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
 * 发消息
 *
 * 上下文由三段拼成,顺序固定:
 *   一、线上人设(短。**不该塞完整角色卡**:一次就回一两句,
 *       拿三千字描述去生成"哈哈你们在聊什么",既贵又不会更好)
 *   二、记忆(分层摘要,带模糊时间)
 *   三、最近的正文(带模糊时间)
 *
 * ⚠️ 所有时间**在这里才变成模糊词**,存进去的永远是绝对时间戳。
 * ========================================================================== */

/** 一次回复给多少 token。手机消息很短,给多了它就开始写小作文 */
const MAX_REPLY_TOKENS = 400;

/** 相邻两条时间说法一样就不重复标,不然满屏都是"刚刚" */
function renderRecent(messages, now) {
    let lastLabel = '';

    return messages.map(m => {
        const label = fuzzyAgo(m.t, now);
        const head = label && label !== lastLabel ? `[${label}] ` : '';
        if (label) lastLabel = label;

        return {
            role: m.from === 'me' ? 'user' : 'assistant',
            content: `${head}${String(m.text || '')}`,
        };
    });
}

/** 拼出要发出去的那一份 */
function buildPrompt(contact, count) {
    const now = Date.now();
    const nick = contact.nick || '对方';

    const memory = buildMemoryText(contact, (from, to) => fuzzyRange(from, to, now));

    const parts = [
        `你在扮演「${nick}」,正在用手机和对方聊天。`,
        '',
        '【你是谁】',
        contact.persona?.trim() || '(这一栏没填,按你在角色设定里本来的样子来。)',
    ];

    if (memory) {
        parts.push('', '【你们之前的经历】', memory);
    }

    parts.push(
        '',
        '【怎么回】',
        `这次回 ${count} 条消息。`,
        '每条用 <msg> 包起来,一条一个,像这样:',
        '<msg>在吗</msg>',
        '<msg>刚看到你消息</msg>',
        '',
        '像发消息一样说话,短句。',
        '不要写旁白、动作、心理描写,这是纯文字聊天。',
        '不要复述方括号里的时间,那只是给你参考用的。',
        '不要重复对方刚说过的话。',
        '对方可能一口气连发了好几条,把这几条连起来看,一起回。',
        '对方发来的 [表情] [图片] [礼物] [位置],就当你真的收到了、看到了。',
        '你想发的话也可以,写成 <msg>[表情] 捂脸笑</msg>、<msg>[图片] 窗外在下雨</msg> 这样,方括号里只能是 表情、图片、礼物、位置 四种,偶尔用,别每次都用。',
        '除了 <msg> 之外不要输出任何别的东西。');

    // 还没被摘要的正文**全部**带上:摘要要等攒过 keepRaw + batchSize 条才摘最老的一批,
    // 之前只带最近 keepRaw 条,中间那几十条既不在摘要里也不在正文里,等于失忆(道长 9/18 逮到的)
    const recent = contact.messages || [];

    return [
        { role: 'system', content: parts.join(LF) },
        ...renderRecent(recent, now),
    ];
}

/**
 * 用选中的那条连接跑一次生成。
 *
 * 两条来源两个走法:酒馆自己的连接配置走官方的 sendRequest(它认得各种源),
 * API 管理器那边固定是自定义源,直接走 ChatCompletionService。
 * **两条都是酒馆服务端发出去的**,公益站看到的就是酒馆。
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Promise<string>}
 */
async function runGeneration(messages, maxTokens = MAX_REPLY_TOKENS, connId = null) {
    const settings = getSettings();
    // 不传就用聊天那条。摘要会传自己那条进来
    const useId = connId === null ? settings.connId : connId;
    const conn = findConnection(useId);
    const model = conn ? currentModelOf(conn) : '';

    // 没选就用酒馆当前选中的那条,再没有就只能让她自己去挑
    const profileId = useId.startsWith('st:')
        ? useId.slice(3)
        : (useId ? '' : extension_settings.connectionManager?.selectedProfile || '');

    if (profileId) {
        const result = await ConnectionManagerRequestService.sendRequest(
            profileId, messages, maxTokens,
            // includePreset 关掉:**回一条微信不该扛整套预设**(状态栏、思维链、面具规则),
            // 那些跟聊天没关系,白烧 token
            { stream: false, extractData: true, includePreset: false, includeInstruct: false },
            model ? { model } : {});

        return String(result?.content || '').trim();
    }

    if (conn && useId.startsWith('acm:')) {
        if (conn.blocked) throw new Error(conn.blocked);

        const result = await getContext().ChatCompletionService.processRequest({
            stream: false,
            messages,
            max_tokens: maxTokens,
            model,
            chat_completion_source: 'custom',
            custom_url: conn.url,
            secret_id: conn.secretId,
        }, {}, true, null);

        return String(result?.content || '').trim();
    }

    throw new Error('还没选连接。去扩展设置里的织梦OS,挑一条「手机用哪个连接」。');
}

/**
 * 把模型回的东西拆成一条条消息。
 *
 * 先认 <msg> 标签:边界明确,模型自己排版换个行也不会多出一条,
 * 而且以后要加图片、语音、延迟,都有地方挂属性。
 *
 * **认不到标签就退回按换行切**:模型偶尔会忘了包标签,
 * 那时候宁可切得糙一点,也不能一条都出不来。
 */
function splitReply(text, limit) {
    const raw = String(text || '');
    const tagged = [...raw.matchAll(/<msg[^>]*>([\s\S]*?)<\/msg>/gi)].map(m => m[1]);

    const lines = (tagged.length ? tagged : raw.split(LF))
        // 模型有时会把参考用的时间标记也抄进来,去掉;[表情] [图片] 这类是消息种类,要留着
        .map(line => String(line).replace(/^\[(?!(?:表情|图片|礼物|位置)\])[^\]]*\]\s*/, '').trim())
        // 没包住的残标签也清掉
        .map(line => line.replace(/<\/?msg[^>]*>/gi, '').trim())
        .filter(Boolean);

    // 说好几条就几条,多的截掉。**提示词管不住的地方由代码兜底**
    return lines.slice(0, Math.max(1, limit || 5));
}

/** 在设定的范围里掷一个数 */
function pickReplyCount() {
    const settings = getSettings();
    const low = Math.max(1, Math.min(settings.replyMin, settings.replyMax));
    const high = Math.max(low, settings.replyMax);
    return low + Math.floor(Math.random() * (high - low + 1));
}

/** 打字要花时间,条数多就多给点 token,不然后面几条会被截断 */
function tokensFor(count) {
    return Math.max(300, count * 110);
}

/** 一条消息假装打了多久。按字数算,给个上下限,太快像机器太慢像卡住 */
function typingDelayFor(text) {
    return Math.min(2600, Math.max(450, String(text || '').length * 90));
}

function appendBubble(message, contact) {
    $('.zos_msgs .zos_empty').remove();
    $('.zos_msgs').append(renderBubble(message, contact || contactById(openChatId) || {}));
    scrollMessagesToEnd();
}

function scrollMessagesToEnd() {
    const box = document.querySelector('.zos_msgs');
    if (box) box.scrollTop = box.scrollHeight;
}

/** 正在等模型回的那个联系人。同一时间只跑一条生成 */
let sending = false;
/** 生成途中她又发了消息:这一轮回完再回一轮 */
let replyAgain = null;
/** 停手计时:她连发时每发一条就重新计时,停够 replyDelay 秒才让对方回 */
let replyTimer = null;

/**
 * 发送只负责把她这条放进去(道长 9/17:允许连发好几条之后 AI 再回,不要强制一问一答)。
 * 输入框空着点发送 = 不等了,让他马上回。
 */
async function onSend() {
    const contact = contactById(openChatId);
    const input = document.querySelector('.zos_input');
    const text = String(input?.value || '').trim();

    if (!contact) return;

    if (!text) {
        // 空着点发送:有她没回的消息就立刻让对方回
        const last = contact.messages?.[contact.messages.length - 1];
        if (last?.from === 'me') {
            clearTimeout(replyTimer);
            requestReply(contact.id);
        }
        return;
    }

    input.value = '';
    await pushMine(contact, text);
}

/** 把她发的一条(文字或者表情、图片这些)放进去、存盘、开始停手计时 */
async function pushMine(contact, text) {
    const chatKey = currentChatKey();
    if (!Array.isArray(contact.messages)) contact.messages = [];
    const message = { from: 'me', text, t: Date.now() };
    contact.messages.push(message);

    if (screen === 'chat_room' && openChatId === contact.id) appendBubble(message, contact);
    await saveContactFrom(contact, chatKey);
    refreshLink();

    scheduleReply(contact.id);
}

function scheduleReply(contactId) {
    clearTimeout(replyTimer);
    const delay = Math.max(0, Number(getSettings().replyDelay) || 0) * 1000;
    replyTimer = setTimeout(() => requestReply(contactId), delay);
}

/** 让对方回。正在回别的就记下来,回完再补一轮 */
async function requestReply(contactId) {
    if (sending) {
        replyAgain = contactId;
        return;
    }

    const contact = contactById(contactId);
    if (!contact) return;
    // 最后一条已经是对方说的,就没什么要回的
    if (contact.messages?.[contact.messages.length - 1]?.from !== 'me') return;

    sending = true;

    // 记下是在哪一局发的。等回复那几秒她可能切走,回复得回到这一局去
    const chatKey = currentChatKey();

    // 等回复时给个"正在输入",不然按下去像没反应
    if (screen === 'chat_room' && openChatId === contact.id) {
        $('.zos_msgs').append('<div class="zos_typing">正在输入...</div>');
        scrollMessagesToEnd();
    }

    const count = pickReplyCount();

    try {
        const reply = await runGeneration(buildPrompt(contact, count), tokensFor(count));
        const lines = splitReply(reply, count);

        if (!lines.length) throw new Error('模型返回了空的');

        $('.zos_typing').remove();
        await deliver(contact, lines, chatKey);

        // 存完再维护。**维护会动正文,所以必须在正文已经落盘之后**。
        // 切走了就不维护:正文还寄存着没落盘,这时候压缩等于拿没存的东西去删东西
        if (currentChatKey() === chatKey || isGlobal(contact.id)) await runMaintain(contact, chatKey);
        refreshLink();
    } catch (error) {
        $('.zos_typing').remove();
        if (screen === 'chat_room') renderScreen();
        await callGenericPopup(
            `<div class="zos_popup"><div class="zos_bad">对方没回上。</div>
            <div class="zos_hint">原话:</div>
            <div class="zos_reason">${escapeHtml(String(error?.message || error))}</div>
            <div class="zos_hint">你的消息已经存好了。输入框空着再点一次发送,就会重新让他回。</div></div>`,
            POPUP_TYPE.TEXT, '', { okButton: '知道了', wide: true });
    } finally {
        sending = false;
        // 回的途中她又发了:再回一轮
        if (replyAgain) {
            const next = replyAgain;
            replyAgain = null;
            scheduleReply(next);
        }
    }
}

/**
 * 把几条回复一条条送出来,像真人在打字。
 *
 * **每一条都当场落盘**,不是等全部演完再存:演到一半刷新页面、切聊天、关浏览器,
 * 已经冒出来的那几条都得留住,不能因为动画没播完就当没发生。
 */
async function deliver(contact, lines, chatKey) {
    const settings = getSettings();
    const animate = settings.typing;

    for (let i = 0; i < lines.length; i++) {
        const message = { from: 'them', text: lines[i], t: Date.now() };
        contact.messages.push(message);
        await saveContactFrom(contact, chatKey);

        // 她可能在演的过程中退出去了,那就别再往屏幕上画,数据已经存好了
        const stillHere = screen === 'chat_room' && openChatId === contact.id;

        if (!animate) continue;
        if (stillHere) appendBubble(message, contact);

        if (i < lines.length - 1) {
            if (stillHere) {
                $('.zos_msgs').append('<div class="zos_typing">正在输入...</div>');
                scrollMessagesToEnd();
            }

            await new Promise(resolve => setTimeout(resolve, typingDelayFor(lines[i + 1])));
            $('.zos_typing').remove();
        }
    }

    // 不管演没演、演到哪儿,最后都按数据重画一次,保证屏幕和存的东西一致
    if (screen === 'chat_room' && openChatId === contact.id) {
        renderScreen();
        scrollMessagesToEnd();
    }
}

/** 该摘要就摘要,该压缩就压缩。失败不吭声,下次再来,反正正文一条没丢 */
async function runMaintain(contact, chatKey) {
    const settings = getSettings();

    // 摘要和聊天用同一条连接(道长 9/18:不该让用户为了摘要再配一个 api)。
    // 管住它别编,靠的是换一套要求:要求放系统位,聊天记录放用户位,见 lib/rolling-summary.js
    const result = await maintain(
        contact,
        prompt => {
            const SEP = '\n\n---\n';
            const cut = prompt.indexOf(SEP);
            const messages = cut < 0
                ? [{ role: 'user', content: prompt }]
                : [{ role: 'system', content: prompt.slice(0, cut) }, { role: 'user', content: prompt.slice(cut + SEP.length) }];
            return runGeneration(messages, 600);
        },
        { ...settings.memory, meName: '我', themName: contact.nick || '对方' });

    if (result.error) {
        console.warn('[织梦OS]', result.did, result.error);
        return;
    }

    if (result.changed) {
        console.log('[织梦OS]', result.did);
        await saveContactFrom(contact, chatKey);
        renderScreen();
    }
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

/** 拉过的模型列表存在这台设备的 localStorage 里(几十个名字,不进 settings.json),下次打开设置页还在 */
const MODEL_CACHE_KEY = 'zhimengos-model-lists';

function readModelCache() {
    try {
        const data = JSON.parse(localStorage.getItem(MODEL_CACHE_KEY) || '{}');
        return data && typeof data === 'object' ? data : {};
    } catch {
        return {};
    }
}

function writeModelCache(connId, models) {
    try {
        localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify({ ...readModelCache(), [connId]: models }));
    } catch { /* 隐私模式之类的写不进去,下次再拉就是 */ }
}

function fillModelSelect(models, current) {
    const list = [...new Set([...(models || []), current].filter(Boolean))];
    if (!list.length) {
        $('#zos_model').html('<option value="">还没加载</option>').val('');
        return;
    }
    $('#zos_model').html(list.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join(''))
        .val(current && list.includes(current) ? current : '');
    $('#zos_model_count').text(models?.length ? `列表里有 ${models.length} 个模型` : '');
}

/**
 * 选中一条之后下面那块:地址、模型、以及不能用时的原因。
 * keepList = 只是换了个模型,下拉列表别动(9/17 的 bug:拉到几十个,选完一个列表只剩一个,就是这里每次都清空)
 */
function renderConnectionDetail(keepList = false) {
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

    if (keepList) return;
    // 换了连接:列表换成这一条自己拉过的那份,没拉过就只放当前模型
    fillModelSelect(readModelCache()[conn.id] || [], model);
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
        writeModelCache(conn.id, models);
        fillModelSelect(models, current);
        // 当前模型不在列表里才替她挑第一个
        if (!current || !models.includes(current)) $('#zos_model').val(models[0]).trigger('change');

        $('#zos_model_count').text(`拉到 ${models.length} 个模型,在上面下拉里选`);
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
    renderConnectionDetail(true);
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
    renderConnectionDetail(true);
    fillModelSelect(readModelCache()[conn.id] || [], currentModelOf(conn));
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

/** 把两个数说成人话:压完剩几条、最多带几条 */
function memoryExplain(mem) {
    const keep = Number(mem.keepRaw) || 0;
    const batch = Number(mem.batchSize) || 0;
    return `也就是说:原话最多带 ${keep + batch} 条,压完还剩最近的 ${keep} 条原话。数字越大,模型看到的原话越多,每次发得也越长。`;
}

/** 手机里的 ⚙️ 设置页(道长 9/17:API 设置整体挪进手机自己的设置里)。
 *  元素 id 沿用原来抽屉里的,事件都委托在 document 上,所以每次重画不用重绑 */
function renderSettings() {
    const settings = getSettings();
    return `
        <div class="zos_appbar">
            <div class="zos_back" data-to="home">‹</div>
            <div class="zos_appbar_title">设置</div>
            <div class="zos_appbar_right"></div>
        </div>
        <div class="zos_settings_page">
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
                <b>回复</b>
                <div class="zos_hint">一次回几条。<b>给模型的是范围里随机抽的一个具体数字</b>,
                    不是范围本身,因为给具体数字它更听话,而随机由我们掌握,效果一样。
                    它要是不听,多出来的条数会被截掉。</div>

                <div class="zos_field zos_range">
                    <span>一次回</span>
                    <input id="zos_reply_min" type="number" min="1" max="20" class="text_pole" value="${settings.replyMin}">
                    <span>到</span>
                    <input id="zos_reply_max" type="number" min="1" max="20" class="text_pole" value="${settings.replyMax}">
                    <span>条</span>
                </div>

                <label class="checkbox_label">
                    <input id="zos_typing" type="checkbox" ${settings.typing ? 'checked' : ''}>
                    <span>一条一条往外冒,像真人在打字</span>
                </label>
                <div class="zos_hint">关掉的话几条一起出来。<b>不管开不开,每条都是当场存好的</b>,
                    演到一半刷新或者切走都不会丢。</div>

                <label class="zos_field">
                    <span>停手几秒后对方才回</span>
                    <input id="zos_reply_delay" type="number" min="0" max="60" class="text_pole" value="${settings.replyDelay}">
                </label>
                <div class="zos_hint">可以一口气连发好几条,停手这么多秒他才回。填 0 就是发一条回一条。
                    输入框空着点「发送」= 不等了,让他马上回。</div>

                <hr>
                <b>线上线下联动</b>
                <label class="checkbox_label">
                    <input id="zos_link_main" type="checkbox" ${settings.linkMain ? 'checked' : ''}>
                    <span>手机里的聊天进主线上下文</span>
                </label>
                <div class="zos_hint">开着的话,主线每次生成都能看到这一局手机里聊过的<b>全部</b>:更早的摘要 + 还没摘要的原话,和手机自己记得的一模一样。
                    只带<b>这一局</b>的联系人;常驻联系人跨局共用,不进主线,免得串到别的故事里。</div>
                <hr>
                <b>记忆</b>
                <div class="zos_hint">聊天记录不会丢。原话攒多了,就把最老的一批压成一段摘要,
                    发给模型的永远是「全部摘要 + 全部还没压的原话」,前后接得上,不会失忆。</div>

                <div class="zos_field zos_range">
                    <span>原话攒到</span>
                    <input id="zos_raw_max" type="number" min="20" max="500" class="text_pole" value="${settings.memory.keepRaw + settings.memory.batchSize}">
                    <span>条时,把最老的</span>
                    <input id="zos_batch_size" type="number" min="10" max="490" class="text_pole" value="${settings.memory.batchSize}">
                    <span>条压成一段摘要</span>
                </div>
                <div id="zos_mem_explain" class="zos_hint">${memoryExplain(settings.memory)}</div>

                <div class="zos_field zos_range">
                    <span>摘要攒到</span>
                    <input id="zos_compact_after" type="number" min="3" max="40" class="text_pole" value="${settings.memory.compactAfter}">
                    <span>段时,把最老的几段再合成一段</span>
                </div>
                <div class="zos_hint">写摘要用的是上面那条聊天连接,不用另选。
                    写摘要时发的是另一套要求:只写聊天里真有的事,不许补、不许猜,所以同一个模型也写得老实。</div>

                <div class="zos_hint">摘要写歪了可以自己改:进某个联系人的设置,那里能看能改能删。</div>

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
        </div>`;
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
                <div class="zos_hint">连接、模型、回复条数、记忆这些设置都搬进手机里了:打开手机,点 ⚙️ 设置。</div>
            </div>
        </div>
    </div>`;

    $('#extensions_settings').append(html);

    $('#zos_open').on('click', () => togglePhone());
    $('#zos_self_check').on('click', () => checkSelfUpdate());

    // 界面上填的是「攒到多少条」和「压掉多少条」,存的还是 keepRaw(压完剩几条)和 batchSize
    $(document).on('input', '#zos_raw_max, #zos_batch_size, #zos_compact_after', function () {
        const mem = getSettings().memory;
        const max = Math.round(Number($('#zos_raw_max').val()));
        const batch = Math.round(Number($('#zos_batch_size').val()));
        const compact = Math.round(Number($('#zos_compact_after').val()));

        // 填一半的时候别把设置写坏,等她填完再说
        if (Number.isFinite(max) && Number.isFinite(batch) && batch >= 10 && max - batch >= 10) {
            mem.batchSize = batch;
            mem.keepRaw = max - batch;
        }
        if (Number.isFinite(compact) && compact >= 3) mem.compactAfter = compact;

        $('#zos_mem_explain').html(memoryExplain(mem));
        saveSettingsDebounced();
    });

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

    $(document).on('change', '#zos_conn', function () {
        getSettings().connId = String($(this).val() || '');
        saveSettingsDebounced();
        renderConnectionDetail();
        $('#zos_model_count').text('');
    });

    $(document).on('input', '#zos_reply_min, #zos_reply_max', function () {
        const key = this.id === 'zos_reply_min' ? 'replyMin' : 'replyMax';
        const value = Number($(this).val());

        // 填一半的时候别把设置写坏
        if (!Number.isFinite(value) || value <= 0) return;

        getSettings()[key] = Math.round(value);
        saveSettingsDebounced();
    });

    $(document).on('input', '#zos_typing', function () {
        getSettings().typing = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
    });


    $(document).on('change', '#zos_model', () => onPickModel());
    $(document).on('click', '#zos_load_models', () => onLoadModels());
    $(document).on('click', '#zos_add_profile', () => onAddProfile());

    $(document).on('keydown', '#zos_model_manual', function (event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            onTypeModel();
        }
    });

    $(document).on('input', '#zos_reply_delay', function () {
        const value = Number($(this).val());
        if (!Number.isFinite(value) || value < 0) return;
        getSettings().replyDelay = Math.min(60, Math.round(value));
        saveSettingsDebounced();
    });

    // 联动开关:关掉当场撤掉注入,不等下一轮
    $(document).on('input', '#zos_link_main', function () {
        getSettings().linkMain = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
        refreshLink();
    });

    // 「+」菜单
    $(document).on('click', '#zos_screen .zos_plus', () => $('.zos_plus_panel').toggleClass('zos_hidden'));
    $(document).on('click', '#zos_screen .zos_plus_item', function () { onPlusItem(String($(this).data('kind'))); });

    renderConnectionOptions();
}

jQuery(async () => {
    getSettings();
    renderPanel();
    applyBall();

    // 换聊天就换一部手机。切走时若手机开着,把它关掉,免得看着上一局的联系人
    // 从收藏夹跳过来的例外:那是在手机里点的,跳完要留在手机里看那一局
    eventSource.on(event_types.CHAT_CHANGED, () => {
        loadLocal();
        // 换了一局,主线上下文里的手机聊天也跟着换
        refreshLink();
        clearTimeout(replyTimer);
        if (jumping) return;
        if (!$('#zos_phone_wrap').hasClass('zos_hidden')) closePhone();
    });

    // 酒馆里改了聊天名,收藏夹跟着改,不然下次点就是"打不开"
    eventSource.on(event_types.CHAT_RENAMED, async ({ avatarId, groupId, oldFileName, newFileName }) => {
        const from = stripJsonl(oldFileName);
        const to = stripJsonl(newFileName);
        let changed = false;

        for (const f of favorites) {
            const sameOwner = groupId ? f.group === String(groupId) : f.avatar === avatarId;
            if (sameOwner && f.file === from) {
                f.file = to;
                changed = true;
            }
        }

        if (changed) await saveFavorites();
    });

    // 一键线下那条注入只该活一轮:生成结束或者被停掉都撤掉,防着 /trigger 半路出错没走到 finally
    const dropOffline = () => {
        mainGenerating = false;
        setExtensionPrompt(KEY_OFFLINE, '', extension_prompt_types.IN_CHAT, 0);
    };
    eventSource.on(event_types.GENERATION_STARTED, (_type, _opts, dryRun) => { if (!dryRun) mainGenerating = true; });
    eventSource.on(event_types.GENERATION_ENDED, dropOffline);
    eventSource.on(event_types.GENERATION_STOPPED, dropOffline);

    loadLocal();
    refreshLink();
    loadFavorites();

    if (!isConnectionManagerAvailable()) {
        console.warn('[织梦OS] 酒馆自带的连接管理器不可用,只能用 API 管理器里的配置或者跟主线走');
    }

    console.log(`[织梦OS] v${VERSION} 已加载。可用连接 ${listConnections().length} 条`);
});
