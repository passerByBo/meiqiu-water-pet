// 统一的动作系统：猫"接下来做什么"、"对某件事怎么反应"，全部由这里按规则挑选。
//
// 每个动作是 public/config/cat-actions.json 里的一条配置：
//   什么时候会被触发（trigger：平时发呆 idle、被摸 pet、被抱 hug、被吓 scare、你喝水 drink……）
//   在哪儿能做（where：地面 floor / 窗口顶上 window / 屏幕底边 edge / 待在原地 anchored）
//   需要满足的条件（when：心情、亲密度、作息阶段、你在用什么软件、全屏、打字、鼠标在不在附近……）
//   有多常见（weight，再乘上心情、作息、活跃度、捣乱程度的系数）
//   冷却时间、每小时最多几次
//   怎么做（steps：一串步骤——摆姿势多久、说什么、冒什么字、发什么声音、转向哪儿、调用一个复杂能力）
//
// 挑选方法（"效用 + 随机"）：先过滤掉不满足条件、在冷却中的动作，再给每个动作打分
//   分数 = 基础权重 × 心情系数 × 作息系数 × 活跃度系数 × 捣乱程度系数 × 新鲜度
// （刚做过的动作新鲜度低，不容易连着重复），最后按分数加权随机选一个。
//
// 用户可以在 %APPDATA%\com.meiqiu.waterpet\config\cat-actions.json 放一份覆盖配置：
//   同 id 的动作会被替换（写 "disabled": true 可以关掉某个动作），新 id 会被加进来。
import { backendApi, type ActivityLevel, type MischiefLevel, type MoodLevel, type RoamMode } from '../shared/backendApi';
import type { CatPose } from './BlackCatModel';
import type { RoutinePhase } from './catConfig';

/** 触发动作的时机 */
export type ActionTrigger =
  | 'idle'            // 平时：上一个动作做完了，想想接下来做什么
  | 'pet'             // 被单击摸摸
  | 'hug'             // 被按住抱抱
  | 'hugEnd'          // 抱完松开
  | 'teaser'          // 你用鼠标当逗猫棒晃它
  | 'scare'           // 鼠标猛冲过去吓到它
  | 'drink'           // 你喝了一杯
  | 'goalReached'     // 今天喝水达标
  | 'snooze'          // 喝水提醒点了"等一下嘛"
  | 'reminderIgnored' // 喝水提醒没人理
  | 'customDone'      // 定时提醒点了"做完啦"
  | 'wakeUp'          // 你回到电脑前，把它吵醒
  | 'trick';          // 右键菜单"表演一个"

/** 猫现在在哪儿 */
export type CatPlace = 'floor' | 'window' | 'edge' | 'anchored';

/** 动作的条件：写了的都要满足，不写的不限制 */
export interface ActionConditions {
  mood?: MoodLevel[];
  routinePhase?: RoutinePhase[];
  /** 你正在用的软件分类（chat、code、browser、video、meeting……） */
  activity?: string[];
  activityLevel?: ActivityLevel[];
  mischiefLevel?: MischiefLevel[];
  roamMode?: RoamMode[];
  /** 时间段 ["HH:MM", "HH:MM"]，支持跨午夜 */
  timeBetween?: [string, string];
  /** 1 = 周一 … 7 = 周日 */
  weekday?: number[];
  intimacyAtLeast?: number;
  intimacyBelow?: number;
  /** 有没有全屏窗口 */
  fullscreen?: boolean;
  /** 开会 / 全屏时的低调模式 */
  lowProfile?: boolean;
  /** 你是不是正在打字 */
  typing?: boolean;
  /** 鼠标是不是在猫附近 */
  cursorNearby?: boolean;
  /** 触发时猫正在做的事（例如 ["sleep"]：睡着时被吓到） */
  behavior?: string[];
  /** 触发时猫"不是"在做这些事 */
  behaviorNot?: string[];
  /** 你多久没理它了（分钟，摸摸 / 抱抱 / 逗猫 / 拎起来 / 喝水都算理它） */
  quietMinutesAtLeast?: number;
  /** 额外的随机门槛：满足其它条件后，还有多大概率可以被选 */
  chance?: number;
}

