//! 用户设置：提醒、饮水、声音、散步、系统五组。
//! 保存在本机配置目录的 settings.json，修改后立即生效并通知所有窗口。

use crate::{mood, reminder, tray};
use chrono::NaiveTime;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
/// 可以养的动物
pub const PET_SPECIES: [&str; 4] = ["cat", "hamster", "shiba", "goldfish"];

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

/// 定时提醒的方式
pub const REMINDER_MODE_ONCE: &str = "once";
pub const REMINDER_MODE_BEFORE_WORK_END: &str = "beforeWorkEnd";
pub const REMINDER_MODE_REPEAT: &str = "repeat";

/// 定时提醒（例如 17:00 录单子、17:30 下班打卡）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomReminder {
    pub id: String,
    pub enabled: bool,
    /// once 固定时间提醒一次 / beforeWorkEnd 下班前多少分钟提醒一次 / repeat 时间段内每隔一段时间提醒
    pub mode: String,
    /// 提醒时间 "HH:MM"（repeat 模式是时间段的开始）
    pub time: String,
    /// repeat 模式：时间段的结束 "HH:MM"
    pub end_time: String,
    /// repeat 模式：每隔多少分钟提醒一次
    pub repeat_interval_minutes: u32,
    /// beforeWorkEnd 模式：下班前多少分钟（0 表示下班那一刻）
    pub minutes_before_work_end: u32,
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
            mode: REMINDER_MODE_ONCE.into(),
            time: "17:00".into(),
            end_time: "18:00".into(),
            repeat_interval_minutes: 60,
            minutes_before_work_end: 0,
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
        if NaiveTime::parse_from_str(&self.end_time, TIME_FORMAT).is_err() {
            self.end_time = "18:00".into();
        }
        self.mode = choose_allowed(self.mode, &[REMINDER_MODE_ONCE, REMINDER_MODE_BEFORE_WORK_END, REMINDER_MODE_REPEAT], REMINDER_MODE_ONCE);
        self.repeat_interval_minutes = self.repeat_interval_minutes.clamp(5, 480);
        self.minutes_before_work_end = self.minutes_before_work_end.min(240);
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

