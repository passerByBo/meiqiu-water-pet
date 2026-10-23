//! 喝水提醒调度：根据真实喝水进度调整提醒节奏，并处理稍后提醒、忽略后升级、工作时段 / 勿扰时段、
//! 离开电脑时暂停、全屏时推迟、定时提醒（录单子、下班打卡）。
//! 计时放在 Rust 里：网页被隐藏时计时器会被节流，Rust 不受影响。所有记录都写进本地数据库。

use crate::desktop_layout;
use crate::mood::{self, MoodEvent};
use crate::pet_window::PetWindowHandles;
use crate::settings::{CustomReminder, Settings, TimePeriod};
use crate::storage::{today_stat_date, Database};
use crate::tray;
use chrono::{Datelike, Duration as ChronoDuration, Local, NaiveDate, NaiveTime};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// 被忽略后多久再提醒
const IGNORED_RETRY_DURATION: Duration = Duration::from_secs(10 * 60);
/// 全屏时推迟多久再检查
const FULLSCREEN_DEFER_DURATION: Duration = Duration::from_secs(60);
const MAX_ESCALATION_LEVEL: u8 = 2;
/// 定时提醒错过多久以内还补提醒（例如那会儿电脑在睡眠、人不在）
const CUSTOM_REMINDER_GRACE_PERIOD: ChronoDuration = ChronoDuration::hours(3);
/// 上班后多久还没喝第一杯，就专门提醒一次
const FIRST_CUP_DEADLINE_MINUTES: i64 = 60;
/// 下班前多久检查今天是否达标
const GOAL_CHECK_BEFORE_END_MINUTES: i64 = 30;
/// 没开"只在工作时段提醒"时，用这个时段估算"现在应该喝到第几杯"
const DEFAULT_DAY_START: (u32, u32) = (9, 0);
const DEFAULT_DAY_END: (u32, u32) = (18, 0);
const TIME_FORMAT: &str = "%H:%M";

/// 提醒相关的设置（从 Settings 中取出的一份副本）
struct ReminderRules {
    remind_interval: Duration,
    snooze_duration: Duration,
    away_threshold: Duration,
    work_hours: TimePeriod,
    quiet_periods: Vec<TimePeriod>,
    fullscreen_do_not_disturb: bool,
    daily_goal: u32,
    cup_volume_ml: u32,
    custom_reminders: Vec<CustomReminder>,
}

impl ReminderRules {
    fn from_settings(settings: &Settings) -> Self {
        ReminderRules {
            remind_interval: Duration::from_secs(settings.remind_interval_minutes as u64 * 60),
            snooze_duration: Duration::from_secs(settings.snooze_minutes as u64 * 60),
            away_threshold: Duration::from_secs(settings.away_threshold_minutes as u64 * 60),
            work_hours: settings.work_hours.clone(),
            quiet_periods: settings.quiet_periods.clone(),
            fullscreen_do_not_disturb: settings.fullscreen_do_not_disturb,
            daily_goal: settings.daily_goal,
            cup_volume_ml: settings.cup_volume_ml,
            custom_reminders: settings.custom_reminders.clone(),
        }
    }

    /// 现在是否允许喝水提醒：在工作时段内（如果开启了），并且不在任何勿扰时段里
    fn is_reminding_allowed_now(&self) -> bool {
        let now = Local::now().time();
        let is_within_work_hours = !self.work_hours.enabled || self.work_hours.contains(now);
        let is_in_quiet_period = self.quiet_periods.iter().any(|period| period.enabled && period.contains(now));
        is_within_work_hours && !is_in_quiet_period
    }

    /// 一天中"喝水的时段"：开启了工作时段就用工作时段，否则用默认的 9:00–18:00
    fn drinking_day(&self) -> (NaiveTime, NaiveTime) {
        let parse = |text: &str, fallback: (u32, u32)| {
            NaiveTime::parse_from_str(text, TIME_FORMAT).unwrap_or_else(|_| NaiveTime::from_hms_opt(fallback.0, fallback.1, 0).unwrap())
        };
        if self.work_hours.enabled {
            (parse(&self.work_hours.start, DEFAULT_DAY_START), parse(&self.work_hours.end, DEFAULT_DAY_END))
        } else {
            (NaiveTime::from_hms_opt(DEFAULT_DAY_START.0, DEFAULT_DAY_START.1, 0).unwrap(),
             NaiveTime::from_hms_opt(DEFAULT_DAY_END.0, DEFAULT_DAY_END.1, 0).unwrap())
        }
    }

