#Requires -Version 7.0
<#
.SYNOPSIS
  检查 / 修复 gently 工作区与构建产物的 Windows 完整性级别（MIC）。

.DESCRIPTION
  背景（R142）：Windows 标准登录令牌带有 TOKEN_MANDATORY_POLICY_NEW_PROCESS_MIN，
  新进程取「父进程 IL」与「可执行文件 IL」的较小值。工作区/构建产物一旦被标成 Low，
  gently.exe 即使从普通终端启动也会以 Low 运行：
  - 写不了 Medium 的 %APPDATA% / %LOCALAPPDATA%（日志、配置、WebView2 profile）；
  - WebView2 初始化失败，主窗口永远不可见。

  只修 node_modules 里的 esbuild.exe 不够：新的 gently.exe、WebView2Loader.dll、
  release 里的 exe 都会重新继承 Low。这个脚本一次检查并修复这些位置。

.PARAMETER Fix
  执行修复（需要“以管理员身份运行”的 PowerShell，High IL）。

.EXAMPLE
  pwsh -File scripts/check-integrity.ps1
  pwsh -File scripts/check-integrity.ps1 -Fix
#>
[CmdletBinding()]
param(
    [switch]$Fix,
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'

function Get-IntegrityLabel([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $text = & icacls $Path 2>$null
    $match = $text | Select-String -Pattern 'Mandatory Label\\(Low|Medium|High|System)' | Select-Object -First 1
    if (-not $match) { return 'None' }
    return $match.Matches[0].Groups[1].Value
}

function Show-Integrity([string]$Path) {
    $label = Get-IntegrityLabel $Path
    if ($null -eq $label) { return $null }
    Write-Host ("{0,-8} {1}" -f $label, $Path)
    return $label
}

$targets = @(
    $RepoRoot,
    (Join-Path $RepoRoot 'src-tauri\target'),
    (Join-Path $RepoRoot 'src-tauri\target\debug\gently.exe'),
    (Join-Path $RepoRoot 'release')
)

Write-Host '== 完整性级别（Low 会阻止 WebView2 / AppData 写入）=='
$low = @()
foreach ($target in $targets) {
    $label = Show-Integrity $target
    if ($label -eq 'Low') { $low += $target }
}

$groups = & whoami /groups 2>$null
$shell = $groups | Select-String -Pattern 'Mandatory Label\\(Low|Medium|High|System)' | Select-Object -First 1
if ($shell) {
    $shellLevel = $shell.Matches[0].Groups[1].Value
    Write-Host ''
    Write-Host "当前终端：$shellLevel"
    if ($shellLevel -eq 'Low') {
        Write-Warning '当前终端本身是 Low：即使 exe 修成 Medium，从这里启动的子进程仍会被 NEW_PROCESS_MIN 降为 Low。请用普通（Medium）PowerShell 启动应用。'
    }
}

if ($low.Count -eq 0) {
    Write-Host ''
    Write-Host '完整性级别检查通过：没有 Low 标签。'
    exit 0
}

Write-Host ''
Write-Warning "发现 $($low.Count) 个 Low 标签。它们会阻止 WebView2 初始化。"
if (-not $Fix) {
    Write-Host '修复：在“以管理员身份运行”的 PowerShell 中执行：'
    Write-Host '  pwsh -File scripts/check-integrity.ps1 -Fix'
    exit 1
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '修复需要管理员权限：请从“以管理员身份运行”的 PowerShell 执行本脚本。'
}

Write-Host ''
Write-Host '正在把工作区与构建产物设为 Medium（递归）…'
& icacls $RepoRoot /setintegritylevel "(OI)(CI)Medium" /T
if ($LASTEXITCODE -ne 0) {
    throw "icacls 失败（退出码 $LASTEXITCODE）。请先关闭所有 gently.exe，确认当前终端是管理员。"
}

Write-Host ''
Write-Host '修复后复查：'
$stillLow = @()
foreach ($target in $targets) {
    $label = Show-Integrity $target
    if ($label -eq 'Low') { $stillLow += $target }
}
if ($stillLow.Count -gt 0) {
    throw "仍有 Low 标签：$($stillLow -join ', ')"
}

Write-Host ''
Write-Host '已完成。请关闭所有 gently.exe，并从普通 PowerShell 重新启动（不要从 Low 终端启动）。'
