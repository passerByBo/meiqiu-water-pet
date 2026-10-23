//! 猫咪窗口：透明、置顶、不抢焦点、不出现在 Alt+Tab 里；由前端每帧告诉它移动到哪儿。

use crate::desktop_layout::{self, DesktopLayout};
use tauri::{AppHandle, Manager, WebviewWindow};

pub const PET_WINDOW_LABEL: &str = "pet";

/// 煤球自己的窗口句柄（枚举窗口时要排除掉自己）
pub struct PetWindowHandles {
    pub excluded_handles: Vec<isize>,
}

pub fn native_handle(window: &WebviewWindow) -> isize {
    #[cfg(windows)]
    {
        window.hwnd().map(|hwnd| hwnd.0 as isize).unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        0
    }
}

/// 设置窗口扩展样式：不激活（点击猫不会抢走你正在打字的窗口的焦点）+ 工具窗口（不出现在 Alt+Tab）
pub fn apply_pet_window_style(window: &WebviewWindow) -> tauri::Result<()> {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        };
        let hwnd = HWND(native_handle(window) as *mut core::ffi::c_void);
        let extended_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, extended_style | (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) as isize);
    }
    // 默认点击穿透，鼠标移到猫身上时前端再关掉
    window.set_ignore_cursor_events(true)?;
    Ok(())
}

/// 移动猫窗口到物理像素坐标 (x, y)；同时保持置顶、不激活
pub fn move_to(window: &WebviewWindow, x: i32, y: i32) {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOSIZE};
        let hwnd = HWND(native_handle(window) as *mut core::ffi::c_void);
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
    }
    #[cfg(not(windows))]
    {
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

pub fn toggle_visibility(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
        if window.is_visible().unwrap_or(true) {
            let _ = window.hide();
        } else {
            let _ = window.show();
        }
    }
}

pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
        let _ = window.show();
    }
}

// ---------------- 给前端调用的命令 ----------------

#[tauri::command]
pub fn get_desktop_layout(handles: tauri::State<PetWindowHandles>) -> DesktopLayout {
    desktop_layout::snapshot(&handles.excluded_handles)
}

#[tauri::command]
pub fn move_pet_window(window: WebviewWindow, x: i32, y: i32) {
    move_to(&window, x, y);
}

#[tauri::command]
pub fn set_click_through(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(enabled).map_err(|error| error.to_string())
}

/// 宠物在桌面上的位置（屏幕逻辑坐标，脚底中心），存在数据库里，下次启动回到原地
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy)]
pub struct PetPosition {
    pub x: f64,
    pub y: f64,
}

const PET_POSITION_KEY: &str = "petPosition";
/// 坐标的合理范围（再大的多屏组合也到不了这里），防止存进奇怪的数字
const MAX_COORDINATE: f64 = 100_000.0;

fn is_valid_position(position: &PetPosition) -> bool {
    position.x.is_finite() && position.y.is_finite() && position.x.abs() < MAX_COORDINATE && position.y.abs() < MAX_COORDINATE
}

/// 读取上次保存的位置；没有或数据不对就返回 None（前端用默认位置）
#[tauri::command]
pub fn get_pet_position(database: tauri::State<crate::storage::Database>) -> Option<PetPosition> {
    let saved = database.read_cat_state(PET_POSITION_KEY)?;
    serde_json::from_str::<PetPosition>(&saved).ok().filter(is_valid_position)
}

#[tauri::command]
pub fn save_pet_position(database: tauri::State<crate::storage::Database>, x: f64, y: f64) {
    let position = PetPosition { x, y };
    if !is_valid_position(&position) {
        return;
    }
    if let Ok(content) = serde_json::to_string(&position) {
        database.write_cat_state(PET_POSITION_KEY, &content);
    }
}
