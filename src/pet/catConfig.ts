// 通用配置：说话频率、各种情境下说什么、行为概率、逗猫 / 抱抱、作息、装扮奖励（public/config/cat-config.json）。
// 用户可以在 %APPDATA%\com.meiqiu.waterpet\config\cat-config.json 放一份覆盖配置，只写想改的部分。
import { backendApi, type ActivityLevel, type Chattiness, type MoodLevel } from '../shared/backendApi';

/** 规则的条件：全部满足才算命中（不写的条件不限制） */
export interface DialogueConditions {
  /** 时间段 ["HH:MM", "HH:MM"]，支持跨午夜（例如 ["22:00", "05:00"]） */
  timeBetween?: [string, string];
  /** 星期几：1 = 周一 … 7 = 周日 */
  weekday?: number[];
  /** 你正在用的软件分类（chat、code、sheet……） */
  activity?: string[];
  /** 猫的心情（happy、normal、grumpy、angry） */
  mood?: string[];
  /** 提醒原因（interval、behind、firstCup、goalCheck、manual） */
  reason?: string[];
  /** 提醒方式（lively、gentle、sign、silentSign、knock、sitOnWindow、pushCup） */
  style?: string[];
  escalationLevelAtLeast?: number;
  /** 落后杯数 = 应该喝到的杯数 - 实际杯数（负数表示超前） */
  deficitAtLeast?: number;
  deficitAtMost?: number;
  /** 还差几杯达标 [最少, 最多] */
  remainingCups?: [number, number];
  cupsAtLeast?: number;
  goalReached?: boolean;
  /** 这一杯刚好让今天达标 */
  justReachedGoal?: boolean;
  /** 已经超过目标 */
  cupsAboveGoal?: boolean;
  /** 刚好喝到目标的一半 */
  isHalfway?: boolean;
  /** 这一杯是被提醒后喝的 */
  hadReminder?: boolean;
  /** 从提醒到喝水用了多少秒 */
  responseSecondsAtMost?: number;
  responseSecondsAtLeast?: number;
  yesterdayReached?: boolean;
  /** 以前有过喝水记录（不是第一次用） */
  hasHistory?: boolean;
  streakAtLeast?: number;
}

export interface DialogueRule {
  /** 台词分组；可以用 {remaining} 代表还差几杯 */
  group: string;
  weight: number;
  when?: DialogueConditions;
}

export interface ChattinessLevel {
  /** 两句闲聊之间至少隔多少秒 */
  ambientMinGapSeconds: number;
  /** 到了可以闲聊的时候，有多大概率真的开口 */
  ambientChance: number;
  /** 两句互动回应之间至少隔多少秒 */
  interactionMinGapSeconds: number;
}

export type LineKind = 'essential' | 'interaction' | 'ambient';

/** 原地发呆时可选的小动作 */
export type IdleAction = 'sit' | 'stand' | 'groom' | 'scratch' | 'yawn' | 'stretch' | 'rest' | 'happy';
/** 站在窗口顶上时可选的动作 */
export type OnWindowAction = 'walk' | 'observe' | 'hopToOther' | 'idle' | 'jumpDown';

/** 猫的行为概率（每次"想下一步做什么"时按这些概率选） */
export interface BehaviorConfig {
  /** 活跃度对偷看、巡视概率的放大系数 */
  activityFactor: Record<ActivityLevel, number>;
  /** 偷看的概率：有全屏窗口时 / 在屏幕底边时 / 平时 */
  peekChance: { fullscreen: number; onEdge: number; normal: number };
  /** 跳上窗口巡视的概率 */
  patrolChance: number;
  /** 出门溜达的概率（其余时间原地发呆），再加上心情的加成 */
  wanderChance: Record<ActivityLevel, number>;
  wanderMoodBonus: Record<MoodLevel, number>;
  /** 捣乱的概率（按设置里的捣乱程度），再乘上心情系数 */
  mischiefChance: { sometimes: number; often: number };
  mischiefMoodFactor: Record<MoodLevel, number>;
  /** 各种捣乱的权重：zoomies 满屏乱跑 / pounce 扑鼠标 / occupyWindow 霸占窗口 / pushCup 推杯子 / follow 跟屁虫 */
  mischiefKinds: Record<string, number>;
  /** 原地发呆时各个小动作的权重 */
  idleWeights: Record<IdleAction, number>;
  /** 站在窗口顶上时各个动作的权重 */
  onWindowWeights: Record<OnWindowAction, number>;
  /** 心情不好时背对你生闷气的概率 */
  sulkChance: Record<MoodLevel, number>;
  /** 心情好时打滚的概率 */
  happyRollChance: number;
  /** 摸它时躲开的概率 */
  dodgePetChance: Record<MoodLevel, number>;
  /** 鼠标猛冲过去吓到它：速度（像素/秒）、离猫多近算冲过去（100% 大小时的像素）、两次之间至少隔几秒 */
  scare: { cursorSpeed: number; radius: number; cooldownSeconds: number };
}

