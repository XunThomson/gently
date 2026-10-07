/**
 * 音源插件清单（plugin.json）——插件与宿主之间的**唯一契约**。
 *
 * 安全约束：插件只以「清单 + 服务端签名」方式下发，**不接受客户端传入的可执行内容**；
 * 清单里声明的权限在加载时校验，超出权限的调用由宿主拒绝。
 */
import {z} from 'zod';
import {qualitySchema} from '../../contracts/primitives.js';

export const PLUGIN_MANIFEST_FILE = 'plugin.json';

export const pluginPermissionSchema = z.enum([
    'network',
    'filesystem:read',
    'filesystem:write',
    'credentials',
]);

export const pluginCredentialFieldSchema = z.object({
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{1,31}$/),
    label: z.string().min(1).max(60),
    required: z.boolean().default(false),
    /** 是否为敏感值（前端输入框掩码显示，服务端加密存储） */
    secret: z.boolean().default(true),
});

export const pluginManifestSchema = z.object({
    /** 插件 id：小写字母/数字/连字符，与曲目 id 前缀 `source:` 对应 */
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/, '插件 id 只允许小写字母、数字与连字符'),
    name: z.string().min(1).max(60),
    /** 语义化版本，用于更新检查与兼容判断 */
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    author: z.string().min(1).max(80),
    description: z.string().max(300).default(''),
    homepage: z.string().url().optional(),
    /** 内置插件不可卸载 */
    builtin: z.boolean().default(false),
    /** 入口文件（相对插件目录）；缺省表示纯声明式插件 */
    entry: z.string().optional(),
    /** 该源支持的音质档位，由高到低 */
    qualities: z.array(qualitySchema).min(1).default(['standard']),
    permissions: z.array(pluginPermissionSchema).default(['network']),
    credentials: z.array(pluginCredentialFieldSchema).default([]),
    /** 宿主最低版本要求，形如 1.0.0 */
    minHostVersion: z.string().optional(),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/** 已加载的插件：清单 + 所在目录 + 运行状态 */
export interface LoadedPlugin {
    manifest: PluginManifest;
    /** 插件目录绝对路径 */
    dir: string;
    /** 最近一次健康探测结果；未探测为 undefined */
    healthy?: boolean;
    /** 探测失败原因（用于 /v1/plugins 的提示） */
    healthDetail?: string;
}

/** 解析插件清单；失败时抛出带字段路径的说明，便于插件作者定位 */
export function parseManifest(raw: unknown, source: string): PluginManifest {
    const parsed = pluginManifestSchema.safeParse(raw);
    if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        throw new Error(`${source} 清单非法：${detail}`);
    }
    return parsed.data;
}
