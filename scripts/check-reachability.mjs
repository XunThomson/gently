#!/usr/bin/env node
/**
 * 「有没有界面入口」守卫：契约命令/事件**是不是真的能走到界面**。
 *
 * 为什么需要（R28 的教训）：`library.local.scan` 的实现、封装、契约登记全都齐全，
 * 契约守卫也一路绿灯——但**没有任何界面调用它**，于是桌面上「本地音乐」页永远是空的。
 * 「命令有前端封装」≠「用户能用」：`check-commands.mjs` 查的是封装存在，
 * 这个脚本查的是**从界面出发能不能走到**。
 *
 * 链路是三层：`views/components` → `store actions` → `services`（→ 契约命令）。
 * 因此不能把 store 当成根：`library.slice` 里写了 `libraryService.scanLocal(...)` 只说明
 * 「store 有这个能力」，**没有视图调用这个 action** 就等于用户摸不到（R28 的原样）。
 *
 * 做法（静态近似，够用且不误报）：
 * 1. 解析出两类节点：
 *    - 服务节点：`export function coreX` / `export const libraryService = {scanLocal(){}}`
 *    - 动作节点：`const actions: LibraryActions = {async scan(){}}` → `actions.library.scan`
 *      （写成 `const scan = async () => {}` + `{scan}` 简写时，去同一个文件里找这个局部定义）
 * 2. **界面侧**（`src/**` 里除 `src/services/**`、`src/store/**` 之外的源码）里出现过 = 直接可达；
 *    动作节点按「界面文件里既有 `useActions()` 又有 `<name>(`」判定（视图普遍是解构调用），
 *    因此会先剥掉 `const {a, b} = useActions().x;` 这类**单纯解构**行，避免「声明了但没用」也算可达；
 * 3. 可达节点引用到的其他节点 = 间接可达，迭代到不动点；
 * 4. 仍然不可达的服务节点就是「没人用」——把它能触及的契约命令列出来，
 *    要么接上界面，要么写进下面的 `DELIBERATE` 白名单并说明理由（每次都会打印，防止悄悄腐烂）。
 *
 * 用法：`node scripts/check-reachability.mjs`（`pnpm check:reachability`，也包含在 `pnpm verify` 里）
 */

import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {basename, dirname, join, relative, sep} from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICES = join(root, 'src', 'services');
const STORE = join(root, 'src', 'store');

/**
 * 明确「有意不做界面入口」的节点：键是节点名，值是理由。
 *
 * 这里只放**产品取舍**（不打算接到界面），不放「暂时忘了接」——后者应该被修掉。
 */
const DELIBERATE = {
    corePushHistory:
        '写历史统一走 `playback.report`（R10 决定：它多带「实际播成的源 + 真实秒数」）；`library.history.push` 是核心里同一份实现的等价入口，前端**不该双写**（会重复计一次播放）',
};

/**
 * 有意不做界面入口的 **store action**：键是 `actions.<切片>.<动作>`，值是理由。
 *
 * 与上面的 `DELIBERATE` 同源：这里有实现、也走通了链路，只是**用户不需要这个按钮**
 * （或者由别的动作覆盖了同一语义）。写进这里就不再只是「一条提示」，而是每次都会打印理由的
 * 决定；一旦哪天真的接上了界面，脚本会提醒把它从这里删掉。
 */
const DELIBERATE_ACTIONS = {
    'actions.player.stop':
        '停止不是用户可见的操作：播放/暂停由 `toggle` 负责，队列播完或切歌各有自己的结算路径（`reportPlayback` + `next`）。`stop` 是 store 的**完整重置入口**（同时清掉 current/detail/队列位置/歌词），冒烟测试用它把状态复位后再断言解析器，保留它比删掉更划算',
};

/* ---------------- 宠物域（独立命名空间，ADR 0010） ---------------- */

/**
 * 有意暂时没有界面入口的宠物命令：键是命令名，值是理由（当前为空）。
 *
 * M2 起 7 条命令都有界面入口：`pet.state` / `pet.install` / `pet.setActive` / `pet.remove`
 * 在设置页的宠物面板，`pet.tick` / `pet.atlas` 在渲染适配器，`pet.interact` 在点击处理里。
 * 以后真有取舍时往这里加，并写清理由。
 */
