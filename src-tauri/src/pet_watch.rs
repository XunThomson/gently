//! 宠物窗口的「看向哪边」+「只有精灵本体吃点击」+「自己在屏幕上走走」（Windows）。
//!
//! 为什么需要宿主来做：
//! - 「看着你」指的是**屏幕上的鼠标在哪**，宠物窗口只在自己那 200×160 里收得到指针事件；
//! - 「透明的地方别挡鼠标」需要知道**窗口之外**的光标位置，前端自己判断不了（被忽略时光标事件也收不到）；
//! - 「走动」是把**窗口**在屏幕上平移，这件事只有宿主能做（前端没有屏幕坐标系）。
//!
//! 这条 60ms 的线程同时做三件事：
//! 1. 算光标相对宠物窗口中心的 16 向角度，**变化时**发 `gently:pet:look`；
//! 2. 判断光标是否落在**可交互区域**里（精灵 + 拖动条，前端登记），不在就 `set_ignore_cursor_events(true)`；
//! 3. 走动开着时，慢慢把窗口挪到屏幕底部的一个随机位置，并告诉宠物「往哪边走」（`gently:pet:walk`），
//!    好让它演 `runLeft` / `runRight`。
//!
//! 边界：
//! - 只在 Windows 上工作（`GetCursorPos`）；其它平台：没有 look、没有自动穿透、也不走动；
//! - 手动「锁定（点击穿透）」优先：锁定后无论光标在哪都穿透（否则锁不住）；
//! - 事件名必须遵守 Tauri 字符集（只允许字母数字与 `- / : _`）；
//! - 方向定义：**0 = 正上，顺时针**（与 Codex Pet v2 的 16 个 look 方向一致）。

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{Emitter, Listener, Manager};

/// 宠物窗口 label（与 `tauri.conf.json` 一致）
const PET_WINDOW_LABEL: &str = "pet";
/// 事件：宠物该看向哪个方向（0..16）
pub const PET_LOOK_EVENT: &str = "gently:pet:look";
/// 事件：宠物正在往哪边走（-1 左 / 0 停 / 1 右）
pub const PET_WALK_EVENT: &str = "gently:pet:walk";
/// 事件：宠物窗口报告「可交互区域」列表（CSS 像素，窗口内坐标）
const PET_HITBOX_EVENT: &str = "gently:pet:hitbox";
/// 事件：宠物窗口的锁定（点击穿透）状态
const PET_LOCK_EVENT: &str = "gently:pet:lock";
/// 事件：是否允许在屏幕上走动
const PET_ROAM_EVENT: &str = "gently:pet:roam";
/// 事件：前端正在拖动宠物窗口（拖动期间冻结穿透切换与自动走动）
const PET_DRAGGING_EVENT: &str = "gently:pet:dragging";
/// 轮询间隔：60ms 够顺滑，也不会把 CPU 拉起来
const POLL_MS: u64 = 60;

/// 上一次发出去的方向（-1 = 还没发过）
static LAST_DIR: AtomicI32 = AtomicI32::new(-1);
/// 手动锁定（点击穿透）状态
static LOCKED: AtomicBool = AtomicBool::new(false);
/// 当前是否处于「忽略光标事件」状态（None = 还没设置过）
static IGNORING: AtomicI32 = AtomicI32::new(-1);
/// 可交互区域（CSS 像素，窗口内坐标）：x, y, w, h；还没收到时当作「整窗都可交互」
static HITBOX: Mutex<Option<Vec<[f64; 4]>>> = Mutex::new(None);
/// 用户正在拖宠物窗口（拖动期间不切穿透、不自己走）
static DRAGGING: AtomicBool = AtomicBool::new(false);
/// 光标连续多少拍落在宠物身上了（用来做「别一擦过就停下」的迟滞）
static INSIDE_STREAK: AtomicI32 = AtomicI32::new(0);
/// 连续这么多拍（≈0.6s）都在宠物身上才暂停走动：光标擦一下就让宠物停住，
/// 核心那边会看到「在走 → 没走 → 在走」，动画就会闪
const PAUSE_AFTER_TICKS: i32 = 10;

