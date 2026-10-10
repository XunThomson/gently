---
status: accepted
last_verified: 2026-10-10
owner: gently
scope: 插件格式双轨制与兼容模式的权限边界
token_budget: 1100
tldr: 自有单文件 ABI 为主；另设**默认关闭**的兼容模式，用于 MusicFree / LX 生态的 CommonJS 插件（require + module.exports）。兼容模式下允许访问任意公网 HTTPS 域名（本机/内网在任何模式下都拒绝），实际访问的域名记入日志作为后续白名单固化的依据；界面必须明示「权限弱于自有 ABI」并要求显式同意。
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
   - 实际访问的域名**记入日志**；后续以「把用到的域名固化为白名单」的确认流程收敛权限
     （首次访问确认 / TOFU），这是兼容模式走向「可收窄」的路径。
4. **界面必须说清代价**：兼容模式插件在预览与安装时要明确提示「可访问任意公网域名，
   权限弱于自有 ABI」，并沿用既有的显式同意闸门（`consent: true`）。
5. **不做任意模块解析**：`require` 只内置一份**固定、可审计**的模块清单
   （当前：`he`；计划：axios 子集 → 我们的 `fetch`、dayjs 子集、crypto-js 子集）。
   清单之外的 `require` 立即抛出可执行错误，说明缺哪个模块、该怎么移植。

## 已完成（截至本 ADR）

- 沙箱注入最小 CommonJS 环境（`module` / `exports` / 受限 `require`）；
- 能力探测同时支持顶层声明与 `module.exports`（两种写法都能识别）；
- `plugin::probe`：只读地跑一遍模块，读出 `module.exports` 的元数据与真实能力
  （兼容插件没有头部注释，元数据只能从导出对象拿）；探测期白名单为空，插件无法出网；
- `@compat` 标记 + 上述域名策略；`@compat` 会推导出 `network` 权限
  （否则插件会在权限闸门被拒，兼容模式形同虚设）；
- 缺依赖错误可读：QuickJS 异常文本穿不过 rquickjs 的 `Display`，
  因此 bootstrap 把「哪个模块不可用 + 怎么移植」写进全局槽位，宿主读出补进错误信息。

## 待完成

1. **`require` 垫片**：axios 子集（→ 我们的 `fetch`，含 `params`/`headers` 与
   `{data, status, headers}` 形状）、dayjs 子集、crypto-js 子集（B 站 WBI 需要 MD5 + SHA256；
   SHA256 可走已有的 `sha2`，MD5 需要新依赖或内置实现）；
2. **返回形状适配**：`{isEnd, data}` → 归一化（当前只认 `[...]` / `{items:[...]}`）；
3. **流程接线**：把兼容开关接进 `plugin.preview` / `plugin.import`
   （无头部注释时用 `probe` 合成清单），并在界面上明示权限弱化；
4. **TOFU 收敛**：基于已记录的域名，让用户一次性确认后固化进 `hosts` 白名单。

## 后果

- 正面：生态可用性与安全边界都摆在明面上；自有 ABI 的严格模型不被稀释；
  SSRF 与「不打本机」这类硬约束对两种格式一视同仁。
- 代价：两套路径意味着**双份测试与文档**；垫片需要长期跟进（crypto-js 覆盖面尤其）。
- 风险：兼容插件的权限事实上是「任意公网 HTTPS」，比自有 ABI 弱得多——
  因此**不能**在 UI 上把两者呈现为同等安全，也不能把兼容插件标为推荐。
