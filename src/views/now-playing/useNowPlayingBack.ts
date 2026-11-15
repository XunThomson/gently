import {useCallback} from 'react';
import {useNavigate} from 'react-router';
import {normalizeMobileHomePath} from '../../config/mobileNav';
import {readPersistedUi} from '../../store/persist';
import {isMobilePlatform} from '../../utils/platform';

/**
 * 歌词页的返回：有应用内历史就退一步；直接打开本页（刷新 / 深链 / 路由恢复）时退回首页，
 * 不把用户丢出应用（`navigate(-1)` 在栈底等于关闭窗口）。
 *
 * **不要退回 `/`**（R145）：根路由会按「最近路由」快照恢复，而快照里正是
 * `/now-playing`，于是 `navigate('/')` 又被重定向回歌词页，看起来就是「退不出去」。
 * 因此栈底时直接去一个具体页面：手机用用户配置的主页，桌面回排行榜。
 */
export function useNowPlayingBack(): () => void {
    const navigate = useNavigate();
    return useCallback(() => {
        const idx =
            typeof window !== 'undefined'
                ? Number((window.history.state as {idx?: unknown} | null)?.idx ?? 0)
                : 0;
        if (idx > 0) {
            navigate(-1);
            return;
        }
        const fallback = isMobilePlatform()
            ? normalizeMobileHomePath(readPersistedUi().homePath)
            : '/ranking';
        navigate(fallback, {replace: true});
    }, [navigate]);
}

export default useNowPlayingBack;
