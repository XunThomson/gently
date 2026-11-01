/**
 * 交付前的一次性验证：**前端 + 契约 + 界面可达性 + 核心**五道关卡一条命令跑完。
 *
 *   1. `tsc --noEmit`               —— 前端类型
 *   2. `node scripts/run-smoke.mjs` —— 冒烟（状态层 / 组件渲染 / i18n / CSS token 守卫）
 *   3. `node scripts/check-commands.mjs` —— 契约守卫（文档 ↔ Rust ↔ 前端服务层）
 *   4. `node scripts/check-reachability.mjs` —— 界面可达性守卫（契约能力能不能从界面走到）
 *   5. `cargo test -p gently-core`  —— 核心单测
 *
 * 用法：`pnpm verify`。
 *
 * 离线环境默认带 `--offline`（本机 registry 缓存已就绪）；需要联网拉依赖时用
 * `GENTLY_CARGO_ONLINE=1 pnpm verify`。离线模式要求该缓存可达——本机约定
 * `CARGO_HOME=F:\Develop\Rust\.cargo`（默认的 `~/.cargo` 里没有这份缓存）。
 */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url)) + path.sep + '..';

const online = Boolean(process.env.GENTLY_CARGO_ONLINE);
const cargoArgs = ['test', '-p', 'gently-core'];
const petArgs = ['test', '-p', 'pet-core'];
/** 宿主（src-tauri）自己的单测：窗口/光标相关的纯函数都在这儿（R100 起纳入关卡） */
const hostArgs = ['test', '-p', 'gently'];
if (!online) {
    cargoArgs.push('--offline');
    petArgs.push('--offline');
    hostArgs.push('--offline');
}

if (!online && !process.env.CARGO_HOME) {
    process.stdout.write(
        '提示：未设置 CARGO_HOME，离线模式将使用默认的 ~/.cargo（本机约定见 README/AGENTS）。\n',
    );
}

const steps = [
    {name: '前端类型检查', command: 'pnpm', args: ['run', 'typecheck']},
    {name: '冒烟测试', command: 'pnpm', args: ['run', 'smoke']},
    {name: '契约守卫', command: 'pnpm', args: ['run', 'check:contract']},
    {name: '界面可达性守卫', command: 'pnpm', args: ['run', 'check:reachability']},
    {name: '核心单测', command: 'cargo', args: cargoArgs},
    // 宠物是**独立引擎**（ADR 0010）：独立性与单测各自一道关卡，退化时立刻红
    {name: '宠物核心独立性守卫', command: 'pnpm', args: ['run', 'check:pet']},
    {name: '宠物核心单测', command: 'cargo', args: petArgs},
    {name: '宿主单测（窗口/光标）', command: 'cargo', args: hostArgs},
];

const failed = [];
for (const step of steps) {
    process.stdout.write(`\n=== ${step.name}：${step.command} ${step.args.join(' ')}\n`);

    // stdio: inherit —— 子进程直接写终端：既保留颜色与进度，也不需要管道
    const result = spawnSync(step.command, step.args, {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32', // Windows 上 pnpm 是 .cmd，需要 shell 才能找到
    });

    if (result.status !== 0) {
        failed.push(`${step.name}（退出码 ${result.status ?? '未知'}）`);
        break; // 前一道关卡失败时后面的结果没有参考价值
    }
}

if (failed.length > 0) {
    process.stderr.write(`\n验证失败：${failed.join('、')}\n`);
    process.exit(1);
}
process.stdout.write('\n全部验证通过 ✓（类型 / 冒烟 / 契约 / 可达性 / 核心单测 / 宠物独立性 / 宠物核心单测 / 宿主单测）\n');

