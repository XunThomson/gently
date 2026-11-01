<#
.SYNOPSIS
  驱动 / 截图**宠物窗口**（仅 Windows；开发与验证工具，不进交付物）。

.DESCRIPTION
  为什么单独一个脚本：主窗口那套 `capture-window.ps1` 只能截主窗口，而宠物的拖动、
  走动、点击穿透都发生在**另一扇 200×160 的透明小窗**上。R105 把拖动从「系统拖动」
  改成「渲染器自己搬窗口」之后，注入式鼠标事件就能真正驱动它了——于是这些交互可以自动化验收。

  它做三件事：
  1. **摆放**：把宠物窗口挪到一个确定位置并置顶（否则它可能正好落在主窗口后面，注入的点击会打到主窗口上）；
  2. **截图**：`CopyFromScreen` 截宠物窗口那块区域（透明窗口合成在桌面上，截的是最终画面）；
  3. **拖动 / 等待走动**：`-Drag` 按住宠物本体拖一段；`-Walk` 等它自己走起来再连拍。

  **必须**在开头调 `SetProcessDpiAwarenessContext(-4)`：PowerShell 默认 DPI 未感知，
  枚举出来的窗口矩形是虚拟化的（1.25 倍缩放下差 20%），按它算的坐标点不到宠物本体，
  表现为「拖了完全没反应」——R105 之前一直以为是「注入事件拖不动窗口」，其实是这个。

.EXAMPLE
  pwsh -File scripts/pet-window.ps1 -Drag -Output release/screenshots/pet-drag.png
  pwsh -File scripts/pet-window.ps1 -Walk -WalkShots 8 -Output release/screenshots/pet-walk.png
#>
[CmdletBinding()]
param(
    # 宠物本体被按住后，指针往左上挪这么多（物理像素）
    [int]$DragX = -120,
    [int]$DragY = -72,
    [switch]$Drag,
    # 等它自己走起来（走动开关要在设置页打开）
    [switch]$Walk,
    [int]$WalkShots = 8,
    [int]$WalkTimeoutSeconds = 90,
    # 摆放位置（物理像素）
    [int]$HomeX = 700,
    [int]$HomeY = 700,
    # 截图路径（不带扩展名也可以）
    [string]$Output = 'release/screenshots/pet-window.png',
    # 已经开着应用时用 -Reuse，不要再启动一份
    [switch]$Reuse,
    [switch]$Kill
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class GentlyPetWindow {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, IntPtr extra);
    public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
    public const uint SWP_NOSIZE = 0x0001, SWP_NOACTIVATE = 0x0010;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

    public static List<string> Dump(uint target) {
        var lines = new List<string>();
        EnumWindows((h, l) => {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid != target) return true;
            var sb = new StringBuilder(256);
            GetWindowText(h, sb, 256);
            RECT r; GetWindowRect(h, out r);
            lines.Add(string.Format("{0}|{1}|{2}|{3}|{4}|{5}|{6}",
                h, IsWindowVisible(h), sb.ToString(), r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top));
            return true;
        }, IntPtr.Zero);
        return lines;
    }
}
"@

[void][GentlyPetWindow]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'release\gently-0.1.0-windows-x64\gently.exe'
if (-not $Reuse) {
    Get-Process gently -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 400
    if (-not (Test-Path $exe)) { throw "找不到可执行文件：$exe（先跑 pnpm package:portable）" }
    Start-Process -FilePath $exe | Out-Null
    Start-Sleep -Seconds 7
}

$proc = Get-Process gently -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { throw 'gently 没在运行' }

function Get-PetWindows {
    [GentlyPetWindow]::Dump([uint32]$proc.Id) | ForEach-Object {
        $parts = $_ -split '\|'
        [pscustomobject]@{
            Handle = [IntPtr][long]$parts[0]
            Title = $parts[2]
            Left = [int]$parts[3]
            Top = [int]$parts[4]
            Width = [int]$parts[5]
            Height = [int]$parts[6]
        }
    }
}

function Get-Pet {
    $pet = Get-PetWindows | Where-Object { $_.Title -like '*宠物*' -and $_.Width -gt 100 } | Select-Object -First 1
    if (-not $pet) { throw '没找到宠物窗口（设置页里的宠物开关可能关着）' }
    $pet
}

