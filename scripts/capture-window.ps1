<#
.SYNOPSIS
  截取/驱动 gently 主窗口（开发与验证工具，仅 Windows）。

.DESCRIPTION
  为什么需要：`docs/STATE.md` 长期写着「视觉正确性依赖人工走查（环境无法截图）」——
  于是主题、布局、新页面**没有人真正看过**，扫描 / 推荐这些「要人点一下」的路径也只能靠假宿主断言。
  这个脚本用 Win32 做两件事：
  1. **截图**：`PrintWindow(PW_RENDERFULLCONTENT)`（WebView2 是 GPU 合成的，不传这个 flag 会抓成空白）；
  2. **驱动**：`SetForegroundWindow` + 光标点击 + 剪贴板粘贴 + 按键，
     于是可以真的把「点本地音乐 → 填目录 → 点扫描」跑一遍并看到结果。

  它不参与构建，也不进交付物。

  用法：
    pwsh -File scripts/capture-window.ps1 -Launch -Steps "click:70,252;wait:1" `
        -Output release/screenshots/local.png
    pwsh -File scripts/capture-window.ps1 -Launch -Steps "click:400,300;paste:D:\Music;click:700,300;wait:5" `
        -Output release/screenshots/scan.png -Kill

  验证**浏览器预览**（无 Tauri 宿主时 UI 必须照常可用）：先 `pnpm build` + `pnpm preview`，
  再用 `-ProcessName msedge -Exe "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"`
  `-ExeArgs "--app=http://localhost:4173"` 把 Edge 当成目标窗口驱动。

  `-Steps` 语法（分号分隔，坐标相对窗口左上角，与截图同一坐标系）：
    click:x,y     左键点击
    paste:文本    写入剪贴板后 Ctrl+V（中文路径也可以）
    enter         回车
    key:0xNN      按一个虚拟键（十六进制）
    wait:秒       等待
    resize:WxH    调整窗口大小（长页面一次看全）
    move:x,y      只移动光标（看 hover 态）
    wheel:-600    滚轮（负=向下）
    drag:x1,y1,x2,y2  拖拽（进度条 / 音量这类只能拖的控件）
    nofocus / focus   关 / 开「每步抢前台」——驱动**原生文件对话框**时先 nofocus，
                      否则抢前台会把对话框顶掉（R50 用它走完了「导入皮肤」的整条路）
    shot:路径     中途存一张（可多次，一次会话截多页）
    shotfg:路径   截**当前前台窗口**（用来看原生文件对话框这类不在应用里的窗口）
    clickfg:x,y   相对**当前前台窗口**点击（配合 nofocus 驱动原生对话框）
    dialog        把当前前台窗口记成「对话框」（原生对话框专用，之后坐标系就固定了）
    shotdlg:路径 / clickdlg:x,y   相对那扇对话框截图 / 点击（不随前台漂移）

  界面坐标（本机窗口 916×609 时实测；窗口大小变了要重新截图量一遍）：
    标题栏 y=32：灯泡 668（明暗）· 调色板 695（主题市场）· 齿轮 722（设置）· 画中画 749
                 窗口按钮 782 / 815 / 856
    侧边栏 x=70：排行榜 93 · 热门推荐 133 · 下载管理 173 · 本地音乐 213 ·
                 插件管理 253 · 最近播放 293 · 我的收藏 373（「我的歌单 +」218,373）
    播放条 y≈527：封面 75（点封面进歌词页）· 上一首 790 · 播放 836 · 下一首 882

  两条踩过的坑：
  1. 脚本会先杀掉遗留的 gently 进程再启动——否则可能驱动到上一轮的旧窗口，
     表现为「点了没反应、截图全是老页面」（主题、路由都不动）；
  2. 滚轮作用于**光标下**的元素，要先用 move 把光标放到内容区，否则停在侧边栏上页面纹丝不动。

  **长流程里每次输入前都会把窗口抢回前台**（R40 的教训）：`SetForegroundWindow` 只在开头调一次不够，
  十几秒的流程里别的窗口会抢走前台，于是合成点击落到**别的窗口**上——脚本一切正常、日志里却一条命令都没有，
  表现为「点了没反应」。现在每个 click/paste/key/move/wheel 之前都会重新抢前台，抢不回来会警告。

  **坐标不要靠肉眼估**（R33 的教训：把「卸载」估到 x=675，实际中心在 640，于是白查了半天
  「按钮点不动」）。两种可靠办法：
  · hover 对照：把光标移到目标上截一张，与「光标停在空白处」的基线逐像素比——
    有差异说明位置对；纯文本按钮的 hover 也会变色（`.ghost:hover`）。
  · 列扫描：在目标行的高度范围里逐列取最大亮度，>150 的连续区间就是标签文字的位置。

  **别在小图上猜**（R36 的教训）：14px 的播放/暂停图标在缩小预览里根本分不清，
  把那一小块裁出来最近邻放大 4~5 倍，一眼就能看出是 ‖ 还是 ▶。
  同理，「截图前后一样」也可能是 PrintWindow 对 WebView2 返回了上一帧：
  先 move 触发重绘、隔 1 秒连拍两张再对比。
