//! 系统托盘：图标 + 菜单；左键单击显示 / 隐藏煤球。
//! "开机自启"和"声音"是勾选项，和设置窗口里的开关保持同步。

use crate::settings::{self, Settings};
use crate::{pet_window, reminder};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

const TRAY_ID: &str = "main-tray";

/// 托盘里的勾选项，设置变化时要更新勾选状态
pub struct TrayCheckItems {
    launch_at_startup: CheckMenuItem<Wry>,
    voice_enabled: CheckMenuItem<Wry>,
}

pub fn create(app: &AppHandle, current_settings: &Settings) -> tauri::Result<()> {
    let toggle_item = MenuItem::with_id(app, "toggle-pet", "显示 / 隐藏煤球", true, None::<&str>)?;
    let drink_item = MenuItem::with_id(app, "record-drink", "💧 我喝了一杯", true, None::<&str>)?;
    let remind_item = MenuItem::with_id(app, "remind-now", "🔔 立即提醒一次", true, None::<&str>)?;
    let statistics_item = MenuItem::with_id(app, "open-statistics", "📊 喝水统计", true, None::<&str>)?;
    let reset_item = MenuItem::with_id(app, "reset-pet", "🩹 煤球卡住了？让它回到原位", true, None::<&str>)?;
    let voice_item = CheckMenuItem::with_id(app, "toggle-voice", "🔊 声音", true, current_settings.voice_enabled, None::<&str>)?;
    let startup_item =
        CheckMenuItem::with_id(app, "toggle-startup", "🚀 开机自启", true, current_settings.launch_at_startup, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "open-settings", "⚙ 设置…", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &toggle_item,
            &drink_item,
            &remind_item,
            &statistics_item,
            &reset_item,
            &PredefinedMenuItem::separator(app)?,
            &voice_item,
            &startup_item,
            &settings_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;
    app.manage(TrayCheckItems { launch_at_startup: startup_item, voice_enabled: voice_item });

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("煤球：今天 0 杯")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle-pet" => pet_window::toggle_visibility(app),
            // 记一杯交给前端处理，这样猫能做出开心的反应
            "record-drink" => {
                let _ = app.emit("tray-action", "record-drink");
            }
            "remind-now" => reminder::trigger_now(app),
            // 复位：让前端把猫放回安全位置；同时确保窗口是显示的、点击穿透是打开的（不会挡住你点别的东西）
            "reset-pet" => {
                pet_window::show(app);
                let _ = app.emit("tray-action", "reset-pet");
            }
            "toggle-voice" => settings::modify(app, |settings| settings.voice_enabled = !settings.voice_enabled),
            "toggle-startup" => settings::modify(app, |settings| settings.launch_at_startup = !settings.launch_at_startup),
            "open-settings" => settings::open_window(app),
            "open-statistics" => settings::show_statistics_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                pet_window::toggle_visibility(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// 设置变化后同步托盘勾选状态（点勾选项时系统会自动切换，这里保证和真实设置一致）
pub fn sync_settings(app: &AppHandle, current_settings: &Settings) {
    if let Some(items) = app.try_state::<TrayCheckItems>() {
        let _ = items.launch_at_startup.set_checked(current_settings.launch_at_startup);
        let _ = items.voice_enabled.set_checked(current_settings.voice_enabled);
    }
}

pub fn update_tooltip(app: &AppHandle, cups_today: u32, daily_goal: u32) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("煤球：今天 {cups_today}/{daily_goal} 杯")));
    }
}