const DELIBERATE_PET = {};

/** 递归收集源码文件 */
function sourceFiles(dir, {exclude = []} = {}) {
    const out = [];
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (['node_modules', 'target', 'dist', 'release', 'archive'].includes(entry.name)) continue;
            if (exclude.includes(full)) continue;
            out.push(...sourceFiles(full, {exclude}));
            continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (entry.name.endsWith('.d.ts')) continue;
        out.push(full);
    }
    return out;
}

/** 用花括号配对取出一段块（从 `{` 开始），返回块内文本 */
function blockAfter(source, start) {
    const open = source.indexOf('{', start);
    if (open < 0) return '';
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(open + 1, i);
        }
    }
    return source.slice(open + 1);
}

/**
 * 取函数体：先配对**参数括号**，再配对函数体花括号。
 *
 * 不能直接用 `blockAfter`：`options: {limit?: number} = {}` 这类对象类型注解里的 `{`
 * 会先被撞上，取到的「函数体」其实是参数类型（第一版就栽在这：`coreCancelSearch`
 * 明明在 `coreSearch` 里被调用，却报成没人用）。
 */
function functionBody(source, start) {
    const open = source.indexOf('(', start);
    if (open < 0) return blockAfter(source, start);
    let depth = 0;
    let close = -1;
    for (let i = open; i < source.length; i += 1) {
        if (source[i] === '(') depth += 1;
        else if (source[i] === ')') {
            depth -= 1;
            if (depth === 0) {
                close = i;
                break;
            }
        }
    }
    return blockAfter(source, close < 0 ? open : close);
}

/**
 * 取对象字面量的**顶层成员**（只认深度 0 处、紧跟 `{` 或 `,` 的 `name(` / `name:`），
 * 返回 `{name, body}` 列表。深度跟踪保证方法体里的 `if (` / `return {` 不会被误当成成员。
 */
function objectMembers(body) {
    const marks = [];
    let depth = 0;
    let atMemberStart = true;

    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];

        if (depth === 0 && atMemberStart) {
            let j = i;
            /* 跳过注释与空白：成员前面常有 JSDoc（不跳过就会把带注释的成员整个漏掉） */
            for (;;) {
                while (j < body.length && /\s/.test(body[j])) j += 1;
                if (body.startsWith('//', j)) {
                    const end = body.indexOf('\n', j);
                    j = end < 0 ? body.length : end + 1;
                    continue;
                }
                if (body.startsWith('/*', j)) {
                    const end = body.indexOf('*/', j);
                    j = end < 0 ? body.length : end + 2;
                    continue;
                }
                break;
            }
            if (body.startsWith('async', j) && !/[A-Za-z0-9_$]/.test(body[j + 5] ?? '')) {
                j += 5;
                while (j < body.length && /\s/.test(body[j])) j += 1;
            }
            const name = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(body.slice(j))?.[0];
            /* 成员三种写法都要认：`name() {}`、`name: () => {}`、以及简写 `{load}` / `{load,}` */
            const isMember = name && /^\s*[:(,}]/.test(body.slice(j + name.length));
            if (isMember) marks.push({name, start: i});
            atMemberStart = false;
            i = j + (name?.length ?? 0) - 1; // 让循环从名字之后继续（括号由深度跟踪处理）
            continue;
        }

        if (ch === '{' || ch === '(' || ch === '[') depth += 1;
        else if (ch === '}' || ch === ')' || ch === ']') depth -= 1;
        else if (ch === ',' && depth === 0) atMemberStart = true;
    }

    return marks.map((mark, index) => ({
        name: mark.name,
        body: body.slice(mark.start, index + 1 < marks.length ? marks[index + 1].start : body.length),
    }));
}

/* ---------------------------------------------------------------- 服务节点 */

const serviceNodes = new Map();

