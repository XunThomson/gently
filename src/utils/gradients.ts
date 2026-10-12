/**
 * 无封面时的渐变占位色板。
 *
 * **不是 mock 数据**：曲目没有封面图时，界面需要一个稳定、可复现的色块
 * （`utils/cover.ts` 按标题哈希取一条），桌面端与浏览器预览用的是同一份。
 * 它以前住在 `src/mock/base.data.mock.ts` 里，导致「纯配色」被卷进 mock 模块
 * （`utils/helpers.ts` 因此静态依赖 mock）；这里独立出来，mock 那边再转出一次保持兼容。
 */
export const GRADIENTS: string[] = [
    'linear-gradient(135deg,#8b6bff,#4a2fd6)',
    'linear-gradient(135deg,#ff9a8b,#ff5f7e)',
    'linear-gradient(135deg,#43c6ac,#1a8f8f)',
    'linear-gradient(135deg,#f7b733,#e08400)',
    'linear-gradient(135deg,#5b8def,#2b4fc7)',
    'linear-gradient(135deg,#f0708f,#c7355c)',
    'linear-gradient(135deg,#59c3a8,#2b8f76)',
    'linear-gradient(135deg,#7f7fd5,#4a4ab8)',
    'linear-gradient(135deg,#ff8a65,#e64a19)',
    'linear-gradient(135deg,#4facfe,#2b6fd6)',
    'linear-gradient(135deg,#c471f5,#8b3fd6)',
    'linear-gradient(135deg,#43e97b,#2aa85a)',
];
