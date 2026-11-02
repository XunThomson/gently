<#
.SYNOPSIS
  安卓 P0 环境自检（**只读**：不安装、不联网、不改环境变量、不写文件）。

.DESCRIPTION
  为什么需要：`docs/ANDROID-PLAN.md` 的 P0 每一步都是「装了 / 没装」的客观事实。
  这类事实散在聊天记录里就会退化成「文档说能跑、实际跑不起来」——
  所以用一个脚本反复打印同一张清单：装完一项跑一次，缺什么一目了然。

  检查项（对应 ANDROID-PLAN §4 的 P0-0 ~ P0-6）：
    JDK / Android SDK / NDK / rust android target / adb 设备 / gen/android /
    Gradle 缓存 / QuickJS 的 android 绑定（P0-4 的真正拦路虎）/ libclang / 构建期端点连通性

  设计取舍：
  - **能查文件就不跑命令**：SDK、NDK、rust target、gen/android、Gradle 缓存、绑定文件都是目录/文件事实，
    只有 `java -version`、`adb devices`、HTTP 探测三项必须调外部程序；
  - 环境变量缺失时回落到**用户/系统环境变量**（注册表只读查询）——某些终端（例如被沙箱代理的会话）
    拿不到父进程的 RUSTUP_HOME / ANDROID_HOME，直接读进程变量会误报 MISS；
  - 外部程序的输出**捕获失败不当作失败**：降级为 WAIT 并提示你手工看一眼原始输出，
    免得在受限终端里显示成「没装」。

  用法：
    pwsh -File scripts/android-env.ps1
    pwsh -File scripts/android-env.ps1 -AndroidHome 'D:\Android\Sdk'
    pwsh -File scripts/android-env.ps1 -NoNetwork      # 不探测网络（离线/只看本地事实）

  退出码：0 = 没有 MISS/WAIT；1 = 还有 MISS（阻塞）或 WAIT（需要拍板/需要人工确认）。
#>
[CmdletBinding()]
param(
    [string]$AndroidHome,
    [string]$RepoRoot,
    [switch]$NoNetwork
)

$ErrorActionPreference = 'Continue'

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }

$script:rows = New-Object System.Collections.Generic.List[object]

function Add-Check {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][ValidateSet('OK', 'MISS', 'WAIT', 'INFO')][string]$Status,
        [string]$Detail = '',
        [string]$Fix = ''
    )
    $script:rows.Add([pscustomobject]@{ Name = $Name; Status = $Status; Detail = $Detail; Fix = $Fix })
}

function Get-Setting {
    param([Parameter(Mandatory)][string]$Name)
    # 进程环境变量 > 用户环境变量 > 系统环境变量（注册表只读）
    $v = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, 'User') }
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, 'Machine') }
    return $v
}

