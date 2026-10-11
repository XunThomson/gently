# 插件示例与作者指南

本目录放**示例插件**与写作说明。它不属于应用运行时数据（运行时目录是
`<appData>/gently/plugins/`），只是给作者看的参考。

> **中立立场**（`docs/adr/0005-neutral-third-party.md`）：本项目不内置、不推荐、不预置任何第三方
> 音源入口。请只为你**有权访问**的内容编写插件；不要在本仓库提交指向侵权内容的插件。

## 一个插件就是一个 `.js` 文件

元数据写在文件**前 60 行**的行注释里：

```js
// @id my-source              // 必填：小写字母/数字/连字符，2~32 位
// @name 我的音源              // 必填
// @version 1.0.0             // 必填：语义化版本
// @author 你的名字            // 必填
// @description 一句话说明      // 可选
// @url https://example.com    // 可选：主页
// @tags 流行,华语             // 可选：逗号分隔（第一个会作为索引里的分组）
// @qualities hires,lossless,high,standard   // 可选，由高到低；缺省 standard
// @hosts api.example.com,cdn.example.com    // 可选：网络白名单（只允许 HTTPS，纯域名）
// @credentials apiKey:API Key:required       // 可选：需要用户提供的凭据
// @minCoreVersion 0.1.0      // 可选
```

## 函数（ABI）

| 函数 | 必选 | 说明 |
|---|---|---|
| `search(keyword, page)` | ✔ | 返回曲目数组 |
| `getMediaSource(track, quality)` | ✔ | 返回 `{url, headers?, quality?}`；**返回 `null` 表示该源不可播**，核心会自动回退到下一个候选 |
| `getTrackInfo(id)` / `getAlbumInfo(id)` / `getPlaylistInfo(id)` | ✘ | 详情 |
| `getLyric(id)` | ✘ | 歌词 |
| `getTopLists()` / `getTopList(id, page)` | ✘ | 榜单/分类 |
| `getRecommend()` | ✘ | 源侧推荐 |

函数可以写成 `function`、`async function` 或 `const x = async () => {}`——核心在运行时探测
（静态扫描只用于预览提示）。

## 沙箱给了什么

插件运行在**空白全局对象**上，只有这些能力，没有 `fs` / `process`：

- `fetch(url, options)`：**只允许 HTTPS，且域名必须命中 `@hosts`**；有超时与体积上限。
  它是同步宿主调用，但对外是 Promise，可以自由 `await`。
- `console.log/info/warn/error`：转发到核心日志（带插件 id）
- `storage.get/set/delete`：插件私有键值（卸载时清理）
- `credentials.get(key)`：读取用户填写的凭据（需声明 `@credentials` 与 `credentials` 权限）

超出白名单的域名 → `plugin.permission_denied`；抛错或超时 → `plugin.runtime_error`。
单次调用默认 8 秒、内存上限 64 MiB，死循环会被强制中断。

> 另有一条**默认关闭**的兼容轨道，用于 MusicFree / LX 生态的 CommonJS 插件（`module.exports` +
> 受限 `require`：只内置 `he` / `axios` / `dayjs` / `crypto-js` 子集，且域名策略更宽松）。
> 它只是为了让现成插件能跑，**推荐路径始终是上面这条自有 ABI**；细节见 `docs/adr/0006`。

## 发布前自测

```bash
# 校验单个文件（元数据、必选函数、@hosts 写法）
cargo run -p gently-core --bin plugin-tool -- check examples/plugins/gently-demo.js

# 由一个目录生成社区仓库索引 repository.json
cargo run -p gently-core --bin plugin-tool -- index ./plugins \
  --base-url https://example.com/plugins --name "我的音源仓库" --out repository.json
```

索引（`repository.json`）与 `*.js` 一起放在任意静态托管上即可分发；
用户把索引地址填进应用就能看到条目并一键安装（应用不预置任何地址）。

客户端会校验索引里的 `fileName`（必须是纯文件名）、`downloadUrl`（必须 HTTPS 且非内网）
与 `sha256`（有则校验），因此索引里的地址写错会被明确拒绝，而不是装上一个坏插件。
