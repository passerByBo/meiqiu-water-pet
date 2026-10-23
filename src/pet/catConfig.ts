// 通用配置：说话频率、各种情境下说什么（public/config/cat-config.json）。
// 用户可以在 %APPDATA%\com.meiqiu.waterpet\config\cat-config.json 放一份覆盖配置，只写想改的部分。
import { backendApi, type Chattiness } from '../shared/backendApi';

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

export interface CatConfig {
  chattiness: { levels: Record<Chattiness, ChattinessLevel> };
  lineKinds: Record<LineKind, string[]>;
  situations: Record<string, DialogueRule[]>;
  reactions: { sameCategoryMinGapSeconds: number };
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
};

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