/** 逗猫棒：在猫附近快速左右晃鼠标 */
export interface TeaserConfig {
  /** 多少秒内来回晃了几次算在逗它 */
  windowSeconds: number;
  minReversals: number;
  /** 每次晃动至少多少像素 */
  minSwingPixels: number;
  /** 鼠标离猫多远以内（像素） */
  maxDistance: number;
  /** 两次扑之间至少隔几秒 */
  cooldownSeconds: number;
  /** 连续扑几次后玩累了，休息一会儿 */
  maxPouncesInRow: number;
  restSeconds: number;
}

/** 一天里的阶段（按设置里的上下班时间、午休算） */
export type RoutinePhase = 'offDay' | 'beforeWork' | 'morning' | 'working' | 'lunch' | 'afternoonSlump' | 'almostOff' | 'overtime';

export interface RoutineConfig {
  /** 上班后多少分钟算"早上刚上班"（爱打哈欠伸懒腰） */
  morningMinutes: number;
  /** 午休后多少分钟算"下午犯困" */
  afternoonSlumpMinutes: number;
  /** 下班前多少分钟开始兴奋 */
  almostOffMinutes: number;
  /** 下班后多少分钟还在用电脑，开始催你下班 */
  overtimeAfterMinutes: number;
  /** 之后每隔多少分钟再催一次，最多催几次 */
  overtimeRepeatMinutes: number;
  maxOvertimeNudges: number;
  /** 各阶段的活跃度系数（乘在偷看、巡视、溜达的概率上） */
  phaseActivityFactor: Partial<Record<RoutinePhase, number>>;
  /** 各阶段发呆小动作的权重倍数 */
  phaseIdleMultipliers: Partial<Record<RoutinePhase, Partial<Record<IdleAction, number>>>>;
}

/** 装扮奖励：满足条件就解锁（条件都写了的话要全部满足） */
export interface RewardRule {
  /** 对应 3D 模型里的装扮：flower 小花 / bow 蝴蝶结 / scarf 围巾 / crown 皇冠 */
  id: string;
  name: string;
  icon: string;
  description: string;
  /** 累计达标天数 */
  goalDaysAtLeast?: number;
  /** 连续达标天数 */
  streakAtLeast?: number;
}

export interface CatConfig {
  chattiness: { levels: Record<Chattiness, ChattinessLevel> };
  lineKinds: Record<LineKind, string[]>;
  situations: Record<string, DialogueRule[]>;
  reactions: { sameCategoryMinGapSeconds: number };
  behavior: BehaviorConfig;
  teaser: TeaserConfig;
  /** 按住猫多少秒算抱抱 */
  hug: { holdSeconds: number };
  routine: RoutineConfig;
  rewards: RewardRule[];
}