/// 默认的两条定时提醒：下班前半小时录单子、下班时打卡（工作日），跟着下班时间走
fn default_custom_reminders() -> Vec<CustomReminder> {
    vec![
        CustomReminder {
            id: "record-orders".into(),
            mode: REMINDER_MODE_BEFORE_WORK_END.into(),
            minutes_before_work_end: 30,
            time: "17:00".into(),
            title: "录单子".into(),
            message: "五点啦，该录单子啦！".into(),
            voice_line_id: Some("custom-record-orders".into()),
            ..CustomReminder::default()
        },
        CustomReminder {
            id: "clock-out".into(),
            mode: REMINDER_MODE_BEFORE_WORK_END.into(),
            minutes_before_work_end: 0,
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
    // ---- 宠物 ----
    /// 现在养的是哪种动物：cat 黑猫 / hamster 仓鼠 / shiba 柴犬 / goldfish 金鱼（喝水数据大家共用，心情亲密度每只各自的）
    pub pet_species: String,
    /// 每种动物的名字（没改过的用默认名字：煤球 / 团子 / 小柴 / 墨墨）
    pub pet_names: HashMap<String, String>,

    // ---- 主人 ----
    /// 怎么称呼主人（气泡文字里用，空着就叫"你"）
    pub owner_name: String,

    // ---- 作息 ----
    /// 上下班时间；enabled = 只在上班时间提醒喝水
    pub work_hours: TimePeriod,
    /// 哪几天上班：1 = 周一 … 7 = 周日
    pub work_weekdays: Vec<u32>,
    /// 午休（不提醒喝水，猫也一起睡午觉）
    pub lunch_break: TimePeriod,

    // ---- 提醒 ----
    /// 多久提醒一次（分钟）
    pub remind_interval_minutes: u32,
    /// 点"等一下嘛"后多久再提醒（分钟）
    pub snooze_minutes: u32,
    /// 其它勿扰时段
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
    /// 正在穿的装扮（none 或已解锁的装扮 id）
    pub equipped_accessory: String,

    // ---- 系统 ----
    pub launch_at_startup: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            pet_species: "cat".into(),
            pet_names: HashMap::new(),
            owner_name: String::new(),
            work_hours: TimePeriod { enabled: true, start: "09:00".into(), end: "17:30".into() },
            work_weekdays: vec![1, 2, 3, 4, 5],
            lunch_break: TimePeriod::default(),
            remind_interval_minutes: 45,
            snooze_minutes: 10,
            quiet_periods: Vec::new(),
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
            equipped_accessory: "none".into(),
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

/// 每种动物的默认名字
fn default_pet_name(species: &str) -> &'static str {
    match species {
        "hamster" => "团子",
        "shiba" => "小柴",
        "goldfish" => "墨墨",
        _ => "煤球",
    }
}

impl Settings {
    /// 现在这只宠物的名字（托盘提示、窗口标题用）
    pub fn current_pet_name(&self) -> String {
        self.pet_names.get(&self.pet_species).cloned().unwrap_or_else(|| default_pet_name(&self.pet_species).to_string())
    }

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
        self.pet_species = choose_allowed(self.pet_species, &PET_SPECIES, "cat");
        // 名字：只保留认识的动物，去掉首尾空格和控制字符，最多 8 个字，空的去掉（用默认名字）
        self.pet_names = self
            .pet_names
            .into_iter()
            .filter(|(species, _)| PET_SPECIES.contains(&species.as_str()))
            .map(|(species, name)| (species, name.trim().chars().filter(|character| !character.is_control()).take(8).collect::<String>()))
            .filter(|(_, name)| !name.is_empty())
            .collect();
        self.work_hours = self.work_hours.sanitized("09:00", "17:30");
        self.lunch_break = self.lunch_break.sanitized("11:30", "13:00");
        self.work_weekdays.retain(|day| (1..=7).contains(day));
        self.work_weekdays.sort_unstable();
        self.work_weekdays.dedup();
        // 称呼：去掉首尾空格和控制字符，最多 8 个字
        self.owner_name = self.owner_name.trim().chars().filter(|character| !character.is_control()).take(8).collect();
        let is_safe_accessory = !self.equipped_accessory.is_empty() && self.equipped_accessory.len() <= 32
            && self.equipped_accessory.chars().all(|character| character.is_ascii_alphanumeric() || character == '-');
        if !is_safe_accessory {
            self.equipped_accessory = "none".into();
        }
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
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|value| {
            let settings = serde_json::from_value::<Settings>(value.clone()).ok()?;
            Some(migrate_old_settings(&value, settings))
        })
        .unwrap_or_default()
        .sanitized()
}

/// 兼容旧版设置文件：
/// 旧版没有单独的"午休"，午休是勿扰时段的第一条 → 挪到午休里；
/// 旧版默认的"录单子 / 下班打卡"是写死的时间 → 改成跟着下班时间走（时间和默认一致时才改，用户改过的不动）
fn migrate_old_settings(raw: &serde_json::Value, mut settings: Settings) -> Settings {
    if raw.get("lunchBreak").is_none() && !settings.quiet_periods.is_empty() {
        settings.lunch_break = settings.quiet_periods.remove(0);
    }
    for reminder in settings.custom_reminders.iter_mut() {
        let raw_reminder = raw["customReminders"].as_array().and_then(|list| list.iter().find(|item| item["id"] == reminder.id.as_str()));
        if raw_reminder.is_some_and(|item| item.get("mode").is_some()) {
            continue;
        }
        let minutes_before = match (reminder.id.as_str(), reminder.time.as_str()) {
            ("record-orders", "17:00") => Some(30),
            ("clock-out", "17:30") => Some(0),
            _ => None,
        };
        if let (Some(minutes), "17:30") = (minutes_before, settings.work_hours.end.as_str()) {
            reminder.mode = REMINDER_MODE_BEFORE_WORK_END.into();
            reminder.minutes_before_work_end = minutes;
        }
    }
    settings
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
    mood::switch_species(app, &settings.pet_species);
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
    open_page_window(app, SETTINGS_WINDOW_LABEL, "settings.html", "煤球 · 设置", 580.0, 720.0);
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
