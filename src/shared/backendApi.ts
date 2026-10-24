// 封装所有和 Rust 后端的通信：命令调用（invoke）和事件监听（listen）
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Point } from './geometry';

/** 物理像素矩形（虚拟屏幕坐标，副屏可能是负数） */
export interface PhysicalRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MonitorInfo {
  id: string;
  bounds: PhysicalRect;
  workArea: PhysicalRect;
  scaleFactor: number;
  isPrimary: boolean;
}

export interface DesktopWindowInfo {
  id: string;
  title: string;
  /** 程序文件名，例如 WeChat.exe */
  processName: string;
  bounds: PhysicalRect;
  isMaximized: boolean;
  isFullscreen: boolean;
  monitorId: string;
  isForeground: boolean;
}

export interface DesktopLayoutPayload {
  monitors: MonitorInfo[];
  windows: DesktopWindowInfo[];
}

export interface CursorPayload {
  x: number;
  y: number;
  isLeftButtonDown: boolean;
}

export interface DrinkProgress {
  cupsToday: number;
  dailyGoal: number;
  volumeMlToday: number;
}

export interface ReminderStatus {
  cupsToday: number;
  dailyGoal: number;
  secondsUntilNextReminder: number;
  isAway: boolean;
  isOutsideRemindingHours: boolean;
  /** 按时间进度现在应该喝到第几杯 */
  expectedCupsNow: number;
}

/** 喝水提醒的原因：正常到点 / 进度落后 / 上班一小时还没喝第一杯 / 快下班还没达标 / 手动触发 */
export type ReminderReason = 'interval' | 'behind' | 'firstCup' | 'goalCheck' | 'manual';

export interface ReminderFiredPayload {
  /** 0 正常 / 1 口渴 / 2 生气 */
  escalationLevel: number;
  reason: ReminderReason;
  cupsToday: number;
  dailyGoal: number;
  /** 按时间进度现在应该喝到第几杯 */
  expectedCups: number;
}

export type MoodLevel = 'happy' | 'normal' | 'grumpy' | 'angry';

export interface CatMoodSnapshot {
  /** 0~100 */
  mood: number;
  level: MoodLevel;
  intimacy: number;
}

export interface DailyAmount {
  /** "YYYY-MM-DD" */
  date: string;
  cups: number;
  volumeMl: number;
}

export interface Statistics {
  today: DailyAmount;
  dailyGoal: number;
  lastSevenDays: DailyAmount[];
  thisMonth: DailyAmount[];
  streakDays: number;
  bestDay: DailyAmount | null;
  /** 最近 30 天每个小时（0~23 点）喝了多少杯 */
  hourlyDistribution: number[];
  reminderResponse: {
    fired: number;
    drank: number;
    snoozed: number;
    ignored: number;
    averageResponseSeconds: number | null;
  };
  totalDays: number;
  totalCups: number;
  /** 一共有多少天达标（不要求连续） */
  goalDaysTotal: number;
}

export interface UnlockedReward {
  id: string;
  unlockedAt: string;
}

export type VoiceMode = 'full' | 'meowOnly';
export type RoamMode = 'free' | 'anchored' | 'edge';
export type ActivityLevel = 'calm' | 'normal' | 'lively';
/** 捣乱程度：不捣乱 / 偶尔 / 经常 */
export type MischiefLevel = 'off' | 'sometimes' | 'often';
/** 话多程度：安静 / 适中 / 话多 */
export type Chattiness = 'quiet' | 'normal' | 'chatty';

/** 时间段，时间格式 "HH:MM" */
export interface TimePeriod {
  enabled: boolean;
  start: string;
  end: string;
}

/** 定时提醒方式：固定时间一次 / 下班前多少分钟 / 时间段内每隔一段时间 */
export type CustomReminderMode = 'once' | 'beforeWorkEnd' | 'repeat';

/** 定时提醒（例如 17:00 录单子、17:30 下班打卡） */
export interface CustomReminder {
  id: string;
  enabled: boolean;
  mode: CustomReminderMode;
  /** "HH:MM"；repeat 模式是时间段的开始 */
  time: string;
  /** repeat 模式：时间段的结束 */
  endTime: string;
  /** repeat 模式：每隔多少分钟 */
  repeatIntervalMinutes: number;
  /** beforeWorkEnd 模式：下班前多少分钟（0 = 下班那一刻） */
  minutesBeforeWorkEnd: number;
  title: string;
  message: string;
  /** 1 = 周一 … 7 = 周日 */
  weekdays: number[];
  /** 预生成语音的台词 id，没有就用系统语音 */
  voiceLineId: string | null;
}

export interface CustomReminderFiredPayload {
  id: string;
  title: string;
  message: string;
  voiceLineId: string | null;
}

