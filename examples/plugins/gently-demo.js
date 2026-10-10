// @id gently-demo
// @name 示例插件（不联网）
// @version 1.0.0
// @author gently
// @description 示例音源插件：演示 ABI 与沙箱用法，不访问任何网络，也不解析任何真实音源。
// @tags 示例,文档
// @qualities standard
// @url https://example.com/gently-demo

/**
 * gently 插件示例（单文件形态）。
 *
 * 这个文件的用途是**说明怎么写插件**，因此刻意保持最小：
 *  - 不声明 `@hosts`，所以拿不到网络权限，`fetch` 一调用就会被拒绝；
 *  - `getMediaSource` 返回 `null`，表示「这个源没有可播地址」——核心会据此回退到下一个候选，
 *    全部候选都返回 null 时前端退回模拟时钟；
 *  - 想让它真的能播，你需要自己拥有音频的内容与直链：加上 `@hosts 你的域名`，
 *    然后在 `getMediaSource` 里返回 `{url, headers?}`。
 *
 * 头部元数据（`// @key value`）必须是文件前 60 行内的行注释：
 *  必填：@id（小写字母/数字/连字符，2~32 位）、@name、@version（语义化版本）、@author
 *  可选：@description、@url、@tags（逗号分隔）、@qualities（standard|high|lossless|hires，由高到低）、
 *       @hosts（逗号分隔的纯域名，只允许 HTTPS）、@credentials（key:标签[:required][:secret]）、
 *       @minCoreVersion、@entry（目录包用）
 */

/** 一个固定的示例曲目列表：不联网，因此内容是写死的。 */
const CATALOG = [
    {id: 'gently-demo:1', title: '示例曲目 A', artist: '示例歌手', album: '示例专辑', durationSec: 210},
    {id: 'gently-demo:2', title: '示例曲目 B', artist: '示例歌手', album: '示例专辑', durationSec: 185},
    {id: 'gently-demo:3', title: '示例曲目 C', artist: '另一位歌手', album: '另一张专辑', durationSec: 240},
];

/** 把内部结构转成核心约定的曲目形状。 */
function toTrack(item) {
    return {
        id: item.id,
        title: item.title,
        artist: item.artist,
        album: item.album,
        duration: `${Math.floor(item.durationSec / 60)}:${String(item.durationSec % 60).padStart(2, '0')}`,
        durationSec: item.durationSec,
        source: 'gently-demo',
        gradient: 'linear-gradient(135deg, #334155, #64748b)',
        tags: ['示例'],
    };
}

/** 必选函数：搜索。可以写 `async`，核心会等待 Promise 落地。 */
async function search(keyword, page) {
    const needle = String(keyword || '').toLowerCase();
    const matched = needle
        ? CATALOG.filter((item) => `${item.title} ${item.artist} ${item.album}`.toLowerCase().includes(needle))
        : CATALOG;
    return matched.map(toTrack);
}

/** 必选函数：解析可播地址。示例插件不联网，因此永远返回 null（核心会回退到下一个候选）。 */
async function getMediaSource(track, quality) {
    console.log(`示例插件被要求解析 ${track.id}（${quality}），但示例不提供任何真实地址`);
    return null;
}

/** 可选函数：榜单分类树。 */
async function getTopLists() {
    return [{title: '示例分类', items: [{id: 'all', title: '全部'}]}];
}

/** 可选函数：某个分类的内容。 */
async function getTopList(id, page) {
    return {items: CATALOG.map(toTrack), hasMore: false};
}
