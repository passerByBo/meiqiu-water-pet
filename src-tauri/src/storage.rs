//! 本地数据库（SQLite）：喝水记录、提醒记录、互动记录、猫咪状态，以及周度 / 月度统计。
//! 文件位置：%APPDATA%\com.meiqiu.waterpet\meiqiu.db。不联网、不上传。

use chrono::{Datelike, Duration as ChronoDuration, Local, NaiveDate, Timelike};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;

const DATABASE_FILE_NAME: &str = "meiqiu.db";
/// 凌晨 4 点前算前一天（照顾熬夜的人）
const DAY_RESET_HOUR: i64 = 4;
const DATE_FORMAT: &str = "%Y-%m-%d";

/// 每个版本的建表 / 升级语句；数据库里用 user_version 记录当前版本，启动时自动升级
const MIGRATIONS: &[&str] = &[
    // 版本 1
    "CREATE TABLE drink_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        drank_at TEXT NOT NULL,
        stat_date TEXT NOT NULL,
        volume_ml INTEGER NOT NULL,
        source TEXT NOT NULL
     );
     CREATE INDEX index_drink_records_stat_date ON drink_records(stat_date);
     CREATE TABLE reminder_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT 'interval',
        fired_at TEXT NOT NULL,
        stat_date TEXT NOT NULL,
        escalation_level INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        response_seconds INTEGER
     );
     CREATE INDEX index_reminder_events_stat_date ON reminder_events(stat_date);
     CREATE TABLE interactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        happened_at TEXT NOT NULL,
        stat_date TEXT NOT NULL
     );
     CREATE INDEX index_interactions_stat_date ON interactions(stat_date);
     CREATE TABLE cat_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
     );",
    // 版本 2：喝水达标解锁的装扮
    "CREATE TABLE unlocked_rewards (
        id TEXT PRIMARY KEY,
        unlocked_at TEXT NOT NULL
     );",
];

pub struct Database(Mutex<Connection>);

/// 统计日期：凌晨 4 点之前算前一天
pub fn stat_date_of(time: chrono::DateTime<Local>) -> NaiveDate {
    (time - ChronoDuration::hours(DAY_RESET_HOUR)).date_naive()
}

pub fn today_stat_date() -> NaiveDate {
    stat_date_of(Local::now())
}

