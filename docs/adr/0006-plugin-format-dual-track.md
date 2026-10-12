---
status: accepted
last_verified: 2026-10-10
owner: gently
scope: 插件格式双轨制与兼容模式的权限边界
token_budget: 1100
tldr: 自有单文件 ABI 为主；另设**默认关闭**的兼容模式，用于 MusicFree / LX 生态的 CommonJS 插件（require + module.exports）。兼容模式下允许访问任意公网 HTTPS 域名（本机/内网在任何模式下都拒绝），实际访问的域名记入观测台账，用户确认后固化为 `hosts` 白名单并关闭兼容模式（TOFU 收敛）；界面必须明示「权限弱于自有 ABI」并要求显式同意。
---

# ADR 0006：插件格式双轨制与兼容模式

## 背景

ADR-0005 定了「不内置任何第三方入口」，但没定**插件格式归谁**。当时的假设是
「单文件 `.js` + 头部注释元数据 + 9 个顶层函数」。

用真实样本校验后该假设被证伪：社区插件（MusicFree / LX 生态）实际是
**CommonJS 模块 + npm 依赖**：

```js
module.exports = {platform, version, name, srcUrl, primaryKey, hints, search, getMediaSource, ...}
require("axios"); require("crypto-js"); require("dayjs"); require("he");
```

- 它们**没有域名声明**（直接请求 `api.bilibili.com` 这类地址）；
- 搜索返回 `{isEnd, data:[...]}` 而非裸数组；
- 大量依赖 axios（HTTP + `params`/`headers`）、crypto-js（签名，如 B 站 WBI）、dayjs、he。

结论：**坚持自有 ABI 就等于放弃现成生态；直接兼容就等于放弃权限声明的安全模型。**
两者都不该默认成立，因此采用双轨制。

## 决策

1. **自有 ABI 是默认与推荐路径**：单文件、头部注释、`@hosts` 声明式白名单、9 个顶层函数。
   文档与示例只推这一条（`examples/plugins/`），工具链（`plugin-tool`）也只校验它。
2. **兼容模式默认关闭**，由用户在导入时显式开启（`@compat` 标记 / 导入参数）。
3. **兼容模式的权限边界**（本 ADR 的核心）：
   - 允许访问**任意公网 HTTPS** 域名（这类插件无法声明白名单）；
   - **本机 / 回环 / 链路本地 / 私有网段在任何模式下都拒绝** —— 兼容模式放宽的是
     「哪些公网域名」，**不是「能不能打本机」**（SSRF 防线不退让，有测试锁定）；
   - 实际访问的域名记入**观测台账**（`plugins/.hosts/<id>.json`，卸载即清）；用户确认后以
     `plugin.compat.confirm` 把用到的域名固化为 `hosts` 白名单并关闭兼容模式（TOFU）——
     这是兼容模式走向「可收窄」的路径（已实现，见下）。
4. **界面必须说清代价**：兼容模式插件在预览与安装时要明确提示「可访问任意公网域名，
   权限弱于自有 ABI」，并沿用既有的显式同意闸门（`consent: true`）。
5. **不做任意模块解析**：`require` 只内置一份**固定、可审计**的模块清单
   （当前：`he` / `axios`（→ 我们的 `fetch`）/ `dayjs` / `crypto-js`（MD5 + SHA256），后三者都是子集）。
   清单之外的 `require` 立即抛出可执行错误，说明缺哪个模块、清单里有什么、该怎么移植。

## 已完成（截至本 ADR）

- 沙箱注入最小 CommonJS 环境（`module` / `exports` / 受限 `require`）；
- 能力探测同时支持顶层声明与 `module.exports`（两种写法都能识别）；
- `plugin::probe`：只读地跑一遍模块，读出 `module.exports` 的元数据与真实能力
  （兼容插件没有头部注释，元数据只能从导出对象拿）；探测期白名单为空，插件无法出网；
- `@compat` 标记 + 上述域名策略；`@compat` 会推导出 `network` 权限
  （否则插件会在权限闸门被拒，兼容模式形同虚设）；
- 缺依赖错误可读：QuickJS 异常文本穿不过 rquickjs 的 `Display`，
  因此 bootstrap 把「哪个模块不可用 + 怎么移植」写进全局槽位，宿主读出补进错误信息。
- **`require` 垫片**（沙箱 JS 拆到 `core/src/plugin/sandbox/`，用 `include_str!` 编进二进制）：
  - `axios` 子集：`params` / `headers` / `data` / `validateStatus` / 请求与响应拦截器，
    返回 axios 形状 `{data, status, statusText, headers, config}`；请求**全部**走宿主 `fetch`，
    因此白名单、兼容模式域名策略与「不打本机」在垫片下一律照旧（有测试锁定）；
  - `dayjs` 子集：解析（纯日期按本地时区）、`format`（常用 token + `[...]` 转义）、
    不可变的 `year()`…`millisecond()`、`add`/`subtract`/`startOf`/`endOf`/`diff`/比较；
    `extend` 与 `dayjs/plugin/*` 显式报错（宁可失败，也不静默算错时区）；
  - `crypto-js` 子集：`MD5` / `SHA256` + `WordArray` 基础 + `Hex`/`Base64`/`Utf8`/`Latin1` 编码；
    **摘要由宿主算**（`sha2` / `md-5`，新增了一个与 sha2 同族的依赖），JS 只做编码与形状——
    密码学实现只有一份；子集外的算法（AES / SHA1 / Hmac* …）抛可执行错误；
  - `he` 子集：`decode` / `encode`。