/** 配置文件读不到时的保底配置 */
const FALLBACK_CONFIG: CatConfig = {
  chattiness: {
    levels: {
      quiet: { ambientMinGapSeconds: 900, ambientChance: .3, interactionMinGapSeconds: 30 },
      normal: { ambientMinGapSeconds: 300, ambientChance: .5, interactionMinGapSeconds: 15 },
      chatty: { ambientMinGapSeconds: 90, ambientChance: .9, interactionMinGapSeconds: 5 },
    },
  },
  lineKinds: { essential: ['remind*', 'drink*', 'goal-*', 'custom-*', 'greet*'], interaction: [], ambient: [] },
  situations: {},
  reactions: { sameCategoryMinGapSeconds: 1800 },
  behavior: {
    activityFactor: { calm: .6, normal: 1, lively: 1.3 },
    peekChance: { fullscreen: .5, onEdge: .3, normal: .14 },
    patrolChance: .28,
    wanderChance: { calm: .25, normal: .5, lively: .7 },
    wanderMoodBonus: { happy: .15, normal: 0, grumpy: -.2, angry: -.3 },
    mischiefChance: { sometimes: .07, often: .2 },
    mischiefMoodFactor: { happy: 1.4, normal: 1, grumpy: 1, angry: 1.2 },
    mischiefKinds: { zoomies: 2, pounce: 1, occupyWindow: 1, pushCup: 1, follow: 1 },
    idleWeights: { sit: 30, stand: 12, groom: 16, scratch: 8, yawn: 8, stretch: 8, rest: 18, happy: 1 },
    onWindowWeights: { walk: 30, observe: 25, hopToOther: 15, idle: 15, jumpDown: 15 },
    sulkChance: { happy: 0, normal: 0, grumpy: .35, angry: .6 },
    happyRollChance: .15,
    dodgePetChance: { happy: 0, normal: 0, grumpy: .4, angry: .8 },
    scare: { cursorSpeed: 1200, radius: 130, cooldownSeconds: 4 },
  },
  teaser: { windowSeconds: 1.6, minReversals: 4, minSwingPixels: 35, maxDistance: 420, cooldownSeconds: 2.5, maxPouncesInRow: 4, restSeconds: 20 },
  hug: { holdSeconds: 2 },
  routine: {
    morningMinutes: 45,
    afternoonSlumpMinutes: 45,
    almostOffMinutes: 20,
    overtimeAfterMinutes: 30,
    overtimeRepeatMinutes: 60,
    maxOvertimeNudges: 3,
    phaseActivityFactor: { lunch: .3, afternoonSlump: .8, almostOff: 1.4, overtime: .7, offDay: .8, beforeWork: .8 },
    phaseIdleMultipliers: {
      morning: { yawn: 2.5, stretch: 2.5 },
      afternoonSlump: { yawn: 2.5, rest: 2 },
      lunch: { rest: 4, yawn: 2 },
      almostOff: { happy: 15, stretch: 1.5 },
      overtime: { yawn: 2, rest: 2 },
      offDay: { rest: 2 },
    },
  },
  rewards: [
    { id: 'flower', name: '小花发卡', icon: '🌸', description: '第一次喝水达标', goalDaysAtLeast: 1 },
    { id: 'bow', name: '粉色蝴蝶结', icon: '🎀', description: '累计 3 天喝水达标', goalDaysAtLeast: 3 },
    { id: 'scarf', name: '暖暖小围巾', icon: '🧣', description: '连续 5 天喝水达标', streakAtLeast: 5 },
    { id: 'crown', name: '小皇冠', icon: '👑', description: '连续 10 天喝水达标', streakAtLeast: 10 },
  ],
};

/** 按权重随机选一个（权重为 0 或负数的不会被选中） */
export function pickWeighted<Key extends string>(weights: Partial<Record<Key, number>>): Key | null {
  const entries = (Object.entries(weights) as [Key, number][]).filter(([, weight]) => weight > 0);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (!entries.length) return null;
  let roll = Math.random() * total;
  for (const [key, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

export let catConfig: CatConfig = FALLBACK_CONFIG;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 深度合并：对象逐层合并，数组和其它值直接用覆盖的 */
function deepMerge<Value>(base: Value, override: unknown): Value {
  if (!isPlainObject(base) || !isPlainObject(override)) return (override ?? base) as Value;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) merged[key] = key in merged ? deepMerge(merged[key], value) : value;
  return merged as Value;
}

export async function loadCatConfig(): Promise<void> {
  try {
    const response = await fetch('/config/cat-config.json');
    catConfig = deepMerge(FALLBACK_CONFIG, await response.json());
  } catch (error) {
    console.warn('读取 cat-config.json 失败，使用保底配置', error);
  }
  try {
    const overrideText = await backendApi.readConfigOverride('cat-config.json');
    if (overrideText) catConfig = deepMerge(catConfig, JSON.parse(overrideText));
  } catch (error) {
    console.warn('用户覆盖配置格式不对，已忽略', error);
  }
}

/** 一类台词属于哪种（必须说 / 互动回应 / 闲聊）；"xxx*" 表示前缀匹配 */
export function lineKindOf(key: string): LineKind {
  const matches = (pattern: string) => (pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern);
  for (const kind of ['essential', 'interaction', 'ambient'] as LineKind[]) {
    if (catConfig.lineKinds[kind]?.some(matches)) return kind;
  }
  return 'interaction';
}