type PoseKey = keyof CatPose;

/** 动作的一步。一步里可以同时写好几项：先执行说话、冒字、声音、转向，再摆姿势或调用能力 */
export interface ActionStep {
  /** 摆一个姿势（必须是 POSE_BEHAVIORS 里的名字），保持 seconds 秒（可以写 [最少, 最多] 随机） */
  pose?: string;
  seconds?: number | [number, number];
  /** 在姿势基础上微调姿势参数，例如 { "squint": 0.6, "tailWrap": 1 } */
  tweak?: Partial<Record<PoseKey, number>>;
  /** 让姿势参数来回摆动，例如 { "headYaw": { "amplitude": 0.8, "speed": 1.5 } }（东张西望） */
  animate?: Partial<Record<PoseKey, { amplitude: number; speed: number }>>;
  /** 原地转圈的速度（弧度 / 秒），例如追尾巴 */
  spin?: number;
  /** 转向：cursor 看鼠标 / user 面向你 / away 背对你 / random 随便看看 */
  face?: 'cursor' | 'user' | 'away' | 'random';
  /** 说一句台词（语音台词分组名） */
  say?: string;
  /** 只显示文字气泡（没有预生成语音的话） */
  text?: string | string[];
  /** 头顶冒一个字 / 表情 */
  float?: string | string[];
  /** 连着冒好几个 */
  burst?: string;
  burstCount?: number;
  /** 声音：purr 呼噜 / knock 敲 / crash 摔碎 / boing 跳 / meow:short、meow:call、meow:happy… 猫叫 */
  sound?: string;
  /** 调用一个复杂能力（散步、偷看、巡视、捣乱……，见 CatBrain.runAbility），调用后这个动作就结束了 */
  run?: string;
}

export interface ActionDefinition {
  id: string;
  /** 中文名，方便看配置和调试 */
  name: string;
  trigger: ActionTrigger | ActionTrigger[];
  where?: CatPlace[];
  when?: ActionConditions;
  weight: number;
  moodWeight?: Partial<Record<MoodLevel, number>>;
  phaseWeight?: Partial<Record<RoutinePhase, number>>;
  activityLevelWeight?: Partial<Record<ActivityLevel, number>>;
  mischiefLevelWeight?: Partial<Record<MischiefLevel, number>>;
  cooldownSeconds?: number;
  maxPerHour?: number;
  /** 抱抱时选到它：挣脱，不让抱 */
  rejectsHold?: boolean;
  steps: ActionStep[];
  disabled?: boolean;
}

/** 挑选动作时的"现场情况" */
export interface ActionContext {
  trigger: ActionTrigger;
  place: CatPlace;
  mood: MoodLevel;
  intimacy: number;
  routinePhase: RoutinePhase;
  activity: string;
  activityLevel: ActivityLevel;
  mischiefLevel: MischiefLevel;
  roamMode: RoamMode;
  isFullscreen: boolean;
  isLowProfile: boolean;
  isTyping: boolean;
  isCursorNearby: boolean;
  behavior: string;
  quietMinutes: number;
  now: Date;
}

/** 配置里能用的姿势（都是 CatBrain 里定义好姿势、时间到了会自动结束的行为） */
export const POSE_BEHAVIORS = new Set([
  'sit', 'stand', 'groom', 'stretch', 'rest', 'sleep', 'petted', 'happy', 'sulk', 'startled', 'dodge', 'scratch', 'yawn',
  'observe', 'rolling', 'swat', 'hugged',
]);

interface SelectionConfig {
  /** 刚做过的动作分数最多打几折（0.6 表示刚做完时分数只剩 40%） */
  noveltyPenalty: number;
  /** 新鲜度恢复的快慢：过了这么多秒，惩罚降到大约三分之一 */
  noveltySeconds: number;
}

interface ActionFile {
  selection?: Partial<SelectionConfig>;
  actions?: ActionDefinition[];
}

