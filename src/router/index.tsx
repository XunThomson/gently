import {createBrowserRouter, Navigate, type RouteObject} from 'react-router'
import App from '../App'
import {appRoutes} from './meta'
import type {AppRoute} from './routes.types'

export const router = createBrowserRouter([
    {
        path: '/',
        element: <App/>,
        children: [
            // 根路径重定向到默认页面，避免首屏空白
            {index: true, element: <Navigate to="/ranking" replace/>},
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
