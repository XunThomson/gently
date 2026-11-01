#!/usr/bin/env node
/**
 * 宠物核心的**独立性守卫**：`pet-core` 不许和音乐软件耦合。
 *
 * 为什么需要机械化检查（ADR 0010）：
 * - 宠物与音乐是两个领域，`pet-core` 要能**单独拆成仓库/应用**；
 * - 「依赖方向」这种东西靠人记必然出错——某天有人为了省事在 `pet-core` 里
 *   `use gently_core::AppPaths`，编译还照样通过，但拆库时就会发现整条数据路径都缠在一起；
 * - 因此每次 `pnpm verify` 都检查一遍，违反就是失败。
 *
 * 检查内容：
 *  1. `pet-core/Cargo.toml` 存在，且**没有** `path = ".."` 之类的仓内相对依赖；
 *  2. `pet-core` 不依赖 `tauri`（UI 可替换）与 `gently-core`（音乐核心）；
 *  3. `pet-core` 下的 .rs 文件里不出现 `gently_core` / `tauri::` 之类的引用；
 *  4. 反向也不许：`core/Cargo.toml`（音乐核心）不能依赖 `pet-core`；
 *  5. `pet-core` 是 workspace 成员（能 `cargo test -p pet-core`）。
 *
 * 用法：`node scripts/check-pet-independence.mjs`（`pnpm check:pet`，也在 `pnpm verify` 里）
 */
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const failures = [];
const note = (msg) => failures.push(msg);

/** 递归列出文件 */
function walk(dir, acc = []) {
    for (const entry of readdirSync(join(root, dir), {withFileTypes: true})) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
            if (entry.name === 'target') continue;
            walk(rel, acc);
        } else {
            acc.push(rel);
        }
    }
    return acc;
}

console.log('宠物核心独立性检查（pet-core ↔ 音乐核心 / UI 框架）');

/* ---------------- 1. Cargo.toml ---------------- */

const manifestPath = 'pet-core/Cargo.toml';
let manifest = '';
try {
    manifest = read(manifestPath);
} catch {
    note(`缺少 ${manifestPath}：宠物核心必须是一个独立 crate`);
}

if (manifest) {
    // 只看 [dependencies] 区段（[package] 里的 description 等不算）
    const depsStart = manifest.indexOf('[dependencies]');
    const deps = depsStart >= 0 ? manifest.slice(depsStart) : '';
    if (/path\s*=/.test(deps)) {
        note('pet-core 的依赖里出现 `path = ...`：独立 crate 不允许仓内相对依赖（拆库会失败）');
    }
    if (/^\s*tauri\s*=/m.test(deps)) {
        note('pet-core 依赖了 tauri：渲染层必须可替换，核心不许绑 UI 框架');
    }
    if (/gently[-_]core/.test(deps)) {
        note('pet-core 依赖了 gently-core：音乐数据处理与宠物养成必须各自独立');
    }
    if (/rusqlite|serde|thiserror/.test(deps) === false) {
        note('pet-core 的依赖看起来不完整（至少应有 serde / rusqlite / thiserror）');
    }
}

/* ---------------- 2. 源码里不许出现耦合引用 ---------------- */

const FORBIDDEN = [
    {pattern: /\bgently_core\b/, why: '引用音乐核心（gently_core）'},
    {pattern: /\btauri::/, why: '引用 tauri（UI 框架必须可替换）'},
    {pattern: /\bcrate::sound\b/, why: '引用不存在的音乐域模块'},
];

const rustFiles = walk('pet-core').filter((file) => file.endsWith('.rs'));
if (rustFiles.length === 0) note('pet-core 里没有任何 .rs 文件（是不是放错目录了？）');

for (const file of rustFiles) {
    const source = read(file);
    for (const {pattern, why} of FORBIDDEN) {
        if (pattern.test(source)) note(`${file} ${why}`);
    }
}

/* ---------------- 3. 反向依赖：音乐核心不许依赖宠物 ---------------- */

try {
    const coreManifest = read('core/Cargo.toml');
    const coreDeps = coreManifest.slice(coreManifest.indexOf('[dependencies]'));
    if (/pet[-_]core/.test(coreDeps)) {
        note('core/Cargo.toml 依赖了 pet-core：音乐核心与宠物核心必须互不依赖');
    }
} catch {
    note('读不到 core/Cargo.toml（仓库结构变了？）');
}

/* ---------------- 4. workspace 成员 ---------------- */

try {
    const workspace = read('Cargo.toml');
    if (!/members\s*=\s*\[[^\]]*"pet-core"[^\]]*\]/s.test(workspace)) {
        note('Cargo.toml 的 workspace members 里没有 "pet-core"（`cargo test -p pet-core` 会失败）');
    }
} catch {
    note('读不到根 Cargo.toml');
}

/* ---------------- 5. 数据必须是自己的库 ---------------- */

const store = rustFiles.find((file) => file.endsWith('store.rs'));
if (!store) {
    note('缺少 pet-core/src/store.rs：宠物资料必须有自己的存储层');
} else {
    const source = read(store);
    if (!/PET_DB_FILE/.test(source) || !/pet\.db/.test(source)) {
        note('pet-core 的存储层没有独立的库文件名（pet.db）');
    }
    if (/gently\.db/.test(source)) {
        note('pet-core 指向了音乐库（gently.db）：两者的数据必须分开');
    }
}

if (failures.length > 0) {
    console.error('\n独立性检查失败：');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}
console.log(
    `  ok   pet-core 独立（${rustFiles.length} 个 .rs 文件，无 gently-core / tauri 依赖，自带 pet.db）`,
);
