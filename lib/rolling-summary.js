/**
 * 分层摘要
 *
 * 这个文件**不认识织梦OS,也不认识酒馆**:不碰 DOM、不发请求、不读设置。
 * 要生成摘要时调用方传一个 generate 回调进来。记忆系统要用直接整个拿走。
 *
 * 结构是道长定的(2026-08-18):
 *   一、每积够一批正文就写一段摘要
 *   二、**永远留一窗正文不摘要**,最近的原话比摘要值钱
 *   三、摘要攒到一定条数再压一层
 *
 * 为什么不是"超了就挤掉最老的"(当班克最早提的那个方案,被她当场否掉):
 * **那就是失忆本身。** 拿一个失忆机制去解决失忆问题。
 * 这个项目存在的理由就是"解决上下线失忆",所以宁可多花一次生成,也不能丢。
 *
 * ⚠️ 三条硬规矩:
 *
 * 一、**摘要没拿到之前,正文一条都不许删。** 生成会失败、会被打断、会返回垃圾。
 *    次序永远是:先拿到 → 存下来 → 确认不空 → 才动正文。
 *
 * 二、**摘要文本里不写日期。** 时间范围记在 from/to 两个时间戳里,
 *    注入时现算成模糊词。理由见 fuzzy-time.js 头部第二条。
 *    这样二级压缩也干净:from 取最早、to 取最晚,不用去解析文本里的日期。
 *
 * 三、**摘要有固定关注点,不是流水账。** 该记的是关系变化和事实变更
 *    (他知道了什么、你们约定了什么、态度怎么变),不是"两人聊了天气"。
 */

/** @typedef {{ from: number, to: number, fromIndex: number, toIndex: number, text: string, level: number }} Summary */

export const DEFAULTS = {
    /** 永远保留这么多条正文不摘要。手机消息每条很短,留多点不贵,而原话比摘要值钱 */
    keepRaw: 40,
    /** 超出保留窗口后,一次摘掉这么多条 */
    batchSize: 60,
    /** 摘要攒到这么多条就压一层 */
    compactAfter: 8,
    /** 压的时候一次合并最老的这么多条 */
    compactBatch: 5,
};

const ASK_SUMMARY = [
    '下面是一段聊天记录。请把它压缩成一小段摘要。',
    '',
    '只记这几样:',
    '1. 关系和态度的变化(谁对谁的态度变了、为什么)',
    '2. 事实变更(谁知道了什么、谁做了什么决定)',
    '3. 约定和承诺(说好要做什么)',
    '',
    '不要记:寒暄、重复的话、没有后果的闲聊。',
    '',
    '**不要写任何具体日期或者"几天前"这类说法。**',
    '段落内部要说先后的话,用"起初""后来"这种词。',
    '',
    '直接给摘要正文,不要标题,不要解释,不要用列表符号。',
].join('\n');

const ASK_COMPACT = [
    '下面是几段按时间先后排列的摘要。请把它们合并成一段更短的。',
    '',
    '保留:关系怎么一步步变到现在、还没了结的事、约定和承诺。',
    '丢掉:已经被后面推翻的、已经了结且没有后续影响的。',
    '',
    '**不要写任何具体日期或者"几天前"这类说法。**',
    '',
    '直接给合并后的正文,不要标题,不要解释。',
].join('\n');

/**
 * 把一批消息渲染成喂给模型的文本。
 *
 * 这里**故意不带时间**:摘要不该写日期,时间由外面的 from/to 负责。
 *
 * @param {Array<{from: string, text: string}>} messages
 * @param {string} meName 用户在这段对话里叫什么
 * @param {string} themName 对方叫什么
 */
function renderForSummary(messages, meName, themName) {
    return messages
        .map(m => `${m.from === 'me' ? meName : themName}:${String(m.text || '').trim()}`)
        .filter(line => line.length > meName.length + 1)
        .join('\n');
}

/**
 * 该不该写一段新摘要。
 * @param {{messages: Array, summaries: Array}} store
 * @param {typeof DEFAULTS} opts
 */
function needsSummary(store, opts) {
    return store.messages.length > opts.keepRaw + opts.batchSize;
}

/**
 * 该不该压一层。
 * @param {{messages: Array, summaries: Array}} store
 * @param {typeof DEFAULTS} opts
 */
function needsCompact(store, opts) {
    return store.summaries.length > opts.compactAfter;
}

