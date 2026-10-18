---
status: proposed
last_verified: 2026-10-18
owner: gently
scope: 1.x 功能收口与 2.x 桌面宠物接口预留
token_budget: 900
tldr: 0.x 是开发线，**1.0.0 等剩余功能项落地后再发布**（是否提前提号待拍板）；1.x 只做完善与兼容修复，2.0 才引入桌面宠物。宠物是**纯本地、只读**的 UI 扩展：`src/pet/` 定义 `PetDefinition`（mount/dispose）与 `PetContext`（播放快照 + 订阅），`PetHost` 挂在外壳里、无宠物时渲染 null；不联网、不上报、不读写用户文件，不提供宠物商店或服务器。
---

# ADR 0007：1.x 版本收口与 2.x 桌面宠物接口

## 背景

目标里写了两条产品规划：

1. **1.x.x 内完善所有功能**，后续版本再根据反馈优化扩展；
2. **2.x.x 开始引入 pet 元素**，现在就要**预留接口**，避免以后大改。

当前版本是 `0.1.0`，1.x 的待完成项还有：下载逻辑收尾、OAuth2 第三方授权（B 站收藏夹优先）、
主题控制面板（待拍板）。宠物作为一个**会长期演进、且与播放状态耦合**的桌面元素，
如果等到 2.x 再从零设计接口，容易把「读播放状态」「生命周期」「可交互区域」做进错误的位置。

## 决策

### 1. 版本线

| 版本 | 含义 | 进入条件 |
|---|---|---|
| `0.x` | 开发线：功能仍在补齐与实测 | 当前阶段 |
| `1.0.0` | 第一个「功能齐全」的稳定版 | 待完成项 1–6 落地、7 拍板后实现或明确不做；`pnpm verify` 全绿；打包版逐条实测 |
| `1.x.y` | 只做完善、兼容与修复 | 1.0.0 之后；不引入破坏性契约变更 |
| `2.0.0` | 引入桌面宠物 | 宠物接口在本 ADR 约束下落地；1.x 的契约保持兼容 |

**是否现在把 `package.json` / `tauri.conf.json` 的版本号提前提到 `1.0.0`：待拍板。**
在拍板前保持 `0.1.0`，不提前发布「稳定版」的承诺；版本号只影响展示与打包文件名，
不改任何行为。

### 2. 2.x 宠物的接口（现在就留）

代码位置：`src/pet/`（当前**没有任何内置宠物**）。

```ts
interface PetDefinition {
  id: string;            // 稳定 id（同 id 覆盖）
  name: string;
  version: string;
  mount(container: HTMLElement, context: PetContext): PetInstance;
}
interface PetInstance { dispose(): void; }

interface PetContext {
  getPlayback(): PetPlaybackSnapshot;                              // 只读快照
  subscribePlayback(listener: (s: PetPlaybackSnapshot) => void): () => void;
}
```

快照只含：当前曲目的 `id/title/artist/album/artwork`、`playing`、`elapsed`、`duration`、
当前歌词行（`text/translation/next`）、当前主题 `theme`。**不暴露队列、音源内部状态或 action**——
宠物是装饰性扩展，不能改变播放行为。

宿主 `PetHost` 挂在应用外壳里：无宠物时渲染 `null`（零成本）；有宠物时给一个覆盖窗口、
默认 `pointer-events: none` 的容器，宠物自己决定哪些元素可交互；单个宠物 `mount` 抛错只跳过它，
不影响应用。注册表（`registerPet` / `listPets` / `subscribePets`）支持运行期增删。

### 3. 2.x 宠物的边界（现在写死，避免以后重议）

- **纯本地**：不联网、不上报、不读写用户文件；需要外部能力时必须走既有 `services/**` 门面，
  且由用户动作触发（与 ADR-0005 一致）。
- **无宠物商店/市场**：不提供服务器、账号或在线分发；宠物实现只能随应用内置或由用户主动导入文件。
- **只读播放状态**：宠物不能暂停/切歌/改音量；需要交互时由应用自己提供入口。
- **性能**：无宠物零成本；有宠物时宿主不轮询，靠 store 订阅；2.x 实现必须对高频进度更新做节流，
  并在窗口隐藏时暂停动画（预算：宠物的持续 CPU 不得影响播放与滚动）。
- **安全**：2.x 若允许用户导入宠物脚本，必须沿用插件沙箱的最低要求（显式同意、权限清单、
  无本机/内网访问），不得把宠物做成绕过插件权限的旁路。

## 已预留的代码与测试

- `src/pet/types.ts`：上述接口；
- `src/pet/registry.ts`：注册/注销/订阅/清空（同 id 覆盖；空 id 抛错）；
- `src/pet/context.ts`：从 store 生成**只读**播放快照（高亮行复用 `utils/lyrics.activeLyricIndex`）；
- `src/pet/PetHost.tsx` + `pet.module.css`：无宠物渲染 null；有宠物时挂载并负责 `dispose`；
- `App.tsx` 挂载 `<PetHost/>`；冒烟测试覆盖「无宠物时不渲染」「注册后宿主出现容器」与快照字段。

## 后果

- 正面：2.x 开始时只需实现具体宠物与分发策略，不需要改外壳、播放桥或歌词高亮算法；
  1.x 的版本线也有了明确门槛，不再把「功能未齐」的版本叫 1.0。
- 代价：现在多了一个**当前无消费者**的扩展点（`src/pet/`）；这是用户明确要求的预留，
  因此接受，并在 2.x 前保持文件小而稳定。
- 风险：宠物如果以后需要存储或网络，必须重新走 ADR（不能在本接口上静默扩权）。