- **返回形状适配**（`plugin::shape::list_items`）：兼容插件按社区协议返回包裹形状，
  统一在这里拆开——裸数组 / `{items}`（自有 ABI）、`{isEnd?, data}`（搜索、歌手作品、推荐歌单、评论）、
  `{isEnd?, musicList}`（专辑、歌单、排行榜详情）。**不猜**未在协议里出现的键名（`list`、`result` 等）；
  形状不认识就丢弃并计数，由 UI 体现。条目字段同样按协议放宽：MusicFree 的 `duration`
  是**数字秒**（自有 ABI 是 `durationSec` / `"3:05"`），三种写法都认，认不出就是 0（不猜时长）。
- **函数名与参数形状适配**（R53 补齐第三处，前两处在 R17）：
  - 别名：MusicFree 的 `getMusicInfo` / `getMusicSheetInfo` / `getTopListDetail`
    映射到自有 ABI 的 `getTrackInfo` / `getPlaylistInfo` / `getTopList`（自有名优先）；
  - **参数形状**：MusicFree 的详情/播放函数收的是**条目对象**，我们手上只有 `source:rawId`。
    核心在归一化时把插件**原始条目**记进**进程内**快照（LRU、不落盘、不上报），
    对兼容插件把这份条目原样交回（`getAlbumInfo` / `getMusicSheetInfo` / `getMusicInfo` /
    `getTopListDetail` / `getLyric` / `getMediaSource`），没有快照时退化成 `{id}`；
    沙箱侧再把字符串 `id` 包成 `{id}` 兜一层。**自有 ABI 一律仍收字符串 id**（有单测锁定）。
    两个实测症状：`getTopListDetail(topListItem)` 拿到字符串 → URL 拼成
    `.../x/web-interface/undefined` → 上游 404；`getMediaSource(musicItem)` 拿不到
    `bvid`/`aid`/`cid` → 拼出 undefined → 「能搜、能看榜单，一播就 plugin.runtime_error」。
- **流程接线**（`plugin::compat`）：`plugin.preview` / `plugin.import` 都接受 `compat: true`
  （用户显式开启；与头部 `@compat` 并存），头部元数据不全时用 `probe` 只读执行一次源码，
  从 `module.exports` 合成清单：
  - `id = compat-<sha256(platform) 前 8 位>`：同一插件升级后 id 不变；没有 `platform` 时退化为
    内容摘要并警告「更新会被视为另一个插件」；
  - 非语义化版本降级为 `0.0.0`、缺作者记「未声明」、权限恒含 `network`、`hosts` 留空、
    能力以运行时探测为准；`srcUrl` 当主页记录（我们**不自动更新**）；
  - 探测期没有出网通道：顶层就发请求的插件会明确报「探测期不能出网」，而不是含糊的失败；
  - 预览/已安装列表都带 `compat` 标记，界面据此在同意前与列表里都提示权限弱化
    （文案走 i18n），不能把兼容插件呈现为与自有 ABI 同等安全。
- **TOFU 收敛**（`plugin::hosts` + `plugin.compat.observed` / `plugin.compat.confirm`）：
  - 沙箱在**放行**兼容请求时把域名记进观测台账（内存 + `plugins/.hosts/<id>.json`，
    只在出现新域名时落盘，卸载即清）；探测期不记——那时的请求本来就会被拒；
  - `plugin.compat.confirm` 把观测到的域名固化成 `hosts` 白名单并**关闭兼容模式**
    （兼容分支先于白名单，光写白名单不关兼容模式等于没写），随后卸载运行时，
    下次使用按新清单重新加载（改权限的命令不顺手执行插件代码）；
  - 白名单**只能来自观测结果**（未观测到的域名一律拒绝），且必须 `consent: true`——
    否则这个命令就成了提权入口；收敛是**收窄**动作，要恢复兼容模式只能重新导入；
  - 界面在已安装列表给出「收敛权限」入口，二次确认里列出将要固化的域名。

- **沙箱 `env` 与用户变量**（R16 完成）：
  - `module.exports.userVariables`（MusicFree 的变量**声明**数组）在合成清单时转成**凭据字段**，
    同时补上 `credentials` 权限——声明了变量却读不到值就没有意义；
  - 沙箱里提供 `env.getUserVariables()` / `env.userVariables`（两者返回同一份
    `Record<string, string>`，**空的时候是 `{}` 而不是 undefined**：插件常写
    `const {cookie} = env.getUserVariables()`，返回 undefined 会直接抛错）、
    `env.os` / `env.appVersion` / `env.lang`，以及 `process{platform, version, env}`；
  - **只回清单声明过的键**，且只在有 `credentials` 权限时回值（与 `credentials.get` 同一道门）；
    实现上是宿主函数 `__hostUserVariables`，bootstrap 包成对象后**删除原始入口**；
  - `env.os` 如实报告当前桌面平台，不假装成 `android`——插件若因此拒绝运行，
    用户看到的提示才是真的原因。

## 待完成

（无。ADR-0006 的待完成清单已清空：`require` 垫片、返回形状适配、流程接线、TOFU 收敛、
`env.getUserVariables()` 均已落地；剩余的 OS keyring 与原生文件选择器属于**依赖缓存**问题，
不是本 ADR 的设计缺口。）

## 后果

- 正面：生态可用性与安全边界都摆在明面上；自有 ABI 的严格模型不被稀释；
  SSRF 与「不打本机」这类硬约束对两种格式一视同仁。
- 代价：两套路径意味着**双份测试与文档**；垫片需要长期跟进（crypto-js 覆盖面尤其）。
- 风险：兼容插件的权限事实上是「任意公网 HTTPS」，比自有 ABI 弱得多——
  因此**不能**在 UI 上把两者呈现为同等安全，也不能把兼容插件标为推荐。
