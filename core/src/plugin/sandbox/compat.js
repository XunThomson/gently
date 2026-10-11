// 兼容模式的 `require` 垫片：一份**固定、可审计**的模块清单（ADR-0006）。
//
// 为什么需要：MusicFree / LX 生态的插件是 CommonJS 模块 + npm 依赖，没有域名声明。
// 为什么只做垫片：任意模块解析 = 放弃审计；因此清单之外一律抛出**可执行的错误**
// （说明缺哪个模块、清单里有什么、该怎么移植），而不是让插件在深处因为 undefined 莫名其妙地失败。
//
// 当前清单（全部是子集，语义以本文件为唯一口径）：
//   he        —— HTML 实体解码/编码（最常用）
//   axios     —— 请求转成宿主 fetch（白名单 / 兼容模式域名策略仍然生效）
//   dayjs     —— 日期解析、格式化、加减、startOf/endOf、diff
//   crypto-js —— MD5 / SHA256 + Hex/Base64/Utf8/Latin1 编码 + WordArray 基础（B 站 WBI 够用）
//
// 这个文件在 bootstrap.js **之后**执行：它用到 bootstrap 装好的 fetch / console。
(function () {
    // ================================================================ 字节工具
    // 垫片内部一律以「字节数组」为中间表示，再交给 WordArray / 宿主哈希。
    const utf8Encode = (text) => {
        const bytes = [];
        const source = String(text);
        for (let i = 0; i < source.length; i++) {
            let code = source.charCodeAt(i);
            if (code >= 0xd800 && code <= 0xdbff && i + 1 < source.length) {
                const next = source.charCodeAt(i + 1);
                if (next >= 0xdc00 && next <= 0xdfff) {
                    code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
                    i++;
                }
            }
            if (code < 0x80) {
                bytes.push(code);
            } else if (code < 0x800) {
                bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
            } else if (code < 0x10000) {
                bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
            } else {
                bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f),
                           0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
            }
        }
        return bytes;
    };

    const utf8Decode = (bytes) => {
        let out = '';
        for (let i = 0; i < bytes.length;) {
            const first = bytes[i];
            let code;
            let size;
            if (first < 0x80) { code = first; size = 1; }
            else if ((first & 0xe0) === 0xc0) { code = first & 0x1f; size = 2; }
            else if ((first & 0xf0) === 0xe0) { code = first & 0x0f; size = 3; }
            else if ((first & 0xf8) === 0xf0) { code = first & 0x07; size = 4; }
            else { code = 0xfffd; size = 1; }
            if (size > 1) {
                let valid = true;
                for (let k = 1; k < size; k++) {
                    const cont = bytes[i + k];
                    if (cont === undefined || (cont & 0xc0) !== 0x80) { valid = false; break; }
                    code = (code << 6) | (cont & 0x3f);
                }
                if (!valid) { code = 0xfffd; size = 1; }
            }
            i += size;
            if (code > 0xffff) {
                code -= 0x10000;
                out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
            } else {
                out += String.fromCharCode(code);
            }
        }
        return out;
    };

    const hexEncode = (bytes) => {
        let out = '';
        for (let i = 0; i < bytes.length; i++) {
            out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
        }
        return out;
    };

    const hexDecode = (text) => {
        const clean = String(text).replace(/[^0-9a-fA-F]/g, '');
        const bytes = [];
        for (let i = 0; i < clean.length; i += 2) {
            bytes.push(parseInt(clean.length - i === 1 ? clean[i] + '0' : clean.slice(i, i + 2), 16));
        }
        return bytes;
    };

    const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

    const base64Encode = (bytes) => {
        let out = '';
        for (let i = 0; i < bytes.length; i += 3) {
            const b0 = bytes[i];
            const b1 = bytes[i + 1];
            const b2 = bytes[i + 2];
            out += BASE64_CHARS[b0 >> 2];
            out += BASE64_CHARS[((b0 & 0x03) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
            out += b1 === undefined ? '=' : BASE64_CHARS[((b1 & 0x0f) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
            out += b2 === undefined ? '=' : BASE64_CHARS[b2 & 0x3f];
        }
        return out;
    };

    const base64Decode = (text) => {
        const clean = String(text).replace(/[^A-Za-z0-9+/]/g, '');
        const bytes = [];
        for (let i = 0; i < clean.length; i += 4) {
            const n0 = BASE64_CHARS.indexOf(clean[i]);
            const n1 = BASE64_CHARS.indexOf(clean[i + 1]);
            const n2 = clean[i + 2] === undefined ? -1 : BASE64_CHARS.indexOf(clean[i + 2]);
            const n3 = clean[i + 3] === undefined ? -1 : BASE64_CHARS.indexOf(clean[i + 3]);
            if (n0 < 0 || n1 < 0) break;
            bytes.push(((n0 << 2) | (n1 >> 4)) & 0xff);
            if (n2 >= 0) bytes.push(((n1 << 4) | (n2 >> 2)) & 0xff);
            if (n3 >= 0) bytes.push(((n2 << 6) | n3) & 0xff);
        }
        return bytes;
    };

    // ================================================================ crypto-js 子集
    // 哈希本身在**宿主**（Rust：sha2 / md-5）里算，JS 只做编码与形状：
    // 这样密码学实现只有一份，垫片里不会出现第二份（容易写错的）MD5。
    const cryptoJs = (function () {
        const WORD_BYTES = 4;

        function wordArrayFromBytes(bytes) {
            const words = [];
            for (let i = 0; i < bytes.length; i++) {
                words[i >>> 2] = (words[i >>> 2] || 0) | (bytes[i] << (24 - (i % 4) * 8));
            }
            return new WordArray(words, bytes.length);
        }

        function WordArray(words, sigBytes) {
            this.words = words || [];
            this.sigBytes = sigBytes === undefined ? this.words.length * WORD_BYTES : sigBytes;
        }

        WordArray.prototype.toBytes = function () {
            const bytes = [];
            for (let i = 0; i < this.sigBytes; i++) {
                bytes.push((this.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff);
            }
            return bytes;
        };
        WordArray.prototype.toString = function (encoder) { return (encoder || Hex).stringify(this); };
        WordArray.prototype.clone = function () { return new WordArray(this.words.slice(0), this.sigBytes); };
        WordArray.prototype.clamp = function () {
            const bytes = this.toBytes();
            const clamped = wordArrayFromBytes(bytes);
            this.words = clamped.words;
            this.sigBytes = clamped.sigBytes;
            return this;
        };
        WordArray.prototype.concat = function (other) {
            const merged = wordArrayFromBytes(this.toBytes().concat(other.toBytes()));
            this.words = merged.words;
            this.sigBytes = merged.sigBytes;
            return this;
        };

        const Hex = {
            stringify: (wordArray) => hexEncode(wordArray.toBytes()),
            parse: (text) => wordArrayFromBytes(hexDecode(text)),
        };
        const Utf8 = {
            stringify: (wordArray) => utf8Decode(wordArray.toBytes()),
            parse: (text) => wordArrayFromBytes(utf8Encode(text)),
        };
        const Latin1 = {
            stringify: (wordArray) => wordArray.toBytes().map((b) => String.fromCharCode(b)).join(''),
            parse: (text) => {
                const bytes = [];
                const source = String(text);
                for (let i = 0; i < source.length; i++) bytes.push(source.charCodeAt(i) & 0xff);
                return wordArrayFromBytes(bytes);
            },
        };
        const Base64 = {
            stringify: (wordArray) => base64Encode(wordArray.toBytes()),
            parse: (text) => wordArrayFromBytes(base64Decode(text)),
        };

        // 输入可以是字符串、WordArray、字节数组（Uint8Array / number[]）
        function messageBytes(message) {
            if (message instanceof WordArray) return message.toBytes();
            if (Array.isArray(message)) return message.slice(0);
            if (typeof Uint8Array !== 'undefined' && message instanceof Uint8Array) {
                return Array.prototype.slice.call(message);
            }
            return utf8Encode(typeof message === 'string' ? message : String(message));
        }

        function digest(algo, message) {
            return Hex.parse(globalThis.__hostDigest(algo, hexEncode(messageBytes(message))));
        }

        // 子集之外的算法/模式：显式报错，避免插件拿到 undefined 后在深处炸掉
        function unsupported(name) {
            return function () {
                const message = 'crypto-js 子集不包含 ' + name
                    + '：兼容模式只内置 MD5 / SHA256 与 Hex / Base64 / Utf8 / Latin1 编码；'
                    + '需要 ' + name + ' 的插件请移植为单文件 ABI 或改用清单内的算法';
                globalThis.__gentlyLoadError = message;
                throw new Error(message);
            };
        }

        const api = {
            MD5: (message) => digest('md5', message),
            SHA256: (message) => digest('sha256', message),
            enc: { Hex: Hex, Utf8: Utf8, Latin1: Latin1, Base64: Base64 },
            lib: {
                WordArray: {
                    create(words, sigBytes) {
                        // crypto-js 的 create 收的是 words；实际插件更多直接传**字节数组**，
                        // 这里按元素范围判断（全部 <= 0xff 视为字节），两种写法都认。
                        const isBytes = Array.isArray(words) && words.length > 0
                            && words.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xff);
                        return isBytes
                            ? wordArrayFromBytes(words.slice(0))
                            : new WordArray(words ? words.slice(0) : [], sigBytes);
                    },
                    random(byteCount) {
                        const bytes = [];
                        for (let i = 0; i < byteCount; i++) bytes.push(Math.floor(Math.random() * 256));
                        return wordArrayFromBytes(bytes);
                    },
                },
            },
        };

        ['AES', 'DES', 'TripleDES', 'RC4', 'Rabbit', 'SHA1', 'SHA224', 'SHA384', 'SHA512', 'SHA3',
         'HmacMD5', 'HmacSHA1', 'HmacSHA256', 'HmacSHA512', 'PBKDF2', 'EvpKDF', 'mode', 'pad',
         'format'].forEach((name) => { api[name] = unsupported(name); });

        return api;
    })();

    // ================================================================ axios 子集
    // 请求全部走宿主 fetch：兼容模式的域名策略、@hosts 白名单、SSRF 防线
    // **都在宿主里**，垫片不可能绕过。
    const axios = (function () {
        const hostFetch = globalThis.fetch;
        const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];
        const defaultHeaders = () => ({
            common: {}, get: {}, post: {}, put: {}, delete: {}, patch: {}, head: {}, options: {},
        });

        const isPlainObject = (value) => value !== null && typeof value === 'object'
            && !Array.isArray(value) && Object.prototype.toString.call(value) !== '[object Date]';

        function serializeParams(params) {
            if (!isPlainObject(params)) return '';
            const parts = [];
            Object.keys(params).forEach((key) => {
                const value = params[key];
                if (value === undefined || value === null) return;
                // 数组按 axios 默认序列化器写成 `key[]`（服务端按 URLSearchParams 解码后同义）；
                // 编码用 encodeURIComponent —— 与 1.x 的 `+`/裸 `[]` 只是字符层面的差异。
                const items = Array.isArray(value) ? value : [value];
                const name = Array.isArray(value) ? key + '[]' : key;
                items.forEach((item) => {
                    if (item === undefined || item === null) return;
                    const text = typeof item === 'object' ? JSON.stringify(item) : String(item);
                    parts.push(encodeURIComponent(name) + '=' + encodeURIComponent(text));
                });
            });
            return parts.join('&');
        }

        function buildUrl(config) {
            let url = String(config.url === undefined ? '' : config.url);
            const base = config.baseURL;
            if (base && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
                url = String(base).replace(/\/+$/, '') + (url.charAt(0) === '/' ? url : '/' + url);
            }
            const query = serializeParams(config.params);
            if (query) url += (url.indexOf('?') === -1 ? '?' : '&') + query;
            return url;
        }

        const headerValue = (headers, name) => {
            const target = String(name).toLowerCase();
            const keys = Object.keys(headers || {});
            for (let i = 0; i < keys.length; i++) {
                if (keys[i].toLowerCase() === target) return headers[keys[i]];
            }
            return undefined;
        };

        const HEADER_BUCKETS = ['common', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

        /** axios 允许 `axios.create({headers: {Referer: 'x'}})` 这种「扁平」写法，这里挑出来。 */
        function flatDefaults(defaultsHeaders) {
            const flat = {};
            if (!isPlainObject(defaultsHeaders)) return flat;
            Object.keys(defaultsHeaders).forEach((key) => {
                const value = defaultsHeaders[key];
                if (HEADER_BUCKETS.indexOf(key.toLowerCase()) === -1 && typeof value !== 'object') {
                    flat[key] = value;
                }
            });
            return flat;
        }

        function mergeHeaders(config, defaults) {
            const method = String(config.method || 'get').toLowerCase();
            const headers = {};
            const assign = (source) => {
                if (!isPlainObject(source)) return;
                Object.keys(source).forEach((key) => {
                    const value = source[key];
                    if (value !== undefined && value !== null) headers[key] = String(value);
                });
            };
            const defaults_ = defaults || {};
            const bucket = (name) => (isPlainObject(defaults_.headers) ? defaults_.headers[name] : undefined);
            assign(bucket('common'));
            assign(bucket(method));
            assign(flatDefaults(defaults_.headers));
            assign(config.headers);
            if (config.data !== undefined && config.data !== null && typeof config.data === 'object'
                && headerValue(headers, 'content-type') === undefined) {
                headers['Content-Type'] = 'application/json;charset=utf-8';
            }
            return headers;
        }

        function serializeBody(data, method, headers) {
            if (data === undefined || data === null || method === 'GET' || method === 'HEAD') return undefined;
            if (typeof data === 'string') return data;
            if (typeof data === 'object') {
                if (headerValue(headers, 'content-type') === undefined) {
                    headers['Content-Type'] = 'application/json;charset=utf-8';
                }
                return JSON.stringify(data);
            }
            return String(data);
        }

        function parseBody(text, headers, responseType) {
            if (responseType === 'text') return text;
            const contentType = String(headerValue(headers, 'content-type') || '');
            const looksJson = /^\s*[[{]/.test(text);
            if (responseType === 'json' || (!responseType && (contentType.indexOf('json') !== -1 || looksJson))) {
                try { return JSON.parse(text); } catch (err) { return text; }
            }
            return text;
        }

        function networkError(cause, config) {
            const error = new Error(cause && cause.message ? cause.message : String(cause));
            error.isAxiosError = true;
            error.code = 'ERR_NETWORK';
            error.config = config;
            return error;
        }

        /** 按 axios 的语义把一串拦截器挂到同一条 Promise 链上（成功/失败两条路径都保留）。 */
        function applyInterceptors(chain, handlers) {
            return handlers.reduce(
                (current, handler) => current.then(
                    (value) => (typeof handler.fulfilled === 'function' ? handler.fulfilled(value) : value),
                    (error) => (typeof handler.rejected === 'function'
                        ? handler.rejected(error)
                        : Promise.reject(error))
                ),
                chain
            );
        }

        function createInterceptorManager() {
            const handlers = [];
            let nextId = 1;
            return {
                handlers: handlers,
                use(fulfilled, rejected) {
                    const id = nextId++;
                    handlers.push({ id: id, fulfilled: fulfilled, rejected: rejected });
                    return id;
                },
                eject(id) {
                    const index = handlers.findIndex((handler) => handler.id === id);
                    if (index !== -1) handlers.splice(index, 1);
                },
                clear() { handlers.length = 0; },
            };
        }

        function send(config) {
            const method = String(config.method || 'get').toUpperCase();
            const url = buildUrl(config);
            const headers = mergeHeaders(config, config.__defaults);
            const body = serializeBody(config.data, method, headers);
            let pending;
            try {
                pending = hostFetch(url, { method: method, headers: headers, body: body });
            } catch (err) {
                // 宿主 fetch 的错误（权限 / 白名单 / 超时）必须原样带出去：
                // 错误文本里的 GENTLY_* 标记是宿主归类错误码的依据。
                return Promise.reject(networkError(err, config));
            }
            return pending.then((res) => res.text().then((text) => {
                const responseHeaders = {};
                (res.headers || []).forEach((pair) => {
                    responseHeaders[String(pair[0]).toLowerCase()] = String(pair[1]);
                });
                const response = {
                    data: parseBody(text, responseHeaders, config.responseType),
                    status: res.status,
                    statusText: '',
                    headers: responseHeaders,
                    config: config,
                };
                const validate = typeof config.validateStatus === 'function'
                    ? config.validateStatus
                    : (status) => status >= 200 && status < 300;
                if (!validate(res.status)) {
                    const error = new Error('Request failed with status code ' + res.status);
                    error.isAxiosError = true;
                    error.code = res.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST';
                    error.config = config;
                    error.response = response;
                    return Promise.reject(error);
                }
                return response;
            }));
        }

        function createInstance(defaults) {
            const requestInterceptors = createInterceptorManager();
            const responseInterceptors = createInterceptorManager();

            const instance = function (config) {
                const merged = Object.assign({}, instance.defaults, config || {});
                merged.__defaults = instance.defaults;
                let chain = Promise.resolve(merged);
                // axios：请求拦截器按**注册逆序**执行，响应拦截器按注册顺序
                chain = applyInterceptors(chain, requestInterceptors.handlers.slice(0).reverse());
                chain = chain.then((prepared) => send(prepared || merged));
                chain = applyInterceptors(chain, responseInterceptors.handlers);
                return chain;
            };

            instance.defaults = defaults;
            instance.request = instance;
            METHODS.forEach((method) => {
                // get / head / delete / options 的第二个参数是 config，其余是 data
                const dataLess = method === 'get' || method === 'head'
                    || method === 'delete' || method === 'options';
                instance[method] = function (url, second, third) {
                    if (dataLess) {
                        return instance(Object.assign({}, second || {}, { method: method, url: url }));
                    }
                    return instance(Object.assign({}, third || {}, { method: method, url: url, data: second }));
                };
            });
            instance.create = (config) => {
                const merged = Object.assign({}, instance.defaults, config || {});
                // headers 要逐层合并（axios 的 create 不会整体替换 headers）
                merged.headers = Object.assign({}, instance.defaults.headers, (config || {}).headers);
                return createInstance(merged);
            };
            instance.all = (promises) => Promise.all(promises);
            instance.spread = (callback) => (values) => callback.apply(null, values);
            instance.isAxiosError = (value) => Boolean(value && value.isAxiosError);
            instance.interceptors = { request: requestInterceptors, response: responseInterceptors };
            return instance;
        }

        return createInstance({ headers: defaultHeaders(), params: {}, timeout: 0 });
    })();

    // ================================================================ dayjs 子集
    const dayjs = (function () {
        const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
                        'September', 'October', 'November', 'December'];
        const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct',
                              'Nov', 'Dec'];
        const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const DAYS_MIN = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

        const UNIT_ALIAS = {
            y: 'year', year: 'year', years: 'year',
            M: 'month', month: 'month', months: 'month',
            w: 'week', week: 'week', weeks: 'week',
            d: 'day', day: 'day', days: 'day',
            h: 'hour', hour: 'hour', hours: 'hour',
            m: 'minute', minute: 'minute', minutes: 'minute',
            s: 'second', second: 'second', seconds: 'second',
            ms: 'millisecond', millisecond: 'millisecond', milliseconds: 'millisecond',
        };
        const UNIT_MS = {
            millisecond: 1, second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000,
        };

        const pad = (value, width) => {
            let text = String(Math.abs(value));
            while (text.length < width) text = '0' + text;
            return (value < 0 ? '-' : '') + text;
        };
        const unitOf = (unit) => {
            const key = UNIT_ALIAS[String(unit)];
            if (!key) {
                throw new Error('dayjs 子集不支持的时间单位：' + unit
                    + '（支持 year/month/week/day/hour/minute/second/millisecond）');
            }
            return key;
        };
        const absFloor = (value) => (value < 0 ? Math.ceil(value) || 0 : Math.floor(value));

        function Dayjs(ms) { this.$ms = ms; }

        function parseInput(input) {
            if (input === undefined || input === null) return Date.now();
            if (typeof input === 'number') return input;
            if (input instanceof Dayjs) return input.$ms;
            if (input instanceof Date) return input.getTime();
            const text = String(input).trim();
            // 纯日期 / 常见「日期 时间」写法按**本地**时间解析
            // （原生 `new Date('2024-01-01')` 会当 UTC，与 dayjs 语义不同）
            let matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
            if (matched) {
                return new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])).getTime();
            }
            matched = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(text);
            if (matched) {
                return new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]),
                    Number(matched[4]), Number(matched[5]), Number(matched[6] || 0),
                    Number(matched[7] || 0)).getTime();
            }
            return new Date(text).getTime();
        }

        const GETTERS = {
            year: (date) => date.getFullYear(),
            month: (date) => date.getMonth(),
            date: (date) => date.getDate(),
            day: (date) => date.getDay(),
            hour: (date) => date.getHours(),
            minute: (date) => date.getMinutes(),
            second: (date) => date.getSeconds(),
            millisecond: (date) => date.getMilliseconds(),
        };
        const SETTERS = {
            year: (date, value) => date.setFullYear(value),
            month: (date, value) => date.setMonth(value),
            date: (date, value) => date.setDate(value),
            day: (date, value) => date.setDate(date.getDate() - date.getDay() + Number(value)),
            hour: (date, value) => date.setHours(value),
            minute: (date, value) => date.setMinutes(value),
            second: (date, value) => date.setSeconds(value),
            millisecond: (date, value) => date.setMilliseconds(value),
        };

        function shift(instance, amount, unit) {
            const key = unitOf(unit);
            if (key === 'hour' || key === 'minute' || key === 'second' || key === 'millisecond') {
                return new Dayjs(instance.$ms + Number(amount) * UNIT_MS[key]);
            }
            const date = new Date(instance.$ms);
            if (key === 'year') date.setFullYear(date.getFullYear() + Number(amount));
            else if (key === 'month') date.setMonth(date.getMonth() + Number(amount));
            else date.setDate(date.getDate() + Number(amount) * (key === 'week' ? 7 : 1));
            return new Dayjs(date.getTime());
        }

        function startOf(instance, unit) {
            const key = unitOf(unit);
            const date = new Date(instance.$ms);
            if (key === 'year') { date.setMonth(0, 1); date.setHours(0, 0, 0, 0); }
            else if (key === 'month') { date.setDate(1); date.setHours(0, 0, 0, 0); }
            else if (key === 'week') { date.setDate(date.getDate() - date.getDay()); date.setHours(0, 0, 0, 0); }
            else if (key === 'day') { date.setHours(0, 0, 0, 0); }
            else if (key === 'hour') { date.setMinutes(0, 0, 0); }
            else if (key === 'minute') { date.setSeconds(0, 0); }
            else if (key === 'second') { date.setMilliseconds(0); }
            return new Dayjs(date.getTime());
        }

        /** dayjs 同款月份差：`a - b`（按整月 + 余量比例）。 */
        function monthDiff(aMs, bMs) {
            if (new Date(aMs).getDate() < new Date(bMs).getDate()) return -monthDiff(bMs, aMs);
            const a = new Date(aMs);
            const b = new Date(bMs);
            const whole = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
            const anchor = shift(new Dayjs(aMs), whole, 'month').$ms;
            const negative = (bMs - anchor) < 0;
            const anchor2 = shift(new Dayjs(aMs), whole + (negative ? -1 : 1), 'month').$ms;
            const value = -(whole + (bMs - anchor) / (negative ? anchor - anchor2 : anchor2 - anchor));
            return value || 0;
        }

        const TOKENS = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|SSS|A|a|ZZ|Z|X|x/g;

        Dayjs.prototype.format = function (pattern) {
            const format = pattern === undefined ? 'YYYY-MM-DDTHH:mm:ssZ' : String(pattern);
            if (!Number.isFinite(this.$ms)) return 'Invalid Date';
            const date = new Date(this.$ms);
            const offset = -date.getTimezoneOffset();
            const sign = offset < 0 ? '-' : '+';
            const offsetHour = pad(Math.floor(Math.abs(offset) / 60), 2);
            const offsetMinute = pad(Math.abs(offset) % 60, 2);
            const hour12 = date.getHours() % 12 || 12;
            return format.replace(TOKENS, (token, literal) => {
                if (literal !== undefined) return literal;
                switch (token) {
                    case 'YYYY': return pad(date.getFullYear(), 4);
                    case 'YY': return pad(date.getFullYear() % 100, 2);
                    case 'MMMM': return MONTHS[date.getMonth()];
                    case 'MMM': return MONTHS_SHORT[date.getMonth()];
                    case 'MM': return pad(date.getMonth() + 1, 2);
                    case 'M': return String(date.getMonth() + 1);
                    case 'DD': return pad(date.getDate(), 2);
                    case 'D': return String(date.getDate());
                    case 'dddd': return DAYS[date.getDay()];
                    case 'ddd': return DAYS_SHORT[date.getDay()];
                    case 'dd': return DAYS_MIN[date.getDay()];
                    case 'd': return String(date.getDay());
                    case 'HH': return pad(date.getHours(), 2);
                    case 'H': return String(date.getHours());
                    case 'hh': return pad(hour12, 2);
                    case 'h': return String(hour12);
                    case 'mm': return pad(date.getMinutes(), 2);
                    case 'm': return String(date.getMinutes());
                    case 'ss': return pad(date.getSeconds(), 2);
                    case 's': return String(date.getSeconds());
                    case 'SSS': return pad(date.getMilliseconds(), 3);
                    case 'A': return date.getHours() < 12 ? 'AM' : 'PM';
                    case 'a': return date.getHours() < 12 ? 'am' : 'pm';
                    case 'ZZ': return sign + offsetHour + offsetMinute;
                    case 'Z': return sign + offsetHour + ':' + offsetMinute;
                    case 'X': return String(Math.floor(this.$ms / 1000));
                    case 'x': return String(this.$ms);
                    default: return token;
                }
            });
        };

        ['year', 'month', 'date', 'day', 'hour', 'minute', 'second', 'millisecond'].forEach((unit) => {
            Dayjs.prototype[unit] = function (value) {
                if (value === undefined) {
                    if (!Number.isFinite(this.$ms)) return NaN;
                    return GETTERS[unit](new Date(this.$ms));
                }
                const date = new Date(this.$ms);
                SETTERS[unit](date, value);
                return new Dayjs(date.getTime());
            };
        });

        Dayjs.prototype.add = function (amount, unit) { return shift(this, amount, unit); };
        Dayjs.prototype.subtract = function (amount, unit) { return shift(this, -Number(amount), unit); };
        Dayjs.prototype.startOf = function (unit) { return startOf(this, unit); };
        Dayjs.prototype.endOf = function (unit) {
            return new Dayjs(shift(startOf(this, unit), 1, unit).$ms - 1);
        };
        Dayjs.prototype.clone = function () { return new Dayjs(this.$ms); };
        Dayjs.prototype.valueOf = function () { return this.$ms; };
        Dayjs.prototype.unix = function () { return Math.floor(this.$ms / 1000); };
        Dayjs.prototype.toDate = function () { return new Date(this.$ms); };
        Dayjs.prototype.toISOString = function () { return new Date(this.$ms).toISOString(); };
        Dayjs.prototype.toJSON = function () {
            return Number.isFinite(this.$ms) ? new Date(this.$ms).toISOString() : null;
        };
        Dayjs.prototype.isValid = function () { return Number.isFinite(this.$ms); };
        Dayjs.prototype.diff = function (input, unit, float) {
            const other = input instanceof Dayjs ? input : dayjs(input);
            const key = unit === undefined ? 'millisecond' : unitOf(unit);
            let result;
            if (key === 'month' || key === 'year') {
                result = monthDiff(this.$ms, other.$ms);
                if (key === 'year') result /= 12;
            } else {
                result = (this.$ms - other.$ms) / UNIT_MS[key];
            }
            return float ? result : absFloor(result);
        };
        Dayjs.prototype.isBefore = function (input) {
            return this.$ms < (input instanceof Dayjs ? input.$ms : dayjs(input).$ms);
        };
        Dayjs.prototype.isAfter = function (input) {
            return this.$ms > (input instanceof Dayjs ? input.$ms : dayjs(input).$ms);
        };
        Dayjs.prototype.isSame = function (input) {
            return this.$ms === (input instanceof Dayjs ? input.$ms : dayjs(input).$ms);
        };

        function dayjs(input) { return new Dayjs(parseInput(input)); }
        dayjs.unix = (seconds) => new Dayjs(Number(seconds) * 1000);
        dayjs.isDayjs = (value) => value instanceof Dayjs;
        dayjs.locale = (name) => {
            if (name === undefined) return 'en';
            throw new Error('dayjs 子集只提供默认的英文（en）本地化，不支持切换语言');
        };
        dayjs.extend = () => {
            throw new Error('dayjs 子集不支持插件扩展（dayjs.extend / require("dayjs/plugin/*")）：'
                + '请把需要的逻辑写在插件里');
        };
        return dayjs;
    })();

    // ================================================================ he 子集
    const he = {
        decode(text) {
            const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
            return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
                if (entity.charAt(0) === '#') {
                    const code = entity.charAt(1) === 'x' || entity.charAt(1) === 'X'
                        ? parseInt(entity.slice(2), 16)
                        : parseInt(entity.slice(1), 10);
                    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
                }
                return Object.prototype.hasOwnProperty.call(NAMED, entity) ? NAMED[entity] : match;
            });
        },
        encode(text) {
            const NAMED = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
            return String(text).replace(/[&<>"']/g, (char) => NAMED[char]);
        },
    };

    // ================================================================ require
    const modules = {
        'he': () => he,
        'axios': () => axios,
        'dayjs': () => dayjs,
        'crypto-js': () => cryptoJs,
    };
    const moduleNames = Object.keys(modules);
    const cache = {};

    function unavailable(name) {
        return '模块 ' + name + ' 不可用：兼容模式只内置固定清单 [' + moduleNames.join(', ')
            + ']（都是子集，语义见文档）。请改用清单内的模块，'
            + '或把插件移植为单文件 ABI（顶层函数 + 文件头 @hosts 注释）';
    }

    globalThis.require = function (name) {
        const key = String(name);
        if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
        if (!Object.prototype.hasOwnProperty.call(modules, key)) {
            // 关键：把可执行的说明放进槽位。QuickJS 的异常文本穿不过 rquickjs 的 Display，
            // 只抛 Error 的话宿主只能看到 "Exception generated by QuickJS"，用户无从下手。
            globalThis.__gentlyLoadError = unavailable(key);
            throw new Error('GENTLY_MODULE_UNAVAILABLE: ' + key);
        }
        const value = modules[key]();
        // 转译后的插件普遍写 `require('axios').default.get(...)`（TypeScript 的
        // `esModuleInterop` 产物）。MusicFree 的做法是 `pkg.default = pkg` 再把包本身返回，
        // 这里照抄：否则 `.default` 是 undefined，报错会是「cannot read property 'get' of undefined」，
        // 与真实原因（少了个 self-reference）完全看不出关系。
        // 注意 `axios` 垫片本身是**可调用对象**，所以这里对象与函数都要处理。
        const assignable = value && (typeof value === 'object' || typeof value === 'function');
        if (assignable && !Object.prototype.hasOwnProperty.call(value, 'default')) {
            try {
                value.default = value;
            } catch (err) {
                /* 冻结对象之类：不影响 require 本身 */
            }
        }
        cache[key] = value;
        return value;
    };
    // 与 MusicFree 一致：require 也挂在 __musicfree_require 上（有的插件会用第二个参数）
    globalThis.__musicfree_require = globalThis.require;
})();
