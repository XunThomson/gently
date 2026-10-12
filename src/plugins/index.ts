import {MOCK_SOURCE_INFO} from './builtin/demo-source-info';
import {registerMusicSource} from './registry';
import type {MusicSourcePlugin} from './types';

/**
 * 内置**演示源**（`mock` / `bilibili` / `netease`）：只在**没有 Tauri 宿主**时存在。
 *
 * 为什么要在模块加载时就判定：这三个源的数据来自 `src/mock/**`，其中还捆着一份
 * 真音频当「可播放地址」——桌面上它们**不是**用户的数据，混在插件列表里就是
 * 「拿 mock 冒充用户数据」（AGENTS 第 4 节末行的红线）。
 *
 * 这里**不能** import `src/services/**` 的 `coreAvailable()` 来判定：`src/services/**`
 * 反过来要 import 本模块（`catalog.service` / `library.service`），模块环会让
 * 「谁先求值」变得不可预测。判定条件与 `window.service` 的 `isTauri()` 保持一致，
 * 是一行运行时常量，重复一份的代价远小于一个环。
 *
 * 判定放在模块顶层是有意的：动态 `import()` 只在浏览器预览真的执行，
 * 桌面端产物里那条链（`src/mock/**` 与随包音频）因此独立成 chunk、永不被加载。
 *
 * 注册的**完成时机是异步的**（`demoSourcesReady`）：视图拿不到「注册还没跑完」的中间态，
 * 因为第一帧渲染远晚于一次微任务；测试要立刻读注册表时 await 那个 Promise。
 */
const hostPresent = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 演示源是否可用：**只有浏览器预览**（没有核心）才是 `true`。 */
export const demoSourcesEnabled: boolean = !hostPresent;

/**
 * 加载三个演示源。
 *
 * 抽成函数（而不是模块顶层的字面量 `import()`）是**为了让打包器无法静态展开它**：
 * 字面量写法会被 Vite 折进 `__vite__mapDeps` 预加载表，把演示数据（`src/mock/**` 的
 * 曲库/榜单/专辑）拖回**主包**——桌面端虽然永不执行这段代码，产物里却仍躺着 mock 数据
 * （R53 实测：主 chunk 里搜得到「晚风告白」）。经过一层函数调用，Rollup 只能保守地
 * 把它留在独立 chunk 里。
 */
const loadDemoSources = (): Promise<unknown> => import('./builtin/demo-sources');

/**
 * 演示源**注册完成**的 Promise（没有宿主时才会真的加载）。
 *
 * 只有在「模块刚求值完就立刻读注册表」的场景才需要 await 它——冒烟测试就是这种场景
 * （打包器把动态 `import()` 编译成异步 `require`，注册发生在下一个微任务）。
 * 应用本身不需要：真实交互远晚于一次微任务。
 */
export const demoSourcesReady: Promise<void> = demoSourcesEnabled
    ? loadDemoSources().then((loaded) => {
          for (const plugin of (loaded as {demoMusicSources: MusicSourcePlugin[]}).demoMusicSources) {
              registerMusicSource(plugin);
          }
      })
    : Promise.resolve();

/* `MOCK_SOURCE_INFO` 只是元数据（无 mock 数据依赖），保持原来的导出不变 */
export {MOCK_SOURCE_INFO};

export {
    registerMusicSource,
    unregisterMusicSource,
    getMusicSource,
    listMusicSources,
    listEnabledMusicSources,
    listMusicSourceInfos,
    getMusicSourceQualities,
    isMusicSourceEnabled,
    setMusicSourceEnabled,
    getActiveMusicSource,
} from './registry';

export type {MusicSourcePlugin} from './types';
export type {MockSourceOptions} from './builtin/source-factory';