/**
 * 维护一次:该摘要就摘要,该压缩就压缩。
 *
 * 每次只做一步,不在一次调用里连着做好几轮。理由是每一步都要花一次生成,
 * 连着做会在用户发一条消息之后卡很久。慢慢追上就行。
 *
 * @param {{messages: Array, summaries: Summary[]}} store 会被就地修改
 * @param {(prompt: string) => Promise<string>} generate 拿提示词换一段文本
 * @param {object} [options]
 * @param {string} [options.meName]
 * @param {string} [options.themName]
 * @returns {Promise<{changed: boolean, did: string, error?: string}>}
 */
export async function maintain(store, generate, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const meName = options.meName || '我';
    const themName = options.themName || '对方';

    if (!store || !Array.isArray(store.messages)) {
        return { changed: false, did: '没有可维护的数据' };
    }

    if (!Array.isArray(store.summaries)) store.summaries = [];

    if (needsSummary(store, opts)) {
        const batch = store.messages.slice(0, opts.batchSize);
        const body = renderForSummary(batch, meName, themName);

        if (!body.trim()) {
            // 这一批全是空消息,没什么可摘的,直接扔掉不算失败
            store.messages.splice(0, opts.batchSize);
            return { changed: true, did: '丢掉了一批空消息' };
        }

        let text = '';
        try {
            text = String(await generate(`${ASK_SUMMARY}\n\n---\n${body}`) || '').trim();
        } catch (error) {
            return { changed: false, did: '写摘要失败', error: String(error?.message || error) };
        }

        // ⚠️ 拿到东西才动正文。空的就原样退出,正文一条不少,下次再试
        if (!text) {
            return { changed: false, did: '写摘要失败', error: '模型返回了空的' };
        }

        store.summaries.push({
            from: Number(batch[0]?.t) || 0,
            to: Number(batch[batch.length - 1]?.t) || 0,
            fromIndex: 0,
            toIndex: opts.batchSize - 1,
            text,
            level: 1,
        });

        store.messages.splice(0, opts.batchSize);
        return { changed: true, did: `把最老的 ${opts.batchSize} 条写成了一段摘要` };
    }

    if (needsCompact(store, opts)) {
        const batch = store.summaries.slice(0, opts.compactBatch);
        const body = batch.map((s, i) => `第${i + 1}段:${s.text}`).join('\n\n');

        let text = '';
        try {
            text = String(await generate(`${ASK_COMPACT}\n\n---\n${body}`) || '').trim();
        } catch (error) {
            return { changed: false, did: '压缩摘要失败', error: String(error?.message || error) };
        }

        if (!text) {
            return { changed: false, did: '压缩摘要失败', error: '模型返回了空的' };
        }

        // from 取最早、to 取最晚。**因为摘要里没写日期,这一步才做得干净**
        store.summaries.splice(0, opts.compactBatch, {
            from: Math.min(...batch.map(s => Number(s.from) || Infinity)),
            to: Math.max(...batch.map(s => Number(s.to) || 0)),
            fromIndex: batch[0]?.fromIndex ?? 0,
            toIndex: batch[batch.length - 1]?.toIndex ?? 0,
            text,
            level: Math.max(...batch.map(s => Number(s.level) || 1)) + 1,
        });

        return { changed: true, did: `把最老的 ${opts.compactBatch} 段摘要压成了一段` };
    }

    return { changed: false, did: '还不用动' };
}

/**
 * 拼出要注入的那段记忆文本。
 *
 * **时间怎么说由调用方传进来**,这个文件不认识 fuzzy-time,两边互不依赖。
 *
 * @param {{messages: Array, summaries: Summary[]}} store
 * @param {(from: number, to: number) => string} formatRange 把一段时间范围说成人话
 * @returns {string} 没有任何摘要时返回空串
 */
export function buildMemoryText(store, formatRange) {
    const summaries = Array.isArray(store?.summaries) ? store.summaries : [];
    if (!summaries.length) return '';

    return summaries
        .map(s => {
            const when = formatRange ? formatRange(s.from, s.to) : '';
            return when ? `[${when}]\n${s.text}` : s.text;
        })
        .join('\n\n');
}

/**
 * 现在的状态,给界面显示用。
 * @param {{messages: Array, summaries: Summary[]}} store
 * @param {object} [options]
 */
export function describe(store, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const messages = Array.isArray(store?.messages) ? store.messages : [];
    const summaries = Array.isArray(store?.summaries) ? store.summaries : [];

    return {
        rawCount: messages.length,
        summaryCount: summaries.length,
        untilSummary: Math.max(0, opts.keepRaw + opts.batchSize + 1 - messages.length),
        untilCompact: Math.max(0, opts.compactAfter + 1 - summaries.length),
    };
}
