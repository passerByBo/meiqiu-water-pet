//! 系统托盘：图标 + 菜单；左键单击显示 / 隐藏宠物。
//! "开机自启"和"声音"是勾选项，和设置窗口里的开关保持同步；菜单和提示里的名字跟着现在养的宠物走。

use crate::settings::{self, Settings};
use crate::{pet_window, reminder};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use crate::storage::Database;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Wry};

const TRAY_ID: &str = "main-tray";

/// 托盘里会变的菜单项：勾选项跟着设置变，带名字的菜单项跟着宠物名字变
pub struct TrayCheckItems {
    launch_at_startup: CheckMenuItem<Wry>,
    voice_enabled: CheckMenuItem<Wry>,
    toggle_pet: MenuItem<Wry>,
    reset_pet: MenuItem<Wry>,
    /// 现在这只宠物的名字（托盘提示里用）
    pet_name: Mutex<String>,
}

pub fn create(app: &AppHandle, current_settings: &Settings) -> tauri::Result<()> {
    let pet_name = current_settings.current_pet_name();
    let toggle_item = MenuItem::with_id(app, "toggle-pet", format!("显示 / 隐藏{pet_name}"), true, None::<&str>)?;
    let drink_item = MenuItem::with_id(app, "record-drink", "💧 我喝了一杯", true, None::<&str>)?;
    let remind_item = MenuItem::with_id(app, "remind-now", "🔔 立即提醒一次", true, None::<&str>)?;
    let statistics_item = MenuItem::with_id(app, "open-statistics", "📊 喝水统计", true, None::<&str>)?;
    let reset_item = MenuItem::with_id(app, "reset-pet", format!("🩹 {pet_name}卡住了？让它回到原位"), true, None::<&str>)?;
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
    app.manage(TrayCheckItems {
        launch_at_startup: startup_item,
        voice_enabled: voice_item,
        toggle_pet: toggle_item.clone(),
        reset_pet: reset_item.clone(),
        pet_name: Mutex::new(pet_name.clone()),
    });

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(format!("{pet_name}：今天 0 杯"))
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

/// 设置变化后同步托盘：勾选状态和真实设置一致；换了宠物或改了名字时，菜单和提示里的名字跟着换
pub fn sync_settings(app: &AppHandle, current_settings: &Settings) {
    let Some(items) = app.try_state::<TrayCheckItems>() else { return };
    let _ = items.launch_at_startup.set_checked(current_settings.launch_at_startup);
    let _ = items.voice_enabled.set_checked(current_settings.voice_enabled);
    let pet_name = current_settings.current_pet_name();
    let is_name_changed = *items.pet_name.lock().unwrap() != pet_name;
    if is_name_changed {
        *items.pet_name.lock().unwrap() = pet_name.clone();
        let _ = items.toggle_pet.set_text(format!("显示 / 隐藏{pet_name}"));
        let _ = items.reset_pet.set_text(format!("🩹 {pet_name}卡住了？让它回到原位"));
        let cups_today = app.try_state::<Database>().map(|database| database.cups_today()).unwrap_or(0);
        update_tooltip(app, cups_today, current_settings.daily_goal);
    }
}

pub fn update_tooltip(app: &AppHandle, cups_today: u32, daily_goal: u32) {
    let pet_name = app.try_state::<TrayCheckItems>().map(|items| items.pet_name.lock().unwrap().clone()).unwrap_or_else(|| "煤球".into());
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("{pet_name}：今天 {cups_today}/{daily_goal} 杯")));
    }
}
