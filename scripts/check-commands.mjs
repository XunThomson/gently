#!/usr/bin/env node
/**
 * 契约守卫：比对 **契约文档 ↔ Rust 命令清单**。
 *
 * 为什么需要：命令名是跨语言 ABI（前端 `invoke`、文档、Rust 分发都以它为准），
 * 而它散落在两处自然语言/代码里，最容易出现「文档写了但没实现」或
 * 「实现了但没登记」。这个脚本把两处对齐，任何一侧漏改都会让 CI 失败。
 *
 * 检查内容：
 *  1. 文档 §2 的命令清单 == `core/src/contract/commands.rs` 的 COMMAND_NAMES；
 *  2. 文档 §3 的事件清单 == `core/src/events.rs` 的 events::ALL
 *     == `src/api/index.ts` 的 `CoreEventMap` 键 == `src/services/core.events.ts` 的 `CORE_EVENTS`
 *     （并按 Tauri 的事件名字符集校验：点号会让事件在桌面上整条丢失）；
 *  3. 文档 §1 的错误码表 == `core/src/contract/error.rs` 的 as_str() 返回值。
 *
 * 用法：`node scripts/check-commands.mjs`（`pnpm check:contract`）
 */

import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const CONTRACT = 'docs/contracts/local-core-api.md';
const COMMANDS_RS = 'core/src/contract/commands.rs';
const EVENTS_RS = 'core/src/events.rs';
const ERROR_RS = 'core/src/contract/error.rs';
const API_TS = 'src/api/index.ts';
const EVENTS_TS = 'src/services/core.events.ts';

/* 宠物域是**独立命名空间**（ADR 0010）：自己的契约文档、自己的错误码表、自己的命令清单。
   两者并列而不是包含关系，因此这里分开守——但同样双向比对，
   避免「加了 pet 命令却没人守」这种契约退化。 */
const PET_CONTRACT = 'docs/contracts/pet-core-api.md';
const PET_COMMANDS_RS = 'pet-core/src/contract.rs';
const PET_ERROR_RS = 'pet-core/src/error.rs';
const PET_DOMAIN = 'pet';

/** Tauri 的事件名校验字符集（`is_event_name_valid`）：超出就当事件丢失处理 */
const TRANSPORT_SAFE = /^[A-Za-z0-9\-/:_]+$/;

/** 命令名的域前缀（用于过滤文档里的非命令反引号 token，如 `common.conflict`） */
const DOMAINS = new Set(['system', 'plugin', 'auth', 'catalog', 'library', 'recommend', 'playback', 'download', 'skin']);

/** 形如文件名而不是命令名的 token（文档里会提到 plugin.json 等） */
const FILE_LIKE = /\.(json|js|ts|toml|md|sql|db)$/;

const failures = [];
const note = (msg) => failures.push(msg);

