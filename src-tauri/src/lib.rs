mod cursor_tracker;
mod desktop_layout;
mod mood;
mod pet_window;
mod reminder;
mod rewards;
mod settings;
mod storage;
mod tray;

use pet_window::{PetWindowHandles, PET_WINDOW_LABEL};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;

/// 前端的提示、警告和错误（例如"煤球复位：来回抖动"）转发到程序日志里，方便排查问题。
/// 只打印，不执行任何东西；内容截断到 500 字，防止刷屏
#[tauri::command]
fn frontend_log(level: String, message: String) {
    let level = match level.as_str() {
        "error" => "错误",
        "warn" => "警告",
        _ => "提示",
    };
    let message: String = message.chars().take(500).collect();
    eprintln!("[前端{level}] {message}");
}

pub fn run() {
    tauri::Builder::default()
        // 防多开：重复启动时只把已有的猫叫出来
        .plugin(tauri_plugin_single_instance::init(|app, _arguments, _working_directory| {
            pet_window::show(app);
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![
            frontend_log,
            pet_window::get_desktop_layout,
            pet_window::move_pet_window,
            pet_window::set_click_through,
            reminder::record_drink,
            reminder::undo_last_drink,
            reminder::snooze_reminder,
            reminder::reminder_ignored,
            reminder::get_reminder_status,
            reminder::snooze_custom_reminder,
            reminder::complete_custom_reminder,
            reminder::get_statistics,
            mood::get_cat_mood,
            mood::record_interaction,
            settings::get_settings,
            settings::get_default_settings,
            settings::update_settings,
            settings::open_settings_window,
            settings::open_statistics_window,
            settings::read_config_override,
            rewards::unlock_reward,
            rewards::get_unlocked_rewards,
        ])
        .setup(|app| {
            let pet_window = app.get_webview_window(PET_WINDOW_LABEL).expect("找不到猫咪窗口");
            pet_window::apply_pet_window_style(&pet_window)?;
            let excluded_handles = vec![pet_window::native_handle(&pet_window)];
            app.manage(PetWindowHandles { excluded_handles: excluded_handles.clone() });

            // 本地数据库（喝水记录、提醒记录、心情等），放在 %APPDATA%\com.meiqiu.waterpet
            let data_directory = app.path().app_data_dir()?;
            let database = storage::Database::open(&data_directory).map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            app.manage(mood::CatMood::load(&database));
            app.manage(database);

            // 先读设置，再按设置创建提醒调度；托盘要在应用设置前建好，才能同步勾选状态
            let current_settings = settings::load(app.handle());
            app.manage(settings::SettingsState(Mutex::new(current_settings.clone())));
            app.manage(reminder::ReminderState::new(&current_settings));
            tray::create(app.handle(), &current_settings)?;
            if let Err(error) = settings::apply(app.handle(), &current_settings) {
                eprintln!("应用设置失败：{error}");
            }

            desktop_layout::start_watcher(app.handle().clone(), excluded_handles);
            cursor_tracker::start(app.handle().clone());
            reminder::start(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("煤球启动失败");
}