/** 配置文件读不到时的保底动作：至少能坐着、溜达 */
const FALLBACK_ACTIONS: ActionDefinition[] = [
  { id: 'fallback-sit', name: '坐一会儿', trigger: 'idle', weight: 1, steps: [{ pose: 'sit', seconds: [3, 6] }] },
  { id: 'fallback-wander', name: '溜达', trigger: 'idle', where: ['floor', 'edge'], weight: 1, steps: [{ run: 'wander' }] },
];

const minutesOf = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

function isWithinTime([start, end]: [string, string], now: Date): boolean {
  const current = now.getHours() * 60 + now.getMinutes();
  const startMinutes = minutesOf(start);
  const endMinutes = minutesOf(end);
  return startMinutes <= endMinutes ? current >= startMinutes && current < endMinutes : current >= startMinutes || current < endMinutes;
}

/** 检查配置是否写对：去掉不认识的姿势；动作最后一步如果不是姿势或能力，补一个"坐一会儿"，保证动作一定会结束 */
function validateAction(action: ActionDefinition): ActionDefinition | null {
  if (!action || typeof action.id !== 'string' || !Array.isArray(action.steps)) return null;
  const steps = action.steps.filter(step => {
    if (step.pose && !POSE_BEHAVIORS.has(step.pose)) {
      console.warn(`动作 ${action.id}：不认识的姿势 ${step.pose}，这一步跳过`);
      return false;
    }
    return true;
  });
  const hasEnding = steps.some(step => step.pose || step.run);
  if (!hasEnding) steps.push({ pose: 'sit', seconds: 2 });
  return { ...action, weight: Number(action.weight) || 0, steps };
}

class ActionLibrary {
  private actions: ActionDefinition[] = FALLBACK_ACTIONS;
  private selection: SelectionConfig = { noveltyPenalty: .6, noveltySeconds: 90 };
  /** 每个动作最近一次被选中的时间，以及最近一小时被选中的时间列表 */
  private readonly lastUsedAt = new Map<string, number>();
  private readonly recentUses = new Map<string, number[]>();

  get count(): number { return this.actions.length; }

  async load(): Promise<void> {
    let file: ActionFile = {};
    try {
      file = await (await fetch('/config/cat-actions.json')).json();
    } catch (error) {
      console.warn('读取 cat-actions.json 失败，只用保底动作', error);
    }
    let override: ActionFile = {};
    try {
      const overrideText = await backendApi.readConfigOverride('cat-actions.json');
      if (overrideText) override = JSON.parse(overrideText);
    } catch (error) {
      console.warn('用户的 cat-actions.json 覆盖配置格式不对，已忽略', error);
    }
    this.selection = { ...this.selection, ...file.selection, ...override.selection };
    // 合并：同 id 用覆盖的，新 id 加进来，disabled 的去掉
    const merged = new Map<string, ActionDefinition>();
    for (const action of [...(file.actions ?? []), ...(override.actions ?? [])]) {
      if (action?.id) merged.set(action.id, action);
    }
    const actions = [...merged.values()].filter(action => !action.disabled).map(validateAction).filter((action): action is ActionDefinition => !!action);
    if (actions.length) this.actions = actions;
  }

