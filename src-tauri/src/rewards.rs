//! 装扮奖励：喝水达标解锁装扮（蝴蝶结、小围巾、小皇冠……）。
//! 解锁条件写在前端的 cat-config.json 里，这里只负责把"已解锁"永久记进数据库。

use crate::storage::{Database, UnlockedReward};
use tauri::{AppHandle, Emitter, Manager};

/// 装扮 id 只允许字母、数字和横线
fn is_valid_reward_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.chars().all(|character| character.is_ascii_alphanumeric() || character == '-')
}

/// 解锁装扮；返回 true 表示这次是新解锁的
#[tauri::command]
pub fn unlock_reward(app: AppHandle, id: String) -> Result<bool, String> {
    if !is_valid_reward_id(&id) {
        return Err("装扮 id 不合法".into());
    }
    let is_new = app.state::<Database>().unlock_reward(&id)?;
    if is_new {
        let _ = app.emit("rewards-changed", ());
    }
    Ok(is_new)
}

#[tauri::command]
pub fn get_unlocked_rewards(database: tauri::State<Database>) -> Result<Vec<UnlockedReward>, String> {
    database.unlocked_rewards()
}
