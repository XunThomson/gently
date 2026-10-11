/**
 * 便携版打包：把 release 二进制与随附文件打成可分发的 zip。
 *
 * 为什么需要它：Tauri 的 MSI / NSIS 安装包依赖 WiX / NSIS 工具链，**首次必须联网**下载；
 * 拿不到网络时仍然要能交付出可运行的东西。`gently.exe` 本身已经把前端资源编进二进制
 * （`frontendDist`），因此「exe + 说明 + 许可」就是一个完整的便携版。
 *
 * 用法：`pnpm package:portable`
 * 产物：`release/gently-<版本>-<平台>-<架构>.zip` + 同名 `.sha256`
 *
 * 校验：打包完会打印 SHA256，并校验 zip 内的 exe 与源文件字节一致（避免「打错文件」）。
 */
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const tauriConf = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));

const arch = process.arch === 'x64' ? 'x64' : process.arch;
const exeName = 'gently.exe';
const binary = path.join(root, 'src-tauri', 'target', 'release', exeName);

if (!existsSync(binary)) {
    process.stderr.write(
        `找不到 ${path.relative(root, binary)}。\n先跑一次打包：CARGO_NET_OFFLINE=true pnpm tauri build --no-bundle\n`,
    );
    process.exit(1);
}

const stageName = `gently-${pkg.version}-windows-${arch}`;
const releaseDir = path.join(root, 'release');
const stageDir = path.join(releaseDir, stageName);
const zipPath = path.join(releaseDir, `${stageName}.zip`);

rmSync(stageDir, {recursive: true, force: true});
mkdirSync(stageDir, {recursive: true});
copyFileSync(binary, path.join(stageDir, exeName));
copyFileSync(path.join(root, 'README.md'), path.join(stageDir, 'README.md'));

/** 便携版自带的说明：用户解压后第一眼看到的东西 */
const notice = `gently ${tauriConf.version}（Windows ${arch} 便携版）
========================================

直接双击 ${exeName} 即可运行，无需安装。

- 数据目录：%APPDATA%\\${tauriConf.identifier}\\（数据库、插件、皮肤、下载、缓存、日志）
  想彻底卸载：删掉这个目录与该 exe 即可，应用不在别处留东西。
- 没有服务器、没有账号、没有遥测：所有能力都在本机这个进程里。
- 应用不预置任何音源：插件由你自己导入（插件页支持粘贴文本 / 网络地址 / 本机路径）。
- 第一次运行时音量、主题等设置都是默认值。

已知限制（与 README 的「已知缺口」一节一致）：
- 第三方凭据在 **Windows 上存进系统凭据管理器**（目标名 \`gently:<插件 id>:<键>\`，重启后仍在）；
  **macOS / Linux 尚未接入**，那两个平台退回进程内存储（重启后要重填），设置页的诊断卡片会如实显示。
- 插件导入用「粘贴文本 / 网络地址 / 本机路径」（核心自己去读文件；Tauri 的 dialog 插件不在离线依赖里）。
  主题市场的「导入皮肤」用的是 WebView 自己的文件选择器，正常可用。
- 本包是便携版；MSI/NSIS 安装包需要联网下载一次打包工具链后才能生成。

完整说明见 README.md，架构与契约见 docs/ 目录。
`;

writeFileSync(path.join(stageDir, 'README-便携版.txt'), notice, 'utf8');

/**
 * 压缩：Windows 上用 PowerShell 的 Compress-Archive（系统自带、无额外依赖），
 * 其它平台退回 `zip` 命令。
 */
if (process.platform === 'win32') {
    const result = spawnSync(
        'powershell',
        [
            '-NoProfile',
            '-Command',
            `Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${zipPath}' -Force`,
        ],
        {stdio: 'inherit'},
    );
    if (result.status !== 0) {
        process.stderr.write('压缩失败。\n');
        process.exit(1);
    }
} else {
    const result = spawnSync('zip', ['-r', '-q', zipPath, stageName], {
        cwd: releaseDir,
        stdio: 'inherit',
    });
    if (result.status !== 0) {
        process.stderr.write('压缩失败（需要系统里有 zip 命令）。\n');
        process.exit(1);
    }
}

/** 校验：zip 里带的 exe 必须与刚构建出来的那份**字节一致** */
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const exeHash = sha256(binary);
writeFileSync(`${zipPath}.sha256`, `${exeHash}  ${exeName}\n`, 'utf8');

const sizeMb = (file) => (statSync(file).size / 1024 / 1024).toFixed(1);
process.stdout.write(
    [
        '',
        `便携版已生成：${path.relative(root, zipPath)}（${sizeMb(zipPath)} MB）`,
        `  目录：${path.relative(root, stageDir)}`,
        `  exe：${exeName}（${sizeMb(binary)} MB）`,
        `  SHA256：${exeHash}`,
        '',
        'MSI / NSIS 安装包请用 `pnpm tauri build`（首次需要联网下载 WiX / NSIS 工具链）。',
        '',
    ].join('\n'),
);
