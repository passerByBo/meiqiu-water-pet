//! 用户设置：提醒、饮水、声音、散步、系统五组。
//! 保存在本机配置目录的 settings.json，修改后立即生效并通知所有窗口。

use crate::{reminder, tray};
use chrono::NaiveTime;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;

const SETTINGS_FILE_NAME: &str = "settings.json";
const SETTINGS_WINDOW_LABEL: &str = "settings";
const STATISTICS_WINDOW_LABEL: &str = "statistics";
const TIME_FORMAT: &str = "%H:%M";
const MAX_QUIET_PERIODS: usize = 5;
const MAX_CUSTOM_REMINDERS: usize = 10;

/// 一个时间段（例如午休 11:30–13:00）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TimePeriod {
    pub enabled: bool,
    pub start: String,
    pub end: String,
}

impl Default for TimePeriod {
    fn default() -> Self {
        // 默认午休 11:30–13:00
        TimePeriod { enabled: true, start: "11:30".into(), end: "13:00".into() }
    }
}

impl TimePeriod {
    /// 判断某个时刻是否落在这个时间段里（支持跨午夜，例如 22:00–07:00）
    pub fn contains(&self, time: NaiveTime) -> bool {
        let (Ok(start), Ok(end)) = (NaiveTime::parse_from_str(&self.start, TIME_FORMAT), NaiveTime::parse_from_str(&self.end, TIME_FORMAT))
        else {
            return false;
        };
        if start <= end {
            time >= start && time < end
        } else {
            time >= start || time < end
        }
    }

    fn sanitized(mut self, fallback_start: &str, fallback_end: &str) -> Self {
        if NaiveTime::parse_from_str(&self.start, TIME_FORMAT).is_err() {
            self.start = fallback_start.into();
        }
        if NaiveTime::parse_from_str(&self.end, TIME_FORMAT).is_err() {
            self.end = fallback_end.into();
        }
        self
    }
}

/// 定时提醒（例如 17:00 录单子、17:30 下班打卡）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomReminder {
    pub id: String,
    pub enabled: bool,
    /// 提醒时间 "HH:MM"
    pub time: String,
    /// 简短标题，例如"下班打卡"
    pub title: String,
    /// 猫说的话
    pub message: String,
    /// 哪几天提醒：1 = 周一 … 7 = 周日
    pub weekdays: Vec<u32>,
    /// 预生成语音的台词 id（没有就用系统语音）
    pub voice_line_id: Option<String>,
}

impl Default for CustomReminder {
    fn default() -> Self {
        CustomReminder {
            id: String::new(),
            enabled: true,
            time: "17:00".into(),
            title: "提醒".into(),
            message: "喵～时间到啦！".into(),
            weekdays: vec![1, 2, 3, 4, 5],
            voice_line_id: None,
        }
    }
}

impl CustomReminder {
    fn sanitized(mut self, index: usize) -> Self {
        if NaiveTime::parse_from_str(&self.time, TIME_FORMAT).is_err() {
            self.time = "17:00".into();
        }
        if self.id.trim().is_empty() {
            self.id = format!("custom-{index}");
        }
        self.title = self.title.chars().take(20).collect();
        self.message = self.message.chars().take(60).collect();
        self.weekdays.retain(|day| (1..=7).contains(day));
        self.weekdays.sort_unstable();
        self.weekdays.dedup();
        self
    }
}