    /// 按时间进度，现在"应该"喝到第几杯了
    fn expected_cups_now(&self) -> f64 {
        let (start, end) = self.drinking_day();
        let now = Local::now().time();
        let total_seconds = (end - start).num_seconds().max(1) as f64;
        let elapsed_seconds = (now - start).num_seconds().clamp(0, total_seconds as i64) as f64;
        self.daily_goal as f64 * elapsed_seconds / total_seconds
    }
}

struct ReminderInner {
    rules: ReminderRules,
    /// 调试环境变量指定的提醒间隔（优先于设置）
    overridden_interval: Option<Duration>,
    stat_date: NaiveDate,
    next_due: Instant,
    /// 已经提醒、正在等用户回应（喝了 / 稍后 / 忽略）
    is_waiting_for_response: bool,
    /// 当前这次喝水提醒在数据库里的记录 id
    active_event_id: Option<i64>,
    /// 0 正常 / 1 口渴 / 2 生气
    escalation_level: u8,
    is_away: bool,
    /// 当前是否处于"不允许提醒"的时段（工作时段外 / 勿扰时段）
    is_outside_reminding_hours: bool,
    /// 每条定时提醒最后一次提醒的日期（同一天只按时提醒一次）
    custom_fired_dates: HashMap<String, NaiveDate>,
    /// 点了"等一下嘛"的定时提醒：什么时候再提醒
    custom_retry_times: HashMap<String, Instant>,
    /// 定时提醒在数据库里的记录 id
    custom_event_ids: HashMap<String, i64>,
    /// 今天是否已经做过"第一杯"和"下班前达标检查"的专门提醒
    has_checked_first_cup: bool,
    has_checked_goal: bool,
    last_mood_tick: Instant,
}

impl ReminderInner {
    fn base_interval(&self) -> Duration {
        self.overridden_interval.unwrap_or(self.rules.remind_interval)
    }

    /// 根据喝水进度调整下次提醒的间隔：落后就早点提醒，超前就放松一点
    fn adaptive_interval(&self, cups_today: u32) -> Duration {
        if self.overridden_interval.is_some() {
            return self.base_interval();
        }
        let deficit = self.rules.expected_cups_now() - cups_today as f64;
        let factor = match deficit {
            value if value >= 2.0 => 0.6,
            value if value >= 1.0 => 0.8,
            value if value <= -1.0 => 1.25,
            _ => 1.0,
        };
        self.base_interval().mul_f64(factor)
    }
}

