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
 *  2. 文档 §3 的事件清单 == `core/src/events.rs` 的 events::ALL；
 *  3. 文档 §1 的错误码表 == `core/src/contract/error.rs` 的 as_str() 返回值。
 *
 * 用法：`node scripts/check-commands.mjs`（`pnpm check:contract`）
 */

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const CONTRACT = 'docs/contracts/local-core-api.md';
const COMMANDS_RS = 'core/src/contract/commands.rs';
const EVENTS_RS = 'core/src/events.rs';
const ERROR_RS = 'core/src/contract/error.rs';

/** 命令名的域前缀（用于过滤文档里的非命令反引号 token，如 `common.conflict`） */
const DOMAINS = new Set(['system', 'plugin', 'catalog', 'library', 'recommend', 'playback', 'download', 'skin']);

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
 * 前端桥接层用到的命令名必须都在契约里：
 * TS 侧没有「命令清单」这种结构（类型是按域/方法组织的），
 * 唯一的点号字符串出现在 `invokeCore('<name>')` 调用处，因此在这里做单向校验，
 * 拼错或用了过期名字会立刻失败。
 */
function frontendCommandNames() {
    const files = ['src/services/core.bridge.ts'];
    const names = new Set();
    for (const file of files) {
        const source = read(file);
        for (const m of source.matchAll(/invokeCore<[^>]*>\(\s*'([^']+)'/g)) {
            names.add(m[1]);
        }
    }
    return names;
}

console.log('契约一致性检查（文档 ↔ Rust 清单 ↔ 前端桥接）');

const markdown = read(CONTRACT);
const commandsSection = section(markdown, '## 2. 命令清单');
const eventsSection = section(markdown, '## 3. 事件清单');
const errorsSection = section(markdown, '## 1. 信封与错误码');

diff('命令清单', extractCommandNames(commandsSection), rustCommandNames(read(COMMANDS_RS)), '若只是缩写写法（如 `.clear`），请在文档里写全名');
diff(
    '事件清单',
    docTokens(eventsSection, /`([a-z]+\.[a-zA-Z.]+)`/g),
    rustEventNames(read(EVENTS_RS)),
    '',
);
diff(
    '错误码',
    docTokens(errorsSection, /`([a-z]+\.[a-z_]+)`/g),
    rustErrorCodes(read(ERROR_RS)),
    '',
);

/* 前端桥接只用 Rust 契约里存在的命令名（单向：不必要求 54 条未实现命令都有桥接） */
const bridged = frontendCommandNames();
const known = rustCommandNames(read(COMMANDS_RS));
const stray = [...bridged].filter((name) => !known.has(name));
if (stray.length > 0) {
    note(`前端桥接使用了契约外的命令名 → ${stray.join(', ')}`);
} else {
    console.log(`  ok   前端桥接命令名（${bridged.size} 项都在契约内）`);
}

if (failures.length > 0) {
    console.error('\n契约不一致：');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}
console.log('\n契约一致 ✓');
