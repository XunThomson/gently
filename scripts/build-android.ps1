<#
.SYNOPSIS
  安卓一键构建（Windows 本机）：pnpm build + pnpm tauri android build → release/*.apk + 同名 .sha256。

.DESCRIPTION
  为什么需要：ANDROID-PLAN 里的构建步骤是给人工执行的（同一会话里先设 ANDROID_HOME / NDK_HOME、
  只出 arm64 要加 `-t aarch64`、传 `--apk`、再到 gen/android 的产物目录里翻 APK、最后手算 SHA256）。
  任何一步漏掉都会得到「构建失败但看不出原因」或「拿错 ABI 的包」。这个脚本把
  「环境检查 → 前端构建 → Tauri 安卓构建 → 收集产物 → 写校验文件」收成一条命令。

  它做的事：
    1) 检查 pnpm / node / cargo / rustup / java / ANDROID_HOME / NDK / rust android target /
       QuickJS 的 android 绑定（缺什么给**一条可执行的中文修复建议**，绝不静默继续）；
    2) 前端：`pnpm build`，并显式设 `TAURI_ENV_PLATFORM=android`——Tauri 的 beforeBuildCommand
       也是在这个环境变量下跑 vite 的，`vite.config.ts` 据此把 110 MB 演示视频从安卓产物里剔除
       （R123）。不设就会把桌面的那份 dist 打进 APK。
    3) 安卓：`pnpm tauri android build --apk`，默认 debug（`--debug`）、release 是 CLI 的默认模式
       （`tauri android build --help` 里没有 `--release` 参数，只有 `-d/--debug`）；
       目标 ABI 用 `-t <aarch64|armv7|x86_64>`，`universal` 表示不传 `-t`（Tauri 的 universal flavor
       会要求四个 ABI 全部编译）。
    4) 用 `-c` 传一份**临时 JSON** 把 `build.beforeBuildCommand` 置空：Tauri 默认会再跑一次
       `pnpm build`，既慢，又会让 `-SkipWeb` 形同虚设。临时文件写在 %TEMP%，结束即删
       （不能内联 JSON：PowerShell → pnpm.cmd 会把双引号吞掉，cli 会报 `key must be a string`，已实测）。
    5) 从 `src-tauri/gen/android/app/build/outputs/apk/<flavor>/<variant>/` 取 APK，复制到
       `release/gently-<版本>-android-<variant>.apk`（同名旧文件先删），写与 `scripts/package-portable.mjs`
       一致的 `<sha256>  <文件名>` 校验文件，并打印路径 / 大小 / SHA256 / adb 安装命令。

  产物命名：
    - 默认 `-Target aarch64`：`release/gently-<版本>-android-<debug|release>.apk`
    - 显式其它 ABI：`release/gently-<版本>-android-<variant>-<target>.apk`
      （不同 ABI 追加后缀，避免 A、B 两次构建互相覆盖；默认 arm64 沿用现有命名）

  release 说明：Tauri/Gradle 只有在 gen/android 配了签名（keystore.properties + signingConfigs）时
  才会产出可安装的 release APK；没配时 Gradle 产出的 `app-*-release-unsigned.apk` 装不上，
  所以脚本在 -Release 下会把它当阻塞项（-Check 里报 MISS，真实构建时提前退出）并给出修复建议。

  退出码：
    - `-Check`：0 = 环境齐备（可以构建）；1 = 有缺失/未确认。输出里会写「仅检查，未构建」。
    - 构建：0 = APK 已生成；非 0 = 检查不过 / 前端或 Tauri 构建失败（Tauri 原始输出保持原样）。

.PARAMETER Release
  打 release 变体（默认 debug）。release 是 Tauri CLI 的默认模式，脚本不再传 `--release`（CLI 没有这个参数）。

.PARAMETER SkipWeb
  跳过脚本自己的 `pnpm build`，复用现有 `dist/`。脚本仍会置空 Tauri 的 beforeBuildCommand，
  所以这次不会再偷偷构建一次前端。dist 不存在时直接报阻塞。

.PARAMETER Check
  只检查环境并打印将要执行的命令，不构建、不写 release/。

.PARAMETER Target
  目标 ABI：aarch64（默认）/ armv7 / x86_64 / universal。
  universal = 不传 -t，由 Tauri 的 universal flavor 合并四个 ABI（需要四个 ABI 的 QuickJS 绑定都齐）。

.PARAMETER AndroidHome
  Android SDK 根目录。默认取 ANDROID_HOME / ANDROID_SDK_ROOT，再退回 %LOCALAPPDATA%\Android\Sdk。

.PARAMETER NdkHome
  NDK 目录（含 source.properties 与 toolchains\llvm\prebuilt\windows-x86_64\bin）。
  默认取 NDK_HOME，再自动挑 $AndroidHome\ndk 下版本号最大的一个。

.PARAMETER JavaHome
  JDK 根目录（含 bin\java.exe）。默认取 JAVA_HOME。AGP 8 要求 JDK 17+。

.PARAMETER CargoHome
  CARGO_HOME 根目录（含 bin\cargo.exe）。默认取 CARGO_HOME，再退回 %USERPROFILE%\.cargo。

.EXAMPLE
  pnpm build:android                     # 一条命令：debug APK（aarch64）→ release/

.EXAMPLE
  pwsh -NoProfile -File scripts/build-android.ps1 -Check
  # 只检查，并打印将要执行的命令；缺环境时退出 1

.EXAMPLE
  pwsh -NoProfile -File scripts/build-android.ps1 -Target universal -Check
  # 校验「四个 ABI 全出」是否真的支持（当前 vendor 只补了 arm64 绑定 → 会报缺绑定）

.EXAMPLE
  pwsh -NoProfile -File scripts/build-android.ps1 -SkipWeb -Release
  # 复用现有 dist，打 release（需要先配好签名）
#>
[CmdletBinding()]
param(
    [switch]$Release,
    [switch]$SkipWeb,
    [switch]$Check,
    [ValidateSet('aarch64', 'armv7', 'x86_64', 'universal')]
    [string]$Target = 'aarch64',
    [string]$AndroidHome,
    [string]$NdkHome,
    [string]$JavaHome,
    [string]$CargoHome
)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
$script:checks = New-Object System.Collections.Generic.List[object]

function Add-Check {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][ValidateSet('OK', 'MISS', 'WAIT', 'INFO')][string]$Status,
        [string]$Detail = '',
        [string]$Fix = ''
    )
    $script:checks.Add([pscustomobject]@{ Name = $Name; Status = $Status; Detail = $Detail; Fix = $Fix })
}

function Get-Setting {
    param([Parameter(Mandatory)][string]$Name)
    # 进程环境变量 > 用户环境变量 > 系统环境变量（注册表只读），与 scripts/android-env.ps1 一致
    $v = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, 'User') }
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, 'Machine') }
    return $v
}

function Invoke-Captured {
    # 返回 @{ Ok = bool; Text = string }
    # 直接捕获优先；受限终端禁止管道时退回「重定向到临时文件」（与 scripts/android-env.ps1 同一套办法）。
    param([Parameter(Mandatory)][string[]]$ArgList)
    $exe = $ArgList[0]
    $rest = @()
    if ($ArgList.Count -gt 1) { $rest = @($ArgList[1..($ArgList.Count - 1)]) }

    try {
        $text = & $exe @rest 2>&1 | Out-String
        if ($text -and $text.Trim()) { return @{ Ok = $true; Text = $text.Trim() } }
    } catch { }

    $resolved = $exe
    if (-not (Test-Path $exe)) {
        $cmd = Get-Command $exe -ErrorAction SilentlyContinue
        if ($cmd) { $resolved = $cmd.Source }
    }
    if (-not (Test-Path $resolved)) { return @{ Ok = $false; Text = "找不到可执行文件：$exe" } }

    $outFile = $null; $errFile = $null
    try {
        $outFile = (New-TemporaryFile).FullName
        $errFile = (New-TemporaryFile).FullName
        $null = Start-Process -FilePath $resolved -ArgumentList $rest -RedirectStandardOutput $outFile `
            -RedirectStandardError $errFile -NoNewWindow -Wait -PassThru
        $stdout = Get-Content $outFile -Raw -ErrorAction SilentlyContinue
        $stderr = Get-Content $errFile -Raw -ErrorAction SilentlyContinue
        $text = (@($stdout, $stderr) | Where-Object { $_ }) -join "`n"
        return @{ Ok = $true; Text = ([string]$text).Trim() }
    } catch {
        return @{ Ok = $false; Text = $_.Exception.Message }
    } finally {
        foreach ($f in @($outFile, $errFile)) { if ($f) { Remove-Item $f -Force -ErrorAction SilentlyContinue } }
    }
}

# ---- 目标 ABI 元数据 ---------------------------------------------------------
# flavor 名来自 gen/android/buildSrc 的 RustPlugin（productFlavors: universal + arm64/arm/x86/x86_64），
# 所以 Tauri 的 -t aarch64 产物在 apk\arm64\<variant>\，universal 在 apk\universal\<variant>\。
$targetInfo = @{
    aarch64 = @{ Triple = 'aarch64-linux-android'; Flavor = 'arm64'; Clang = 'aarch64-linux-android24-clang.cmd' }
    armv7   = @{ Triple = 'armv7-linux-androideabi'; Flavor = 'arm'; Clang = 'armv7a-linux-androideabi24-clang.cmd' }
    i686    = @{ Triple = 'i686-linux-android'; Flavor = 'x86'; Clang = 'i686-linux-android24-clang.cmd' }
    x86_64  = @{ Triple = 'x86_64-linux-android'; Flavor = 'x86_64'; Clang = 'x86_64-linux-android24-clang.cmd' }
}
$requiredTargets = if ($Target -eq 'universal') { @('aarch64', 'armv7', 'i686', 'x86_64') } else { @($Target) }
$flavor = if ($Target -eq 'universal') { 'universal' } else { $targetInfo[$Target].Flavor }
$variant = if ($Release) { 'release' } else { 'debug' }
$neededTriples = @($requiredTargets | ForEach-Object { $targetInfo[$_].Triple })

# ---- 解析路径（参数 > 环境变量 > 约定默认值；不在仓库里写死任何本机路径）--------
$sdkRoot = $null
$sdkSource = ''
if ($AndroidHome) {
    $sdkRoot = $AndroidHome; $sdkSource = '-AndroidHome'
} else {
    $sdkRoot = Get-Setting 'ANDROID_HOME'
    if ($sdkRoot) { $sdkSource = 'ANDROID_HOME' }
    else {
        $sdkRoot = Get-Setting 'ANDROID_SDK_ROOT'
        if ($sdkRoot) { $sdkSource = 'ANDROID_SDK_ROOT' }
    }
    if (-not $sdkRoot -and $env:LOCALAPPDATA) {
        $defaultSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
        if (Test-Path $defaultSdk) { $sdkRoot = $defaultSdk; $sdkSource = '默认路径 %LOCALAPPDATA%\Android\Sdk' }
    }
}

$ndkRoot = $null
$ndkSource = ''
if ($NdkHome) {
    $ndkRoot = $NdkHome; $ndkSource = '-NdkHome'
} else {
    $envNdk = Get-Setting 'NDK_HOME'
    if ($envNdk -and (Test-Path $envNdk)) { $ndkRoot = $envNdk; $ndkSource = 'NDK_HOME' }
}
if (-not $ndkRoot -and $sdkRoot -and (Test-Path (Join-Path $sdkRoot 'ndk'))) {
    $ndkDirs = @(Get-ChildItem (Join-Path $sdkRoot 'ndk') -Directory -ErrorAction SilentlyContinue |
        Sort-Object { if ($_.Name -match '^(\d+)\.(\d+)\.(\d+)') { [int]$matches[1] * 1000000 + [int]$matches[2] * 1000 + [int]$matches[3] } else { 0 } })
    if ($ndkDirs.Count -gt 0) { $ndkRoot = $ndkDirs[-1].FullName; $ndkSource = '自动查找 $ANDROID_HOME\ndk 下最新版本' }
}

$jdkRoot = $null
$jdkSource = ''
if ($JavaHome) {
    $jdkRoot = $JavaHome; $jdkSource = '-JavaHome'
} else {
    $jdkRoot = Get-Setting 'JAVA_HOME'
    if ($jdkRoot) { $jdkSource = 'JAVA_HOME' }
}

$cargoRoot = $null
$cargoSource = ''
if ($CargoHome) {
    $cargoRoot = $CargoHome; $cargoSource = '-CargoHome'
} else {
    $cargoRoot = Get-Setting 'CARGO_HOME'
    if ($cargoRoot) { $cargoSource = 'CARGO_HOME' }
    elseif ($env:USERPROFILE -and (Test-Path (Join-Path $env:USERPROFILE '.cargo'))) {
        $cargoRoot = Join-Path $env:USERPROFILE '.cargo'; $cargoSource = '默认路径 %USERPROFILE%\.cargo'
    }
}

# ---- 读版本与 compileSdk ------------------------------------------------------
$pkgVersion = '0.0.0'
try {
    $pkg = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
    if ($pkg.version) { $pkgVersion = [string]$pkg.version }
} catch { }

$gradleAppFile = Join-Path $repoRoot 'src-tauri\gen\android\app\build.gradle.kts'
$compileSdk = 36
if (Test-Path $gradleAppFile) {
    $m = Select-String -Path $gradleAppFile -Pattern 'compileSdk\s*=\s*(\d+)' | Select-Object -First 1
    if ($m) { $compileSdk = [int]$m.Matches.Groups[1].Value }
}

Write-Host ''
Write-Host ('gently 安卓一键构建    ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')) -ForegroundColor Cyan
Write-Host ('仓库：' + $repoRoot)
Write-Host ('目标：-Target ' + $Target + '（' + ($neededTriples -join ', ') + '）· 变体：' + $variant + ' · 版本：' + $pkgVersion)
Write-Host ('Android SDK：' + $(if ($sdkRoot) { "$sdkRoot（$sdkSource）" } else { '(未设置)' }))
Write-Host ('NDK：' + $(if ($ndkRoot) { "$ndkRoot（$ndkSource）" } else { '(未设置)' }))
Write-Host ('JDK：' + $(if ($jdkRoot) { "$jdkRoot（$jdkSource）" } else { '(未设置)' }))
Write-Host ('CARGO_HOME：' + $(if ($cargoRoot) { "$cargoRoot（$cargoSource）" } else { '(未设置)' }))
if ($Check) { Write-Host '模式：仅检查（-Check），不会构建、不会写 release/' -ForegroundColor Yellow }
Write-Host ''

# ---- 1. 基础工具链 ------------------------------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $r = Invoke-Captured @('node', '--version')
    Add-Check 'node' 'OK' $(if ($r.Ok -and $r.Text) { 'node ' + $r.Text } else { $nodeCmd.Source + '（版本未取到）' })
} else {
    Add-Check 'node' 'MISS' 'PATH 里没有 node' '装 Node.js 20+（https://nodejs.org），或在 nvm 里 nvm use <版本> 后重开终端'
}

$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
if ($pnpmCmd) {
    $r = Invoke-Captured @('pnpm', '--version')
    Add-Check 'pnpm' 'OK' $(if ($r.Ok -and $r.Text) { 'pnpm ' + $r.Text } else { $pnpmCmd.Source + '（版本未取到）' })
} else {
    Add-Check 'pnpm' 'MISS' 'PATH 里没有 pnpm' 'npm i -g pnpm（或 corepack enable pnpm），然后重开终端'
}

$cargoExe = $null
$cargoOverrideBroken = $false
if ($CargoHome -and -not (Test-Path (Join-Path $CargoHome 'bin\cargo.exe'))) {
    # 显式 -CargoHome 指错时不要偷偷改用 PATH 上的另一个 cargo
    $cargoOverrideBroken = $true
} elseif ($cargoRoot -and (Test-Path (Join-Path $cargoRoot 'bin\cargo.exe'))) {
    $cargoExe = Join-Path $cargoRoot 'bin\cargo.exe'
} elseif (Get-Command cargo -ErrorAction SilentlyContinue) {
    $cargoExe = (Get-Command cargo).Source
}
if ($cargoExe) {
    $r = Invoke-Captured @($cargoExe, '--version')
    Add-Check 'cargo' 'OK' $(if ($r.Ok -and $r.Text) { $r.Text } else { $cargoExe + '（版本未取到）' })
} else {
    $detail = if ($cargoOverrideBroken) { '-CargoHome 指向的目录没有 bin\cargo.exe：' + $cargoRoot } else { '找不到 cargo（CARGO_HOME=' + $(if ($cargoRoot) { $cargoRoot } else { '(未设置)' }) + '）' }
    Add-Check 'cargo' 'MISS' $detail '装 Rust（rustup-init）后重开终端；已装但不在默认位置时用 -CargoHome 指到 cargo 根目录（含 bin\cargo.exe）'
}

$rustupExe = $null
if ($cargoRoot -and (Test-Path (Join-Path $cargoRoot 'bin\rustup.exe'))) {
    $rustupExe = Join-Path $cargoRoot 'bin\rustup.exe'
} elseif (Get-Command rustup -ErrorAction SilentlyContinue) {
    $rustupExe = (Get-Command rustup).Source
}
if ($rustupExe) {
    $r = Invoke-Captured @($rustupExe, '--version')
    $firstLine = ''
    if ($r.Ok -and $r.Text) { $firstLine = ($r.Text -split "`r?`n")[0].Trim() }
    Add-Check 'rustup' 'OK' $(if ($firstLine) { $firstLine } else { $rustupExe + '（版本未取到）' })
} else {
    Add-Check 'rustup' 'MISS' '找不到 rustup（rust android target 由它管理）' '从 https://rustup.rs 装 rustup（与 cargo 一起），或把 -CargoHome 指到已装 rustup 的 cargo 根目录'
}

$javaExe = $null
$javaOverrideBroken = $false
if ($jdkRoot -and (Test-Path (Join-Path $jdkRoot 'bin\java.exe'))) {
    $javaExe = Join-Path $jdkRoot 'bin\java.exe'
} elseif ($JavaHome) {
    # 显式 -JavaHome 指错时不要偷偷改用 PATH 上的另一个 JDK
    $javaOverrideBroken = $true
} elseif (Get-Command java -ErrorAction SilentlyContinue) {
    $javaExe = (Get-Command java).Source
}
if ($javaExe) {
    $r = Invoke-Captured @($javaExe, '-version')
    $javaText = if ($r.Ok) { $r.Text } else { '' }
    $major = 0
    if ($javaText -match 'version "(\d+)(?:\.(\d+))?') {
        $major = [int]$Matches[1]
        if ($major -eq 1 -and $Matches[2]) { $major = [int]$Matches[2] }
    }
    $javaLine = (($javaText -split "`r?`n") | Where-Object { $_ -match 'version "' } | Select-Object -First 1)
    if (-not $javaLine) { $javaLine = $javaExe }
    if ($major -eq 0) {
        Add-Check 'java' 'WAIT' ($javaLine.Trim() + '（版本号读不出来）') '在普通终端里跑一次 java -version；确认是 JDK 17+，或用 -JavaHome 指到 JDK 根目录'
    } elseif ($major -lt 17) {
        Add-Check 'java' 'MISS' ($javaLine.Trim() + "（AGP 8 需要 JDK 17+）") '装 JDK 17，并用 -JavaHome 指到 JDK 根目录（或设 JAVA_HOME）；只改 PATH 不够，Gradle 先认 JAVA_HOME'
    } else {
        Add-Check 'java' 'OK' $javaLine.Trim()
    }
} else {
    $javaDetail = if ($javaOverrideBroken) { '-JavaHome 指向的目录没有 bin\java.exe：' + $jdkRoot } else { 'JAVA_HOME=' + $(if ($jdkRoot) { $jdkRoot } else { '(未设置)' }) + '，PATH 里也没有 java' }
    Add-Check 'java' 'MISS' $javaDetail '装 JDK 17（AGP 8 要求）；用 -JavaHome 或 JAVA_HOME 指到 JDK 根目录（含 bin\java.exe），只改 PATH 不够，Gradle 先认 JAVA_HOME'
}

# ---- 2. Android SDK / platform / build-tools ----------------------------------
$sdkPlatforms = @()
$sdkBuildTools = @()
if (-not $sdkRoot) {
    Add-Check 'Android SDK' 'MISS' 'ANDROID_HOME / ANDROID_SDK_ROOT 未设置，也没有默认的 %LOCALAPPDATA%\Android\Sdk' '装 Android SDK（Android Studio → SDK Manager），然后设 ANDROID_HOME，或用 -AndroidHome 指到 SDK 根目录（ANDROID-PLAN P0-1）'
} elseif (-not (Test-Path $sdkRoot)) {
    Add-Check 'Android SDK' 'MISS' ('目录不存在：' + $sdkRoot) '把 -AndroidHome / ANDROID_HOME 改成真实的 SDK 根目录（含 platforms、build-tools、platform-tools）'
} else {
    $sdkPlatforms = @(Get-ChildItem (Join-Path $sdkRoot 'platforms') -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
    $sdkBuildTools = @(Get-ChildItem (Join-Path $sdkRoot 'build-tools') -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
    $missingSdk = @()
    if ($sdkPlatforms -notcontains ('android-' + $compileSdk)) { $missingSdk += ('platforms;android-' + $compileSdk) }
    if ($sdkBuildTools.Count -eq 0) { $missingSdk += 'build-tools;35.0.0' }
    if (-not (Test-Path (Join-Path $sdkRoot 'platform-tools\adb.exe'))) { $missingSdk += 'platform-tools' }
    if ($missingSdk.Count -gt 0) {
        $fix = 'sdkmanager --sdk_root="' + $sdkRoot + '" ' + (($missingSdk | ForEach-Object { '"' + $_ + '"' }) -join ' ')
        Add-Check 'Android SDK' 'MISS' ('缺：' + ($missingSdk -join '、') + '（compileSdk=' + $compileSdk + '）') $fix
    } else {
        Add-Check 'Android SDK' 'OK' ('platforms ' + ($sdkPlatforms -join '/') + ' · build-tools ' + ($sdkBuildTools -join '/'))
    }
}

# ---- 3. NDK 与目标 ABI 的 clang 包装器 ----------------------------------------
$ndkBinDir = $null
if (-not $ndkRoot) {
    Add-Check 'NDK' 'MISS' '找不到 NDK（NDK_HOME 未设，$ANDROID_HOME\ndk 也没有可用版本）' '用 sdkmanager 装 NDK（r23+，本仓库实测 28.2.13676358），然后设 NDK_HOME，或用 -NdkHome 指到 ndk\<版本>（ANDROID-PLAN P0-2）'
} elseif (-not (Test-Path $ndkRoot)) {
    Add-Check 'NDK' 'MISS' ('目录不存在：' + $ndkRoot) '把 -NdkHome / NDK_HOME 改成真实的 NDK 目录（含 source.properties）'
} else {
    $ndkProps = Join-Path $ndkRoot 'source.properties'
    $ndkBinDir = Join-Path $ndkRoot 'toolchains\llvm\prebuilt\windows-x86_64\bin'
    if (-not (Test-Path $ndkProps) -or -not (Test-Path $ndkBinDir)) {
        Add-Check 'NDK' 'MISS' ('不是完整 NDK：' + $ndkRoot + '（缺 source.properties 或 toolchains\llvm\prebuilt\windows-x86_64\bin）') '换完整 NDK（r23+，Windows 的 prebuilt 目录必须带 clang 包装器），或用 -NdkHome 指到正确目录'
    } else {
        $ndkRev = ''
        $revLine = Select-String -Path $ndkProps -Pattern '^Pkg\.Revision' | Select-Object -First 1
        if ($revLine) { $ndkRev = $revLine.Line.Trim() }
        Add-Check 'NDK' 'OK' ($ndkRoot + $(if ($ndkRev) { ' · ' + $ndkRev } else { '' }))
    }
}

if ($ndkBinDir -and (Test-Path $ndkBinDir)) {
    $missingClang = @()
    foreach ($t in $requiredTargets) {
        $clangName = $targetInfo[$t].Clang
        if (-not (Test-Path (Join-Path $ndkBinDir $clangName))) { $missingClang += $clangName }
    }
    if ($missingClang.Count -gt 0) {
        Add-Check ('NDK clang (' + $Target + ')') 'MISS' ('缺：' + ($missingClang -join '、')) '换 r23+ 的完整 NDK（脚本按 API 24 包装器检查），或用 -NdkHome 指到完整 NDK；只装 arm64 时用 -Target aarch64'
    } else {
        Add-Check ('NDK clang (' + $Target + ')') 'OK' (($requiredTargets | ForEach-Object { $targetInfo[$_].Clang }) -join '、')
    }
}

# ---- 4. rust android target + QuickJS 绑定 ------------------------------------
$installedTargets = @()
if ($rustupExe) {
    $r = Invoke-Captured @($rustupExe, 'target', 'list', '--installed')
    if ($r.Ok -and $r.Text) {
        $installedTargets = @($r.Text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }
}
if ($installedTargets.Count -eq 0) {
    # rustup 输出拿不到时回落到 rustlib 目录（与 android-env.ps1 的做法一致，不把「读不到」当「没装」）
    $rustupRoots = @()
    $cands = @((Get-Setting 'RUSTUP_HOME'))
    if ($cargoRoot) {
        $cargoParent = Split-Path -Parent $cargoRoot -ErrorAction SilentlyContinue
        if ($cargoParent) { $cands += (Join-Path $cargoParent '.rustup') }
    }
    if ($env:USERPROFILE) { $cands += (Join-Path $env:USERPROFILE '.rustup') }
    foreach ($cand in $cands) {
        if ($cand -and (Test-Path (Join-Path $cand 'toolchains')) -and ($rustupRoots -notcontains $cand)) { $rustupRoots += $cand }
    }
    foreach ($root in $rustupRoots) {
        Get-ChildItem (Join-Path $root 'toolchains') -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            Get-ChildItem (Join-Path $_.FullName 'lib\rustlib') -Directory -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty Name | ForEach-Object { $installedTargets += $_ }
        }
    }
    $installedTargets = @($installedTargets | Where-Object { $_ -match 'linux-android' } | Sort-Object -Unique)
}
$missingTriples = @($neededTriples | Where-Object { $installedTargets -notcontains $_ })
if ($missingTriples.Count -gt 0) {
    Add-Check 'rust targets' 'MISS' ('缺：' + ($missingTriples -join '、') + $(if ($installedTargets.Count -gt 0) { '（已装：' + (($installedTargets | Where-Object { $_ -match 'linux-android' }) -join '/') + '）' } else { '' })) ('rustup target add ' + ($missingTriples -join ' '))
} else {
    Add-Check 'rust targets' 'OK' ($neededTriples -join ' · ')
}

$bindingDir = Join-Path $repoRoot 'vendor\rquickjs-sys\src\bindings'
$missingBindings = @($neededTriples | Where-Object { -not (Test-Path (Join-Path $bindingDir ($_ + '.rs'))) })
if ($missingBindings.Count -gt 0) {
    $detail = '缺 ' + (($missingBindings | ForEach-Object { 'vendor/rquickjs-sys/src/bindings/' + $_ + '.rs' }) -join '、')
    Add-Check 'QuickJS 绑定' 'MISS' $detail '补这些绑定文件（按 LP64 / C-ABI 同构取对应 gnu 版本并注明来路，不能拿别的架构顶替），或改用 -Target aarch64（ANDROID-PLAN §3.1、§5 风险 9）'
} else {
    Add-Check 'QuickJS 绑定' 'OK' ('vendor/rquickjs-sys 已含 ' + ($neededTriples -join ' / '))
}

# ---- 5. 移动工程与前端产物 ----------------------------------------------------
$gradlew = Join-Path $repoRoot 'src-tauri\gen\android\gradlew.bat'
if ((Test-Path $gradlew) -and (Test-Path $gradleAppFile)) {
    Add-Check 'gen/android' 'OK' 'src-tauri/gen/android 已生成'
} else {
    Add-Check 'gen/android' 'MISS' 'src-tauri/gen/android 不存在或缺 app/build.gradle.kts' '先跑一次 pnpm tauri android init（ANDROID-PLAN P0-5；需要 ANDROID_HOME / NDK_HOME 已就绪）'
}

# ---- 5b. Tauri npm 包 ↔ Rust crate 的 minor 对齐 -------------------------------
# CLI 在「开始编译后」才检查这一项；-Check 先拦，避免白等一次构建。
$lockPath = Join-Path $repoRoot 'Cargo.lock'
$lockText = if (Test-Path $lockPath) { Get-Content $lockPath -Raw } else { '' }
function Get-LockVersion([string]$name) {
    if ($lockText -match ('name = "' + [regex]::Escape($name) + '"\s*\r?\nversion = "([^"]+)"')) {
        return $matches[1]
    }
    return $null
}
function Get-Minor([string]$version) {
    $parts = $version -split '\.'
    if ($parts.Count -lt 2) { return $version }
    return ($parts[0..1] -join '.')
}
$pkgPairs = @(
    @{Name = 'Tauri'; Rust = 'tauri'; Npm = '@tauri-apps/api'},
    @{Name = 'Tauri opener'; Rust = 'tauri-plugin-opener'; Npm = '@tauri-apps/plugin-opener'}
)
foreach ($pair in $pkgPairs) {
    $rustVersion = Get-LockVersion $pair.Rust
    $npmPkgPath = Join-Path $repoRoot ('node_modules\' + $pair.Npm.Replace('/', '\') + '\package.json')
    if (-not $rustVersion -or -not (Test-Path $npmPkgPath)) { continue }
    $npmVersion = (Get-Content $npmPkgPath -Raw | ConvertFrom-Json).version
    if ((Get-Minor $rustVersion) -ne (Get-Minor $npmVersion)) {
        Add-Check ($pair.Name + ' 版本对齐') 'MISS' ("Rust $($pair.Rust)=$rustVersion，$($pair.Npm)=$npmVersion") ('pnpm add ' + $pair.Npm + '@<与 Rust 同 minor 的最新版>（不要降 Rust crate；见 GOTCHAS §83）')
    } else {
        Add-Check ($pair.Name + ' 版本对齐') 'OK' ("$($pair.Rust)=$rustVersion / $($pair.Npm)=$npmVersion（同 minor）")
    }
}

if ($SkipWeb) {
    $distIndex = Join-Path $repoRoot 'dist\index.html'
    if (Test-Path $distIndex) {
        Add-Check '前端产物' 'OK' 'dist/index.html 已存在（-SkipWeb 复用，不再构建）'
    } else {
        Add-Check '前端产物' 'MISS' 'dist/index.html 不存在，-SkipWeb 没有可复用的产物' '去掉 -SkipWeb（脚本会先构建前端），或在设了 TAURI_ENV_PLATFORM=android 的终端里先跑 pnpm build'
    }
}

# ---- 6. release 签名（只有 -Release 才检查）------------------------------------
if ($Release) {
    $keystoreProps = @(
        (Join-Path $repoRoot 'src-tauri\gen\android\keystore.properties'),
        (Join-Path $repoRoot 'src-tauri\gen\android\app\keystore.properties')
    ) | Where-Object { Test-Path $_ }
    $hasSigningBlock = $false
    if (Test-Path $gradleAppFile) {
        $hasSigningBlock = [bool](Select-String -Path $gradleAppFile -Pattern 'signingConfig' -Quiet)
    }
    if ($keystoreProps.Count -eq 0 -and -not $hasSigningBlock) {
        Add-Check 'release 签名' 'MISS' 'gen/android 没有签名配置 → Gradle 只会产出 app-*-release-unsigned.apk（不能安装）' '在 src-tauri/gen/android 配 keystore.properties + build.gradle.kts 的 signingConfigs.release（Tauri 官方 Android 签名步骤），或去掉 -Release 用默认 debug 包'
    } elseif ($keystoreProps.Count -eq 0 -or -not $hasSigningBlock) {
        Add-Check 'release 签名' 'MISS' '签名配置不完整（keystore.properties 或 signingConfigs 缺一项）' '补齐 src-tauri/gen/android 的 keystore.properties 与 build.gradle.kts 的 signingConfigs.release；或去掉 -Release'
    } else {
        Add-Check 'release 签名' 'OK' 'gen/android 已有签名配置（keystore.properties + signingConfigs）'
    }
}

# ---- 输出检查结果 --------------------------------------------------------------
$width = ($script:checks | ForEach-Object { $_.Name.Length } | Measure-Object -Maximum).Maximum
foreach ($row in $script:checks) {
    $color = switch ($row.Status) {
        'OK' { 'Green' }
        'MISS' { 'Red' }
        'WAIT' { 'Yellow' }
        default { 'DarkGray' }
    }
    Write-Host ('[{0}] ' -f $row.Status) -ForegroundColor $color -NoNewline
    Write-Host ($row.Name.PadRight($width) + '  ') -NoNewline
    Write-Host $row.Detail
}
$blocking = @($script:checks | Where-Object { $_.Status -in @('MISS', 'WAIT') })

# 将要执行的命令（-Check 与构建前都会打印，避免「脚本自己猜参数」）
$tauriCmd = 'pnpm tauri android build --apk'
if (-not $Release) { $tauriCmd += ' --debug' }
if ($Target -ne 'universal') { $tauriCmd += (' -t ' + $Target) }
$tauriCmd += ' -c <临时 JSON>'

Write-Host ''
Write-Host '将要执行（工作目录＝仓库根；环境变量只设在本进程，不写进仓库）：' -ForegroundColor DarkGray
Write-Host ('  1) pnpm build' + $(if ($SkipWeb) { '   [已用 -SkipWeb 跳过]' } else { '    # 设 TAURI_ENV_PLATFORM=android，vite 据此剔除 110 MB 演示视频' })) -ForegroundColor DarkGray
Write-Host ('  2) ' + $tauriCmd) -ForegroundColor DarkGray
Write-Host ('     临时 JSON 内容：{"build":{"beforeBuildCommand":""}}（把 Tauri 自己的 pnpm build 置空，避免重复构建）') -ForegroundColor DarkGray
if ($Target -eq 'universal') {
    Write-Host '     universal 不传 -t：Tauri 的 universal flavor 会编译四个 ABI（缺任一绑定即失败）' -ForegroundColor DarkGray
} elseif (-not $Release) {
    Write-Host '     本变体是 debug（--debug）；release 是 CLI 默认模式，没有 --release 参数' -ForegroundColor DarkGray
} else {
    Write-Host '     本变体是 release（CLI 默认模式，不加 --debug）；没有 --release 参数' -ForegroundColor DarkGray
}

# ---- -Check：只检查，不构建 ----------------------------------------------------
if ($Check) {
    Write-Host ''
    Write-Host '仅检查，未构建。' -ForegroundColor Yellow
    if ($blocking.Count -eq 0) {
        Write-Host '结论：环境齐备，可以去掉 -Check 执行构建。' -ForegroundColor Green
        exit 0
    }
    Write-Host ('结论：还有 ' + $blocking.Count + ' 项阻塞（按顺序处理；退出码 1）：') -ForegroundColor Yellow
    $i = 0
    foreach ($row in $blocking) {
        $i++
        Write-Host ("  $i. $($row.Name)：$($row.Detail)")
        if ($row.Fix) { Write-Host ("     → $($row.Fix)") -ForegroundColor Yellow }
    }
    Write-Host ''
    Write-Host '分步命令与失败分支见 docs/ANDROID-PLAN.md §4 / §5。'
    exit 1
}

if ($blocking.Count -gt 0) {
    Write-Host ''
    Write-Host ('构建未开始：还有 ' + $blocking.Count + ' 项阻塞（不静默继续）：') -ForegroundColor Red
    $i = 0
    foreach ($row in $blocking) {
        $i++
        Write-Host ("  $i. $($row.Name)：$($row.Detail)")
        if ($row.Fix) { Write-Host ("     → $($row.Fix)") -ForegroundColor Yellow }
    }
    Write-Host ''
    Write-Host '先处理完上面的项，再跑一次同一条命令；也可以用 -Check 复看环境清单。'
    exit 1
}

# ---- 应用解析结果到本进程环境（Tauri / Gradle / cargo 都在同一会话里找这些变量）----
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$env:NDK_HOME = $ndkRoot
if ($jdkRoot -and (Test-Path (Join-Path $jdkRoot 'bin\java.exe'))) { $env:JAVA_HOME = $jdkRoot }
if ($cargoRoot -and (Test-Path (Join-Path $cargoRoot 'bin\cargo.exe'))) {
    $env:CARGO_HOME = $cargoRoot
} elseif (-not $CargoHome -and (Get-Setting 'CARGO_HOME')) {
    # 环境里的 CARGO_HOME 是坏的但 PATH 上有 cargo：别把坏路径传给子进程
    Remove-Item Env:CARGO_HOME -ErrorAction SilentlyContinue
}
$pathParts = @()
if ($jdkRoot -and (Test-Path (Join-Path $jdkRoot 'bin\java.exe'))) { $pathParts += (Join-Path $jdkRoot 'bin') }
if ($ndkBinDir -and (Test-Path $ndkBinDir)) { $pathParts += $ndkBinDir }
if ($cargoRoot -and (Test-Path (Join-Path $cargoRoot 'bin\cargo.exe'))) { $pathParts += (Join-Path $cargoRoot 'bin') }
if ($pathParts.Count -gt 0) { $env:PATH = (($pathParts + @($env:PATH)) -join ';') }

# ---- 构建 1/2：前端 ------------------------------------------------------------
Write-Host ''
Write-Host '== 1/2 前端构建 ==' -ForegroundColor Cyan
if ($SkipWeb) {
    Write-Host '已跳过（-SkipWeb），复用 dist/' -ForegroundColor Yellow
} else {
    # Tauri 的 beforeBuildCommand 会注入这个变量；我们自己构建时必须显式设，否则 dist 里会带上桌面演示视频
    $env:TAURI_ENV_PLATFORM = 'android'
    & pnpm build
    if ($LASTEXITCODE -ne 0) {
        $code = $LASTEXITCODE
        Write-Host ''
        Write-Host ('[FAIL] pnpm build 退出码 ' + $code + '（原始错误见上方输出，未截断）') -ForegroundColor Red
        Write-Host '下一步：先单独跑 pnpm build 看完整报错；常见原因是 tsc 类型错误或 dist 被占用。'
        exit $code
    }
}

# ---- 构建 2/2：Tauri 安卓 ------------------------------------------------------
Write-Host ''
Write-Host '== 2/2 Tauri 安卓构建 ==' -ForegroundColor Cyan
$configJson = '{"build":{"beforeBuildCommand":""}}'
$tempDir = if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
$configPath = Join-Path $tempDir ('gently-android-build-' + $PID + '-' + (Get-Random -Minimum 100000 -Maximum 999999) + '.json')
$buildLog = Join-Path $tempDir ('gently-android-build-' + $PID + '-' + (Get-Random -Minimum 100000 -Maximum 999999) + '.log')
Set-Content -Path $configPath -Value $configJson -Encoding ascii
try {
    $null = Get-Content $configPath -Raw | ConvertFrom-Json
} catch {
    Remove-Item $configPath -Force -ErrorAction SilentlyContinue
    Write-Host '[FAIL] 临时构建配置写不出来（JSON 解析失败），未开始构建。' -ForegroundColor Red
    exit 1
}

$tauriArgs = @('tauri', 'android', 'build', '--apk')
if (-not $Release) { $tauriArgs += '--debug' }
if ($Target -ne 'universal') { $tauriArgs += @('-t', $Target) }
$tauriArgs += @('-c', $configPath)

Write-Host ('  执行：pnpm ' + (($tauriArgs | ForEach-Object { if ($_ -eq $configPath) { '<临时 JSON>' } else { $_ } }) -join ' ')) -ForegroundColor DarkGray
$buildStartedAt = Get-Date
$buildCode = 0
try {
    # Tee：既保留终端输出，又把 Tauri 自己打印的「Finished N APK at: <path>」留下来，
    # 产物直接从这行读——不靠 flavor 目录猜（见下方说明）。
    & pnpm @tauriArgs 2>&1 | Tee-Object -FilePath $buildLog
    $buildCode = $LASTEXITCODE
} finally {
    Remove-Item $configPath -Force -ErrorAction SilentlyContinue
}

function Write-BuildFailureAdvice {
    Write-Host ''
    Write-Host 'Tauri 的原始错误就在上面的输出里（脚本没有截断、没有改写）。按报错关键字处理：' -ForegroundColor Yellow
    Write-Host '  - "couldn''t read ...\bindings\<target>.rs" → 该 ABI 缺 QuickJS 绑定：改用 -Target aarch64，或按 ANDROID-PLAN §3.1 补绑定'
    Write-Host '  - "NDK at ... did not have a source.properties" / 找不到 clang → -NdkHome 指到完整 NDK（r23+）'
    Write-Host '  - "requires Java 17" / "Unsupported class file major version" → -JavaHome 指到 JDK 17（AGP 8 要求）'
    Write-Host '  - "Could not resolve com.android.tools.build" → Gradle 首次要联网拉 AGP（ANDROID-PLAN §5 风险 1）'
    Write-Host '  - "Blocking waiting for file lock on Android" → 先结束另一个 tauri android 进程再跑'
    Write-Host '完整失败分支：docs/ANDROID-PLAN.md §4（P0-6）与 §5。'
}

if ($buildCode -ne 0) {
    Write-Host ''
    Write-Host ('[FAIL] pnpm tauri android build 退出码 ' + $buildCode) -ForegroundColor Red
    Write-BuildFailureAdvice
    exit $buildCode
}

# ---- 收集产物 ------------------------------------------------------------------
# 不能只按 `-t aarch64 → arm64 flavor` 猜：Tauri CLI 在没有 `--split-per-abi` 时
# 会把本次请求的 ABI 打进 **universal** flavor（实测：`-t aarch64` 产出
# `apk/universal/debug/app-universal-debug.apk`，而 arm64 目录里是上一次的旧包）。
# 所以优先取「本次构建时间之后写出的最新 APK」，再退回按 flavor 找。
$apkRoot = Join-Path $repoRoot 'src-tauri\gen\android\app\build\outputs\apk'
$apkDir = Join-Path $apkRoot (Join-Path $flavor $variant)
$apk = $null
$reportedApk = $null
if (Test-Path $buildLog) {
    $logText = Get-Content $buildLog -Raw
    if ($logText -match '(?m)Finished[^\r\n]*APK[^\r\n]*at:\s*\r?\n\s*([^\r\n]+?\.apk)') {
        $candidate = $matches[1].Trim()
        if (Test-Path $candidate) { $reportedApk = Get-Item $candidate }
    }
}
$fresh = @()
if (Test-Path $apkRoot) {
    $fresh = @(
        Get-ChildItem $apkRoot -Recurse -File -Filter '*.apk' -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -ge $buildStartedAt.AddSeconds(-15) } |
            Sort-Object LastWriteTime -Descending
    )
}
if ($reportedApk) {
    $apk = $reportedApk
} elseif ($fresh.Count -gt 0) {
    $apk = $fresh[0]
} elseif (Test-Path $apkDir) {
    $exact = Join-Path $apkDir ('app-' + $flavor + '-' + $variant + '.apk')
    $unsigned = Join-Path $apkDir ('app-' + $flavor + '-' + $variant + '-unsigned.apk')
    if (Test-Path $exact) {
        $apk = Get-Item $exact
    } elseif (Test-Path $unsigned) {
        $apk = Get-Item $unsigned
    } else {
        $candidates = @(Get-ChildItem $apkDir -Filter '*.apk' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
        if ($candidates.Count -gt 0) { $apk = $candidates[0] }
    }
}

if (-not $apk) {
    Write-Host ''
    Write-Host ('[FAIL] 构建命令返回 0，但没找到 APK：' + $apkDir) -ForegroundColor Red
    if (Test-Path $apkRoot) {
        $found = @(Get-ChildItem $apkRoot -Recurse -File -Filter '*.apk' -ErrorAction SilentlyContinue)
        if ($found.Count -gt 0) {
            Write-Host '目录里现有的 APK（可能是其它 ABI / 上一次的产物）：'
            foreach ($f in $found) { Write-Host ('  ' + $f.FullName) }
        }
    }
    Write-Host ('下一步：确认命令带了 --apk；当前 Gradle flavor 是 "' + $flavor + '"，ABI 目录若变了要同步脚本；原始输出见上方。') -ForegroundColor Yellow
    exit 1
}

$isUnsigned = $apk.Name -match '-unsigned\.apk$'
if ($isUnsigned) {
    Write-Host ''
    Write-Host '[FAIL] release 产物未签名（Gradle 输出 -unsigned.apk），装不上，不复制到 release/。' -ForegroundColor Red
    Write-Host ('  原始产物：' + $apk.FullName)
    Write-Host '  下一步：在 src-tauri/gen/android 配 keystore.properties + build.gradle.kts 的 signingConfigs.release（Tauri 官方 Android 签名步骤），或去掉 -Release 用默认 debug 包。' -ForegroundColor Yellow
    exit 1
}

$suffix = if ($Target -eq 'aarch64') { '' } else { '-' + $Target }
$apkName = 'gently-' + $pkgVersion + '-android-' + $variant + $suffix + '.apk'
$releaseDir = Join-Path $repoRoot 'release'
if (-not (Test-Path $releaseDir)) { $null = New-Item -ItemType Directory -Path $releaseDir }
$outPath = Join-Path $releaseDir $apkName
$shaPath = $outPath + '.sha256'
$hash = ''
try {
    # 同名旧文件先删（APK 与它的 .sha256 一起），避免把上一次的校验文件留在旁边
    foreach ($stale in @($outPath, $shaPath)) {
        if (Test-Path $stale) { Remove-Item -LiteralPath $stale -Force -ErrorAction Stop }
    }
    Copy-Item -LiteralPath $apk.FullName -Destination $outPath -ErrorAction Stop
    if (-not (Test-Path $outPath)) { throw '复制后找不到目标文件' }
    if ((Get-Item $outPath).Length -ne $apk.Length) { throw '复制后大小与源 APK 不一致' }
    $hash = (Get-FileHash -LiteralPath $outPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLower()
    # 格式与 scripts/package-portable.mjs 一致：`<sha256>  <文件名>` + LF
    $shaLine = $hash + '  ' + $apkName
    Set-Content -Path $shaPath -Value ($shaLine + "`n") -NoNewline -Encoding ascii -ErrorAction Stop
    if ((Get-Content -LiteralPath $shaPath -Raw) -ne ($shaLine + "`n")) { throw 'SHA256 校验文件写回内容不一致' }
} catch {
    Write-Host ''
    Write-Host ('[FAIL] 收集产物失败：' + $_.Exception.Message) -ForegroundColor Red
    Write-Host ('  源文件：' + $apk.FullName)
    Write-Host ('  目标：' + $outPath + '（如果残留了半个文件，删掉重跑即可）')
    exit 1
}

Remove-Item $buildLog -Force -ErrorAction SilentlyContinue

$size = (Get-Item $outPath).Length
$sizeMb = [math]::Round($size / 1024 / 1024, 1)
$relOut = $outPath.Substring($repoRoot.Length).TrimStart('\')

Write-Host ''
Write-Host '构建完成' -ForegroundColor Green
Write-Host ('  APK：' + $relOut + '（' + $sizeMb + ' MB / ' + $size + ' 字节）')
Write-Host ('  SHA256：' + $hash)
Write-Host ('  校验文件：' + $shaPath.Substring($repoRoot.Length).TrimStart('\'))
Write-Host ('  来源：' + $apk.FullName.Substring($repoRoot.Length).TrimStart('\') + '（' + $variant + '）')
$adb = $null
if ($sdkRoot -and (Test-Path (Join-Path $sdkRoot 'platform-tools\adb.exe'))) { $adb = Join-Path $sdkRoot 'platform-tools\adb.exe' }
if ($adb) {
    Write-Host ('  安装到已连接真机：& "' + $adb + '" install -r "' + $outPath + '"')
} else {
    Write-Host '  安装到真机：用 SDK 自带的 adb install -r <上面的 APK 路径>'
}
if ($Release) {
    Write-Host '  提示：release 包只会安装到用同一签名证书的旧版本上；换证书要先卸载。' -ForegroundColor DarkGray
}
Write-Host ''
exit 0