#>
[CmdletBinding()]
param(
    # PNG 输出路径（相对仓库根目录）
    [Parameter(Mandatory = $true)][string]$Output,
    # 先启动 exe 再操作
    [switch]$Launch,
    # 可执行文件（默认离线交付的便携版目录里的那份）
    [string]$Exe = 'release\gently-0.1.0-windows-x64\gently.exe',
    # 目标窗口所属的进程名（默认 gently；验证**浏览器预览**时传 msedge）
    [string]$ProcessName = 'gently',
    # 传给 -Exe 的额外启动参数（例如浏览器预览：--app=http://localhost:4173）
    [string]$ExeArgs = '',
    # 以「应用窗口」方式打开这个 URL（浏览器预览专用：脚本自己拼 --app/--window-size/独立 profile，
    # 免得在命令行里传以 `--` 开头的参数被 PowerShell 当成参数名）
    [string]$AppUrl = '',
    # 启动后等待窗口出现并完成首屏的秒数
    [int]$WaitSeconds = 15,
    # 交互步骤（见上面语法）
    [string]$Steps = '',
    # 断言「界面真的渲染了」：抽样像素若几乎只有一种颜色（白屏/黑屏）则退出码 1
    [switch]$AssertRendered,
    # 结束进程（只在 -Launch 时有效）
    [switch]$Kill
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class GentlyWin32 {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOSIZE = 0x0001;
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int w, int h, bool repaint);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const int SW_RESTORE = 9;

    /* 强制重绘：WebView2 的合成结果偶尔不刷新，PrintWindow 会返回**上一帧**
       （R36 见过「截图一模一样」，R41 见过「日志里已经收藏成功、截图上心还是空的」）*/
    [DllImport("user32.dll")] public static extern bool InvalidateRect(IntPtr hWnd, IntPtr rect, bool erase);
    [DllImport("user32.dll")] public static extern bool UpdateWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr hWnd, IntPtr rect, IntPtr region, uint flags);
    public const uint RDW_INVALIDATE = 0x0001;
    public const uint RDW_UPDATENOW = 0x0100;
    public const uint RDW_ALLCHILDREN = 0x0080;

    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);

    /// <summary>进程里**面积最大的可见顶层窗口**：`MainWindowHandle` 有时指到 16x16 的隐藏辅助窗口</summary>
    public static IntPtr LargestWindow(uint targetPid) {
        IntPtr best = IntPtr.Zero;
        long bestArea = 0;
        EnumWindows((hWnd, _) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid != targetPid || !IsWindowVisible(hWnd)) return true;
            RECT rect;
            if (!GetWindowRect(hWnd, out rect)) return true;
            long area = (long)(rect.Right - rect.Left) * (rect.Bottom - rect.Top);
            if (area > bestArea) { bestArea = area; best = hWnd; }
            return true;
        }, IntPtr.Zero);
        return best;
    }
}
'@