/* ---------------- 走动状态 ---------------- */
/// 允许走动（设置页开关）
static ROAM: AtomicBool = AtomicBool::new(false);
/// 当前走动方向（-1 / 0 / 1），变化时才发事件
static WALK_DIR: AtomicI32 = AtomicI32::new(0);
/// 这一趟的目标 x（物理像素；None = 现在没在走）
static WALK_TARGET: Mutex<Option<i32>> = Mutex::new(None);
/// 60ms 计数的「时钟」（不读系统时间，方便推理）
static TICK: AtomicU64 = AtomicU64::new(0);
/// 下一次该出发的 tick
static NEXT_WALK_AT: AtomicU64 = AtomicU64::new(120);
/// xorshift64 的状态
static RNG: AtomicU64 = AtomicU64::new(0x9e37_79b9_7f4a_7c15);
/// 每 60ms 挪多少物理像素（4px ≈ 66px/s，桌宠速度）
const WALK_STEP_PX: i32 = 4;
/// 一趟至少走多远，避免原地抖
const WALK_MIN_DISTANCE_PX: i32 = 120;
/// 走完之后歇多久：18–42 秒（300–700 个 tick）
const REST_MIN_TICKS: u64 = 300;
const REST_MAX_TICKS: u64 = 700;

/// 启动轮询 + 订阅前端发来的两个窗口状态事件
pub fn install(app: tauri::AppHandle) {
    listen_state_events(&app);
    #[cfg(windows)]
    {
        let handle = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(POLL_MS));
            poll_once(&handle);
        });
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

/// 前端 → 宿主：可交互区域列表 / 锁定状态（两端都是「最新值覆盖」，不需要队列）
fn listen_state_events(app: &tauri::AppHandle) {
    #[derive(Deserialize)]
    struct HitArea {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }
    #[derive(Deserialize)]
    struct HitBox {
        rects: Vec<HitArea>,
    }
    #[derive(Deserialize)]
    struct Lock {
        locked: bool,
    }

    let hitbox_app = app.clone();
    app.listen(PET_HITBOX_EVENT, move |event| {
        let payload = event.payload();
        let Ok(hit) = serde_json::from_str::<HitBox>(payload) else { return };
        let rects: Vec<[f64; 4]> = hit
            .rects
            .iter()
            .map(|area| [area.x, area.y, area.width, area.height])
            .collect();
        tracing::debug!(count = rects.len(), "宠物可交互区域已更新");
        if let Ok(mut slot) = HITBOX.lock() {
            *slot = Some(rects);
        }
        /* 立刻按新矩形重新判定一次（拖动/换宠物后不用等下一次轮询） */
        #[cfg(windows)]
        poll_once(&hitbox_app);
    });

    app.listen(PET_LOCK_EVENT, move |event| {
        let payload = event.payload();
        let Ok(lock) = serde_json::from_str::<Lock>(payload) else { return };
        LOCKED.store(lock.locked, Ordering::Relaxed);
        tracing::debug!(locked = lock.locked, "宠物窗口锁定状态已更新");
    });

    app.listen(PET_ROAM_EVENT, move |event| {
        let payload = event.payload();
        let Ok(roam) = serde_json::from_str::<Roam>(payload) else { return };
        ROAM.store(roam.enabled, Ordering::Relaxed);
        if !roam.enabled {
            /* 关掉走动：立刻清掉目标，让窗口停在原地 */
            if let Ok(mut target) = WALK_TARGET.lock() {
                *target = None;
            }
        }
        tracing::debug!(enabled = roam.enabled, "宠物走动开关已更新");
    });

    app.listen(PET_DRAGGING_EVENT, move |event| {
        let payload = event.payload();
        let Ok(drag) = serde_json::from_str::<Dragging>(payload) else { return };
        DRAGGING.store(drag.dragging, Ordering::Relaxed);
        tracing::debug!(dragging = drag.dragging, "宠物窗口拖动状态已更新");
    });
}

#[derive(Deserialize)]
struct Dragging {
    dragging: bool,
}

#[derive(Deserialize)]
struct Roam {
    enabled: bool,
}

/// xorshift64：走动目标与歇息时长用它取随机（不引入依赖，也不需要密码学强度）
fn next_rand() -> u64 {
    let mut state = RNG.load(Ordering::Relaxed);
    state ^= state << 13;
    state ^= state >> 7;
    state ^= state << 17;
    RNG.store(state, Ordering::Relaxed);
    state
}

#[cfg(windows)]
fn current_tick() -> u64 {
    TICK.fetch_add(1, Ordering::Relaxed) + 1
}