pub struct ReminderState(Mutex<ReminderInner>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DrinkProgress {
    pub cups_today: u32,
    pub daily_goal: u32,
    pub volume_ml_today: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReminderStatus {
    pub cups_today: u32,
    pub daily_goal: u32,
    pub seconds_until_next_reminder: u64,
    pub is_away: bool,
    pub is_outside_reminding_hours: bool,
    /// 按时间进度现在应该喝到第几杯
    pub expected_cups_now: f64,
}

/// 喝水提醒的原因，前端据此说不同的话
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum ReminderReason {
    /// 正常到点
    Interval,
    /// 喝水进度落后了
    Behind,
    /// 上班一小时还没喝第一杯
    FirstCup,
    /// 快下班了还没达标
    GoalCheck,
    /// 托盘里手动触发
    Manual,
}

impl ReminderReason {
    fn as_str(&self) -> &'static str {
        match self {
            ReminderReason::Interval => "interval",
            ReminderReason::Behind => "behind",
            ReminderReason::FirstCup => "firstCup",
            ReminderReason::GoalCheck => "goalCheck",
            ReminderReason::Manual => "manual",
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReminderFiredPayload {
    escalation_level: u8,
    reason: ReminderReason,
    cups_today: u32,
    daily_goal: u32,
    /// 按时间进度现在应该喝到第几杯（前端据此判断超前还是落后，选不同的台词）
    expected_cups: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CustomReminderFiredPayload {
    id: String,
    title: String,
    message: String,
    voice_line_id: Option<String>,
}

impl ReminderState {
    pub fn new(settings: &Settings) -> Self {
        // 调试用：MEIQIU_REMIND_INTERVAL_SECONDS=30 可以把提醒间隔改成 30 秒，方便测试
        let overridden_interval = std::env::var("MEIQIU_REMIND_INTERVAL_SECONDS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .map(Duration::from_secs);
        let rules = ReminderRules::from_settings(settings);
        let first_interval = overridden_interval.unwrap_or(rules.remind_interval);
        ReminderState(Mutex::new(ReminderInner {
            rules,
            overridden_interval,
            stat_date: today_stat_date(),
            next_due: Instant::now() + first_interval,
            is_waiting_for_response: false,
            active_event_id: None,
            escalation_level: 0,
            is_away: false,
            is_outside_reminding_hours: false,
            custom_fired_dates: HashMap::new(),
            custom_retry_times: HashMap::new(),
            custom_event_ids: HashMap::new(),
            has_checked_first_cup: false,
            has_checked_goal: false,
            last_mood_tick: Instant::now(),
        }))
    }
}

/// 键鼠空闲了多久
fn idle_duration() -> Duration {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::SystemInformation::GetTickCount;
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut info).as_bool() {
            return Duration::from_millis(GetTickCount().wrapping_sub(info.dwTime) as u64);
        }
    }
    Duration::ZERO
}

/// 后台线程：每秒检查一次是否该提醒
pub fn start(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(1));
        tick(&app);
    });
}

fn tick(app: &AppHandle) {
    let state = app.state::<ReminderState>();
    let database = app.state::<Database>();
    let excluded_handles = app.state::<PetWindowHandles>().excluded_handles.clone();
    let mut inner = state.0.lock().unwrap();
    let now = Instant::now();
    let cups_today = database.cups_today();

    // 跨天：重置当天的状态（杯数直接从数据库按日期统计，不用清零）
    let today = today_stat_date();
    if today != inner.stat_date {
        inner.stat_date = today;
        inner.has_checked_first_cup = false;
        inner.has_checked_goal = false;
        inner.escalation_level = 0;
        tray::update_tooltip(app, 0, inner.rules.daily_goal);
    }

    // 每分钟根据喝水进度更新一次心情
    if inner.last_mood_tick.elapsed() >= Duration::from_secs(60) {
        inner.last_mood_tick = now;
        let deficit = if inner.rules.is_reminding_allowed_now() { inner.rules.expected_cups_now() - cups_today as f64 } else { 0.0 };
        mood::apply(app, MoodEvent::MinuteTick { deficit });
    }

    // 离开 / 回来
    let idle = idle_duration();
    if !inner.is_away && idle >= inner.rules.away_threshold {
        inner.is_away = true;
        let _ = app.emit("user-away", ());
    } else if inner.is_away && idle < Duration::from_secs(3) {
        inner.is_away = false;
        inner.next_due = now + inner.adaptive_interval(cups_today); // 人回来后重新计时，不会一回来就连环提醒
        let _ = app.emit("user-back", ());
    }

    // 定时提醒（录单子、下班打卡等）：不受工作时段、勿扰时段限制，人不在时等回来再提醒
    if !inner.is_away {
        check_custom_reminders(app, &database, &mut inner, now);
    }

    // 喝水提醒：工作时段外 / 勿扰时段暂停计时（离开这些时段后重新开始计时）
    if !inner.rules.is_reminding_allowed_now() {
        inner.is_outside_reminding_hours = true;
        return;
    }
    if inner.is_outside_reminding_hours {
        inner.is_outside_reminding_hours = false;
        inner.next_due = now + inner.adaptive_interval(cups_today);
    }
    if inner.is_away || inner.is_waiting_for_response {
        return;
    }

    // 根据真实数据的专门提醒：上班一小时还没喝第一杯 / 快下班还没达标
    let (day_start, day_end) = inner.rules.drinking_day();
    let current_time = Local::now().time();
    let special_reason = if !inner.has_checked_first_cup && cups_today == 0
        && current_time >= day_start + ChronoDuration::minutes(FIRST_CUP_DEADLINE_MINUTES) {
        inner.has_checked_first_cup = true;
        Some(ReminderReason::FirstCup)
    } else if !inner.has_checked_goal && cups_today < inner.rules.daily_goal
        && current_time >= day_end - ChronoDuration::minutes(GOAL_CHECK_BEFORE_END_MINUTES) && current_time < day_end {
        inner.has_checked_goal = true;
        Some(ReminderReason::GoalCheck)
    } else {
        None
    };
    if cups_today > 0 {
        inner.has_checked_first_cup = true;
    }

    let reason = match special_reason {
        Some(reason) => reason,
        None if now >= inner.next_due => {
            if inner.rules.expected_cups_now() - cups_today as f64 >= 1.5 { ReminderReason::Behind } else { ReminderReason::Interval }
        }
        None => return,
    };
    // 全屏应用（看视频、放 PPT、打游戏）时推迟
    if inner.rules.fullscreen_do_not_disturb && desktop_layout::snapshot(&excluded_handles).is_foreground_fullscreen() {
        inner.next_due = now + FULLSCREEN_DEFER_DURATION;
        return;
    }
    fire_water_reminder(app, &database, &mut inner, reason, cups_today);
}

fn fire_water_reminder(app: &AppHandle, database: &Database, inner: &mut ReminderInner, reason: ReminderReason, cups_today: u32) {
    inner.is_waiting_for_response = true;
    inner.active_event_id = database.record_reminder_fired("water", reason.as_str(), inner.escalation_level);
    let _ = app.emit(
        "reminder-fired",
        ReminderFiredPayload {
            escalation_level: inner.escalation_level,
            reason,
            cups_today,
            daily_goal: inner.rules.daily_goal,
            expected_cups: inner.rules.expected_cups_now(),
        },
    );
}

/// 检查每条定时提醒：今天该提醒、已经到点（3 小时内）、今天还没提醒过 → 提醒；
/// 或者之前点了"等一下嘛"、再提醒的时间到了 → 再提醒一次
fn check_custom_reminders(app: &AppHandle, database: &Database, inner: &mut ReminderInner, now: Instant) {
    let local_now = Local::now();
    let today = today_stat_date();
    let weekday = local_now.weekday().number_from_monday();
    let current_time = local_now.time();
    for reminder in inner.rules.custom_reminders.clone().into_iter().filter(|reminder| reminder.enabled) {
        let Ok(reminder_time) = NaiveTime::parse_from_str(&reminder.time, TIME_FORMAT) else { continue };
        let is_scheduled_today = reminder.weekdays.contains(&weekday);
        let has_fired_today = inner.custom_fired_dates.get(&reminder.id) == Some(&today);
        let is_time_reached = current_time >= reminder_time && current_time - reminder_time < CUSTOM_REMINDER_GRACE_PERIOD;
        let is_retry_due = inner.custom_retry_times.get(&reminder.id).is_some_and(|retry_time| now >= *retry_time);
        if !(is_scheduled_today && !has_fired_today && is_time_reached) && !is_retry_due {
            continue;
        }
        inner.custom_fired_dates.insert(reminder.id.clone(), today);
        inner.custom_retry_times.remove(&reminder.id);
        if let Some(event_id) = database.record_reminder_fired("custom", &reminder.id, 0) {
            inner.custom_event_ids.insert(reminder.id.clone(), event_id);
        }
        let _ = app.emit(
            "custom-reminder-fired",
            CustomReminderFiredPayload { id: reminder.id, title: reminder.title, message: reminder.message, voice_line_id: reminder.voice_line_id },
        );
        // 一次只提醒一条，避免两条同时到点时气泡互相覆盖；下一条下一秒再提醒
        break;
    }
}

/// 设置修改后：更新提醒规则；间隔变了就按新间隔重新计时
pub fn apply_settings(app: &AppHandle, settings: &Settings) {
    let state = app.state::<ReminderState>();
    let cups_today = app.try_state::<Database>().map(|database| database.cups_today()).unwrap_or(0);
    let mut inner = state.0.lock().unwrap();
    let previous_interval = inner.base_interval();
    inner.rules = ReminderRules::from_settings(settings);
    if inner.base_interval() != previous_interval && !inner.is_waiting_for_response {
        inner.next_due = Instant::now() + inner.adaptive_interval(cups_today);
    }
    tray::update_tooltip(app, cups_today, inner.rules.daily_goal);
}

/// 托盘"立即提醒一次"（测试用）
pub fn trigger_now(app: &AppHandle) {
    let state = app.state::<ReminderState>();
    let database = app.state::<Database>();
    let mut inner = state.0.lock().unwrap();
    let cups_today = database.cups_today();
    fire_water_reminder(app, &database, &mut inner, ReminderReason::Manual, cups_today);
}

// ---------------- 给前端调用的命令 ----------------

/// 记一杯：写进数据库，结束当前提醒，按最新进度重新计时，心情变好
#[tauri::command]
pub fn record_drink(app: AppHandle, state: tauri::State<ReminderState>, database: tauri::State<Database>, source: Option<String>) -> Result<DrinkProgress, String> {
    let (cups_today, daily_goal, volume_ml_today) = {
        let mut inner = state.0.lock().unwrap();
        let cups_today = database.record_drink(inner.rules.cup_volume_ml, source.as_deref().unwrap_or("unknown"))?;
        if let Some(event_id) = inner.active_event_id.take() {
            database.record_reminder_result(event_id, "drank");
        }
        inner.is_waiting_for_response = false;
        inner.escalation_level = 0;
        inner.next_due = Instant::now() + inner.adaptive_interval(cups_today); // 任何时候喝水都重新计时
        (cups_today, inner.rules.daily_goal, cups_today * inner.rules.cup_volume_ml)
    };
    tray::update_tooltip(&app, cups_today, daily_goal);
    mood::apply(&app, if cups_today == daily_goal { MoodEvent::GoalReached } else { MoodEvent::Drank });
    Ok(DrinkProgress { cups_today, daily_goal, volume_ml_today })
}

/// 撤销今天最后一杯（点错时用）
#[tauri::command]
pub fn undo_last_drink(app: AppHandle, state: tauri::State<ReminderState>, database: tauri::State<Database>) -> Result<DrinkProgress, String> {
    let cups_today = database.undo_last_drink_today()?;
    let inner = state.0.lock().unwrap();
    tray::update_tooltip(&app, cups_today, inner.rules.daily_goal);
    Ok(DrinkProgress { cups_today, daily_goal: inner.rules.daily_goal, volume_ml_today: cups_today * inner.rules.cup_volume_ml })
}

#[tauri::command]
pub fn snooze_reminder(app: AppHandle, state: tauri::State<ReminderState>, database: tauri::State<Database>) {
    {
        let mut inner = state.0.lock().unwrap();
        if let Some(event_id) = inner.active_event_id.take() {
            database.record_reminder_result(event_id, "snoozed");
        }
        inner.is_waiting_for_response = false;
        inner.next_due = Instant::now() + inner.rules.snooze_duration;
    }
    mood::apply(&app, MoodEvent::ReminderSnoozed);
}

/// 提醒气泡超时没人理：升级（口渴 → 生气），10 分钟后再提醒，心情变差
#[tauri::command]
pub fn reminder_ignored(app: AppHandle, state: tauri::State<ReminderState>, database: tauri::State<Database>) {
    {
        let mut inner = state.0.lock().unwrap();
        if let Some(event_id) = inner.active_event_id.take() {
            database.record_reminder_result(event_id, "ignored");
        }
        inner.is_waiting_for_response = false;
        inner.escalation_level = (inner.escalation_level + 1).min(MAX_ESCALATION_LEVEL);
        inner.next_due = Instant::now() + IGNORED_RETRY_DURATION;
    }
    mood::apply(&app, MoodEvent::ReminderIgnored);
}

/// 定时提醒点了"等一下嘛"：过一会儿（稍后提醒间隔）再提醒，直到点"做完啦"
#[tauri::command]
pub fn snooze_custom_reminder(state: tauri::State<ReminderState>, database: tauri::State<Database>, id: String) {
    let mut inner = state.0.lock().unwrap();
    if let Some(event_id) = inner.custom_event_ids.remove(&id) {
        database.record_reminder_result(event_id, "snoozed");
    }
    let retry_time = Instant::now() + inner.rules.snooze_duration;
    inner.custom_retry_times.insert(id, retry_time);
}

/// 定时提醒点了"做完啦"
#[tauri::command]
pub fn complete_custom_reminder(state: tauri::State<ReminderState>, database: tauri::State<Database>, id: String) {
    let mut inner = state.0.lock().unwrap();
    if let Some(event_id) = inner.custom_event_ids.remove(&id) {
        database.record_reminder_result(event_id, "done");
    }
    inner.custom_retry_times.remove(&id);
}

#[tauri::command]
pub fn get_reminder_status(state: tauri::State<ReminderState>, database: tauri::State<Database>) -> ReminderStatus {
    let inner = state.0.lock().unwrap();
    ReminderStatus {
        cups_today: database.cups_today(),
        daily_goal: inner.rules.daily_goal,
        seconds_until_next_reminder: inner.next_due.saturating_duration_since(Instant::now()).as_secs(),
        is_away: inner.is_away,
        is_outside_reminding_hours: inner.is_outside_reminding_hours,
        expected_cups_now: inner.rules.expected_cups_now(),
    }
}

/// 统计数据（统计窗口用）
#[tauri::command]
pub fn get_statistics(state: tauri::State<ReminderState>, database: tauri::State<Database>) -> Result<crate::storage::Statistics, String> {
    let daily_goal = state.0.lock().unwrap().rules.daily_goal;
    database.statistics(daily_goal)
}