function Save-PetShot([string]$path) {
    $pet = Get-Pet
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
    $bmp = New-Object System.Drawing.Bitmap $pet.Width, $pet.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bmp)
    $graphics.CopyFromScreen($pet.Left, $pet.Top, 0, 0, (New-Object System.Drawing.Size $pet.Width, $pet.Height))
    $graphics.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "已保存 $path"
}

# 等宠物停下来（走动开着时它每 60ms 挪 4px）：拖动验证要在一个静止的窗口上做，
# 否则「窗口跟着光标走」会和「走动」叠加，位移量对不上。
function Wait-Still([int]$stableMs = 1200) {
    $last = Get-Pet
    $since = Get-Date
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 100
        $now = Get-Pet
        if ($now.Left -ne $last.Left -or $now.Top -ne $last.Top) {
            $last = $now
            $since = Get-Date
            continue
        }
        if (((Get-Date) - $since).TotalMilliseconds -ge $stableMs) { return $now }
    }
    return Get-Pet
}

function Place-Pet {
    $pet = Get-Pet
    [void][GentlyPetWindow]::SetWindowPos(
        $pet.Handle,
        [GentlyPetWindow]::HWND_TOPMOST,
        $HomeX,
        $HomeY,
        0,
        0,
        ([GentlyPetWindow]::SWP_NOSIZE -bor [GentlyPetWindow]::SWP_NOACTIVATE)
    )
    [void][GentlyPetWindow]::BringWindowToTop($pet.Handle)
    Start-Sleep -Milliseconds 600
    Get-Pet
}

$pet = Place-Pet
Write-Host "宠物窗口：$($pet.Left),$($pet.Top) $($pet.Width)x$($pet.Height)"

$base = [System.IO.Path]::ChangeExtension($Output, $null).TrimEnd('.')
$dir = Split-Path -Parent $Output
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

if ($Drag) {
    $pet = Wait-Still
    Write-Host "静止后：$($pet.Left),$($pet.Top)"
    Save-PetShot "$base-idle.png"
    # 精灵在窗口偏右下：按 55% / 62% 的位置（点空白处会被「自动点击穿透」吃掉，什么都不发生）
    $startX = [int]($pet.Left + $pet.Width * 0.55)
    $startY = [int]($pet.Top + $pet.Height * 0.62)
    Write-Host "按下点：$startX,$startY"
    [void][GentlyPetWindow]::SetCursorPos($startX, $startY)
    Start-Sleep -Milliseconds 150
    [GentlyPetWindow]::mouse_event([GentlyPetWindow]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 150
    $steps = 12
    for ($i = 1; $i -le $steps; $i++) {
        [void][GentlyPetWindow]::SetCursorPos(
            [int]($startX + ($DragX * $i / $steps)),
            [int]($startY + ($DragY * $i / $steps))
        )
        Start-Sleep -Milliseconds 50
    }
    Start-Sleep -Milliseconds 200
    $during = Get-Pet
    Write-Host "拖动中：$($during.Left),$($during.Top)"
    Save-PetShot "$base-dragging.png"
    [GentlyPetWindow]::mouse_event([GentlyPetWindow]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 600
    $after = Get-Pet
    Write-Host "松手后：$($after.Left),$($after.Top)"
    Save-PetShot "$base-dropped.png"
    Write-Host "位移：dx=$($after.Left - $pet.Left) dy=$($after.Top - $pet.Top)（应当≈ $DragX / $DragY）"
}

if ($Walk) {
    $start = Get-Pet
    $deadline = (Get-Date).AddSeconds($WalkTimeoutSeconds)
    $moved = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 120
        $now = Get-Pet
        if ([math]::Abs($now.Left - $start.Left) -gt 12) {
            $moved = $true
            break
        }
    }
    if (-not $moved) {
        Write-Host "$WalkTimeoutSeconds 秒内没走动（设置页里的「在屏幕上走动」可能关着）"
        exit 2
    }
    for ($i = 0; $i -lt $WalkShots; $i++) {
        Save-PetShot "$base-walk-$i.png"
        Start-Sleep -Milliseconds 110
    }
}

if ($Kill) {
    Get-Process gently -ErrorAction SilentlyContinue | Stop-Process -Force
    Write-Host '已结束应用进程'
}

