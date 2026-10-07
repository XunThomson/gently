# 音源插件目录（声明式）

每个子目录放一个 `plugin.json`，宿主启动时扫描一次（`PLUGIN_DIR`，缺省相对 `server/` 的 `plugins/`）。

```
plugins/
├── README.md           本文件
└── <plugin-id>/        建议目录名 = 清单里的 id
    ├── plugin.json     **唯一契约**，必需
    └── ...             其它数据文件（图标、静态映射表等）
```

行为约定（实现见 `src/infra/plugins/registry.ts`）：

- 目录不存在 → 记一条日志后跳过，**不阻塞启动**；
- 子目录缺 `plugin.json` → 跳过并告警；
- 清单非法 → 该插件加载失败并记录字段级原因，**其它插件与服务不受影响**；
- `id` 重复 → 保留先加载的一个；
- 启动信息里的 `plugins` 数量 = 成功加载的插件数。

## plugin.json 字段

Schema 在 `src/infra/plugins/manifest.ts`（`pluginManifestSchema`），字段与约束如下：

| 字段 | 类型 | 必填 | 约束 / 缺省 |
|---|---|---|---|
| `id` | string | ✅ | `^[a-z0-9][a-z0-9-]{1,31}$`；与曲目 id 前缀 `source:` 对应 |
| `name` | string | ✅ | 1–60 字符 |
| `version` | string | ✅ | 语义化版本 `\d+\.\d+\.\d+(-prerelease)?` |
| `author` | string | ✅ | 1–80 字符 |
| `description` | string | | ≤300 字符，缺省 `""` |
| `homepage` | string(url) | | 可选 |
| `builtin` | boolean | | 缺省 `false`；内置插件不可卸载 |
| `entry` | string | | 入口文件（相对插件目录）；**缺省即纯声明式插件** |
| `qualities` | enum[] | | `standard` / `high` / `lossless` / `hires`，至少 1 个，缺省 `["standard"]`，**由高到低** |
| `permissions` | enum[] | | `network` / `filesystem:read` / `filesystem:write` / `credentials`，缺省 `["network"]` |
| `credentials` | object[] | | 缺省 `[]`；每项 `{key, label, required=false, secret=true}`，`key` 匹配 `^[a-zA-Z][a-zA-Z0-9_]{1,31}$`，`label` 1–60 |
| `minHostVersion` | string | | 宿主最低版本要求，形如 `1.0.0` |

最小示例：

```json
{
  "id": "example",
  "name": "示例音源",
  "version": "0.1.0",
  "author": "gently",
  "qualities": ["high", "standard"]
}
```

## 当前只支持声明式插件（重要）

- 宿主**只读清单**，不执行任何第三方代码。声明了 `entry` 的插件也能被扫描、出现在
  `GET /v1/plugins` 的列表里，但入口不会被加载——代码沙箱（isolated-vm / worker 隔离）
  在业务阶段才接入，接入点就是 `src/infra/plugins/registry.ts` 的 `loadEntryPoint()`，
  **当前实现直接抛错拒绝**。
- 为什么这么做：安全。插件是「清单 + 服务端签名」下发的数据，宿主**不接受客户端传入的可执行内容**；
  在没有沙箱之前宁可拒绝执行，也不要出现「看起来加载了插件、其实没有隔离」的隐患。
- 同理，`permissions` 与 `credentials` 目前只是**声明**：权限越界的调用由宿主拒绝、
  敏感凭据由服务端加密存储，这两条都随沙箱一并实现。
- `healthy` 字段由健康探测回写（`plugin-probe` 队列任务，未接入），当前列表里通常没有该字段。

## 排查清单

- 插件没出现在日志/列表里：先看清单是否非法（错误信息带字段路径），再看目录是否是 `PLUGIN_DIR` 的直接子目录；
- 改完清单不用改代码，重启进程即可（宿主启动时扫描；`load()` 可重复调用以支持后续热重载）。
