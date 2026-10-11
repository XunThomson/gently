// 沙箱 bootstrap：把宿主注入的原始入口（`__host*`）包装成插件可用的最小 API，
// 然后**删除原始入口**——插件只能看到受控封装，没有绕过路径。
//
// 这个文件由 `host.rs` 用 `include_str!` 编进二进制，并在 `compat.js` **之前**执行：
// compat.js 里的 `require` 垫片依赖这里装好的 fetch / console / storage / credentials。
(function () {
    const hostFetch = globalThis.__hostFetch;
    const hostLog = globalThis.__hostLog;
    const hostStorageGet = globalThis.__hostStorageGet;
    const hostStorageSet = globalThis.__hostStorageSet;
    const hostStorageDelete = globalThis.__hostStorageDelete;
    const hostCredentialGet = globalThis.__hostCredentialGet;
    const hostUserVariables = globalThis.__hostUserVariables;
    const hostEnvInfo = globalThis.__hostEnvInfo;

    // ---- CommonJS 最小环境 ----
    // 现实中的社区插件（MusicFree / LX 风格）是 CommonJS 模块，需要 module/exports。
    // `require` 由 compat.js 提供：那里是一份**固定、可审计**的模块清单，不做任意解析。
    globalThis.module = { exports: {} };
    globalThis.exports = globalThis.module.exports;

    const flat = (args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');

    globalThis.console = {
        log: (...a) => hostLog('info', flat(a)),
        info: (...a) => hostLog('info', flat(a)),
        warn: (...a) => hostLog('warn', flat(a)),
        error: (...a) => hostLog('error', flat(a)),
    };

    // fetch 是同步宿主调用，但对外暴露为 Promise（作者可以自由使用 await）
    globalThis.fetch = function (url, options) {
        const res = JSON.parse(hostFetch(String(url), JSON.stringify(options || {})));
        return Promise.resolve({
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            headers: res.headers || [],
            text: () => Promise.resolve(res.body),
            json: () => Promise.resolve(JSON.parse(res.body)),
        });
    };

    globalThis.storage = {
        get(key) {
            const raw = hostStorageGet(String(key));
            return raw === null || raw === undefined ? undefined : JSON.parse(raw);
        },
        set(key, value) {
            hostStorageSet(String(key), JSON.stringify(value === undefined ? null : value));
        },
        delete(key) {
            hostStorageDelete(String(key));
        },
    };

    globalThis.credentials = {
        get(key) {
            const value = hostCredentialGet(String(key));
            return value === null || value === undefined ? undefined : value;
        },
    };

    // MusicFree 风格的 `env`：插件用它读取用户在应用里填的变量（我们这边就是「凭据」）。
    // 形状照抄 MusicFree（见 musicfree 的 plugin.ts）：`env.getUserVariables()` 与
    // `env.userVariables` 都返回 `Record<string, string>`，没有填过就是空对象——
    // 不能返回 undefined，否则 `const {cookie} = env.getUserVariables()` 会直接抛错。
    const envInfo = JSON.parse(hostEnvInfo());

    globalThis.env = {
        getUserVariables: () => JSON.parse(hostUserVariables()),
        get userVariables() {
            return JSON.parse(hostUserVariables());
        },
        os: envInfo.os,
        appVersion: envInfo.appVersion,
        lang: envInfo.lang,
    };

    // 有的插件读 `process.env`（MusicFree 把同一个 env 同时挂在 process 上）
    globalThis.process = {
        platform: envInfo.platform,
        version: envInfo.appVersion,
        env: globalThis.env,
    };

    // 收集插件导出的函数：顶层 const/let 声明不在 globalThis 上，只有回到 JS 里
    // 用 eval(name) 才能看到（宿主据此做能力探测）。
    //
    // **协议别名**：MusicFree 的函数名有几处与我们的 ABI 不同，兼容插件不会改名字，
    // 因此在收集时就把别名解析掉——统一以我们的能力名登记，宿主调用时不需要知道来源。
    // 别名只覆盖「语义相同、只是叫法不同」的三处；`getRecommend` 没有对等物
    // （MusicFree 是 tag → 歌单两级），宁可不认也不能瞎接。
    const ALIASES = {
        getTrackInfo: 'getMusicInfo',
        getPlaylistInfo: 'getMusicSheetInfo',
        getTopList: 'getTopListDetail',
    };

    globalThis.__collect = function () {
        const names = ['search', 'getMediaSource', 'getTrackInfo', 'getAlbumInfo',
                       'getPlaylistInfo', 'getLyric', 'getTopLists', 'getTopList', 'getRecommend'];
        const out = {};
        const exported = (globalThis.module && globalThis.module.exports) || {};

        // 先按我们自己的 ABI 名找，找不到再试协议别名（自有 ABI 名优先）
        const resolve = (name) => {
            const candidates = [name];
            if (ALIASES[name]) candidates.push(ALIASES[name]);
            for (let i = 0; i < candidates.length; i++) {
                const candidate = candidates[i];
                let fn;
                try { fn = eval(candidate); } catch (err) { fn = undefined; }
                // CommonJS 风格：函数挂在 module.exports 上（单文件 ABI 则是顶层声明）
                if (typeof fn !== 'function' && typeof exported[candidate] === 'function') {
                    fn = exported[candidate];
                }
                if (typeof fn === 'function') return fn;
            }
            return undefined;
        };

        for (let i = 0; i < names.length; i++) {
            const fn = resolve(names[i]);
            if (typeof fn === 'function') { out[names[i]] = fn; }
        }
        globalThis.__plugin_exports = out;
        return Object.keys(out);
    };

    // 统一入口：核心只通过它调用插件（能力缺失在这里就被挡住）。
    // 结果写进全局槽位，宿主排空微任务队列后读取——这样插件可以自由地写 async 函数。
    globalThis.__invoke = function (name, argsJson) {
        const exports = globalThis.__plugin_exports || {};
        const fn = exports[name];
        if (typeof fn !== 'function') {
            globalThis.__gentlyError = 'GENTLY_CAPABILITY_MISSING: ' + name;
            return;
        }
        let args;
        try {
            args = JSON.parse(argsJson || '[]');
        } catch (err) {
            globalThis.__gentlyError = 'GENTLY_PLUGIN_ERROR: 调用参数不是合法 JSON';
            return;
        }
        const fail = (err) => {
            globalThis.__gentlyError = 'GENTLY_PLUGIN_ERROR: ' + (err && err.message ? err.message : String(err));
        };
        try {
            Promise.resolve(fn.apply(null, args)).then(
                (value) => {
                    globalThis.__gentlyResult = JSON.stringify(value === undefined ? null : value);
                },
                fail
            );
        } catch (err) {
            fail(err);
        }
    };

    // 抹掉原始入口：插件只能用上面这些受控封装
    delete globalThis.__hostFetch;
    delete globalThis.__hostLog;
    delete globalThis.__hostStorageGet;
    delete globalThis.__hostStorageSet;
    delete globalThis.__hostStorageDelete;
    delete globalThis.__hostCredentialGet;
    delete globalThis.__hostUserVariables;
    delete globalThis.__hostEnvInfo;
})();
