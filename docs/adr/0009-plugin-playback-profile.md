---
status: proposed
last_verified: 2026-10-25
owner: gently
scope: 插件播放失败语义、跨源回退与用户可见诊断（R86 设计稿）
token_budget: 900
tldr: 保持 `getMediaSource` 兼容，增加可选的 `unavailable` 原因；核心记录有界的播放尝试并通过新命令 `playback.explain` 暴露，不改变 `playback.resolve` 的 null 契约。跨源换源默认由用户触发，自动回退需显式设置。平台适配留在插件里，核心不写“每源适配表”。
---

# ADR 0009：插件播放失败要可解释，换源由用户触发

## 背景

R86 实测：同一首网易云歌曲在 MusicFree 能播，在 gently 的网易云测试插件上返回
`playback.no_source` 的界面结果。代码层面有三个不同问题，不能用一个“换源”掩盖：

1. **元数据错误**：候选 `qualities` 曾被写死为 `["standard"]`，而前端又直接用全局首选档位
   （默认 `high`）。只实现 standard 的插件会收到不支持的档位并返回 null。
   R86 已修：候选 qualities 来自清单，播放按源 `pickQuality`。
2. **平台限制**：随包网易云测试插件只走 `song/media/outer/url`；会员/版权受限曲目
   会回 HTML/404，插件主动拒绝。这是源站/账号限制，播放器无法绕过。
3. **没有诊断**：核心把插件的异常/`null` 都折叠成“没候选”，前端只能显示
   “无法播放”，无法区分会员、版权、地区、登录失效或网络超时。

## 决策（建议）

1. **ABI 向后兼容**：`getMediaSource(track, quality)` 继续返回
   `{url, headers?, quality?, mimeType?, expiresInSec?}` 或 `null`；新增**可选**字段：
   ```js
   {unavailable: {code: 'auth'|'membership'|'copyright'|'region'|'unknown', message?: string}}
   ```
   `null` 仍表示“该源没有可用地址”，老插件无需改。插件作者最清楚本站的限制，映射留在插件里；
   核心不新增“网易云/QQ 音乐适配表”。
2. **核心记录尝试**：`playback.resolve` 仍返回 `ResolvedMedia | null`（契约不变），
   但在内存里按 `ref + quality` 保存最近一次有界的 `attempts`
   （source / stage / code / message / elapsedMs；不存令牌与 URL 查询串，TTL 5 分钟、LRU）。
   新增只读命令 `playback.explain{ref, quality?}` 返回这份记录；失败后用户点“为什么”才读。
   这样不改变现有播放调用，也不把诊断数据写进 SQLite。
3. **候选来源分两类**：
   - 搜索结果自带 `candidates`，按顺序尝试；
   - 榜单/收藏/历史只有单源。新增用户动作 `catalog.alternatives{ref, title, artist, excludeSources?}`
     或复用现有 `catalog.search`，按标题 + 歌手找其它源；**只在用户点“换源”时调用**。
     自动换源默认关闭；以后可做设置项，但必须限制并发与总超时，不能一次失败打满所有源。
4. **界面**：失败状态显示“重试 / 换源 / 查看原因”。原因来自 `playback.explain`：
   会员、版权、地区、登录失效、插件异常、网络超时；没有记录就回退到“该源不可播”。
   “登录”只在插件声明了 `@oauth` / `@login` 时出现，打开插件页对应入口。
5. **插件页**展示 `manifest.qualities`、能力、兼容模式、最近一次失败（不含敏感信息）；
   作者用 `plugin-tool check` 就能看到清单是否声明了不真实的 qualities。

## 后果

- 正面：不破坏现有 73 条命令和社区插件；失败原因可验证；跨源行为有明确用户动作；
  平台差异由插件承担，核心保持中立（ADR-0005）。
- 代价：需要新增事件/命令或内存表与前端 UI；`getMediaSource` 返回原因需要插件作者配合，
  老插件只能得到“未知原因”。
- 风险：`attempts` 可能包含插件给出的上游文案，必须限制长度并过滤 URL/令牌；
  “换源”搜索会增加网络请求，必须由用户点击，并限制只搜一次、可取消。
- 未决：`unavailable` 是否进入 §5.2 的正式 ABI（需契约版本更新）；自动换源是否提供设置；
  `playback.explain` 的 attempts 生命周期是否跟随缓存清理。以上在实现前需用户确认。

## 不在本 ADR 范围

- 绕过会员/版权/地区限制；
- 让核心内置第三方地址或“每平台适配表”；
- 带 JS / 多文件的 Web 壁纸（见 R85 安全边界）；
- 性能预算与渲染优化（另立性能探针/设计）。