/// 默认的两条定时提醒：17:00 录单子、17:30 下班打卡（工作日）
fn default_custom_reminders() -> Vec<CustomReminder> {
    vec![
        CustomReminder {
            id: "record-orders".into(),
            time: "17:00".into(),
            title: "录单子".into(),
            message: "五点啦，该录单子啦！".into(),
            voice_line_id: Some("custom-record-orders".into()),
            ..CustomReminder::default()
        },
        CustomReminder {
            id: "clock-out".into(),
            time: "17:30".into(),
            title: "下班打卡".into(),
            message: "下班时间到啦，记得打卡哦！".into(),
            voice_line_id: Some("custom-clock-out".into()),
            ..CustomReminder::default()
        },
    ]
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    // ---- 提醒 ----
    /// 多久提醒一次（分钟）
    pub remind_interval_minutes: u32,
    /// 点"等一下嘛"后多久再提醒（分钟）
    pub snooze_minutes: u32,
    /// 只在工作时段提醒
    pub work_hours: TimePeriod,
    /// 勿扰时段（午休等）
    pub quiet_periods: Vec<TimePeriod>,
    /// 全屏应用时不打扰
    pub fullscreen_do_not_disturb: bool,
    /// 键鼠多久没动算离开（分钟）
    pub away_threshold_minutes: u32,
    /// 定时提醒（不受工作时段、勿扰时段限制）
    pub custom_reminders: Vec<CustomReminder>,

    // ---- 饮水 ----
    pub daily_goal: u32,
    pub cup_volume_ml: u32,

    // ---- 声音 ----
    pub voice_enabled: bool,
    /// full（猫叫 + 说话）/ meowOnly（只有猫叫）
    pub voice_mode: String,
    /// 音量 0–100
    pub voice_volume: u32,

    // ---- 散步 ----
    /// 启动时的散步模式：free / anchored / edge
    pub default_roam_mode: String,
    /// 活跃度：calm / normal / lively
    pub activity_level: String,
    /// 鼠标猛冲过去会吓跑猫
    pub scare_enabled: bool,
    /// 捣乱程度：off 不捣乱 / sometimes 偶尔 / often 经常（满屏乱跑、扑鼠标、霸占窗口……）
    pub mischief_level: String,
    /// 猫咪大小（百分比）
    pub cat_size_percent: u32,
    /// 话多程度：quiet 安静 / normal 适中 / chatty 话多（闲聊的频率，提醒不受影响）
    pub chattiness: String,

    // ---- 系统 ----
    pub launch_at_startup: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            remind_interval_minutes: 45,
            snooze_minutes: 10,
            work_hours: TimePeriod { enabled: true, start: "09:00".into(), end: "17:30".into() },
            quiet_periods: vec![TimePeriod::default()],
            fullscreen_do_not_disturb: true,
            away_threshold_minutes: 5,
            custom_reminders: default_custom_reminders(),
            daily_goal: 8,
            cup_volume_ml: 250,
            voice_enabled: true,
            voice_mode: "full".into(),
            voice_volume: 80,
            default_roam_mode: "free".into(),
            activity_level: "normal".into(),
            scare_enabled: true,
            mischief_level: "sometimes".into(),
            cat_size_percent: 75,
            chattiness: "normal".into(),
            launch_at_startup: false,
        }
    }
}

/// 字符串选项不在允许列表里时，换成默认值
fn choose_allowed(value: String, allowed: &[&str], fallback: &str) -> String {
    if allowed.contains(&value.as_str()) {
        value
    } else {
        fallback.into()
    }
}

impl Settings {
    /// 把不合法的值修正到允许范围内（防止手改配置文件或前端传错）
    fn sanitized(mut self) -> Self {
        self.remind_interval_minutes = self.remind_interval_minutes.clamp(15, 180);
        self.snooze_minutes = self.snooze_minutes.clamp(5, 30);
        self.away_threshold_minutes = self.away_threshold_minutes.clamp(3, 30);
        self.daily_goal = self.daily_goal.clamp(1, 20);
        self.cup_volume_ml = self.cup_volume_ml.clamp(50, 1000);
        self.voice_volume = self.voice_volume.min(100);
        self.voice_mode = choose_allowed(self.voice_mode, &["full", "meowOnly"], "full");
        self.default_roam_mode = choose_allowed(self.default_roam_mode, &["free", "anchored", "edge"], "free");
        self.activity_level = choose_allowed(self.activity_level, &["calm", "normal", "lively"], "normal");
        self.mischief_level = choose_allowed(self.mischief_level, &["off", "sometimes", "often"], "sometimes");
        self.cat_size_percent = self.cat_size_percent.clamp(50, 125);
        self.chattiness = choose_allowed(self.chattiness, &["quiet", "normal", "chatty"], "normal");
        self.work_hours = self.work_hours.sanitized("09:00", "17:30");
        self.custom_reminders.truncate(MAX_CUSTOM_REMINDERS);
        self.custom_reminders = self.custom_reminders.into_iter().enumerate().map(|(index, reminder)| reminder.sanitized(index)).collect();
        self.quiet_periods.truncate(MAX_QUIET_PERIODS);
        self.quiet_periods = self.quiet_periods.into_iter().map(|period| period.sanitized("11:30", "13:00")).collect();
        self
    }
}

