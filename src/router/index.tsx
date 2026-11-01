import {createBrowserRouter, Navigate, type RouteObject} from 'react-router'
import App from '../App'
import {MOBILE_HOME_PATH} from '../components/shell/mobile/nav'
import {isMobilePlatform} from '../utils/platform'
import {appRoutes} from './meta'
import type {AppRoute} from './routes.types'

export const router = createBrowserRouter([
    {
        path: '/',
        element: <App/>,
        children: [
            // 根路径重定向到默认页面，避免首屏空白。
            // 手机端 home 是搜索页（不做推荐与排行榜，2026-11-01 决定），桌面端仍是排行榜。
            {index: true, element: <Navigate to={isMobilePlatform() ? MOBILE_HOME_PATH : '/ranking'} replace/>},
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
