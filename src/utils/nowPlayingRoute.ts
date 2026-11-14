/**
 * 歌词页路由的唯一字面量与「要不要新压一条历史」的判定。
 *
 * 单独成文件是为了让播放条、移动播放条、功能抽屉都引用同一份：
 * 已经在 `/now-playing` 时再 `navigate()` 只会往历史里塞重复项，
 * 用户得点同样多次「返回」才回得去（R141 真机 bug）。
 */
export const NOW_PLAYING_PATH = '/now-playing';

export function shouldOpenNowPlaying(pathname: string): boolean {
    return pathname !== NOW_PLAYING_PATH;
}