Add-Type -AssemblyName System.Drawing

function Get-GentlyWindow {
    # **遍历全部同名进程**再挑面积最大的可见窗口。
    # 为什么不能只看一个进程：同一个可执行文件常常是多进程的（Edge 尤其明显：8 个 msedge 进程里
    # 只有一个持有 `--app` 那扇窗），只取「最新启动的那个」会直接找不到窗口（R48 撞到）。
    # 同时保留「像主窗口」的尺寸判据：启动早期可能只有 16x16 的辅助窗口，
    # 拿它当目标就会驱动到空气上、截出一张 16x16 的图（R34 栽过）。
    $procs = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
    if (-not $procs) { return $null }

    $best = $null
    $bestArea = 0
    foreach ($proc in $procs) {
        $handle = [GentlyWin32]::LargestWindow([uint32]$proc.Id)
        if ($handle -eq [IntPtr]::Zero) { continue }
        $rect = Get-Rect $handle
        $width = $rect.Right - $rect.Left
        $height = $rect.Bottom - $rect.Top
        if ($width -lt 400 -or $height -lt 300) { continue }
        $area = $width * $height
        if ($area -gt $bestArea) {
            $bestArea = $area
            $best = [pscustomobject]@{ Process = $proc; Handle = $handle }
        }
    }
    return $best
}

function Get-Rect([IntPtr]$handle) {
    $rect = New-Object GentlyWin32+RECT
    [void][GentlyWin32]::GetWindowRect($handle, [ref]$rect)
    return $rect
}

<#
把窗口重新抬到前台后再发输入。

**为什么每次输入前都要做**：`SetForegroundWindow` 只在开头调一次是不够的——跑长流程时
（十几秒、几十个步骤）别的窗口会抢走前台，于是 `SetCursorPos` + `mouse_event` 合成出来的点击
落到**别的窗口**上：脚本一切正常、日志里却一条命令都没有，表现为「点了没反应」。
R40 排查收藏/歌单流程时就栽在这里（前几步有效、后面全丢）。
#>
function Focus-App([IntPtr]$handle) {
    # `nofocus` 步骤会把这个开关打开：原生文件对话框是**另一个窗口**，
    # 每次输入前抢前台会把它顶掉，所以对话框那几步要显式关掉抢前台。
    if ($script:skipFocus) { return }
    if ([GentlyWin32]::GetForegroundWindow() -eq $handle) { return }
    [void][GentlyWin32]::ShowWindow($handle, [GentlyWin32]::SW_RESTORE)
    [void][GentlyWin32]::BringWindowToTop($handle)
    [void][GentlyWin32]::SetForegroundWindow($handle)
    Start-Sleep -Milliseconds 120
    if ([GentlyWin32]::GetForegroundWindow() -ne $handle) {
        Write-Warning '输入前没能把窗口抢回前台：这一步的点击可能落到别的窗口上'
    }
}

function Save-Shot([IntPtr]$handle, [string]$relativePath) {
    # 先强制重绘再抓：否则可能抓到**上一帧**（日志显示状态已变、图却还是旧的）
    [void][GentlyWin32]::RedrawWindow(
        $handle,
        [IntPtr]::Zero,
        [IntPtr]::Zero,
        [GentlyWin32]::RDW_INVALIDATE -bor [GentlyWin32]::RDW_UPDATENOW -bor [GentlyWin32]::RDW_ALLCHILDREN
    )
    [void][GentlyWin32]::InvalidateRect($handle, [IntPtr]::Zero, $true)
    [void][GentlyWin32]::UpdateWindow($handle)
    Start-Sleep -Milliseconds 350
    $rect = Get-Rect $handle
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) { throw "窗口尺寸异常：${width}x${height}" }

    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    $ok = [GentlyWin32]::PrintWindow($handle, $hdc, 2)   # PW_RENDERFULLCONTENT = 2
    $graphics.ReleaseHdc($hdc)
    $graphics.Dispose()
    if (-not $ok) { Write-Warning 'PrintWindow 返回 false（仍会保存，可能是空白图）' }

    $target = Join-Path $root $relativePath
    $dir = Split-Path -Parent $target
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)

    # 「渲染了没有」的廉价判据：抽样后颜色种类太少 = 白屏/黑屏（WebView 起不来、JS 崩了都会这样）
    $colors = New-Object 'System.Collections.Generic.HashSet[int]'
    for ($y = 0; $y -lt $height; $y += 8) {
        for ($x = 0; $x -lt $width; $x += 8) {
            [void]$colors.Add($bitmap.GetPixel($x, $y).ToArgb())
        }
    }
    $bitmap.Dispose()

    Write-Host "已保存截图：$relativePath（${width}x${height}，抽样颜色 $($colors.Count) 种）"
    if ($AssertRendered -and $colors.Count -lt 5) {
        Write-Error "界面看起来是空白的（抽样只有 $($colors.Count) 种颜色）——WebView 可能没渲染出来"
    }
}