for (const path of sourceFiles(SERVICES)) {
    const source = readFileSync(path, 'utf8');
    const file = relative(root, path).split(sep).join('/');

    for (const match of source.matchAll(/export (?:async )?function ([A-Za-z0-9_]+)/g)) {
        serviceNodes.set(match[1], {file, body: functionBody(source, match.index)});
    }

    for (const match of source.matchAll(/export const ([A-Za-z_][A-Za-z0-9_]*) = \{/g)) {
        const objectName = match[1];
        const body = blockAfter(source, match.index);
        serviceNodes.set(objectName, {file, body});
        for (const member of objectMembers(body)) {
            serviceNodes.set(`${objectName}.${member.name}`, {file, body: member.body});
        }
    }
}

/* ---------------------------------------------------------------- 动作节点 */

/**
 * 切片文件里的**模块级局部函数**（`const load = async () => {}` / `function x() {}`）。
 *
 * 切片普遍把实现写成局部函数、再把名字塞进 `actions`（`{load}` 简写）或从局部函数里
 * 调别的局部函数（`candidatesOf` / `subscribeCore`）。不把它们串起来，
 * 节点体就是空的，`libraryService.*` 会被误判成没人用。
 */
function localFunctions(source) {
    const found = new Map();
    for (const match of source.matchAll(/(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\(|function\b)/g)) {
        found.set(match[1], functionBody(source, match.index));
    }
    for (const match of source.matchAll(/(?:^|\n)\s*(?:export\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
        found.set(match[1], functionBody(source, match.index));
    }
    return found;
}

/** 把节点体里引用到的局部函数体**递归**并进来（深度有限，切片文件本来就不大） */
function withLocalClosure(body, locals, depth = 0) {
    if (depth > 3) return body;
    let merged = body;
    for (const [name, localBody] of locals) {
        if (!new RegExp(`\\b${name}\\b`).test(body)) continue;
        merged += `\n${withLocalClosure(localBody, locals, depth + 1)}`;
    }
    return merged;
}

const actionNodes = new Map();

for (const path of sourceFiles(STORE)) {
    const name = basename(path);
    if (!name.endsWith('.slice.ts')) continue;
    const slice = name.replace('.slice.ts', '');
    const source = readFileSync(path, 'utf8');
    const file = relative(root, path).split(sep).join('/');
    const locals = localFunctions(source);

    const block = source.match(/const actions: [A-Za-z]+Actions = \{/);
    if (!block) continue;
    const body = blockAfter(source, block.index);

    for (const member of objectMembers(body)) {
        /* `{load}` 这种简写：真正的实现在同文件的局部定义里 */
        const bare = member.body.trim();
        const implementation = new RegExp(`^${member.name}$`).test(bare)
            ? (locals.get(member.name) ?? member.body)
            : member.body;
        actionNodes.set(`actions.${slice}.${member.name}`, {
            file,
            body: withLocalClosure(implementation, locals),
        });
    }
}

/* ---------------------------------------------------------------- 引用关系 */

const serviceKeys = [...serviceNodes.keys()];
const actionKeys = [...actionNodes.keys()];

/** 一段代码引用了哪些服务节点 / 动作节点 */
function references(body) {
    const services = new Set();
    const actions = new Set();

    for (const key of serviceKeys) {
        const [objectName, methodName] = key.split('.');
        const pattern = methodName
            ? new RegExp(`\\b${objectName}\\s*\\.\\s*${methodName}\\b`)
            : new RegExp(`\\b${key}\\b`);
        if (pattern.test(body)) services.add(key);
    }

    for (const key of actionKeys) {
        const [, slice, method] = key.split('.');
        if (new RegExp(`(?:getActions\\(\\)|\\.actions|\\bactions)\\s*\\.\\s*${slice}\\s*\\.\\s*${method}\\b`).test(body)) {
            actions.add(key);
        }
    }

    return {services, actions};
}

/* ---------------------------------------------------------------- 界面侧（根） */

const uiFiles = sourceFiles(join(root, 'src'), {exclude: [SERVICES, STORE]});
const uiSources = uiFiles.map((path) => {
    const original = readFileSync(path, 'utf8');
    /** 解构时可能改名（`const {add: addDownload} = useActions().download`）→ 记下别名 */
    const aliases = new Map();
    const text = original.replace(
        /const\s*\{([^}]*)\}\s*=\s*useActions\(\)\s*\.\s*([A-Za-z]+)\s*;/g,
        (_whole, names, slice) => {
            for (const part of String(names).split(',')) {
                const [from, to] = part.split(':').map((piece) => piece.trim());
                if (!from) continue;
                aliases.set(to || from, from);
            }
            return `useActions().${slice};`;
        },
    );
    return {
        path: relative(root, path).split(sep).join('/'),
        /* 文件里是否用 `useActions()` 取动作 */
        usesActions: /useActions\(\)/.test(original),
        /* 解构出来的**名字**已被剥掉（声明不等于调用），别名表补回「谁代表哪个动作」 */
        aliases,
        text,
    };
});

const reachableServices = new Set();
const reachableActions = new Set();

for (const [key, node] of serviceNodes) {
    const [objectName, methodName] = key.split('.');
    const pattern = methodName
        ? new RegExp(`\\b${objectName}\\s*\\.\\s*${methodName}\\b`)
        : new RegExp(`\\b${key}\\b`);
    if (uiSources.some((file) => pattern.test(file.text))) reachableServices.add(key);
    void node;
}

/** 视图既可能直接调用（`scan(...)`），也可能把动作当回调传下去（`onClick={next}` / `{onConfirm: clearRecent}`） */
const usedIn = (text, name) =>
    new RegExp(`(?:\\b${name}\\s*\\(|[{=:,]\\s*${name}\\b|\\b${name}\\s*[,}])`).test(text);

for (const key of actionNodes.keys()) {
    const [, , method] = key.split('.');
    const reached = uiSources.some((file) => {
        if (!file.usesActions) return false;
        if (usedIn(file.text, method)) return true;
        for (const [alias, target] of file.aliases) {
            if (target === method && usedIn(file.text, alias)) return true;
        }
        return false;
    });
    if (reached) reachableActions.add(key);
}

/* 不动点：可达节点引用到的节点也可达 */
for (let changed = true; changed; ) {
    changed = false;
    for (const [key, node] of serviceNodes) {
        if (!reachableServices.has(key)) continue;
        for (const ref of references(node.body).services) {
            if (!reachableServices.has(ref)) {
                reachableServices.add(ref);
                changed = true;
            }
        }
    }
    for (const [key, node] of actionNodes) {
        if (!reachableActions.has(key)) continue;
        const {services, actions} = references(node.body);
        for (const ref of services) {
            if (!reachableServices.has(ref)) {
                reachableServices.add(ref);
                changed = true;
            }
        }
        for (const ref of actions) {
            if (!reachableActions.has(ref)) {
                reachableActions.add(ref);
                changed = true;
            }
        }
    }
}

/** 服务节点能触及的契约命令（含它引用到的节点） */
function commandsOf(key, seen = new Set()) {
    if (seen.has(key)) return new Set();
    seen.add(key);
    const node = serviceNodes.get(key);
    if (!node) return new Set();
    const found = new Set();
    for (const match of node.body.matchAll(
        /'((?:system|plugin|catalog|library|recommend|playback|download|skin)\.[a-zA-Z0-9.]+)'/g,
    )) {
        found.add(match[1]);
    }
    for (const ref of references(node.body).services) {
        for (const command of commandsOf(ref, seen)) found.add(command);
    }
    return found;
}

/* 全大写常量（CORE_EVENTS / EVENT_NAME_PATTERN）是契约数据，不是能力入口 */
const isCapability = (key) => !/^[A-Z0-9_]+$/.test(key.split('.').pop());

const unreachable = [...serviceNodes.entries()]
    .filter(([key]) => isCapability(key) && !reachableServices.has(key))
    .map(([key, node]) => ({key, file: node.file, commands: [...commandsOf(key)].sort()}))
    .filter((node) => node.commands.length > 0 || /^core/.test(node.key));

const unexpected = unreachable.filter((node) => !(node.key in DELIBERATE));
const deadActions = [...actionNodes.keys()].filter((key) => !reachableActions.has(key));

console.log(
    `界面可达性检查（服务节点 ${serviceNodes.size} / 动作节点 ${actionNodes.size} / 界面文件 ${uiSources.length}）`,
);
for (const [key, reason] of Object.entries(DELIBERATE)) {
    if (!unreachable.some((node) => node.key === key)) {
        console.log(`  note  白名单里的 ${key} 已经接上界面了（请从 DELIBERATE 移除）`);
    } else {
        console.log(`  ok    有意不做入口：${key} —— ${reason}`);
    }
}

/* 没人调用的 store action 不算失败（可能只是持久化/调试用），但值得知道 */
const undocumentedActions = deadActions.filter((key) => !(key in DELIBERATE_ACTIONS));
for (const [key, reason] of Object.entries(DELIBERATE_ACTIONS)) {
    if (deadActions.includes(key)) {
        console.log(`  ok    有意不做界面入口（action）：${key} —— ${reason}`);
    } else {
        console.log(`  note  白名单里的 ${key} 已经有界面调用了（请从 DELIBERATE_ACTIONS 移除）`);
    }
}
if (undocumentedActions.length > 0) {
    console.log(
        `  note  ${undocumentedActions.length} 个 store action 没有界面调用：${undocumentedActions.join(', ')}`,
    );
}

if (unexpected.length > 0) {
    console.error('\n有实现、有封装，但**界面走不到**的服务节点：');
    for (const node of unexpected) {
        console.error(`  - ${node.key}（${node.file}）→ ${node.commands.join(', ') || '（无命令字面量）'}`);
    }
    console.error('\n要么接上界面，要么写进 scripts/check-reachability.mjs 的 DELIBERATE 并说明理由。');
    process.exit(1);
}

/* ---------------- 宠物域：命令是否真的能从界面走到 ---------------- */

/** 读 `pub const XXX: &[&str]` 清单 */
function rustConstList(source, constName) {
    const start = source.indexOf(`pub const ${constName}`);
    if (start < 0) return [];
    const body = source.slice(start, source.indexOf('];', start));
    return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const petCommands = rustConstList(
    readFileSync(join(root, 'pet-core', 'src', 'contract.rs'), 'utf8'),
    'PET_COMMAND_NAMES',
);
const petServicePath = 'src/services/core.pet.ts';
const petServiceSource = readFileSync(join(root, petServicePath), 'utf8');

/* 界面对应的方法名（命令 → 门面方法）：M1 的渲染适配器会调其中几个 */
const PET_METHODS = {
    'pet.atlas': 'atlas',
    'pet.state': 'state',
    'pet.tick': 'tick',
    'pet.install': 'install',
    'pet.setActive': 'setActive',
    'pet.interact': 'interact',
    'pet.remove': 'remove',
};

/* 界面侧文件里的文本（`uiSources` 已经排除了 services / store） */
const petUiText = uiSources.map((source) => source.text).join('\n');

const petBridged = petCommands.filter((command) => petServiceSource.includes(`'${command}'`));
const petUnbridged = petCommands.filter((command) => !petBridged.includes(command));
const petUnreachable = petBridged.filter((command) => {
    const method = PET_METHODS[command];
    return !(method && new RegExp(`petService\\.${method}\\b`).test(petUiText));
});

for (const [command, reason] of Object.entries(DELIBERATE_PET)) {
    if (!petUnreachable.includes(command)) {
        console.log(`  note   宠物的 ${command} 已经有界面调用了（请从 DELIBERATE_PET 移除）`);
    } else {
        console.log(`  ok    宠物命令有意暂不做入口：${command} —— ${reason}`);
    }
}

const petUnexpected = petUnreachable.filter((command) => !(command in DELIBERATE_PET));
if (petUnbridged.length > 0) {
    console.error(`\n宠物命令没有前端封装（${petServicePath}）→ ${petUnbridged.join(', ')}`);
    process.exit(1);
}
if (petUnexpected.length > 0) {
    console.error(`\n宠物命令有封装、但界面走不到 → ${petUnexpected.join(', ')}`);
    console.error('要么接上界面，要么写进 scripts/check-reachability.mjs 的 DELIBERATE_PET 并说明理由。');
    process.exit(1);
}
console.log(
    `  ok    宠物命令都能从界面走到或已登记为有意留白（${petCommands.length} 条，留白 ${petUnreachable.length} 条）`,
);

console.log(`  ok    所有契约能力都能从界面走到（有意留白 ${Object.keys(DELIBERATE).length} 项）`);