fn format_date(date: NaiveDate) -> String {
    date.format(DATE_FORMAT).to_string()
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DailyAmount {
    pub date: String,
    pub cups: u32,
    pub volume_ml: u32,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReminderResponseSummary {
    pub fired: u32,
    pub drank: u32,
    pub snoozed: u32,
    pub ignored: u32,
    /// 从提醒到喝水平均用了多少秒
    pub average_response_seconds: Option<u32>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Statistics {
    pub today: DailyAmount,
    pub daily_goal: u32,
    /// 最近 7 天（含今天），从早到晚
    pub last_seven_days: Vec<DailyAmount>,
    /// 本月每一天（1 号到今天）
    pub this_month: Vec<DailyAmount>,
    /// 连续达标天数（今天达标就算上今天）
    pub streak_days: u32,
    /// 历史上喝得最多的一天
    pub best_day: Option<DailyAmount>,
    /// 最近 30 天每个小时喝了多少杯（0~23 点），看你一般什么时候喝水
    pub hourly_distribution: Vec<u32>,
    /// 最近 7 天的提醒响应情况
    pub reminder_response: ReminderResponseSummary,
    /// 一共陪伴了多少天（有过记录的天数）
    pub total_days: u32,
    pub total_cups: u32,
    /// 一共有多少天达标（不要求连续）
    pub goal_days_total: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UnlockedReward {
    pub id: String,
    pub unlocked_at: String,
}

impl Database {
    pub fn open(directory: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(directory).map_err(|error| format!("创建数据目录失败：{error}"))?;
        let connection = Connection::open(directory.join(DATABASE_FILE_NAME)).map_err(|error| format!("打开数据库失败：{error}"))?;
        // WAL 模式：写入更快，程序异常退出也不容易损坏数据
        connection
            .execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")
            .map_err(|error| error.to_string())?;
        Self::migrate(&connection)?;
        Ok(Database(Mutex::new(connection)))
    }

    /// 按版本号依次执行还没执行过的升级语句
    fn migrate(connection: &Connection) -> Result<(), String> {
        let current_version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0)).map_err(|error| error.to_string())?;
        for (index, migration) in MIGRATIONS.iter().enumerate().skip(current_version.max(0) as usize) {
            connection.execute_batch(migration).map_err(|error| format!("升级数据库到版本 {} 失败：{error}", index + 1))?;
            connection.execute_batch(&format!("PRAGMA user_version = {}", index + 1)).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    // ---------------- 喝水 ----------------

    /// 记一杯，返回今天一共喝了几杯
    pub fn record_drink(&self, volume_ml: u32, source: &str) -> Result<u32, String> {
        let now = Local::now();
        let connection = self.0.lock().unwrap();
        connection
            .execute(
                "INSERT INTO drink_records (drank_at, stat_date, volume_ml, source) VALUES (?1, ?2, ?3, ?4)",
                params![now.to_rfc3339(), format_date(stat_date_of(now)), volume_ml, source],
            )
            .map_err(|error| error.to_string())?;
        Self::cups_on(&connection, stat_date_of(now))
    }

    /// 撤销今天最后一杯（误点时用），返回撤销后今天的杯数
    pub fn undo_last_drink_today(&self) -> Result<u32, String> {
        let today = today_stat_date();
        let connection = self.0.lock().unwrap();
        connection
            .execute(
                "DELETE FROM drink_records WHERE id = (SELECT id FROM drink_records WHERE stat_date = ?1 ORDER BY id DESC LIMIT 1)",
                params![format_date(today)],
            )
            .map_err(|error| error.to_string())?;
        Self::cups_on(&connection, today)
    }

    pub fn cups_today(&self) -> u32 {
        let connection = self.0.lock().unwrap();
        Self::cups_on(&connection, today_stat_date()).unwrap_or(0)
    }

    fn cups_on(connection: &Connection, date: NaiveDate) -> Result<u32, String> {
        connection
            .query_row("SELECT COUNT(*) FROM drink_records WHERE stat_date = ?1", params![format_date(date)], |row| row.get(0))
            .map_err(|error| error.to_string())
    }

    // ---------------- 提醒 ----------------

    /// 记录一次提醒，返回记录 id（之后用它记录你的回应）
    pub fn record_reminder_fired(&self, kind: &str, reason: &str, escalation_level: u8) -> Option<i64> {
        let now = Local::now();
        let connection = self.0.lock().unwrap();
        connection
            .execute(
                "INSERT INTO reminder_events (kind, reason, fired_at, stat_date, escalation_level) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![kind, reason, now.to_rfc3339(), format_date(stat_date_of(now)), escalation_level],
            )
            .ok()?;
        Some(connection.last_insert_rowid())
    }

    /// 记录你对提醒的回应：drank 喝了 / snoozed 稍后 / ignored 忽略 / done 做完了
    pub fn record_reminder_result(&self, event_id: i64, result: &str) {
        let connection = self.0.lock().unwrap();
        let fired_at: Option<String> = connection
            .query_row("SELECT fired_at FROM reminder_events WHERE id = ?1 AND result IS NULL", params![event_id], |row| row.get(0))
            .optional()
            .ok()
            .flatten();
        let Some(fired_at) = fired_at else { return };
        let response_seconds = chrono::DateTime::parse_from_rfc3339(&fired_at)
            .map(|fired_time| (Local::now() - fired_time.with_timezone(&Local)).num_seconds().max(0))
            .unwrap_or(0);
        let _ = connection.execute(
            "UPDATE reminder_events SET result = ?1, response_seconds = ?2 WHERE id = ?3",
            params![result, response_seconds, event_id],
        );
    }

    // ---------------- 互动 ----------------

    pub fn record_interaction(&self, kind: &str) {
        let now = Local::now();
        let connection = self.0.lock().unwrap();
        let _ = connection.execute(
            "INSERT INTO interactions (kind, happened_at, stat_date) VALUES (?1, ?2, ?3)",
            params![kind, now.to_rfc3339(), format_date(stat_date_of(now))],
        );
    }

    pub fn interactions_today(&self, kind: &str) -> u32 {
        let connection = self.0.lock().unwrap();
        connection
            .query_row(
                "SELECT COUNT(*) FROM interactions WHERE stat_date = ?1 AND kind = ?2",
                params![format_date(today_stat_date()), kind],
                |row| row.get(0),
            )
            .unwrap_or(0)
    }

    // ---------------- 猫咪状态（心情、亲密度等，键值对） ----------------

    pub fn read_cat_state(&self, key: &str) -> Option<String> {
        let connection = self.0.lock().unwrap();
        connection.query_row("SELECT value FROM cat_state WHERE key = ?1", params![key], |row| row.get(0)).optional().ok().flatten()
    }

    pub fn write_cat_state(&self, key: &str, value: &str) {
        let connection = self.0.lock().unwrap();
        let _ = connection.execute(
            "INSERT INTO cat_state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        );
    }

    // ---------------- 统计 ----------------

    pub fn statistics(&self, daily_goal: u32) -> Result<Statistics, String> {
        let today = today_stat_date();
        let connection = self.0.lock().unwrap();
        let amounts_between = |start: NaiveDate, end: NaiveDate| -> Result<Vec<DailyAmount>, String> {
            let mut statement = connection
                .prepare("SELECT stat_date, COUNT(*), SUM(volume_ml) FROM drink_records WHERE stat_date BETWEEN ?1 AND ?2 GROUP BY stat_date")
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![format_date(start), format_date(end)], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?, row.get::<_, Option<u32>>(2)?.unwrap_or(0)))
                })
                .map_err(|error| error.to_string())?;
            let recorded: std::collections::HashMap<String, (u32, u32)> =
                rows.filter_map(Result::ok).map(|(date, cups, volume)| (date, (cups, volume))).collect();
            // 没有记录的日子补 0，保证图表连续
            let mut amounts = Vec::new();
            let mut date = start;
            while date <= end {
                let key = format_date(date);
                let (cups, volume_ml) = recorded.get(&key).copied().unwrap_or((0, 0));
                amounts.push(DailyAmount { date: key, cups, volume_ml });
                date += ChronoDuration::days(1);
            }
            Ok(amounts)
        };

        let last_seven_days = amounts_between(today - ChronoDuration::days(6), today)?;
        let month_start = today.with_day0(0).unwrap_or(today);
        let this_month = amounts_between(month_start, today)?;
        let today_amount = last_seven_days.last().cloned().unwrap_or_default();

        // 连续达标天数：从今天（今天没达标就从昨天）往前数
        let recent = amounts_between(today - ChronoDuration::days(365), today)?;
        let mut streak_days = 0;
        for (offset, amount) in recent.iter().rev().enumerate() {
            if amount.cups >= daily_goal {
                streak_days += 1;
            } else if offset > 0 {
                break;
            }
        }

        let best_day = connection
            .query_row(
                "SELECT stat_date, COUNT(*) AS cups, SUM(volume_ml) FROM drink_records GROUP BY stat_date ORDER BY cups DESC, stat_date DESC LIMIT 1",
                [],
                |row| Ok(DailyAmount { date: row.get(0)?, cups: row.get(1)?, volume_ml: row.get::<_, Option<u32>>(2)?.unwrap_or(0) }),
            )
            .optional()
            .map_err(|error| error.to_string())?;

        // 最近 30 天按小时分布
        let mut hourly_distribution = vec![0u32; 24];
        {
            let mut statement = connection
                .prepare("SELECT drank_at FROM drink_records WHERE stat_date >= ?1")
                .map_err(|error| error.to_string())?;
            let times = statement
                .query_map(params![format_date(today - ChronoDuration::days(29))], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?;
            for time in times.filter_map(Result::ok) {
                if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(&time) {
                    hourly_distribution[parsed.with_timezone(&Local).hour() as usize] += 1;
                }
            }
        }

        let reminder_response = connection
            .query_row(
                "SELECT COUNT(*),
                        SUM(result = 'drank'), SUM(result = 'snoozed'), SUM(result = 'ignored'),
                        AVG(CASE WHEN result = 'drank' THEN response_seconds END)
                 FROM reminder_events WHERE kind = 'water' AND stat_date >= ?1",
                params![format_date(today - ChronoDuration::days(6))],
                |row| {
                    Ok(ReminderResponseSummary {
                        fired: row.get(0)?,
                        drank: row.get::<_, Option<u32>>(1)?.unwrap_or(0),
                        snoozed: row.get::<_, Option<u32>>(2)?.unwrap_or(0),
                        ignored: row.get::<_, Option<u32>>(3)?.unwrap_or(0),
                        average_response_seconds: row.get::<_, Option<f64>>(4)?.map(|seconds| seconds.round() as u32),
                    })
                },
            )
            .map_err(|error| error.to_string())?;

        let (total_days, total_cups): (u32, u32) = connection
            .query_row("SELECT COUNT(DISTINCT stat_date), COUNT(*) FROM drink_records", [], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|error| error.to_string())?;
        let goal_days_total: u32 = connection
            .query_row(
                "SELECT COUNT(*) FROM (SELECT stat_date FROM drink_records GROUP BY stat_date HAVING COUNT(*) >= ?1)",
                params![daily_goal],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;

        Ok(Statistics {
            today: today_amount,
            daily_goal,
            last_seven_days,
            this_month,
            streak_days,
            best_day,
            hourly_distribution,
            reminder_response,
            total_days,
            total_cups,
            goal_days_total,
        })
    }

    // ---------------- 装扮 ----------------

    /// 解锁一个装扮；返回 true 表示这次是新解锁的（以前没解锁过）
    pub fn unlock_reward(&self, id: &str) -> Result<bool, String> {
        let connection = self.0.lock().unwrap();
        let inserted = connection
            .execute("INSERT OR IGNORE INTO unlocked_rewards (id, unlocked_at) VALUES (?1, ?2)", params![id, Local::now().to_rfc3339()])
            .map_err(|error| error.to_string())?;
        Ok(inserted > 0)
    }

    pub fn unlocked_rewards(&self) -> Result<Vec<UnlockedReward>, String> {
        let connection = self.0.lock().unwrap();
        let mut statement = connection.prepare("SELECT id, unlocked_at FROM unlocked_rewards ORDER BY unlocked_at").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| Ok(UnlockedReward { id: row.get(0)?, unlocked_at: row.get(1)? }))
            .map_err(|error| error.to_string())?;
        Ok(rows.filter_map(Result::ok).collect())
    }
}