if ($Launch) {
    if (-not (Test-Path $Exe)) { throw "找不到可执行文件：$Exe（先跑 pnpm tauri build --no-bundle）" }
    # 先清掉遗留实例：否则可能驱动到旧窗口（旧数据、旧主题）而看不出任何变化
    Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    if ($AppUrl) {
        $profile = Join-Path $env:TEMP 'gently-browser-preview'
        Start-Process -FilePath (Resolve-Path $Exe).Path -ArgumentList @(
            "--app=$AppUrl",
            '--window-size=1500,900',
            '--no-first-run',
            "--user-data-dir=$profile"
        ) | Out-Null
    } elseif ($ExeArgs) {
        Start-Process -FilePath (Resolve-Path $Exe).Path -ArgumentList $ExeArgs | Out-Null
    } else {
        Start-Process -FilePath (Resolve-Path $Exe).Path | Out-Null
    }
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$window = $null
while ((Get-Date) -lt $deadline) {
    $window = Get-GentlyWindow
    if ($window) { break }
    Start-Sleep -Milliseconds 300
}
if (-not $window) { throw "等待 $WaitSeconds 秒仍未找到 $ProcessName 主窗口" }
Start-Sleep -Seconds 2   # 首屏渲染

$handle = $window.Handle
[void][GentlyWin32]::ShowWindow($handle, [GentlyWin32]::SW_RESTORE)
# 真把窗口抬到最前：Chromium 把「被遮挡的窗口」当成 hidden，媒体播放会被挂起
# （表现为 <audio> 拿到了字节却不前进——R34 排查「本地播放进度不动」时踩到的就是这个）
[void][GentlyWin32]::BringWindowToTop($handle)
[void][GentlyWin32]::SetWindowPos($handle, [GentlyWin32]::HWND_TOPMOST, 0, 0, 0, 0, [GentlyWin32]::SWP_NOMOVE -bor [GentlyWin32]::SWP_NOSIZE)
[void][GentlyWin32]::SetForegroundWindow($handle)
[void][GentlyWin32]::SetWindowPos($handle, [GentlyWin32]::HWND_NOTOPMOST, 0, 0, 0, 0, [GentlyWin32]::SWP_NOMOVE -bor [GentlyWin32]::SWP_NOSIZE)
Start-Sleep -Milliseconds 500

if ([GentlyWin32]::GetForegroundWindow() -ne $handle) {
    Write-Warning '窗口不在前台：Chromium 可能把页面当成 hidden，媒体播放会被挂起'
}

foreach ($step in ($Steps -split ';' | Where-Object { $_.Trim() -ne '' })) {
    $parts = $step.Split(':', 2)
    $kind = $parts[0].Trim()
    $value = if ($parts.Length -gt 1) { $parts[1] } else { '' }

    switch ($kind) {
        'click' {
            Focus-App $handle
            $rect = Get-Rect $handle
            $xy = $value.Split(',')
            [void][GentlyWin32]::SetCursorPos($rect.Left + [int]$xy[0], $rect.Top + [int]$xy[1])
            Start-Sleep -Milliseconds 150
            [GentlyWin32]::mouse_event([GentlyWin32]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 60
            [GentlyWin32]::mouse_event([GentlyWin32]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
            Write-Host "click $value"
            Start-Sleep -Milliseconds 400
        }
        'clickfg' {
            # 相对**当前前台窗口**点击（原生对话框专用：它的坐标不在应用窗口坐标系里）。
            # 配合 `nofocus` 用：先点开对话框 → nofocus → clickfg/paste/enter → focus
            $fg = [GentlyWin32]::GetForegroundWindow()
            if ($fg -eq [IntPtr]::Zero) { Write-Warning '没有前台窗口可点'; continue }
            $rect = Get-Rect $fg
            $xy = $value.Split(',')
            [void][GentlyWin32]::SetCursorPos($rect.Left + [int]$xy[0], $rect.Top + [int]$xy[1])
            Start-Sleep -Milliseconds 150
            [GentlyWin32]::mouse_event([GentlyWin32]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 60
            [GentlyWin32]::mouse_event([GentlyWin32]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
            Write-Host "clickfg $value"
            Start-Sleep -Milliseconds 400
        }
        'paste' {
            Focus-App $handle
            Set-Clipboard -Value $value
            Start-Sleep -Milliseconds 200
            [GentlyWin32]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)                                 # Ctrl
            [GentlyWin32]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)                                 # V
            [GentlyWin32]::keybd_event(0x56, 0, [GentlyWin32]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
            [GentlyWin32]::keybd_event(0x11, 0, [GentlyWin32]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
            Write-Host "paste $value"
            Start-Sleep -Milliseconds 400
        }
        'enter' {
            Focus-App $handle
            [GentlyWin32]::keybd_event(0x0D, 0, 0, [UIntPtr]::Zero)
            [GentlyWin32]::keybd_event(0x0D, 0, [GentlyWin32]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 400
        }
        'key' {
            Focus-App $handle
            $vk = [Convert]::ToByte($value, 16)
            [GentlyWin32]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
            [GentlyWin32]::keybd_event($vk, 0, [GentlyWin32]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 300
        }
        'wait' { Start-Sleep -Seconds ([double]$value) }
        'nofocus' {
            # 之后的步骤不抢前台（用于驱动**原生文件对话框**这类别的窗口）
            $script:skipFocus = $true
            Write-Host 'nofocus'
        }
        'focus' {
            $script:skipFocus = $false
            Write-Host 'focus'
        }
        'resize' {
            # 把窗口改大：长页面（插件导入/预览/同意/安装）一次看全，省得跟滚轮较劲
            $wh = $value.Split('x')
            $rect = Get-Rect $handle
            [void][GentlyWin32]::MoveWindow($handle, $rect.Left, $rect.Top, [int]$wh[0], [int]$wh[1], $true)
            Write-Host "resize $value"
            Start-Sleep -Milliseconds 800
        }
        'shot' {
            # 流程中途存一张（一次会话里可以把多个页面都截下来）
            Save-Shot $handle $value.Trim()
        }
        'shotfg' {
            # 截**当前前台窗口**：原生对话框（文件选择器 / 消息框）不在应用窗口里，
            # 用 `shot` 永远拍不到它；这一步专门用来看清对话框上有什么、控件在哪（R50 加的）
            $fg = [GentlyWin32]::GetForegroundWindow()
            if ($fg -eq [IntPtr]::Zero) { Write-Warning '没有前台窗口可截' } else { Save-Shot $fg $value.Trim() }
        }
        'dialog' {
            # 记住「现在这扇原生对话框」的句柄（此刻它在前台、应用窗口被禁用）。
            # 之后用 shotdlg/clickdlg 都以**它**为坐标系——不再依赖「当前前台窗口」，
            # 因为前台会在几步之间被换走（R50 就是栽在这上面：clickfg 算错坐标系，点了空气）。
            $fg = [GentlyWin32]::GetForegroundWindow()
            if ($fg -eq [IntPtr]::Zero -or $fg -eq $handle) {
                Write-Warning '当前前台窗口不是别的窗口，dialog 句柄没记下来'
            } else {
                $script:dialogHandle = $fg
                $rect = Get-Rect $fg
                Write-Host "dialog hwnd=$fg ($($rect.Right - $rect.Left)x$($rect.Bottom - $rect.Top))"
            }
        }
        'shotdlg' {
            if ($script:dialogHandle -ne [IntPtr]::Zero -and [GentlyWin32]::IsWindow($script:dialogHandle)) {
                Save-Shot $script:dialogHandle $value.Trim()
            } else {
                Write-Warning '没有可用的对话框句柄（先来一步 dialog）'
            }
        }
        'clickdlg' {
            if ($script:dialogHandle -eq [IntPtr]::Zero -or -not [GentlyWin32]::IsWindow($script:dialogHandle)) {
                Write-Warning '没有可用的对话框句柄（先来一步 dialog）'
                continue
            }
            $rect = Get-Rect $script:dialogHandle
            $xy = $value.Split(',')
            [void][GentlyWin32]::SetCursorPos($rect.Left + [int]$xy[0], $rect.Top + [int]$xy[1])
            Start-Sleep -Milliseconds 150
            [GentlyWin32]::mouse_event([GentlyWin32]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 60
            [GentlyWin32]::mouse_event([GentlyWin32]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
            Write-Host "clickdlg $value"
            Start-Sleep -Milliseconds 400
        }
        'move' {
            # 只移动光标（用来看清 hover 态：例如卡片上的「不感兴趣」按钮只有悬浮才出现）
            Focus-App $handle
            $rect = Get-Rect $handle
            $xy = $value.Split(',')
            [void][GentlyWin32]::SetCursorPos($rect.Left + [int]$xy[0], $rect.Top + [int]$xy[1])
            Start-Sleep -Milliseconds 500
        }
        'wheel' {
            # value 是滚轮增量：负=向下滚（每格 120）。滚轮作用于**光标下**的元素
            Focus-App $handle
            $delta = [int]$value
            $unsigned = [int]$delta
            [GentlyWin32]::mouse_event(0x0800, 0, 0, $unsigned, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 400
        }
        'drag' {
            # 拖拽：x1,y1,x2,y2。用于进度条（SeekBar）与音量这类**只能拖**的控件：
            # 一次按下 → 中间分几步移动（真实拖拽每步都会触发 pointermove）→ 抬起。
            # 分步很重要：一步跳到终点有些控件收不到 pointermove，松手时位置就回弹了。
            Focus-App $handle
            $rect = Get-Rect $handle
            $nums = $value.Split(',')
            if ($nums.Length -ne 4) { Write-Warning "drag 需要 x1,y1,x2,y2：$value"; continue }
            $x1 = [int]$nums[0]; $y1 = [int]$nums[1]; $x2 = [int]$nums[2]; $y2 = [int]$nums[3]
            [void][GentlyWin32]::SetCursorPos($rect.Left + $x1, $rect.Top + $y1)
            Start-Sleep -Milliseconds 120
            [GentlyWin32]::mouse_event([GentlyWin32]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 80
            $steps = 12
            for ($i = 1; $i -le $steps; $i++) {
                $x = [int]($x1 + ($x2 - $x1) * $i / $steps)
                $y = [int]($y1 + ($y2 - $y1) * $i / $steps)
                [void][GentlyWin32]::SetCursorPos($rect.Left + $x, $rect.Top + $y)
                Start-Sleep -Milliseconds 40
            }
            [GentlyWin32]::mouse_event([GentlyWin32]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
            Write-Host "drag $value"
            Start-Sleep -Milliseconds 400
        }
        default { Write-Warning "未知步骤：$step" }
    }
}

Save-Shot $handle $Output

if ($Kill -and $Launch) {
    Stop-Process -Id $window.Process.Id -Force -ErrorAction SilentlyContinue
    Write-Host '已结束应用进程'
}
