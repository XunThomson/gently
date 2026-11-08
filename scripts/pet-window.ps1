<#
.SYNOPSIS
  驱动 / 截图**宠物窗口**（仅 Windows；开发与验证工具，不进交付物）。

.DESCRIPTION
  为什么单独一个脚本：主窗口那套 `capture-window.ps1` 只能截主窗口，而宠物的拖动、
  走动、点击穿透都发生在**另一扇随图集与尺寸档位调整的透明小窗**上。R105 把拖动从「系统拖动」
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
    # 右键打开操作菜单并截图
    [switch]$Menu,
    # 打开菜单后切换一个尺寸档位
    [ValidateSet('small', 'medium', 'large')]
    [string]$MenuSize,
    # 在已打开的菜单里点「喂食」
    [switch]$MenuFeed,
    # 在已打开的菜单里点「摸头」
    [switch]$MenuPet,
    # 在已打开的菜单里点「停止游走」（再点一次恢复）
    [switch]$MenuRoam,
    # 在已打开的菜单里点「隐藏宠物」
    [switch]$MenuHide,
    # 把光标停在宠物本体上，截一张状态卡
    [switch]$Hover,
    # 等它自己走起来（走动开关要在设置页打开）
    [switch]$Walk,
    [int]$WalkShots = 8,
    [int]$WalkTimeoutSeconds = 90,
    # 摆放位置（物理像素）
    [int]$HomeX = 700,
    [int]$HomeY = 300,
    # 截图路径（不带扩展名也可以）
    [string]$Output = 'release/screenshots/pet-window.png',
    # 让宠物窗口重新加载页面（改了前端代码又不想重启应用时用）
    [switch]$Reload,
    # 已经开着应用时用 -Reuse，不要再启动一份
    [switch]$Reuse,
    [switch]$Kill
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
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
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, IntPtr extra);
    public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
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
            Visible = $parts[1] -eq 'True'
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

# 与 src/utils/petPresentation.ts / petWindowPosition.ts 保持一致的布局参数：
# 窗口是本体四周各留一份 HUD 槽位的画布（四边等距），本体永远在窗口正中。
$script:HudReserve = 260
$script:HudGap = 8
$script:Pad = $script:HudReserve + $script:HudGap
# 操作菜单内容高度（6 行按钮 + 间距 + 内边距）；改菜单样式后跟着调
$script:MenuHeight = 218
$script:MenuRowY = @{ feed = 28; touch = 62; size = 122; roam = 156; hide = 190 }

# 按宠物窗口的屏幕位置推算 HUD 槽位（贴左右边时在内侧，否则优先上方）
function Get-PetLayout($pet) {
    $screen = [System.Windows.Forms.Screen]::FromHandle($pet.Handle).Bounds
    $bodyLeft = $pet.Left + $script:Pad
    $bodyTop = $pet.Top + $script:Pad
    $bodyRight = $pet.Left + $pet.Width - $script:Pad
    $bodyBottom = $pet.Top + $pet.Height - $script:Pad
    $centerX = ($bodyLeft + $bodyRight) / 2
    $centerY = ($bodyTop + $bodyBottom) / 2
    $nearLeft = ($bodyLeft - $screen.Left) -lt ($script:HudReserve + $script:HudGap)
    $nearRight = ($screen.Right - $bodyRight) -lt ($script:HudReserve + $script:HudGap)
    if ($nearLeft -ne $nearRight) {
        $side = if ($nearLeft) { 'right' } else { 'left' }
    } elseif ($bodyTop - $script:HudGap - $script:HudReserve -ge $screen.Top) {
        $side = 'above'
    } else {
        $side = 'below'
    }
    $slotLeft = $centerX - $script:HudReserve / 2
    $slotTop = 0
    switch ($side) {
        'above' { $slotTop = $bodyTop - $script:HudGap - $script:HudReserve }
        'below' { $slotTop = $bodyBottom + $script:HudGap }
        'left' { $slotLeft = $bodyLeft - $script:HudGap - $script:HudReserve }
        'right' { $slotLeft = $bodyRight + $script:HudGap }
    }
    if ($side -eq 'above' -or $side -eq 'below') {
        $slotLeft = [math]::Max($screen.Left, [math]::Min($slotLeft, $screen.Right - $script:HudReserve))
    } else {
        $slotTop = [math]::Max($screen.Top, [math]::Min($centerY - $script:HudReserve / 2, $screen.Bottom - $script:HudReserve))
    }
    [pscustomobject]@{
        Side = $side
        BodyX = [int]$centerX
        BodyY = [int]$centerY
        SlotLeft = [int]$slotLeft
        SlotTop = [int]$slotTop
    }
}

