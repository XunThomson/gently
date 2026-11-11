import {createBrowserRouter, Navigate, type RouteObject} from 'react-router'
import App from '../App'
import {normalizeMobileHomePath} from '../config/mobileNav'
import {RouterErrorPage} from '../components/ui/route-error'
import {readPersistedUi} from '../store/persist'
import {isMobilePlatform} from '../utils/platform'
import {appRoutes} from './meta'
import type {AppRoute} from './routes.types'

/**
 * 手机端「主页」：用户可以在设置页改（`ui.homePath`），默认搜索页。
 *
 * 根路由在**模块加载时**就要决定重定向目标（此时还没有 React 上下文，拿不到 store hook），
 * 所以直接读一次持久化偏好；非法路径统一归一化回默认值。
 */
function mobileHomePath(): string {
    return normalizeMobileHomePath(readPersistedUi().homePath)
}

export const router = createBrowserRouter([
    {
        path: '/',
        element: <App/>,
        /* lazy 分包加载失败会落到 Router 默认错误页（无主题，看起来像白屏）；
           这里换成应用自己的错误页（R139）。 */
        errorElement: <RouterErrorPage/>,
        children: [
            // 根路径重定向到默认页面，避免首屏空白。
            // 手机端 home 默认是搜索页（可在设置里改），桌面端仍是排行榜。
            {index: true, element: <Navigate to={isMobilePlatform() ? mobileHomePath() : '/ranking'} replace/>},
            ...toRouteObjects(appRoutes),
        ],
    },
])

function toRouteObjects(routes: AppRoute[]): RouteObject[] {
    return routes.map((r) => {
        const common = {
            element: r.element,
            lazy: r.lazy
                ? async () => ({Component: (await r.lazy!()).default})
                : undefined,
            children: r.children ? toRouteObjects(r.children) : undefined,
        }

        if (r.index) {
            return {index: true, ...common} as RouteObject
        }
        return {path: r.path, ...common} as RouteObject
    })
}