pub struct SettingsState(pub Mutex<Settings>);

fn settings_file_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|directory| directory.join(SETTINGS_FILE_NAME))
}

/// 启动时读取设置；文件不存在或损坏时使用默认值
pub fn load(app: &AppHandle) -> Settings {
    settings_file_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|content| serde_json::from_str::<Settings>(&content).ok())
        .unwrap_or_default()
        .sanitized()
}

fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_file_path(app).ok_or("找不到配置目录")?;
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    }
    let content = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

/// 让开机自启的实际状态和设置保持一致（设置为准）
fn apply_launch_at_startup(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    let is_enabled = autolaunch.is_enabled().unwrap_or(false);
    if enabled && !is_enabled {
        autolaunch.enable().map_err(|error| format!("开启开机自启失败：{error}"))?;
    } else if !enabled && is_enabled {
        autolaunch.disable().map_err(|error| format!("关闭开机自启失败：{error}"))?;
    }
    Ok(())
}

/// 把设置应用到各个模块
pub fn apply(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    apply_launch_at_startup(app, settings.launch_at_startup)?;
    reminder::apply_settings(app, settings);
    tray::sync_settings(app, settings);
    Ok(())
}

/// 修改设置：应用 → 保存 → 通知所有窗口
pub fn update(app: &AppHandle, new_settings: Settings) -> Result<Settings, String> {
    let new_settings = new_settings.sanitized();
    apply(app, &new_settings)?;
    save(app, &new_settings)?;
    *app.state::<SettingsState>().0.lock().unwrap() = new_settings.clone();
    let _ = app.emit("settings-changed", &new_settings);
    Ok(new_settings)
}

/// 在当前设置的基础上改一项（托盘勾选项用）
pub fn modify(app: &AppHandle, change: impl FnOnce(&mut Settings)) {
    let mut settings = app.state::<SettingsState>().0.lock().unwrap().clone();
    change(&mut settings);
    if let Err(error) = update(app, settings) {
        eprintln!("修改设置失败：{error}");
    }
}

/// 打开一个普通窗口（设置、统计）；已经打开就把它切到前面。
/// 注意：在 Windows 上，如果在命令处理或菜单事件里直接同步创建窗口，会和 WebView2 互相等待而卡死
/// （表现为窗口白屏、关不掉），所以放到单独的线程里创建。
fn open_page_window(app: &AppHandle, label: &'static str, page: &'static str, title: &'static str, width: f64, height: f64) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let result = WebviewWindowBuilder::new(&app, label, WebviewUrl::App(page.into()))
            .title(title)
            .inner_size(width, height)
            .min_inner_size(420.0, 480.0)
            .center()
            .build();
        if let Err(error) = result {
            eprintln!("打开窗口 {label} 失败：{error}");
        }
    });
}

pub fn open_window(app: &AppHandle) {
    open_page_window(app, SETTINGS_WINDOW_LABEL, "settings.html", "煤球 · 设置", 480.0, 680.0);
}

pub fn show_statistics_window(app: &AppHandle) {
    open_page_window(app, STATISTICS_WINDOW_LABEL, "statistics.html", "煤球 · 喝水统计", 760.0, 720.0);
}

// ---------------- 给前端调用的命令 ----------------

#[tauri::command]
pub fn get_settings(state: tauri::State<SettingsState>) -> Settings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_default_settings() -> Settings {
    Settings::default()
}

#[tauri::command]
pub fn update_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    update(&app, settings)
}

#[tauri::command]
pub fn open_settings_window(app: AppHandle) {
    open_window(&app);
}

/// 读取用户放在数据目录里的覆盖配置（%APPDATA%\com.meiqiu.waterpet\config\<文件名>），没有就返回 None。
/// 文件名只允许字母、数字、横线和点，防止读到配置目录以外的文件
#[tauri::command]
pub fn read_config_override(app: AppHandle, file_name: String) -> Option<String> {
    let is_safe_name = !file_name.is_empty()
        && !file_name.contains("..")
        && file_name.chars().all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '.');
    if !is_safe_name {
        return None;
    }
    let path = app.path().app_data_dir().ok()?.join("config").join(file_name);
    fs::read_to_string(path).ok()
}

#[tauri::command]
pub fn open_statistics_window(app: AppHandle) {
    show_statistics_window(&app);
}