/** 截取文档中某个二级标题到下一个二级标题之间的内容 */
function section(markdown, heading) {
    const start = markdown.indexOf(heading);
    if (start < 0) throw new Error(`契约文档缺少章节：${heading}`);
    const rest = markdown.slice(start + heading.length);
    const end = rest.search(/\n## /);
    return end < 0 ? rest : rest.slice(0, end);
}

/** 从文档小节里抽取看起来像命令名的反引号 token */
function extractCommandNames(text) {
    const names = new Set();
    for (const match of text.matchAll(/`([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)(?:\{[^}]*\})?`/g)) {
        const name = match[1];
        const [domain] = name.split('.');
        if (!DOMAINS.has(domain)) continue; // `common.conflict` 之类不是命令
        if (FILE_LIKE.test(name)) continue; // `plugin.json` 是文件不是命令
        names.add(name);
    }
    return names;
}

/** 从 Rust 源里读 COMMAND_NAMES 字符串字面量 */
function rustCommandNames(source) {
    const block = source.slice(source.indexOf('pub const COMMAND_NAMES'));
    const body = block.slice(0, block.indexOf('];'));
    return new Set([...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

/** 读任意 `pub const XXX: &[&str] = &[...]` 清单（宠物域复用） */
function rustConstList(source, constName) {
    const start = source.indexOf(`pub const ${constName}`);
    if (start < 0) return null;
    const body = source.slice(start, source.indexOf('];', start));
    return new Set([...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

/** 文档里「表格行首列的反引号名字」：宠物契约与音乐契约都按这个写法解析 */
function docTableNames(sectionText) {
    const names = new Set();
    for (const line of sectionText.split('\n')) {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith('|')) continue;
        const match = trimmed.match(/\|\s*`([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+(?:\{[^}]*\})?)`/);
        if (!match) continue;
        // 单元格里写作 `pet.tick{petId, dtMs}`：花括号是参数提示，不属于命令名
        const name = match[1].split('{')[0];
        if (name.split('.')[0] !== PET_DOMAIN) continue;
        if (FILE_LIKE.test(name)) continue;
        names.add(name);
    }
    return names;
}

/** `pub const NAME: &str = "value";` → Map(NAME → value)：用于解析事件的标识符引用 */
function rustConstMap(source) {
    const map = new Map();
    for (const m of source.matchAll(/pub const ([A-Z0-9_]+): &str = "([^"]+)";/g)) {
        map.set(m[1], m[2]);
    }
    return map;
}

/**
 * 事件清单在 Rust 里是用常量标识符聚合的（`ALL: &[&str] = &[DOWNLOAD_DONE, ...]`），
 * 因此这里先把标识符解析回字符串，再与文档比对。
 */
function rustEventNames(source) {
    const map = rustConstMap(source);
    const block = source.slice(source.indexOf('pub const ALL'));
    const body = block.slice(0, block.indexOf('];'));
    const names = [];
    for (const m of body.matchAll(/"([^"]+)"|([A-Z][A-Z0-9_]+)/g)) {
        if (m[1]) names.push(m[1]);
        else if (map.has(m[2])) names.push(map.get(m[2]));
    }
    return new Set(names);
}

function rustErrorCodes(source) {
    const block = source.slice(source.indexOf('pub const fn as_str'));
    const body = block.slice(0, block.indexOf('\n    }'));
    return new Set([...body.matchAll(/"([a-z]+\.[a-z_]+)"/g)].map((m) => m[1]));
}

/** `src/api/index.ts` 的 `CoreEventMap` 键（前端事件类型只有类型、没有运行时值） */
function tsEventMapKeys(source) {
    const block = source.slice(source.indexOf('export interface CoreEventMap'));
    const body = block.slice(0, block.indexOf('\n}'));
    return new Set([...body.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
}

/** `src/services/core.events.ts` 的 `CORE_EVENTS` 值（运行时唯一的事件名定义处） */
function tsEventConstants(source) {
    const block = source.slice(source.indexOf('export const CORE_EVENTS'));
    const body = block.slice(0, block.indexOf('} as const'));
    return new Set([...body.matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => m[2]));
}

/**
 * 事件名必须落在 Tauri 接受的字符集里。
 *
 * 这不是风格问题：带点号的名字 `emit` 会报 `only alphanumeric, '-', '/', ':', '_' permitted`，
 * 于是**事件全部静默丢失**——流式搜索只能等超时、下载进度永远不动。所以在这里拦。
 */
function checkTransportSafe(label, names) {
    for (const name of names) {
        if (!TRANSPORT_SAFE.test(name)) {
            note(`${label}：事件名 \`${name}\` 含传输层不接受的字符（Tauri 只允许字母数字与 - / : _）`);
        }
    }
}

/** 文档侧的反引号 token（过滤掉文件名等非契约名） */
function docTokens(text, pattern) {
    const names = new Set();
    for (const m of text.matchAll(pattern)) {
        const name = m[1];
        if (FILE_LIKE.test(name)) continue;
        names.add(name);
    }
    return names;
}

function diff(label, documented, implemented, hint) {
    const missingInRust = [...documented].filter((n) => !implemented.has(n));
    const missingInDoc = [...implemented].filter((n) => !documented.has(n));
    if (missingInRust.length === 0 && missingInDoc.length === 0) {
        console.log(`  ok   ${label}（${documented.size} 项一致）`);
        return;
    }
    if (missingInRust.length > 0) {
        note(`${label}：文档里有、Rust 缺失 ${missingInRust.length} 项 → ${missingInRust.join(', ')}`);
    }
    if (missingInDoc.length > 0) {
        note(`${label}：Rust 里有、文档缺失 ${missingInDoc.length} 项 → ${missingInDoc.join(', ')}。${hint}`);
    }
}

/**
 * 前端服务层用到的命令名必须都在契约里。
 *
 * 这里做**字面量全量扫描**而不是只看 `invokeCore('<name>')`：很多命令是通过统一的
 * 包装函数（`detail<T>(command, params)` / `page<T>(command)`）转发的，命令名以普通字符串
 * 参数出现。把「域前缀的点号字面量」全部收集起来，再减去事件名与错误码，剩下的就必须是
 * 契约里的命令——拼错或用了过期名字会立刻失败。
 */
const SERVICE_LITERAL = /'((?:system|plugin|auth|catalog|library|recommend|playback|download|skin)\.[a-zA-Z0-9.]+)'/g;

function frontendCommandNames() {
    const dir = join(root, 'src/services');
    const files = readdirSync(dir)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => join(dir, name));
    const names = new Set();
    for (const file of files) {
        const source = readFileSync(file, 'utf8');
        for (const m of source.matchAll(SERVICE_LITERAL)) {
            const name = m[1];
            if (FILE_LIKE.test(name)) continue;
            names.add(name);
        }
    }
    return names;
}

console.log('契约一致性检查（文档 ↔ Rust 清单 ↔ 前端桥接）');

const markdown = read(CONTRACT);
const commandsSection = section(markdown, '## 2. 命令清单');
const eventsSection = section(markdown, '## 3. 事件清单');
const errorsSection = section(markdown, '## 1. 信封与错误码');

/**
 * 事件清单先算出来：命令小节里会自然地提到事件（例如「进度经 `library:scan:progress` 推送」），
 * 那些 token 不是命令。不把它们从命令集合里剔除的话，守卫会因为一句说明文字而失败。
 */
const rustEvents = rustEventNames(read(EVENTS_RS));
const documentedCommands = new Set(
    [...extractCommandNames(commandsSection)].filter((name) => !rustEvents.has(name)),
);

diff('命令清单', documentedCommands, rustCommandNames(read(COMMANDS_RS)), '若只是缩写写法（如 `.clear`），请在文档里写全名');
/* 事件名只从 §3 的表格行首取：正文里的说明文字、Rust 路径（`plugin::transport::x`）都不是清单 */
diff(
    '事件清单（文档 ↔ Rust）',
    docTokens(eventsSection, /^\|\s*`([a-z][a-z0-9]*(?::[a-z0-9]+)+)`/gm),
    rustEvents,
    '',
);
diff('事件清单（Rust ↔ 前端类型）', tsEventMapKeys(read(API_TS)), rustEvents, '请同步 `src/api/index.ts` 的 CoreEventMap');
diff('事件清单（Rust ↔ 前端常量）', tsEventConstants(read(EVENTS_TS)), rustEvents, '请同步 `src/services/core.events.ts`');
checkTransportSafe('事件清单', rustEvents);
diff(
    '错误码',
    docTokens(errorsSection, /`([a-z]+\.[a-z_]+)`/g),
    rustErrorCodes(read(ERROR_RS)),
    '',
);

/* 前端服务层只用 Rust 契约里存在的命令名（事件名与错误码从字面量集合里剔除） */
const rustErrors = rustErrorCodes(read(ERROR_RS));
const bridged = new Set([...frontendCommandNames()].filter((n) => !rustEvents.has(n) && !rustErrors.has(n)));
const known = rustCommandNames(read(COMMANDS_RS));
const stray = [...bridged].filter((name) => !known.has(name));
if (stray.length > 0) {
    note(`前端服务层使用了契约外的命令名 → ${stray.join(', ')}`);
} else {
    console.log(`  ok   前端服务层命令名（${bridged.size} 项都在契约内）`);
}

/* 反向：已实现且 UI 需要的命令是否都有前端封装（避免「后端有、前端没接线」） */
const unbridged = [...known].filter((name) => !bridged.has(name));
if (unbridged.length > 0) {
    note(`契约命令没有前端封装 → ${unbridged.join(', ')}`);
} else {
    console.log(`  ok   契约命令全部有前端封装（${known.size} 项）`);
}

/* ---------------- 宠物域：独立命名空间（ADR 0010） ---------------- */

const petMarkdown = read(PET_CONTRACT);
const petDocCommands = docTableNames(section(petMarkdown, '## 2. 命令清单'));
const petRustCommands = rustConstList(read(PET_COMMANDS_RS), 'PET_COMMAND_NAMES');
if (petRustCommands === null) {
    note(`读不到 ${PET_COMMANDS_RS} 的 PET_COMMAND_NAMES：宠物域契约清单必须存在于代码里`);
} else {
    diff('宠物命令清单（文档 ↔ Rust）', petDocCommands, petRustCommands, '宠物命令要先登记契约文档 §2，再改进程清单');
}

diff(
    '宠物错误码',
    docTokens(section(petMarkdown, '## 1. 信封与错误码'), /`(pet\.[a-z_]+)`/g),
    rustErrorCodes(read(PET_ERROR_RS)),
    '请同步 `pet-core/src/error.rs` 的 as_str() 与文档 §1',
);

/* 前端服务层一旦出现 `pet.*` 字面量，就必须是已登记的命令（M1 起生效）。
   注意排除宠物**错误码**：它们也是 `pet.*` 形状，但不是命令。 */
const petErrorCodes = rustErrorCodes(read(PET_ERROR_RS));
const petLiterals = new Set();
{
    const dir = join(root, 'src/services');
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.ts'))) {
        const source = readFileSync(join(dir, name), 'utf8');
        for (const m of source.matchAll(/'((?:pet)\.[a-zA-Z0-9.]+)'/g)) {
            if (!petErrorCodes.has(m[1])) petLiterals.add(m[1]);
        }
    }
}
const strayPet = petRustCommands
    ? [...petLiterals].filter((name) => !petRustCommands.has(name))
    : [...petLiterals];
if (strayPet.length > 0) {
    note(`前端服务层使用了宠物契约外的命令名 → ${strayPet.join(', ')}`);
} else {
    console.log(`  ok   宠物命令（文档 ↔ Rust ↔ 前端字面量，${petRustCommands?.size ?? 0} 项）`);
}

if (failures.length > 0) {
    console.error('\n契约不一致：');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}
console.log('\n契约一致 ✓');
