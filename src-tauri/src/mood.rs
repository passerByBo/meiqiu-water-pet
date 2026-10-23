//! 猫咪的心情和亲密度：完全由真实数据驱动，保存在数据库里，重启不丢。
//!   心情 0~100：喝水、达标、摸摸让它开心；忽略提醒、喝水落后让它不高兴；平时慢慢回到 60
//!   亲密度：每次互动、每天使用都会增加，只增不减

use crate::storage::{today_stat_date, Database};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const BASELINE_MOOD: f64 = 60.0;
const MOOD_KEY: &str = "mood";
const INTIMACY_KEY: &str = "intimacy";
const LAST_VISIT_DATE_KEY: &str = "lastVisitDate";
/// 每天最多有多少次摸摸能加心情和亲密度（防止刷）
const MAX_COUNTED_PETS_PER_DAY: u32 = 30;

/// 会影响心情的事情
pub enum MoodEvent {
    Drank,
    GoalReached,
    Petted,
    ReminderSnoozed,
    ReminderIgnored,
    /// 每分钟一次：根据喝水进度慢慢变化（deficit = 应该喝的杯数 - 实际喝的杯数）
    MinuteTick { deficit: f64 },
}

#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MoodSnapshot {
    /// 0~100
    pub mood: u32,
    /// happy 开心 / normal 一般 / grumpy 闹别扭 / angry 发脾气
    pub level: &'static str,
    pub intimacy: u32,
}

struct MoodInner {
    mood: f64,
    intimacy: u32,
    last_snapshot: Option<MoodSnapshot>,
}

pub struct CatMood(Mutex<MoodInner>);

fn level_of(mood: f64) -> &'static str {
    match mood {
        value if value >= 75.0 => "happy",
        value if value >= 45.0 => "normal",
        value if value >= 25.0 => "grumpy",
        _ => "angry",
    }
}

impl CatMood {
    /// 从数据库读出心情和亲密度；今天第一次打开时亲密度 +5
    pub fn load(database: &Database) -> Self {
        let mood = database.read_cat_state(MOOD_KEY).and_then(|value| value.parse().ok()).unwrap_or(BASELINE_MOOD);
        let mut intimacy = database.read_cat_state(INTIMACY_KEY).and_then(|value| value.parse().ok()).unwrap_or(0);
        let today = today_stat_date().to_string();
        if database.read_cat_state(LAST_VISIT_DATE_KEY).as_deref() != Some(today.as_str()) {
            intimacy += 5;
            database.write_cat_state(LAST_VISIT_DATE_KEY, &today);
            database.write_cat_state(INTIMACY_KEY, &intimacy.to_string());
        }
        CatMood(Mutex::new(MoodInner { mood, intimacy, last_snapshot: None }))
    }

    pub fn snapshot(&self) -> MoodSnapshot {
        let inner = self.0.lock().unwrap();
        MoodSnapshot { mood: inner.mood.round() as u32, level: level_of(inner.mood), intimacy: inner.intimacy }
    }
}

/// 处理一件影响心情的事：更新数值 → 保存 → 有变化就通知前端
pub fn apply(app: &AppHandle, event: MoodEvent) {
    let database = app.state::<Database>();
    let state = app.state::<CatMood>();
    let snapshot = {
        let mut inner = state.0.lock().unwrap();
        let (mood_change, intimacy_change) = match event {
            MoodEvent::Drank => (8.0, 1),
            MoodEvent::GoalReached => (15.0, 3),
            MoodEvent::Petted => {
                if database.interactions_today("pet") <= MAX_COUNTED_PETS_PER_DAY { (3.0, 1) } else { (0.0, 0) }
            }
            MoodEvent::ReminderSnoozed => (-4.0, 0),
            MoodEvent::ReminderIgnored => (-12.0, 0),
            MoodEvent::MinuteTick { deficit } => {
                // 落后 2 杯以上：每分钟不开心一点；否则慢慢回到平常心情
                let drift = if deficit >= 2.0 { -1.0 } else { (BASELINE_MOOD - inner.mood).signum() * 0.3 };
                (drift, 0)
            }
        };
        inner.mood = (inner.mood + mood_change).clamp(0.0, 100.0);
        inner.intimacy += intimacy_change;
        database.write_cat_state(MOOD_KEY, &format!("{:.1}", inner.mood));
        if intimacy_change > 0 {
            database.write_cat_state(INTIMACY_KEY, &inner.intimacy.to_string());
        }
        let snapshot = MoodSnapshot { mood: inner.mood.round() as u32, level: level_of(inner.mood), intimacy: inner.intimacy };
        if inner.last_snapshot.as_ref() == Some(&snapshot) {
            return;
        }
        inner.last_snapshot = Some(snapshot.clone());
        snapshot
    };
    let _ = app.emit("cat-mood-changed", snapshot);
}

// ---------------- 给前端调用的命令 ----------------

#[tauri::command]
pub fn get_cat_mood(state: tauri::State<CatMood>) -> MoodSnapshot {
    state.snapshot()
}

/// 记录一次互动（pet 摸摸 / lift 拎起来 / peekCaught 抓包 …）
#[tauri::command]
pub fn record_interaction(app: AppHandle, kind: String) {
    app.state::<Database>().record_interaction(&kind);
    if kind == "pet" {
        apply(&app, MoodEvent::Petted);
    }
}