function Invoke-Captured {
    # 返回 @{ Ok = bool; Text = string }
    # 两条路：先直接捕获（普通终端都行）；再退回标准输出重定向到临时文件
    # （受限终端会禁止 piped stdio，例如被 Harness 沙箱代理的会话——那时第一种必然失败）。
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

$androidHome = if ($AndroidHome) { $AndroidHome } else { Get-Setting 'ANDROID_HOME' }
if (-not $androidHome) { $androidHome = Get-Setting 'ANDROID_SDK_ROOT' }
# 环境变量都没设时的兜底：Android Studio 的默认安装位置（不写死某台机器的盘符）
if (-not $androidHome) {
    $defaultSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    if (Test-Path $defaultSdk) { $androidHome = $defaultSdk }
}

Write-Host ''
Write-Host ('gently 安卓 P0 环境自检（只读）    ' + (Get-Date -Format 'yyyy-MM-dd HH:mm')) -ForegroundColor Cyan
Write-Host ('仓库：' + $RepoRoot)
Write-Host ('Android SDK：' + $(if ($androidHome) { $androidHome } else { '(未设置)' }))
Write-Host ''

# ---- 1. JDK -----------------------------------------------------------------
$javaHome = Get-Setting 'JAVA_HOME'
$javaOk = $false
$javaDetail = ''
if ($javaHome -and (Test-Path (Join-Path $javaHome 'bin\java.exe'))) {
    $javaOk = $true
    $javaDetail = $javaHome
    $release = Join-Path $javaHome 'release'
    if (Test-Path $release) {
        $ver = (Select-String -Path $release -Pattern '^JAVA_VERSION="(.+)"' | Select-Object -First 1).Matches.Groups[1].Value
        if ($ver) { $javaDetail = "$javaHome · $ver" }
    }
}
if ($javaOk) {
    Add-Check 'JDK' 'OK' $javaDetail
    $j = Invoke-Captured @('java', '-version')
    if ($j.Ok -and $j.Text) { Write-Host ('        java: ' + (($j.Text -split "`n")[0].Trim())) -ForegroundColor DarkGray }
} else {
    Add-Check 'JDK' 'MISS' "JAVA_HOME=$(if ($javaHome) { $javaHome } else { '(未设置)' })" '装 JDK 17 并设 JAVA_HOME（AGP 8 要 17）'
}

# ---- 2. Android SDK ---------------------------------------------------------
$platforms = @(); $buildTools = @(); $ndkDirs = @()
if ($androidHome -and (Test-Path $androidHome)) {
    if (Test-Path (Join-Path $androidHome 'platforms')) {
        $platforms = Get-ChildItem (Join-Path $androidHome 'platforms') -Directory | Select-Object -ExpandProperty Name
    }
    if (Test-Path (Join-Path $androidHome 'build-tools')) {
        $buildTools = Get-ChildItem (Join-Path $androidHome 'build-tools') -Directory | Select-Object -ExpandProperty Name
    }
    if (Test-Path (Join-Path $androidHome 'ndk')) {
        # 注意：单个目录时管道结果是字符串而不是数组，必须 @() 包一层，
        # 否则 `$ndkDirs[-1]` 会取到字符串的最后一个字符（曾经误报 ndk\8）
        $ndkDirs = @(Get-ChildItem (Join-Path $androidHome 'ndk') -Directory | Sort-Object Name | Select-Object -ExpandProperty Name)
    }
    if ($platforms.Count -gt 0 -and $buildTools.Count -gt 0) {
        Add-Check 'Android SDK' 'OK' ('platforms ' + ($platforms -join '/') + ' · build-tools ' + ($buildTools -join '/'))
    } else {
        Add-Check 'Android SDK' 'MISS' "目录在，但缺 platforms/build-tools：$androidHome" '用 sdkmanager 装 platforms;android-35 与 build-tools;35.0.0'
    }
} else {
    Add-Check 'Android SDK' 'MISS' 'ANDROID_HOME 未设置且默认路径不存在' '设 ANDROID_HOME 指向 SDK 根目录（ANDROID-PLAN P0-1）'
}

# ---- 3. NDK ------------------------------------------------------------------
$ndkHome = Get-Setting 'NDK_HOME'
if (-not ($ndkHome -and (Test-Path $ndkHome))) { $ndkHome = $null }
if (-not $ndkHome -and $ndkDirs.Count -gt 0) { $ndkHome = Join-Path $androidHome ('ndk\' + $ndkDirs[-1]) }
if ($ndkHome) {
    $rev = ''
    $prop = Join-Path $ndkHome 'source.properties'
    if (Test-Path $prop) {
        $line = Select-String -Path $prop -Pattern '^Pkg\.Revision' | Select-Object -First 1
        if ($line) { $rev = $line.Line.Trim() }
    }
    $binDir = Join-Path $ndkHome 'toolchains\llvm\prebuilt\windows-x86_64\bin'
    $clang24 = Join-Path $binDir 'aarch64-linux-android24-clang.cmd'
    $clang21 = Join-Path $binDir 'aarch64-linux-android21-clang.cmd'
    $ar = Join-Path $binDir 'llvm-ar.exe'
    if ((Test-Path $clang24) -and (Test-Path $ar)) {
        Add-Check 'NDK' 'OK' ($ndkHome + $(if ($rev) { " · $rev" } else { '' }))
    } elseif ((Test-Path $clang21) -and (Test-Path $ar)) {
        Add-Check 'NDK' 'WAIT' "$ndkHome 只有 API 21 的 clang 包装器（没有 24）" '设置 CC_/AR_/CARGO_TARGET_*_LINKER 显式指到 …android21-clang；或换一个带 24 的 NDK'
    } else {
        Add-Check 'NDK' 'MISS' "$ndkHome 缺 aarch64-linux-android24-clang.cmd 或 llvm-ar.exe" 'NDK 包不完整（或版本太老：需要 r23+ 的 standalone clang）'
    }
} else {
    Add-Check 'NDK' 'MISS' "找不到 NDK（$androidHome\ndk 为空，NDK_HOME 也没设）" 'sdkmanager --sdk_root=<主SDK> "ndk;<版本>"，再设 NDK_HOME（ANDROID-PLAN P0-2）'
}

# ---- 4. rust android target（查 toolchain 里的 rustlib 目录，不依赖 rustup 输出）----
$rustupRoots = @()
foreach ($cand in @((Get-Setting 'RUSTUP_HOME'), (Join-Path $env:USERPROFILE '.rustup'))) {
    if ($cand -and (Test-Path (Join-Path $cand 'toolchains')) -and ($rustupRoots -notcontains $cand)) { $rustupRoots += $cand }
}
$cargoHome = Get-Setting 'CARGO_HOME'
if ($cargoHome) {
    $sibling = Join-Path (Split-Path -Parent $cargoHome) '.rustup'
    if ((Test-Path (Join-Path $sibling 'toolchains')) -and ($rustupRoots -notcontains $sibling)) { $rustupRoots += $sibling }
}
$libTargets = @()
foreach ($root in $rustupRoots) {
    Get-ChildItem (Join-Path $root 'toolchains') -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $tc = $_.Name
        Get-ChildItem (Join-Path $_.FullName 'lib\rustlib') -Directory -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty Name | ForEach-Object { $libTargets += $_ }
    }
}
# rustlib 下除了各 target 还有 etc/src 等目录，只保留形如 <arch>-<platform> 的名字
$libTargets = $libTargets |
    Where-Object { $_ -match '^(x86_64|i686|aarch64|armv7|arm|thumbv|wasm32|riscv64)' -and $_ -match '-' } |
    Sort-Object -Unique
$androidTargets = @($libTargets | Where-Object { $_ -match 'linux-android' })
if ($androidTargets -contains 'aarch64-linux-android') {
    $extra = @($androidTargets | Where-Object { $_ -ne 'aarch64-linux-android' })
    Add-Check 'rust targets' 'OK' ('aarch64-linux-android' + $(if ($extra.Count -gt 0) { ' · 另有 ' + ($extra -join '/') } else { '' }))
} else {
    $have = if ($libTargets) { ($libTargets -join ', ') } else { '(没找到任何 toolchain)' }
    Add-Check 'rust targets' 'MISS' "缺 aarch64-linux-android；已装：$have" 'rustup target add aarch64-linux-android（ANDROID-PLAN P0-3）'
}

# ---- 5. adb 与真机 -----------------------------------------------------------
$adb = $null
if ($androidHome -and (Test-Path (Join-Path $androidHome 'platform-tools\adb.exe'))) {
    $adb = Join-Path $androidHome 'platform-tools\adb.exe'
} elseif (Get-Command adb -ErrorAction SilentlyContinue) {
    $adb = 'adb'
}
if ($adb) {
    $d = Invoke-Captured @($adb, 'devices')
    if ($d.Ok) {
        $online = @($d.Text -split "`n" | Where-Object { $_ -match '\tdevice$' })
        if ($online.Count -gt 0) {
            Add-Check 'adb 设备' 'OK' (($online | ForEach-Object { ($_ -split "`t")[0].Trim() }) -join ', ')
        } else {
            Add-Check 'adb 设备' 'MISS' '没有处于 device 状态的设备（unauthorized 也算没有）' '插真机 + 开 USB 调试 + 手机上点「允许」（ANDROID-PLAN P0-0）'
        }
    } else {
        Add-Check 'adb 设备' 'WAIT' '拿不到 adb 输出（当前终端无法捕获子进程输出）' "请手工跑一次：`"$adb`" devices，确认里面有一行以 device 结尾"
    }
} else {
    Add-Check 'adb 设备' 'MISS' '找不到 adb.exe' 'platform-tools 缺失（用 sdkmanager 装 platform-tools）'
}

# ---- 6. 移动工程是否已生成 ----------------------------------------------------
$gradlew = Join-Path $RepoRoot 'src-tauri\gen\android\gradlew.bat'
$buildGradle = Join-Path $RepoRoot 'src-tauri\gen\android\app\build.gradle.kts'
if ((Test-Path $gradlew) -and (Test-Path $buildGradle)) {
    Add-Check 'gen/android' 'OK' 'src-tauri/gen/android 已生成'
} else {
    Add-Check 'gen/android' 'MISS' 'src-tauri/gen/android 还不存在' 'pnpm tauri android init（需要 ANDROID_HOME + NDK_HOME，ANDROID-PLAN P0-5）'
}

# ---- 6b. 移动端单窗配置（多窗口时移动端会加载错窗口 → 白屏）--------------------
$androidConf = Join-Path $RepoRoot 'src-tauri\tauri.android.conf.json'
if (Test-Path $androidConf) {
    $winCount = 0
    try {
        $conf = Get-Content $androidConf -Raw | ConvertFrom-Json
        $winCount = @($conf.app.windows).Count
    } catch { $winCount = -1 }
    if ($winCount -eq 1) {
        Add-Check '移动端单窗配置' 'OK' 'tauri.android.conf.json 只声明 1 个窗口'
    } elseif ($winCount -gt 1) {
        Add-Check '移动端单窗配置' 'MISS' "tauri.android.conf.json 声明了 $winCount 个窗口（移动端只有一个 webview）" '只留 main 窗口，见 ANDROID-PLAN §3.3'
    } else {
        Add-Check '移动端单窗配置' 'WAIT' 'tauri.android.conf.json 解析失败或没有 app.windows' '检查 JSON'
    }
} else {
    Add-Check '移动端单窗配置' 'MISS' '没有 src-tauri/tauri.android.conf.json → 移动端会按 tauri.conf.json 的三窗配置加载（实测白屏）' '加一份只含 main 窗口的 android 专属配置'
}

# ---- 7. Gradle 缓存（首次构建必须联网拉一次）----------------------------------
$gradleCaches = Join-Path $env:USERPROFILE '.gradle\caches'
if (Test-Path $gradleCaches) {
    Add-Check 'Gradle 缓存' 'OK' $gradleCaches
} else {
    Add-Check 'Gradle 缓存' 'INFO' '还没有 ~/.gradle/caches（首次构建会联网拉 Gradle 发行包与 AGP）' ''
}

# ---- 8. QuickJS 的 android 绑定（P0-4 的真正拦路虎）----------------------------
# 首选看仓库里的 vendored patch（2026-11-01 已落地，见 vendor/rquickjs-sys/VENDORED.md）；
# 没有 patch 时才回落到 registry 缓存，判断「上游到底带不带 android 绑定」。
$vendoredBinding = Join-Path $RepoRoot 'vendor\rquickjs-sys\src\bindings\aarch64-linux-android.rs'
$vendoredRoot = Join-Path $RepoRoot 'vendor\rquickjs-sys'
$registrySrc = @()
if ($cargoHome) { $registrySrc += (Join-Path $cargoHome 'registry\src') }
$registrySrc += (Join-Path $env:USERPROFILE '.cargo\registry\src')
if (Test-Path $vendoredBinding) {
    Add-Check 'QuickJS 绑定' 'OK' 'vendor/rquickjs-sys 已含 aarch64-linux-android.rs（由 [patch.crates-io] 接管）'
    # 32 位 ARM 的绑定仍然缺：`--apk` 默认四 ABI 一起编时会在这里失败（实测）
    $armv7Binding = Join-Path $RepoRoot 'vendor\rquickjs-sys\src\bindings\armv7-linux-androideabi.rs'
    if (-not (Test-Path $armv7Binding)) {
        Add-Check 'QuickJS 绑定(armv7)' 'INFO' '没有 armv7-linux-androideabi.rs → 只出 arm64 时用 `-t aarch64`；四 ABI 全出会失败' ''
    }
} else {
    $sysDir = $null
    foreach ($r in $registrySrc) {
        if (-not (Test-Path $r)) { continue }
        $sysDir = Get-ChildItem $r -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ChildItem $_.FullName -Directory -Filter 'rquickjs-sys-*' -ErrorAction SilentlyContinue } |
            Select-Object -First 1
        if ($sysDir) { break }
    }
    if ($sysDir) {
        $binding = Join-Path $sysDir.FullName 'src\bindings\aarch64-linux-android.rs'
        if (Test-Path $binding) {
            Add-Check 'QuickJS 绑定' 'OK' "$($sysDir.Name) 已含 aarch64-linux-android.rs（不需要 patch，也不需要 bindgen）"
        } else {
            Add-Check 'QuickJS 绑定' 'MISS' "$($sysDir.Name) 没有 aarch64-linux-android.rs，且仓库里没有 vendor 补丁 → P0-4 会在 include! 处失败（build.rs 只 warning）" '恢复 vendor/rquickjs-sys + 根 Cargo.toml 的 [patch.crates-io]（见 ANDROID-PLAN §3.1 / GOTCHAS §48）'
        }
    } else {
        Add-Check 'QuickJS 绑定' 'INFO' 'registry/src 里没有 rquickjs-sys（先跑一次 cargo build 解包）' ''
    }
}

# [patch] 是否还接着：Cargo.toml 里没有 patch 段时，vendor 目录形同虚设
if ((Test-Path $vendoredRoot) -and -not (Select-String -Path (Join-Path $RepoRoot 'Cargo.toml') -Pattern 'rquickjs-sys\s*=\s*\{\s*path' -Quiet)) {
    Add-Check 'QuickJS patch 接线' 'MISS' 'vendor/rquickjs-sys 在，但根 Cargo.toml 没有 [patch.crates-io] 指向它' '把 [patch.crates-io] rquickjs-sys = { path = "vendor/rquickjs-sys" } 加回去'
}

# libclang 只有选 A（bindgen）才需要，因此只报信息
$clangCandidates = @()
if ($ndkHome) { $clangCandidates += (Join-Path $ndkHome 'toolchains\llvm\prebuilt\windows-x86_64\bin\libclang.dll') }
$clangCandidates += 'C:\Program Files\LLVM\bin\libclang.dll'
$found = @($clangCandidates | Where-Object { Test-Path $_ })
if ($found.Count -gt 0) {
    Add-Check 'libclang' 'OK' ($found -join ' ; ')
} else {
    Add-Check 'libclang' 'INFO' '没找到 libclang.dll（只有 bindgen 方案才需要；当前走 vendored patch）' ''
}

# ---- 9. 构建期端点连通性 ------------------------------------------------------
if ($NoNetwork) {
    Add-Check '网络' 'INFO' '已跳过（-NoNetwork）' ''
} elseif (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    Add-Check '网络' 'INFO' '没有 curl.exe，跳过连通性探测' ''
} else {
    $endpoints = [ordered]@{
        'crates.io'      = 'https://index.crates.io/config.json'
        'rust dist'      = 'https://static.rust-lang.org/dist/channel-rust-stable.toml'
        'Gradle 发行包'   = 'https://services.gradle.org/distributions/'
        'Maven Central'  = 'https://repo.maven.apache.org/maven2/'
        'Google Maven'   = 'https://dl.google.com/dl/android/maven2/com/android/tools/build/gradle/8.13.0/gradle-8.13.0.pom'
    }
    $bad = @()
    $unknown = @()
    foreach ($key in $endpoints.Keys) {
        $r = Invoke-Captured @('curl.exe', '-sS', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '8', $endpoints[$key])
        $code = if ($r.Ok) { ($r.Text -split "`n" | Where-Object { $_ -match '^\d{3}$' } | Select-Object -First 1) } else { $null }
        $why = ''
        if ($r.Ok -and $r.Text) {
            $line = ($r.Text -split "`n" | Where-Object { $_ -match 'curl:|schannel|SEC_E_' } | Select-Object -First 1)
            if ($line) {
                # curl 的本地化信息会出现乱码（代码页不同），只留可打印 ASCII 部分
                $clean = ($line -replace '[^\x20-\x7E]', '').Trim().TrimEnd('-').Trim()
                $why = ' · ' + $clean
            }
        }
        if (-not $code -or $code -eq '000') {
            Add-Check ("网络 · " + $key) 'WAIT' ('没能完成请求（HTTP ' + $code + '）' + $why) '在你自己的终端里重跑这一项；000 + schannel/SEC_E_* 是受限会话（拿不到 TLS 凭据）的症状，不是网络故障'
            $unknown += $key
        } elseif ($code -match '^(2|3)\d\d$') {
            Add-Check ("网络 · " + $key) 'OK' "HTTP $code"
        } else {
            Add-Check ("网络 · " + $key) 'MISS' "HTTP $code"; $bad += $key
        }
    }
    if ($bad.Count -gt 0) {
        Add-Check '网络（结论）' 'MISS' ($bad -join ', ') 'Gradle 卡在 AGP 解析时按 ANDROID-PLAN §5 风险 1 处理（加镜像并记录加的是什么、怎么撤）'
    } elseif ($unknown.Count -gt 0) {
        Add-Check '网络（结论）' 'WAIT' '没能判定（本会话拿不到 TLS 凭据）' '在你自己的终端里手工跑一次看 HTTP 码，或用浏览器打开同一个 URL'
    }
}

# ---- 输出 --------------------------------------------------------------------
$width = ($script:rows | ForEach-Object { $_.Name.Length } | Measure-Object -Maximum).Maximum
foreach ($row in $script:rows) {
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

$blocking = @($script:rows | Where-Object { $_.Status -in @('MISS', 'WAIT') })
Write-Host ''
if ($blocking.Count -eq 0) {
    Write-Host '结论：P0 前置条件齐了，可以跑 pnpm tauri android dev。' -ForegroundColor Green
    exit 0
}

Write-Host ('结论：还有 ' + $blocking.Count + ' 项没就绪（按顺序处理）：') -ForegroundColor Yellow
$i = 0
foreach ($row in $blocking) {
    $i++
    Write-Host ("  $i. $($row.Name)：$($row.Detail)")
    if ($row.Fix) { Write-Host ("     → $($row.Fix)") }
}
Write-Host ''
Write-Host '分步命令与期望输出见 docs/ANDROID-PLAN.md §4。'
exit 1
