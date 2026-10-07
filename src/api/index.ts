/**
 * 后端接口规范（类型契约）。
 *
 * 这里**只有契约**，没有任何实现：
 * - `types.ts`  传输原语与接口专用模型
 * - `contract.ts` 按域划分的接口定义（`GentlyApi`）
 *
 * 规范正文见 `docs/contracts/backend-api.md`。
 * 接入后端时，在 `src/services/**` 内把 mock 换成 `createApiClient(options)` 的调用即可，
 * UI 与 store 不需要改动。
 */

export * from './types';
export * from './contract';