/** 用户设置（字段和 Rust 端 settings.rs 一一对应） */
export interface AppSettings {
  /** 现在养的是哪种动物 */
  petSpecies: 'cat' | 'hamster' | 'shiba' | 'goldfish';
  /** 每种动物的名字（没改过的不在里面，用默认名字） */
  petNames: Partial<Record<'cat' | 'hamster' | 'shiba' | 'goldfish', string>>;
  /** 每种动物现在用的皮肤 id（没有就是默认外观，见 pet/skins.ts） */
  petSkins: Partial<Record<'cat' | 'hamster' | 'shiba' | 'goldfish', string>>;
  /** 怎么称呼主人（空着就叫"你"） */
  ownerName: string;
  // 作息
  /** 上下班时间；enabled = 只在上班时间提醒喝水 */
  workHours: TimePeriod;
  /** 哪几天上班：1 = 周一 … 7 = 周日 */
  workWeekdays: number[];
  lunchBreak: TimePeriod;
  // 提醒
  remindIntervalMinutes: number;
  snoozeMinutes: number;
  quietPeriods: TimePeriod[];
  fullscreenDoNotDisturb: boolean;
  awayThresholdMinutes: number;
  customReminders: CustomReminder[];
  // 饮水
  dailyGoal: number;
  cupVolumeMl: number;
  // 声音
  voiceEnabled: boolean;
  voiceMode: VoiceMode;
  voiceVolume: number;
  // 散步
  defaultRoamMode: RoamMode;
  activityLevel: ActivityLevel;
  scareEnabled: boolean;
  mischiefLevel: MischiefLevel;
  /** 猫咪大小（百分比，50~125） */
  catSizePercent: number;
  /** 话多程度（闲聊的频率） */
  chattiness: Chattiness;
  /** 正在穿的装扮（none 或已解锁的装扮 id） */
  equippedAccessory: string;
  // 系统
  launchAtStartup: boolean;
}

const subscribe = <Payload>(eventName: string, handler: (payload: Payload) => void): Promise<UnlistenFn> =>
  listen<Payload>(eventName, event => handler(event.payload));

export const backendApi = {
  getDesktopLayout: () => invoke<DesktopLayoutPayload>('get_desktop_layout'),
  movePetWindow: (x: number, y: number) => invoke<void>('move_pet_window', { x, y }),
  /** 调整宠物窗口大小（物理像素） */
  resizePetWindow: (width: number, height: number) => invoke<void>('resize_pet_window', { width, height }),
  setClickThrough: (enabled: boolean) => invoke<void>('set_click_through', { enabled }),
  /** 上次保存的宠物位置（屏幕逻辑坐标，脚底中心）；没有就是 null */
  getPetPosition: () => invoke<Point | null>('get_pet_position'),
  savePetPosition: (position: Point) => invoke<void>('save_pet_position', { x: position.x, y: position.y }),

  /** source：从哪儿记的（bubble 气泡 / doubleClick 双击 / menu 菜单 / tray 托盘） */
  recordDrink: (source: string) => invoke<DrinkProgress>('record_drink', { source }),
  undoLastDrink: () => invoke<DrinkProgress>('undo_last_drink'),
  getStatistics: () => invoke<Statistics>('get_statistics'),
  getCatMood: () => invoke<CatMoodSnapshot>('get_cat_mood'),
  recordInteraction: (kind: string) => invoke<void>('record_interaction', { kind }),
  openStatisticsWindow: () => invoke<void>('open_statistics_window'),
  readConfigOverride: (fileName: string) => invoke<string | null>('read_config_override', { fileName }),
  snoozeReminder: () => invoke<void>('snooze_reminder'),
  reminderIgnored: () => invoke<void>('reminder_ignored'),
  getReminderStatus: () => invoke<ReminderStatus>('get_reminder_status'),
  snoozeCustomReminder: (id: string) => invoke<void>('snooze_custom_reminder', { id }),
  completeCustomReminder: (id: string) => invoke<void>('complete_custom_reminder', { id }),
  /** 返回 true 表示这次是新解锁的 */
  unlockReward: (id: string) => invoke<boolean>('unlock_reward', { id }),
  getUnlockedRewards: () => invoke<UnlockedReward[]>('get_unlocked_rewards'),

  getSettings: () => invoke<AppSettings>('get_settings'),
  getDefaultSettings: () => invoke<AppSettings>('get_default_settings'),
  updateSettings: (settings: AppSettings) => invoke<AppSettings>('update_settings', { settings }),
  openSettingsWindow: () => invoke<void>('open_settings_window'),

  onDesktopLayoutChanged: (handler: (layout: DesktopLayoutPayload) => void) => subscribe('desktop-layout-changed', handler),
  onCursorMoved: (handler: (cursor: CursorPayload) => void) => subscribe('cursor-moved', handler),
  onReminderFired: (handler: (payload: ReminderFiredPayload) => void) => subscribe('reminder-fired', handler),
  onCustomReminderFired: (handler: (payload: CustomReminderFiredPayload) => void) => subscribe('custom-reminder-fired', handler),
  onUserAway: (handler: () => void) => subscribe<null>('user-away', () => handler()),
  onUserBack: (handler: () => void) => subscribe<null>('user-back', () => handler()),
  onTrayAction: (handler: (action: string) => void) => subscribe('tray-action', handler),
  onSettingsChanged: (handler: (settings: AppSettings) => void) => subscribe('settings-changed', handler),
  onCatMoodChanged: (handler: (mood: CatMoodSnapshot) => void) => subscribe('cat-mood-changed', handler),
  onRewardsChanged: (handler: () => void) => subscribe<null>('rewards-changed', () => handler()),
  onTypingChanged: (handler: (isTyping: boolean) => void) => subscribe<{ isTyping: boolean }>('typing-changed', payload => handler(payload.isTyping)),
};
