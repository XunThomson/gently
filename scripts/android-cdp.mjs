#!/usr/bin/env node
/**
 * 真机 WebView 的 CDP 小工具（Android / 仅开发用）。
 *
 * 为什么需要它：`adb shell input tap x,y` 要**手算坐标**，一改布局就全废；
 * 而安卓 WebView 开着 devtools socket（debug 包默认开），可以直接在页面里
 * 执行 JS、按文本找元素、截整屏、看网络请求——比截图数像素靠谱得多。
 *
 * 用法（真机连着 USB、装的是 debug 包）：
 *   node scripts/android-cdp.mjs eval --expr "location.href"
 *   node scripts/android-cdp.mjs eval --file scripts/probes/audio-state.js
 *   node scripts/android-cdp.mjs tap  --text "播放"
 *   node scripts/android-cdp.mjs shot --out release/screenshots/x.png
 *   node scripts/android-cdp.mjs net  --seconds 12        # 媒体请求/响应/失败事件
 *   node scripts/android-cdp.mjs ping                     # 端口/进程自检
 *
 * 退出码：0 成功，1 失败（每条错误都带原始命令与原因，不猜）。
 */
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import path from 'node:path';

const ADB = process.env.ADB_PATH ?? 'F:\\Develop\\Android\\Sdk\\platform-tools\\adb.exe';
const PORT = Number(process.env.CDP_PORT ?? 9222);

function usage(code = 1) {
    console.error(
        [
            '用法：node scripts/android-cdp.mjs <命令> [参数]',
            '',
            '  ping                                  自检（socket / 端口 / 页面 URL）',
            '  eval --expr "<js>" | --file <path>    在页面里求值（表达式或 async 表达式），打印返回值',
            '  tap  --text <文本> | --selector <css> 按文本 / 选择器点中心点',
            '  shot --out <png>                      整屏截图（Page.captureScreenshot）',
            '  net  [--seconds N]                    收集 N 秒网络事件（媒体 URL 的请求 / 响应 / 失败）',
        ].join('\n'),
    );
    process.exit(code);
}

/** 找出 WebView 的 devtools socket 名（`@webview_devtools_remote_<pid>`） */
function findDevtoolsSocket() {
    const out = execFileSync(ADB, ['shell', 'cat', '/proc/net/unix'], {encoding: 'utf8'});
    const hit = out.match(/@(webview_devtools_remote_\d+)/);
    if (!hit) throw new Error('没有发现 webview_devtools_remote_*（debug 包才会开；先启动应用）');
    return hit[1];
}

/** 把 socket 转发到本机端口，返回可用的 /json 地址 */
function forward(socket) {
    const out = execFileSync(ADB, ['forward', `tcp:${PORT}`, `localabstract:${socket}`], {encoding: 'utf8'}).trim();
    if (out !== String(PORT) && out !== '') {
        // adb 正常会打印端口号；非预期输出就原样报出来，别静默
        console.error(`[cdp] adb forward 输出异常：${out}`);
    }
    return `http://127.0.0.1:${PORT}`;
}

async function listPages(base) {
    const res = await fetch(`${base}/json`);
    if (!res.ok) throw new Error(`GET ${base}/json 失败：HTTP ${res.status}`);
    return res.json();
}

class Cdp {
    constructor(url) {
        this.ws = new WebSocket(url);
        this.nextId = 1;
        this.pending = new Map();
        this.events = [];
        this.opened = new Promise((resolve, reject) => {
            this.ws.addEventListener('open', () => resolve());
            this.ws.addEventListener('error', (event) => reject(new Error(`WebSocket 失败：${event?.message ?? 'unknown'}`)));
        });
        this.ws.addEventListener('message', (event) => {
            const msg = JSON.parse(event.data);
            if (msg.id && this.pending.has(msg.id)) {
                const {resolve, reject} = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
                else resolve(msg.result);
                return;
            }
            if (msg.method) this.events.push(msg);
        });
    }

    async send(method, params = {}) {
        await this.opened;
        const id = this.nextId++;
        const payload = JSON.stringify({id, method, params});
        const promise = new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
        this.ws.send(payload);
        return promise;
    }

    close() {
        try {
            this.ws.close();
        } catch {
            /* 关不掉也无所谓：进程退出会断 */
        }
    }
}

