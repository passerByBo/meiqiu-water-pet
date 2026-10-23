//! 鼠标追踪 + 打字检测。
//! 猫的窗口大部分时间是"点击穿透"的，网页收不到鼠标事件，所以由 Rust 读取全局鼠标位置推送给前端
//! （用来转头看鼠标、判断鼠标是否在猫身上、拖拽猫）。
//! 打字检测：键鼠有输入、但鼠标没动 → 认为在打字（或滚动滚轮）。只判断"是否在打字"，不读取按了什么键。

use serde::Serialize;
use std::time::{Duration, Instant};
use std::thread;
use tauri::{AppHandle, Emitter};

/// 约 60 次/秒；只有位置或按键变化时才推送
const CURSOR_POLL_INTERVAL: Duration = Duration::from_millis(16);
/// 最后一次键盘输入后多久内算"正在打字"
const TYPING_HOLD_DURATION: Duration = Duration::from_millis(1500);

#[derive(Serialize, Clone, Copy, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CursorState {
    /// 物理像素坐标（虚拟屏幕坐标，副屏可能是负数）
    pub x: i32,
    pub y: i32,
    pub is_left_button_down: bool,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct TypingState {
    is_typing: bool,
}

pub fn read_cursor() -> CursorState {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut point = POINT::default();
        let _ = GetCursorPos(&mut point);
        // 最高位为 1 表示按键当前处于按下状态
        let is_left_button_down = (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0;
        CursorState { x: point.x, y: point.y, is_left_button_down }
    }
    #[cfg(not(windows))]
    CursorState::default()
}

/// 系统记录的"最后一次键鼠输入"时刻（毫秒计数）
fn last_input_tick() -> u32 {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut info).as_bool() {
            return info.dwTime;
        }
    }
    0
}

pub fn start(app: AppHandle) {
    thread::spawn(move || {
        let mut previous_state: Option<CursorState> = None;
        let mut previous_input_tick = last_input_tick();
        let mut last_keyboard_activity: Option<Instant> = None;
        let mut was_typing = false;
        loop {
            let state = read_cursor();
            let input_tick = last_input_tick();
            // 有新的输入，但鼠标位置和按键都没变 → 键盘输入
            if input_tick != previous_input_tick && previous_state == Some(state) {
                last_keyboard_activity = Some(Instant::now());
            }
            previous_input_tick = input_tick;

            if previous_state != Some(state) {
                let _ = app.emit("cursor-moved", state);
                previous_state = Some(state);
            }

            let is_typing = last_keyboard_activity.is_some_and(|time| time.elapsed() < TYPING_HOLD_DURATION);
            if is_typing != was_typing {
                let _ = app.emit("typing-changed", TypingState { is_typing });
                was_typing = is_typing;
            }
            thread::sleep(CURSOR_POLL_INTERVAL);
        }
    });
}
