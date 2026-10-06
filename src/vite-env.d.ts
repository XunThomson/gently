/// <reference types="vite/client" />

/** 由 vite.config.ts 的 define 注入，来源是 package.json 的 version */
declare const __APP_VERSION__: string;

/** 测试音频（m4s）以静态资源方式导入，得到可播放 URL */
declare module '*.m4s' {
    const src: string;
    export default src;
}