/// 走动一步：返回是否真的移动了（窗口不可见 / 没开走动 / 用户正在操作 → 不动）
#[cfg(windows)]
fn walk_step(app: &tauri::AppHandle, window: &tauri::WebviewWindow, cursor_inside: bool) {
    if !ROAM.load(Ordering::Relaxed) {
        stop_walking(app);
        return;
    }
    /* 用户正把光标放在宠物身上（准备点/拖）时先别动，免得「点不到」。
       但要连续待一小会儿才算真的在操作：擦一下就走不该让走动停下来。 */
    if cursor_inside {
        let streak = INSIDE_STREAK.fetch_add(1, Ordering::Relaxed) + 1;
        if streak >= PAUSE_AFTER_TICKS {
            stop_walking(app);
            return;
        }
    } else {
        INSIDE_STREAK.store(0, Ordering::Relaxed);
    }
    let Ok(monitor) = window.current_monitor() else {
        return;
    };
    let Some(monitor) = monitor else { return };
    let Ok(size) = window.inner_size() else { return };
    let Ok(position) = window.outer_position() else { return };
    let monitor_left = monitor.position().x;
    let monitor_right = monitor_left + monitor.size().width as i32 - size.width as i32;

    let mut target_slot = match WALK_TARGET.lock() {
        Ok(slot) => slot,
        Err(_) => return,
    };
    if target_slot.is_none() {
        let tick = current_tick();
        if tick < NEXT_WALK_AT.load(Ordering::Relaxed) {
            stop_walking(app);
            return;
        }
        /* 选一个离现在足够远的目标；运气不好（太近）就下一轮再试 */
        let span = (monitor_right - monitor_left).max(1) as u64;
        let mut candidate = monitor_left + (next_rand() % span) as i32;
        for _ in 0..4 {
            if (candidate - position.x).abs() >= WALK_MIN_DISTANCE_PX {
                break;
            }
            candidate = monitor_left + (next_rand() % span) as i32;
        }
        *target_slot = Some(candidate);
        tracing::debug!(target = candidate, "宠物出发去一个新的位置");
    }
    let Some(target) = *target_slot else { return };

    let dx = target - position.x;
    let step = dx.clamp(-WALK_STEP_PX, WALK_STEP_PX);
    let next_x = position.x + step;
    let _ = window.set_position(tauri::PhysicalPosition::new(next_x, position.y));

    let dir = step.signum();
    emit_walk(app, dir);

    if dx.abs() <= WALK_STEP_PX {
        *target_slot = None;
        drop(target_slot);
        stop_walking(app);
        let rest = REST_MIN_TICKS + (next_rand() % (REST_MAX_TICKS - REST_MIN_TICKS));
        NEXT_WALK_AT.store(current_tick() + rest, Ordering::Relaxed);
        tracing::debug!(next_in_ticks = rest, "宠物到地方了，歇一会儿");
    }
}

/// 方向变化时才发事件（宠物窗口据此演 runLeft / runRight）
#[cfg(windows)]
fn emit_walk(app: &tauri::AppHandle, dir: i32) {
    if WALK_DIR.swap(dir, Ordering::Relaxed) != dir {
        tracing::debug!(dir, "宠物走动方向变化");
        let _ = app.emit_to(PET_WINDOW_LABEL, PET_WALK_EVENT, dir);
    }
}

#[cfg(windows)]
fn stop_walking(app: &tauri::AppHandle) {
    emit_walk(app, 0);
}