# 菜单打开后的左上角：上/下贴向本体，左/右在槽位里居中
function Get-MenuOrigin($layout) {
    $top = switch ($layout.Side) {
        'above' { $layout.SlotTop + $script:HudReserve - $script:MenuHeight }
        'below' { $layout.SlotTop }
        default { $layout.SlotTop + [int](($script:HudReserve - $script:MenuHeight) / 2) }
    }
    [pscustomobject]@{ Left = $layout.SlotLeft; Top = [int]$top }
}

# 菜单某一行的屏幕坐标（x 取菜单内任意位置：按钮是整行宽）
function Get-MenuPoint($pet, [string]$row) {
    $menu = Get-MenuOrigin (Get-PetLayout $pet)
    [pscustomobject]@{
        X = [int]($menu.Left + 70)
        Y = [int]($menu.Top + $script:MenuRowY[$row])
    }
}

# Place-Pet 只搬原生窗口，前端不知道位置变了；补一次 8px 的往返拖动让布局重算
function Sync-PetLayout {
    $pet = Get-Pet
    $x = [int]($pet.Left + $pet.Width / 2)
    $y = [int]($pet.Top + $pet.Height / 2)
    [void][GentlyPetWindow]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 120
    [GentlyPetWindow]::mouse_event([GentlyPetWindow]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [void][GentlyPetWindow]::SetCursorPos($x + 8, $y)
    Start-Sleep -Milliseconds 80
    [void][GentlyPetWindow]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 80
    [GentlyPetWindow]::mouse_event([GentlyPetWindow]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 500
    Get-Pet
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

# 把光标放到本体上并产生一次**真实移动**。
# 宿主 60ms 轮询按命中区切换点击穿透：光标第一次落到透明画布上时窗口还在穿透状态，
# 那次 SetCursorPos 的移动事件收不到；必须等穿透关掉后再抖一下，渲染器才会收到 pointerenter。
function Nudge-Body([int]$x, [int]$y) {
    [void][GentlyPetWindow]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 300
    [void][GentlyPetWindow]::SetCursorPos($x + 3, $y + 2)
    Start-Sleep -Milliseconds 120
    [void][GentlyPetWindow]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 400
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
if ($Reload) {
    [void][GentlyPetWindow]::SetForegroundWindow($pet.Handle)
    Start-Sleep -Milliseconds 150
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait('{F5}')
    Start-Sleep -Seconds 2
    Write-Host '已请求宠物窗口重载'
    exit 0
}

# Place-Pet 是直接搬原生窗口，前端不知道位置变了：补一次往返拖动让 HUD 重新选边
$pet = Sync-PetLayout

$base = [System.IO.Path]::ChangeExtension($Output, $null).TrimEnd('.')
$dir = Split-Path -Parent $Output
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

if ($Drag) {
    $pet = Wait-Still
    Write-Host "静止后：$($pet.Left),$($pet.Top)"
    Save-PetShot "$base-idle.png"
    # 窗口是本体四周等距的画布：本体就在窗口正中
    $startX = [int]($pet.Left + $pet.Width * 0.5)
    $startY = [int]($pet.Top + $pet.Height * 0.5)
    Write-Host "按下点：$startX,$startY"
    Nudge-Body $startX $startY
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

if ($Menu) {
    $pet = Wait-Still
    $startX = [int]($pet.Left + $pet.Width * 0.5)
    $startY = [int]($pet.Top + $pet.Height * 0.5)
    Nudge-Body $startX $startY
    [GentlyPetWindow]::mouse_event([GentlyPetWindow]::RIGHTDOWN, 0, 0, 0, [IntPtr]::Zero)
    [GentlyPetWindow]::mouse_event([GentlyPetWindow]::RIGHTUP, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 400
    Save-PetShot "$base-menu.png"
}

if ($Hover) {
    $pet = Wait-Still
    Nudge-Body ([int]($pet.Left + $pet.Width * 0.5)) ([int]($pet.Top + $pet.Height * 0.5))
    Start-Sleep -Milliseconds 500
    Save-PetShot "$base-hover.png"
}

if ($MenuFeed) {
    $pet = Get-Pet
    $point = Get-MenuPoint $pet 'feed'
    [void][GentlyPetWindow]::SetCursorPos($point.X, $point.Y)
    Start-Sleep -Milliseconds 150
    [GentlyPetWindow]::mouse_event([GentlyPetWindow]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    [GentlyPetWindow]::mouse_event([GentlyPetWindow]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 700
    Save-PetShot "$base-fed.png"
}

if ($MenuPet) {
    $pet = Get-Pet
    $point = Get-MenuPoint $pet 'touch'
    [void][GentlyPetWindow]::SetCursorPos($point.X, $point.Y)
    Start-Sleep -Milliseconds 150
    [GentlyPetWindow]::mouse_event([GentlyPetWindow]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    [GentlyPetWindow]::mouse_event([GentlyPetWindow]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 700
    Save-PetShot "$base-pet.png"
}

if ($MenuRoam) {
    $pet = Get-Pet
    $point = Get-MenuPoint $pet 'roam'
    [void][GentlyPetWindow]::SetCursorPos($point.X, $point.Y)
    Start-Sleep -Milliseconds 150
    [GentlyPetWindow]::mouse_event([GentlyPetWindow]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    [GentlyPetWindow]::mouse_event([GentlyPetWindow]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 700
    Save-PetShot "$base-roam.png"
}

if ($MenuHide) {
    $pet = Get-Pet
    $point = Get-MenuPoint $pet 'hide'
    [void][GentlyPetWindow]::SetCursorPos($point.X, $point.Y)
    Start-Sleep -Milliseconds 150
    [GentlyPetWindow]::mouse_event([GentlyPetWindow]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    [GentlyPetWindow]::mouse_event([GentlyPetWindow]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 800
    $petAfter = Get-PetWindows | Where-Object { $_.Visible -and $_.Title -like '*宠物*' -and $_.Width -gt 100 }
    if ($petAfter) { Write-Host "隐藏后仍在：$($petAfter.Width)x$($petAfter.Height)" }
    else { Write-Host '宠物窗口已隐藏' }
}

if ($MenuSize) {
    $pet = Get-Pet
    $menuOrigin = Get-MenuOrigin (Get-PetLayout $pet)
    $offsetX = switch ($MenuSize) {
        'small' { 51 }
        'medium' { 130 }
        'large' { 209 }
    }
    [void][GentlyPetWindow]::SetCursorPos($menuOrigin.Left + $offsetX, $menuOrigin.Top + $script:MenuRowY['size'])
    [GentlyPetWindow]::mouse_event([GentlyPetWindow]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    [GentlyPetWindow]::mouse_event([GentlyPetWindow]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 700
    Save-PetShot "$base-$MenuSize-menu.png"
    $resized = Get-Pet
    Write-Host "切换 $MenuSize 后：$($resized.Width)x$($resized.Height)"
}

if ($Walk) {
    $start = Get-Pet
    # 光标停在宠物身上时宿主会暂停走动（避免点在动的目标上）；挪到屏幕角落再等
    $screen = [System.Windows.Forms.Screen]::FromHandle($start.Handle).Bounds
    [void][GentlyPetWindow]::SetCursorPos($screen.Left + 20, $screen.Top + 20)
    Start-Sleep -Milliseconds 400
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