  private matches(action: ActionDefinition, context: ActionContext): boolean {
    const triggers = Array.isArray(action.trigger) ? action.trigger : [action.trigger];
    if (!triggers.includes(context.trigger)) return false;
    if (action.where && !action.where.includes(context.place)) return false;
    const conditions = action.when;
    if (!conditions) return true;
    const weekday = context.now.getDay() === 0 ? 7 : context.now.getDay();
    const checks: [unknown, () => boolean][] = [
      [conditions.mood, () => conditions.mood!.includes(context.mood)],
      [conditions.routinePhase, () => conditions.routinePhase!.includes(context.routinePhase)],
      [conditions.activity, () => conditions.activity!.includes(context.activity)],
      [conditions.activityLevel, () => conditions.activityLevel!.includes(context.activityLevel)],
      [conditions.mischiefLevel, () => conditions.mischiefLevel!.includes(context.mischiefLevel)],
      [conditions.roamMode, () => conditions.roamMode!.includes(context.roamMode)],
      [conditions.timeBetween, () => isWithinTime(conditions.timeBetween!, context.now)],
      [conditions.weekday, () => conditions.weekday!.includes(weekday)],
      [conditions.intimacyAtLeast, () => context.intimacy >= conditions.intimacyAtLeast!],
      [conditions.intimacyBelow, () => context.intimacy < conditions.intimacyBelow!],
      [conditions.fullscreen, () => context.isFullscreen === conditions.fullscreen],
      [conditions.lowProfile, () => context.isLowProfile === conditions.lowProfile],
      [conditions.typing, () => context.isTyping === conditions.typing],
      [conditions.cursorNearby, () => context.isCursorNearby === conditions.cursorNearby],
      [conditions.behavior, () => conditions.behavior!.includes(context.behavior)],
      [conditions.behaviorNot, () => !conditions.behaviorNot!.includes(context.behavior)],
      [conditions.quietMinutesAtLeast, () => context.quietMinutes >= conditions.quietMinutesAtLeast!],
      [conditions.chance, () => Math.random() < conditions.chance!],
    ];
    return checks.every(([condition, check]) => condition === undefined || check());
  }

  /** 冷却中、或者这一小时做得太多了 */
  private isResting(action: ActionDefinition, nowMs: number): boolean {
    const lastUsed = this.lastUsedAt.get(action.id);
    if (action.cooldownSeconds && lastUsed !== undefined && nowMs - lastUsed < action.cooldownSeconds * 1000) return true;
    if (action.maxPerHour !== undefined) {
      const usesInLastHour = (this.recentUses.get(action.id) ?? []).filter(time => nowMs - time < 3_600_000).length;
      if (usesInLastHour >= action.maxPerHour) return true;
    }
    return false;
  }

  /** 打分：基础权重 × 各种系数 × 新鲜度 */
  score(action: ActionDefinition, context: ActionContext, nowMs = performance.now()): number {
    let score = action.weight;
    score *= action.moodWeight?.[context.mood] ?? 1;
    score *= action.phaseWeight?.[context.routinePhase] ?? 1;
    score *= action.activityLevelWeight?.[context.activityLevel] ?? 1;
    score *= action.mischiefLevelWeight?.[context.mischiefLevel] ?? 1;
    const lastUsed = this.lastUsedAt.get(action.id);
    if (lastUsed !== undefined) {
      const secondsAgo = (nowMs - lastUsed) / 1000;
      score *= 1 - this.selection.noveltyPenalty * Math.exp(-secondsAgo / this.selection.noveltySeconds);
    }
    return Math.max(0, score);
  }

  /** 选一个动作；excludeIds：刚才试过但做不成的（例如想偷看却找不到地方） */
  choose(context: ActionContext, excludeIds: Set<string> = new Set(), ignoreCooldown = false): ActionDefinition | null {
    const nowMs = performance.now();
    const candidates = this.actions
      .filter(action => !excludeIds.has(action.id) && this.matches(action, context) && (ignoreCooldown || !this.isResting(action, nowMs)))
      .map(action => ({ action, score: this.score(action, context, nowMs) }))
      .filter(candidate => candidate.score > 0);
    if (!candidates.length) return null;
    const total = candidates.reduce((sum, candidate) => sum + candidate.score, 0);
    let roll = Math.random() * total;
    for (const candidate of candidates) {
      roll -= candidate.score;
      if (roll <= 0) return candidate.action;
    }
    return candidates[candidates.length - 1].action;
  }

  markUsed(id: string): void {
    const nowMs = performance.now();
    this.lastUsedAt.set(id, nowMs);
    const uses = (this.recentUses.get(id) ?? []).filter(time => nowMs - time < 3_600_000);
    uses.push(nowMs);
    this.recentUses.set(id, uses);
  }
}

export const actionLibrary = new ActionLibrary();
