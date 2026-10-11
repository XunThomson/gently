import type {PluginPermission} from '../../api';

/**
 * 权限 → i18n 键。
 *
 * 放在这里而不是某个组件的私有常量里：导入面板与订阅面板都要把「将获得什么能力」
 * 摆给用户看（同意是安装的硬门槛），两处必须用同一套措辞。
 */
export const PERMISSION_LABEL: Record<PluginPermission, string> = {
    network: 'page.plugin.permissionNetwork',
    credentials: 'page.plugin.permissionCredentials',
    'filesystem:read': 'page.plugin.permissionFilesystemRead',
    'filesystem:write': 'page.plugin.permissionFilesystemWrite',
};
