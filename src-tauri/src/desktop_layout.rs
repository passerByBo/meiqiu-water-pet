//! 桌面布局：列出所有显示器和可见窗口（物理像素坐标），并在布局变化时推送给前端。
//! 前端据此计算猫能走的空地、能藏的窗口。

use serde::Serialize;
use std::{thread, time::Duration};
use tauri::{AppHandle, Emitter};

/// 轮询间隔：每秒约 7 次，拖动窗口时猫也能及时躲开；只有布局真的变化时才推送
const LAYOUT_POLL_INTERVAL: Duration = Duration::from_millis(140);

#[derive(Serialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl PhysicalRect {
    fn width(&self) -> i32 {
        self.right - self.left
    }
    fn height(&self) -> i32 {
        self.bottom - self.top
    }
    fn covers(&self, other: &PhysicalRect) -> bool {
        self.left <= other.left && self.top <= other.top && self.right >= other.right && self.bottom >= other.bottom
    }
}

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    /// 显示器设备名（例如 \\.\DISPLAY1），作为唯一标识
    pub id: String,
    /// 整块屏幕的范围
    pub bounds: PhysicalRect,
    /// 去掉任务栏后的可用区域
    pub work_area: PhysicalRect,
    /// 缩放比例（100% = 1.0，150% = 1.5）
    pub scale_factor: f64,
    pub is_primary: bool,
}

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindow {
    pub id: String,
    pub title: String,
    /// 程序文件名（例如 WeChat.exe、chrome.exe），用来判断你在做什么；只在内存里用，不保存不上传
    pub process_name: String,
    /// 窗口实际可见的范围（不含看不见的阴影和缩放边框）
    pub bounds: PhysicalRect,
    pub is_maximized: bool,
    /// 盖住整块屏幕（F11 全屏、全屏视频、PPT 放映等）
    pub is_fullscreen: bool,
    pub monitor_id: String,
    pub is_foreground: bool,
}

#[derive(Serialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLayout {
    pub monitors: Vec<MonitorInfo>,
    /// 按从上到下的层叠顺序排列
    pub windows: Vec<DesktopWindow>,
}

impl DesktopLayout {
    /// 当前前台窗口是否是全屏应用（用来推迟提醒）
    pub fn is_foreground_fullscreen(&self) -> bool {
        self.windows.iter().any(|window| window.is_foreground && window.is_fullscreen)
    }
}

/// 读取当前桌面布局；excluded_handles 是要忽略的窗口（煤球自己的窗口）
pub fn snapshot(excluded_handles: &[isize]) -> DesktopLayout {
    #[cfg(windows)]
    {
        native::snapshot(excluded_handles)
    }
    #[cfg(not(windows))]
    {
        let _ = excluded_handles;
        DesktopLayout::default()
    }
}