#[cfg(windows)]
fn poll_once(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    let Some((x, y)) = cursor_position() else {
        return;
    };
    let dx = x - position.x;
    let dy = y - position.y;

    /* 0. 用户正在拖：这期间穿透状态与窗口位置都归用户，宿主一律不插手 */
    if DRAGGING.load(Ordering::Relaxed) {
        stop_walking(app);
        return;
    }

    /* 1. 看向哪里：以窗口中心为原点（小窗里中心≈精灵中心，够用） */
    let cx = f64::from(dx) - f64::from(size.width) / 2.0;
    let cy = f64::from(dy) - f64::from(size.height) / 2.0;
    let mut dir = ((cx.atan2(-cy) / (std::f64::consts::TAU / 16.0)).round() as i32) % 16;
    if dir < 0 {
        dir += 16;
    }
    if LAST_DIR.swap(dir, Ordering::Relaxed) != dir {
        tracing::debug!(dir, "宠物看向新的方向");
        let _ = app.emit_to(PET_WINDOW_LABEL, PET_LOOK_EVENT, dir);
    }

    /* 2. 只有「可交互区域」吃点击：光标不在任何一块里（或者用户锁定了）就穿透 */
    let scale = window.scale_factor().unwrap_or(1.0);
    let inside = match HITBOX.lock().ok().and_then(|slot| slot.clone()) {
        Some(rects) => inside_any(dx, dy, &rects, scale),
        /* 还没收到矩形：保守一点，整窗都算可交互（宁可挡一点，也别让宠物突然点不到） */
        None => true,
    };
    let desired_ignore = LOCKED.load(Ordering::Relaxed) || !inside;
    let desired = i32::from(desired_ignore);
    if IGNORING.swap(desired, Ordering::Relaxed) != desired {
        if let Err(err) = window.set_ignore_cursor_events(desired_ignore) {
            tracing::warn!(error = %err, "设置宠物窗口点击穿透失败");
        } else {
            tracing::debug!(ignore = desired_ignore, inside, "宠物窗口点击穿透状态切换");
        }
    }

    /* 3. 走动：慢慢把窗口挪到屏幕上的另一个位置（光标在宠物身上时先停） */
    walk_step(app, &window, inside);
}

/// 光标（物理像素，窗口内坐标）是否落在**任意一块**可交互区域（CSS 像素）里
#[cfg(windows)]
fn inside_any(dx: i32, dy: i32, rects: &[[f64; 4]], scale: f64) -> bool {
    rects
        .iter()
        .any(|rect| inside_rect(dx, dy, rect[0], rect[1], rect[2], rect[3], scale))
}

/// 光标（物理像素，窗口内坐标）是否落在某块矩形（CSS 像素）里
#[cfg(windows)]
fn inside_rect(dx: i32, dy: i32, x: f64, y: f64, width: f64, height: f64, scale: f64) -> bool {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let left = x * scale;
    let top = y * scale;
    let right = left + width * scale;
    let bottom = top + height * scale;
    f64::from(dx) >= left && f64::from(dx) <= right && f64::from(dy) >= top && f64::from(dy) <= bottom
}

#[cfg(windows)]
#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn GetCursorPos(point: *mut Point) -> i32;
}

#[cfg(windows)]
fn cursor_position() -> Option<(i32, i32)> {
    let mut point = Point { x: 0, y: 0 };
    // SAFETY: 传进去的是本函数栈上的合法指针，GetCursorPos 只写这一个结构
    let ok = unsafe { GetCursorPos(&mut point) };
    if ok == 0 {
        return None;
    }
    Some((point.x, point.y))
}

#[cfg(test)]
mod tests {
    use super::{inside_any, inside_rect};

    #[test]
    fn hit_box_respects_the_scale_factor() {
        // 精灵在窗口 (104,48) 起、96×104，缩放 1.0
        assert!(inside_rect(110, 60, 104.0, 48.0, 96.0, 104.0, 1.0));
        assert!(!inside_rect(10, 10, 104.0, 48.0, 96.0, 104.0, 1.0));
        // 150% 缩放：物理坐标要按 1.5 倍放大后比较
        assert!(inside_rect(170, 80, 104.0, 48.0, 96.0, 104.0, 1.5));
        assert!(!inside_rect(150, 80, 104.0, 48.0, 96.0, 104.0, 1.5));
        // 边界算「里面」：光标刚好在右上角
        assert!(inside_rect(200, 152, 104.0, 48.0, 96.0, 104.0, 1.0));
    }

    #[test]
    fn any_of_the_registered_areas_counts() {
        /* 两块：顶部拖动条（整宽 14px）+ 精灵（右下 96×104）。
           拖动条必须算「里面」，否则自动穿透会让它永远收不到 pointerdown（R101 的拖动失效）。 */
        let rects = vec![[0.0, 0.0, 200.0, 14.0], [96.0, 48.0, 96.0, 104.0]];
        assert!(inside_any(100, 6, &rects, 1.0), "光标在拖动条上 → 吃鼠标");
        assert!(inside_any(150, 100, &rects, 1.0), "光标在精灵上 → 吃鼠标");
        assert!(!inside_any(20, 100, &rects, 1.0), "窗口左下角是空的 → 穿透");
        assert!(!inside_any(180, 20, &rects, 1.0), "拖动条右侧与精灵之间的空隙 → 穿透");
    }
}





