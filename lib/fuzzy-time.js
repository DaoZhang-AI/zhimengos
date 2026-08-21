/**
 * 时间模糊化
 *
 * 这个文件**不认识织梦OS,也不认识酒馆**,只吃时间戳吐字符串。
 * 记忆系统要用直接整个拿走。
 *
 * 为什么要有它(2026-08-18 道长):
 * **AI 很爱瞎说时间。四五天前的事它会说"昨天",哪怕你给了时间戳。**
 * 根因不是它记性差,是**你给了它数字,它就要做算术,而它不会做算术**。
 *
 * 所以解法不是让它算得更准,是**不给它数字**:喂进去之前就把时间换成模糊词,
 * 它连算的机会都没有。
 *
 * ⚠️ 两条规矩,都是踩出来的:
 *
 * 一、**别给"3天前",给"前几天"。** 模型会**字面复述**你给的词。
 *    你给"3天前"它就说"三天前",实际是 4.5 天就错了;
 *    你给"前几天"它说"前几天",**永远不会错**。模糊本身就是准确。
 *
 * 二、**模糊化只发生在喂给模型之前的最后一刻,存储永远存绝对时间戳。**
 *    (2026-08-18 道长指出的)摘要生成于"现在"但要活很久,
 *    今天烤进去的"前几天"三个月后还写着"前几天",那时它指的已经是三个月前。
 *    **把相对词固化下来 = 埋一个必然过期的东西。**
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 一个时刻离现在有多远,说成人话。
 *
 * 刻意**不给精确数字**,理由见文件头第一条。
 *
 * @param {number} then 那时候的时间戳
 * @param {number} [now] 现在,不传就取当下
 * @returns {string} 例如 '刚刚' '前几天' '大约一个月前'
 */
export function fuzzyAgo(then, now = Date.now()) {
    const gap = Number(now) - Number(then);

    // 时间戳缺失或者是未来,别硬编一个说法,交给调用方决定怎么显示
    if (!Number.isFinite(gap)) return '';
    if (gap < 0) return '刚刚';

    if (gap < 3 * MINUTE) return '刚刚';
    if (gap < HOUR) return '没多久之前';
    if (gap < 5 * HOUR) return '几个小时前';
    if (gap < DAY) return '今天早些时候';
    if (gap < 2 * DAY) return '昨天';
    if (gap < 6 * DAY) return '前几天';
    if (gap < 11 * DAY) return '大约一周前';
    if (gap < 20 * DAY) return '大半个月前';
    if (gap < 45 * DAY) return '大约一个月前';
    if (gap < 100 * DAY) return '两三个月前';
    if (gap < 200 * DAY) return '半年前';
    if (gap < 400 * DAY) return '快一年前';
    return '很久以前';
}

/**
 * 一段时间范围离现在有多远。给摘要用:它盖住的是一整段而不是一个点。
 *
 * 首尾落在同一个说法里就只说一个,不然说成"从…到…"。
 *
 * @param {number} from 这段的开头
 * @param {number} to 这段的结尾
 * @param {number} [now]
 * @returns {string}
 */
export function fuzzyRange(from, to, now = Date.now()) {
    const head = fuzzyAgo(from, now);
    const tail = fuzzyAgo(to, now);

    if (!head && !tail) return '';
    if (!head || !tail || head === tail) return head || tail;

    return `${head}到${tail}那段`;
}

/**
 * 界面上显示用的时间。
 *
 * **和模糊化是两回事,别混。** 用户看自己的手机时,真手机就是显示准确时间;
 * 模糊化只针对喂给模型的那一份。
 *
 * @param {number} ts
 * @param {number} [now]
 * @returns {string} 例如 '21:03' '昨天 21:03' '8月14日'
 */
export function displayTime(ts, now = Date.now()) {
    const time = Number(ts);
    if (!Number.isFinite(time)) return '';

    const date = new Date(time);
    const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

    // 按"今天/昨天"分,不按 24 小时分:23:50 发的消息第二天早上该显示"昨天"而不是"几小时前"
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    if (time >= startOfToday.getTime()) return clock;
    if (time >= startOfToday.getTime() - DAY) return `昨天 ${clock}`;

    const sameYear = date.getFullYear() === new Date(now).getFullYear();
    const day = `${date.getMonth() + 1}月${date.getDate()}日`;

    return sameYear ? day : `${date.getFullYear()}年${day}`;
}