/// 后台线程：定时读取布局，有变化就推送 desktop-layout-changed 事件
pub fn start_watcher(app: AppHandle, excluded_handles: Vec<isize>) {
    thread::spawn(move || {
        let mut previous_layout = DesktopLayout::default();
        loop {
            let layout = snapshot(&excluded_handles);
            if layout != previous_layout {
                let _ = app.emit("desktop-layout-changed", &layout);
                previous_layout = layout;
            }
            thread::sleep(LAYOUT_POLL_INTERVAL);
        }
    });
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
        MONITOR_DEFAULTTONEAREST,
    };
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, IsZoomed, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };

    /// 这些系统窗口不算"挡路的窗口"：桌面本身、任务栏、系统弹出层等
    const IGNORED_WINDOW_CLASSES: &[&str] = &[
        "Progman",
        "WorkerW",
        "Shell_TrayWnd",
        "Shell_SecondaryTrayWnd",
        "Windows.UI.Core.CoreWindow",
        "NotifyIconOverflowWindow",
        "TopLevelWindowForOverflowXamlIsland",
        "XamlExplorerHostIslandWindow",
    ];
    /// 太小的窗口（悬浮小工具等）忽略
    const MINIMUM_WINDOW_SIZE: i32 = 40;
    const MONITORINFOF_PRIMARY: u32 = 1;
    const USER_DEFAULT_DPI: f64 = 96.0;

    struct WindowCollector<'a> {
        excluded_handles: &'a [isize],
        monitors: &'a [(isize, MonitorInfo)],
        foreground_handle: isize,
        windows: Vec<DesktopWindow>,
    }

    fn to_physical_rect(rect: RECT) -> PhysicalRect {
        PhysicalRect { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    }

    /// 读取 Win32 返回的 UTF-16 字符串
    fn read_wide_text(read: impl FnOnce(&mut [u16]) -> i32) -> String {
        let mut buffer = [0u16; 256];
        let length = read(&mut buffer).clamp(0, buffer.len() as i32) as usize;
        String::from_utf16_lossy(&buffer[..length])
    }

    thread_local! {
        /// 进程 id → 程序文件名 的缓存（每秒要读好几次布局，避免反复打开进程）
        static PROCESS_NAME_CACHE: std::cell::RefCell<std::collections::HashMap<u32, String>> = Default::default();
    }

    /// 读取窗口所属程序的文件名（只取文件名，例如 WeChat.exe）
    unsafe fn read_process_name(hwnd: HWND) -> String {
        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id == 0 {
            return String::new();
        }
        if let Some(cached_name) = PROCESS_NAME_CACHE.with(|cache| cache.borrow().get(&process_id).cloned()) {
            return cached_name;
        }
        let process_name = query_process_name(process_id);
        PROCESS_NAME_CACHE.with(|cache| {
            let mut cache = cache.borrow_mut();
            if cache.len() > 500 {
                cache.clear(); // 防止长时间运行后缓存无限增长
            }
            cache.insert(process_id, process_name.clone());
        });
        process_name
    }

    unsafe fn query_process_name(process_id: u32) -> String {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) else {
            return String::new();
        };
        let mut buffer = [0u16; 520];
        let mut length = buffer.len() as u32;
        let full_path = if QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut length).is_ok() {
            String::from_utf16_lossy(&buffer[..length as usize])
        } else {
            String::new()
        };
        let _ = CloseHandle(process);
        full_path.rsplit(['\\', '/']).next().unwrap_or_default().to_string()
    }

    pub fn snapshot(excluded_handles: &[isize]) -> DesktopLayout {
        let monitors = collect_monitors();
        let mut collector = WindowCollector {
            excluded_handles,
            monitors: &monitors,
            foreground_handle: unsafe { GetForegroundWindow() }.0 as isize,
            windows: Vec::new(),
        };
        unsafe {
            let _ = EnumWindows(Some(collect_window), LPARAM(&mut collector as *mut WindowCollector as isize));
        }
        let windows = collector.windows;
        DesktopLayout { monitors: monitors.into_iter().map(|(_, monitor)| monitor).collect(), windows }
    }

    fn collect_monitors() -> Vec<(isize, MonitorInfo)> {
        let mut monitors: Vec<(isize, MonitorInfo)> = Vec::new();
        unsafe {
            let _ = EnumDisplayMonitors(None, None, Some(collect_monitor), LPARAM(&mut monitors as *mut Vec<(isize, MonitorInfo)> as isize));
        }
        monitors
    }

    unsafe extern "system" fn collect_monitor(monitor: HMONITOR, _hdc: HDC, _clip: *mut RECT, data: LPARAM) -> BOOL {
        let monitors = &mut *(data.0 as *mut Vec<(isize, MonitorInfo)>);
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(monitor, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool() {
            let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
            let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
            let name_length = info.szDevice.iter().position(|&character| character == 0).unwrap_or(info.szDevice.len());
            monitors.push((
                monitor.0 as isize,
                MonitorInfo {
                    id: String::from_utf16_lossy(&info.szDevice[..name_length]),
                    bounds: to_physical_rect(info.monitorInfo.rcMonitor),
                    work_area: to_physical_rect(info.monitorInfo.rcWork),
                    scale_factor: dpi_x as f64 / USER_DEFAULT_DPI,
                    is_primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
                },
            ));
        }
        BOOL(1)
    }

    unsafe extern "system" fn collect_window(hwnd: HWND, data: LPARAM) -> BOOL {
        let collector = &mut *(data.0 as *mut WindowCollector);
        if let Some(window) = describe_window(hwnd, collector) {
            collector.windows.push(window);
        }
        BOOL(1)
    }

    /// 判断一个顶层窗口是不是"用户能看到的普通窗口"，是的话返回它的信息
    unsafe fn describe_window(hwnd: HWND, collector: &WindowCollector) -> Option<DesktopWindow> {
        let handle = hwnd.0 as isize;
        if collector.excluded_handles.contains(&handle) || !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return None;
        }
        // 被系统"隐藏"的窗口（其它虚拟桌面上的窗口、挂起的 UWP 应用）
        let mut cloaked = 0u32;
        if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, size_of::<u32>() as u32).is_ok()
            && cloaked != 0
        {
            return None;
        }
        let extended_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if extended_style & WS_EX_TOOLWINDOW.0 != 0 {
            return None;
        }
        let class_name = read_wide_text(|buffer| GetClassNameW(hwnd, buffer));
        if IGNORED_WINDOW_CLASSES.contains(&class_name.as_str()) {
            return None;
        }
        let title = read_wide_text(|buffer| GetWindowTextW(hwnd, buffer));
        if title.is_empty() {
            return None;
        }

        // 优先取 DWM 的可见边框，没有的话退回普通窗口矩形
        let mut frame = RECT::default();
        let has_frame_bounds = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut frame as *mut RECT as *mut c_void,
            size_of::<RECT>() as u32,
        )
        .is_ok();
        if !has_frame_bounds && GetWindowRect(hwnd, &mut frame).is_err() {
            return None;
        }
        let bounds = to_physical_rect(frame);
        if bounds.width() < MINIMUM_WINDOW_SIZE || bounds.height() < MINIMUM_WINDOW_SIZE {
            return None;
        }

        let monitor_handle = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST).0 as isize;
        let monitor = collector.monitors.iter().find(|(monitor_key, _)| *monitor_key == monitor_handle).map(|(_, monitor)| monitor)?;
        Some(DesktopWindow {
            id: handle.to_string(),
            title,
            process_name: read_process_name(hwnd),
            is_fullscreen: bounds.covers(&monitor.bounds),
            bounds,
            is_maximized: IsZoomed(hwnd).as_bool(),
            monitor_id: monitor.id.clone(),
            is_foreground: handle == collector.foreground_handle,
        })
    }
}