async function connect() {
    const socket = findDevtoolsSocket();
    const base = forward(socket);
    const pages = await listPages(base);
    const page = pages.find((entry) => entry.type === 'page');
    if (!page) throw new Error(`没有页面目标：${JSON.stringify(pages)}`);
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.opened;
    return {cdp, page, socket};
}

/** 求值：表达式或 async 代码；异常也原样抛出 */
async function evaluate(cdp, expression) {
    const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
    });
    if (result.exceptionDetails) {
        const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
        throw new Error(`页面内异常：${text}`);
    }
    return result.result?.value;
}

async function main() {
    const [command, ...rest] = process.argv.slice(2);
    if (!command) usage();

    const flag = (name, fallback = '') => {
        const index = rest.indexOf(`--${name}`);
        return index >= 0 ? rest[index + 1] : fallback;
    };

    if (command === 'ping') {
        const {cdp, page, socket} = await connect();
        console.log(JSON.stringify({socket, url: page.url, title: page.title}, null, 2));
        cdp.close();
        return;
    }

    if (command === 'eval') {
        const expression = flag('expr') || (flag('file') ? null : null);
        const file = flag('file');
        const source = file
            ? (await import('node:url')).fileURLToPath
                ? (await import('node:fs')).readFileSync(path.resolve(file), 'utf8')
                : null
            : expression;
        if (!source) usage();
        const {cdp} = await connect();
        const value = await evaluate(cdp, source);
        if (typeof value === 'string') console.log(value);
        else console.log(JSON.stringify(value, null, 2));
        cdp.close();
        return;
    }

    if (command === 'tap') {
        const text = flag('text');
        const selector = flag('selector');
        if (!text && !selector) usage();
        const probe = selector
            ? `(() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return {x: r.left + r.width / 2, y: r.top + r.height / 2, label: el.textContent || ''};
              })()`
            : `(() => {
                const wanted = ${JSON.stringify(text)};
                const nodes = [...document.querySelectorAll('button, [role="button"], a, div, span')];
                const el = nodes.find((node) => (node.textContent || '').trim() === wanted);
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return {x: r.left + r.width / 2, y: r.top + r.height / 2, label: (el.textContent || '').trim()};
              })()`;
        const {cdp} = await connect();
        const point = await evaluate(cdp, probe);
        if (!point) throw new Error(`找不到目标：${text ?? selector}`);
        for (const type of ['mousePressed', 'mouseReleased']) {
            await cdp.send('Input.dispatchMouseEvent', {
                type,
                x: Math.round(point.x),
                y: Math.round(point.y),
                button: 'left',
                clickCount: 1,
            });
        }
        console.log(JSON.stringify({clicked: point}, null, 2));
        cdp.close();
        return;
    }

    if (command === 'shot') {
        const out = flag('out', `release/screenshots/android-${Date.now()}.png`);
        const {cdp} = await connect();
        const shot = await cdp.send('Page.captureScreenshot', {format: 'png'});
        writeFileSync(path.resolve(out), Buffer.from(shot.data, 'base64'));
        console.log(`已保存截图：${out}`);
        cdp.close();
        return;
    }

    if (command === 'net') {
        const seconds = Number(flag('seconds', '12'));
        const {cdp} = await connect();
        await cdp.send('Network.enable', {});
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        const interesting = cdp.events.filter((event) => {
            if (!event.method?.startsWith('Network.')) return false;
            const url = event.params?.request?.url ?? event.params?.response?.url ?? '';
            return url.includes('127.0.0.1') || event.method === 'Network.loadingFailed';
        });
        for (const event of interesting) {
            if (event.method === 'Network.requestWillBeSent') {
                console.log(`REQ  ${event.params.request.url}`);
            } else if (event.method === 'Network.responseReceived') {
                const r = event.params.response;
                console.log(`RESP ${r.url} status=${r.status} mime=${r.mimeType} type=${event.params.type}`);
                console.log(`     headers=${JSON.stringify(r.headers)}`);
            } else if (event.method === 'Network.loadingFailed') {
                console.log(`FAIL ${event.params.type} ${event.params.errorText} canceled=${event.params.canceled}`);
            }
        }
        if (interesting.length === 0) console.log('（这段时间没有 127.0.0.1 的网络事件）');
        cdp.close();
        return;
    }

    usage();
}

main().catch((err) => {
    console.error(`[cdp] ${err.message}`);
    process.exit(1);
});
