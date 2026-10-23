// 猫的"大脑"，分两层：
//   动作层：平时做什么、对每件事怎么反应，统一交给动作系统（actionSystem.ts + cat-actions.json）按条件和权重挑选，
//           再由这里的"动作执行器"一步步执行（摆姿势、说话、冒字、声音、转向、调用能力）
//   能力层：动作配置里写不出来的复杂本事——走路寻路、跳跃、巡视窗口顶、偷看、各种提醒方式、捣乱、追鼠标……
// 另外还有：心情影响、作息、逗猫棒、抱抱、被吓到、卡住后自动复位
import {
  CALM_IDLE_MULTIPLIER, LIVELY_IDLE_MULTIPLIER, PEEK_DUCK_CURSOR_SPEED, RUN_SPEED, SNEAK_SPEED,
  STRIDE_LENGTH, WALK_SPEED, catPixels,
} from './constants';
import { catConfig, type RoutinePhase } from './catConfig';
import { actionLibrary, type ActionContext, type ActionDefinition, type ActionStep, type ActionTrigger, type CatPlace } from './actionSystem';
import type { DesktopLayout, LocalWindow } from './DesktopLayout';
import type { FreeSpaceMap } from './FreeSpaceMap';
import type { PeekGeometry, PeekPlanner, PeekSpot } from './PeekPlanner';
import { createDefaultPose, POSE_NAMES, type CatPose } from './BlackCatModel';
import type { MeowKind, SoundEffect } from './catVoice';
import type { ActivityLevel, MischiefLevel, MoodLevel, RoamMode } from '../shared/backendApi';
import type { Point, Rect } from '../shared/geometry';
import { clamp, dampAngle, pickRandom, randomBetween } from '../shared/geometry';

export type Behavior =
  | 'wander' | 'flee' | 'goRemind' | 'remindWaiting' | 'sit' | 'stand' | 'groom' | 'stretch' | 'rest' | 'sleep'
  | 'petted' | 'happy' | 'sulk' | 'lifted' | 'landing' | 'startled' | 'dodge' | 'scratch' | 'yawn'
  | 'sneakTo' | 'sneakIn' | 'tailOut' | 'slipIn' | 'turnHidden' | 'peekOut' | 'peeking' | 'duck' | 'hiding' | 'caught' | 'peekExit'
  | 'jumpPrep' | 'jumping' | 'observe' | 'rolling' | 'pounceWiggle' | 'pushingCup' | 'zoomies' | 'follow' | 'swat' | 'hugged';

/** 提醒方式：活泼 / 轻柔 / 举牌 / 安静举牌 / 敲窗 / 坐到窗口上 / 推杯子 */
export type ReminderStyle = 'lively' | 'gentle' | 'sign' | 'silentSign' | 'knock' | 'sitOnWindow' | 'pushCup';

export interface ReminderRequest {
  escalationLevel: number;
  style: ReminderStyle;
  /** 牌子上的字，例如"喝水！""打卡！" */
  signText: string;
  /** 在哪个窗口上提醒（通常是你正在用的窗口） */
  targetWindowId?: string;
  /** 到位后显示气泡（喝水提醒和定时提醒的气泡不一样） */
  showBubble: () => void;
}

/** 大脑通过它让界面说话、冒特效、发出声音 */
export interface CatEffects {
  say(text: string, durationMs?: number): void;
  /** addressOwner：气泡文字前面可能加上主人的称呼（"小明，……"） */
  sayLine(key: string, options?: { durationMs?: number; count?: number; isImportant?: boolean; meowKind?: MeowKind; fallbackText?: string; addressOwner?: boolean }): void;
  hideBubble(): void;
  float(text: string, position: Point): void;
  burst(text: string, count: number): void;
  meow(kind: MeowKind): void;
  purr(): void;
  playSound(kind: SoundEffect): void;
  /** 巡视时观察一个窗口：控制器根据你在做什么说一句话 */
  reactToWindow(window: LocalWindow): void;
  /** 一段捣乱开始时说的话 */
  announceMischief(kind: MischiefKind): void;
}

export type MischiefKind = 'zoomies' | 'pounce' | 'occupyWindow' | 'pushCup' | 'follow';

const MOVING_BEHAVIORS = new Set<Behavior>(['wander', 'flee', 'goRemind', 'sneakTo', 'sneakIn', 'slipIn', 'peekOut', 'duck', 'peekExit', 'zoomies', 'follow']);
const CALM_BEHAVIORS = new Set<Behavior>(['wander', 'sit', 'stand', 'groom', 'stretch', 'rest', 'observe', 'scratch', 'yawn']);
const PEEK_OUT_BEHAVIORS = new Set<Behavior>(['peekOut', 'peeking', 'caught']);              // 脑袋露在外面的阶段
const PEEK_HIDDEN_BEHAVIORS = new Set<Behavior>(['slipIn', 'turnHidden', 'duck', 'hiding']); // 完全藏在后面的阶段
const NO_LOOK_BEHAVIORS = new Set<Behavior>(['sleep', 'groom', 'lifted', 'sulk', 'stretch', 'duck', 'hiding', 'slipIn', 'turnHidden', 'tailOut', 'sneakIn', 'rolling', 'dodge', 'yawn', 'scratch', 'hugged']);
/** 鼠标猛冲过去时会被吓到的行为（平常发呆、溜达、睡觉、在窗口上观察） */
const SCARABLE_BEHAVIORS = new Set<Behavior>([...CALM_BEHAVIORS, 'sleep', 'happy', 'sulk']);
/** 鼠标轨迹保留多久（秒），用来算速度和判断有没有"冲过"猫 */
const CURSOR_TRAIL_SECONDS = .15;
/** 卡住检测：多少秒内行为切换超过多少次算异常 */
const BEHAVIOR_CHURN_WINDOW_SECONDS = 3;
const MAX_BEHAVIOR_CHANGES_IN_WINDOW = 30;
/** 跳一次最远多少像素，更远的距离分几次跳过去（"蹦蹦蹦"） */
const MAX_HOP_DISTANCE = 320;
/** 站在窗口顶上至少要留出的高度（猫的身体在窗口上沿上方） */
const WINDOW_TOP_CLEARANCE = 140; // 100% 大小时的像素数，使用时按猫咪大小换算
const MIN_WINDOW_WIDTH_FOR_STANDING = 200;
const PUSH_CUP_SECONDS = 2.6;
const ROLL_SECONDS = 1.4;

interface PeekState {
  spot: PeekSpot;
  peekCount: number;
  lastAnchor: Point;
}

/** 站在某个窗口的顶边上（巡视、霸占窗口、在窗口上提醒） */
interface WindowSurface {
  windowId: string;
  /** 记录窗口左上角，窗口被拖动时猫跟着走 */
  lastAnchor: Point;
}

interface JumpState {
  from: Point;
  to: Point;
  elapsed: number;
  duration: number;
  arcHeight: number;
  landingSurface: WindowSurface | null;
  onLand: () => void;
}

type WalkStyle = 'normal' | 'sneak' | 'run';

export class CatBrain {
  position: Point = { x: 0, y: 0 };
  yaw = 0;
  targetYaw = 0;
  behavior: Behavior = 'sit';
  behaviorTimer = 2;
  /** 当前行为已经持续了多久 */
  behaviorElapsed = 0;
  path: Point[] = [];
  moveSpeed = WALK_SPEED;
  currentSpeed = 0;
  /** 移动时保持朝向（缩回去时倒退，不转身） */
  keepFacing = false;
  walkStyle: WalkStyle = 'normal';
  onArrive: (() => void) | null = null;
  roamMode: RoamMode = 'free';
  /** 当前是否在屏幕底边（任务栏上沿或全屏时的屏幕底边） */
  isOnEdge = false;
  peek: PeekState | null = null;
  surface: WindowSurface | null = null;
  jump: JumpState | null = null;
  walkPhase = 0;
  elapsedSeconds = 0;
  lastPettedTime = -99;
  effectTimer = 0;
  cursor = { x: -9999, y: -9999, speed: 0, stillSeconds: 0 };
  /** 最近一小段鼠标轨迹（时间单位：秒，和 elapsedSeconds 同一个时钟） */
  private cursorTrail: { x: number; y: number; time: number }[] = [];
  private lastScaredTime = -99;
  /** 初始位置设置好之后才开始响应窗口变化，避免启动时误报"被压到" */
  isReady = false;

  // ---- 由控制器根据设置和数据更新 ----
  activityLevel: ActivityLevel = 'normal';
  mischiefLevel: MischiefLevel = 'sometimes';
  isScareEnabled = true;
  moodLevel: MoodLevel = 'normal';
  /** 开会、全屏时保持低调：不捣乱、不乱跑 */
  isLowProfile = false;
  /** 一天里的阶段（作息），影响精神头 */
  routinePhase: RoutinePhase = 'working';
  /** 亲密度（越高解锁越多亲昵动作） */
  intimacy = 0;
  /** 你是不是正在打字、正在用什么软件（动作条件会用到） */
  isUserTyping = false;
  foregroundCategory = 'other';
  /** 你上次理它的时间（摸摸、抱抱、逗猫、拎起来、喝水） */
  private lastInteractionTime = 0;

  // ---- 动作执行器 ----
  /** 正在执行的动作和执行到第几步；为 null 表示当前行为不是动作系统安排的 */
  private actionRun: { definition: ActionDefinition; stepIndex: number; trigger: ActionTrigger; poseStep: ActionStep | null } | null = null;
  /** 执行器自己在切换行为时为 true（别的代码切换行为会打断当前动作） */
  private isRunnerChangingBehavior = false;

  // ---- 逗猫棒、抱抱 ----
  private teaserPouncesInRow = 0;
  private lastTeaserPounceTime = -99;
  private teaserRestUntil = -99;
  private isTeaserPounce = false;

  // ---- 卡住检测 ----
  private behaviorChangeTimes: number[] = [];
  /** 卡住后复位，之后的一小段时间内不响应窗口变化，避免马上又卡回去 */
  private layoutReactionPausedUntil = -99;

  // ---- 提醒 ----
  private reminder: ReminderRequest | null = null;
  private knockCount = 0;
  private hasCupCrashed = false;

  // ---- 其它小状态 ----
  private isCursorOverCat = false;
  private hasReactedInObserve = false;
  private landingCallback: (() => void) | null = null;
  /** 刚落地的"压扁再弹起"程度 */
  squashAmount = 0;
  /** 你切换窗口时，猫转头看过去的位置和剩余时间 */
  private glanceTarget: Point | null = null;
  private glanceSecondsLeft = 0;
  private zoomiesLeft = 0;
  private followSecondsLeft = 0;

  constructor(
    private freeSpaceMap: FreeSpaceMap,
    private desktop: DesktopLayout,
    private peekPlanner: PeekPlanner,
    private effects: CatEffects,
  ) {}

  get edgeLineY(): number { return this.desktop.workArea.bottom; }

  get peekGeometry(): PeekGeometry | null {
    return this.peek ? this.peekPlanner.geometryOf(this.peek.spot) : null;
  }

  get surfaceWindow(): LocalWindow | undefined {
    return this.surface ? this.desktop.findWindow(this.surface.windowId) : undefined;
  }

  /** 头的大概位置（用来摆气泡、特效、判断鼠标距离） */
  get headPosition(): Point {
    const geometry = this.peekGeometry;
    if (geometry && PEEK_OUT_BEHAVIORS.has(this.behavior)) return geometry.headPosition;
    return { x: this.position.x, y: this.position.y - catPixels(78) };
  }

  /** 偷看时需要裁掉的区域（猫和藏身窗口重叠的部分变透明，看起来就像躲在窗口后面） */
  get clipRect(): Rect | null {
    return this.peek ? this.peekGeometry?.cover ?? null : null;
  }

  get isSleeping(): boolean { return this.behavior === 'sleep'; }
  get isReminding(): boolean { return this.reminder !== null; }

  /** 活跃度影响发呆时间的长短 */
  private idleDuration(min: number, max: number): number {
    const multiplier = this.activityLevel === 'calm' ? CALM_IDLE_MULTIPLIER : this.activityLevel === 'lively' ? LIVELY_IDLE_MULTIPLIER : 1;
    return randomBetween(min, max) * multiplier;
  }

  setBehavior(behavior: Behavior, durationSeconds = Infinity): void {
    this.noteBehaviorChange();
    this.behavior = behavior;
    this.behaviorTimer = durationSeconds;
    this.behaviorElapsed = 0;
    this.path = [];
    this.onArrive = null;
    this.keepFacing = false;
    this.walkStyle = 'normal';
    // 坐下时大多数时候转过来面向你，更可爱
    if (!this.peek) {
      if (behavior === 'sit' || behavior === 'groom' || behavior === 'scratch' || behavior === 'yawn') this.targetYaw = randomBetween(-.9, .9);
      if (behavior === 'remindWaiting' || behavior === 'happy' || behavior === 'petted' || behavior === 'observe') this.targetYaw = 0;
      if (behavior === 'sulk' || behavior === 'dodge') this.targetYaw = Math.PI + randomBetween(-.4, .4);
    }
  }

  moveAlong(path: Point[] | null, speed: number, behavior: Behavior, onArrive?: () => void, options: { keepFacing?: boolean; walkStyle?: WalkStyle } = {}): void {
    this.noteBehaviorChange();
    if (!path || !path.length) {
      this.behavior = behavior;
      this.behaviorElapsed = 0;
      this.path = [];
      onArrive?.();
      return;
    }
    this.behavior = behavior;
    this.behaviorTimer = Infinity;
    this.behaviorElapsed = 0;
    this.path = path;
    this.moveSpeed = speed;
    this.onArrive = onArrive ?? null;
    this.keepFacing = options.keepFacing ?? false;
    this.walkStyle = options.walkStyle ?? (speed >= RUN_SPEED ? 'run' : 'normal');
  }

  // =====================================================================
  // 动作层：问动作系统"现在做什么 / 怎么反应"，再一步步执行
  // =====================================================================
  /** 上一个动作做完了：想想接下来做什么 */
  chooseNextBehavior(): void {
    // 站着的窗口不能站了（最大化了、变窄了）：先跳下来
    const window = this.surfaceWindow;
    if (this.surface && (!window || !this.isWindowTopUsable(window))) { this.jumpDown(); return; }
    // 自由模式下蹲在边缘时，一旦桌面有了空地就回去
    if (this.roamMode === 'free' && this.isOnEdge && !this.surface && this.freeSpaceMap.freeCellCount > 0) { this.leaveEdge(); return; }
    if (!this.performAction('idle')) this.setBehavior('sit', this.idleDuration(3, 5));
  }

  /** 猫现在在哪儿 */
  get place(): CatPlace {
    if (this.roamMode === 'anchored') return 'anchored';
    if (this.surface) return 'window';
    return this.isOnEdge ? 'edge' : 'floor';
  }

  /** 挑选动作时的"现场情况" */
  private buildActionContext(trigger: ActionTrigger): ActionContext {
    const head = this.headPosition;
    return {
      trigger,
      place: this.place,
      mood: this.moodLevel,
      intimacy: this.intimacy,
      routinePhase: this.routinePhase,
      activity: this.foregroundCategory,
      activityLevel: this.activityLevel,
      mischiefLevel: this.mischiefLevel,
      roamMode: this.roamMode,
      isFullscreen: this.desktop.hasFullscreenWindow,
      isLowProfile: this.isLowProfile,
      isTyping: this.isUserTyping,
      isCursorNearby: this.cursor.x > -1000 && Math.hypot(this.cursor.x - head.x, this.cursor.y - head.y) < 400,
      behavior: this.behavior,
      quietMinutes: (this.elapsedSeconds - this.lastInteractionTime) / 60,
      now: new Date(),
    };
  }

  /**
   * 按触发时机挑一个动作来做。做不成的（例如想偷看却找不到藏身的地方）换一个，最多试 4 次。
   * 返回做了哪个动作；一个都做不成返回 null（调用的地方会用保底动作）
   */
  performAction(trigger: ActionTrigger, ignoreCooldown = false): ActionDefinition | null {
    const triedIds = new Set<string>();
    for (let attempt = 0; attempt < 4; attempt++) {
      const definition = actionLibrary.choose(this.buildActionContext(trigger), triedIds, ignoreCooldown);
      if (!definition) return null;
      triedIds.add(definition.id);
      if (this.startAction(definition, trigger)) {
        actionLibrary.markUsed(definition.id);
        if (import.meta.env.DEV) console.info(`动作：${definition.name}（${definition.id}，${trigger}，在${this.place}）`);
        return definition;
      }
    }
    return null;
  }

  private startAction(definition: ActionDefinition, trigger: ActionTrigger): boolean {
    this.actionRun = { definition, stepIndex: 0, trigger, poseStep: null };
    return this.advanceAction();
  }

  /**
   * 执行动作的下一步：
   *   说话、冒字、声音、转向这些"瞬间完成"的立刻做，然后接着下一步；
   *   摆姿势要保持一段时间，时间到了（handleBehaviorTimeout）再接着执行；
   *   调用能力（散步、偷看、捣乱……）后，动作就交给能力了，到此结束。
   * 返回 false 表示动作已经结束（或者能力做不成）
   */
  private advanceAction(): boolean {
    const run = this.actionRun;
    if (!run) return false;
    while (run.stepIndex < run.definition.steps.length) {
      const step = run.definition.steps[run.stepIndex++];
      if (step.run) {
        this.actionRun = null;
        const isStarted = this.runAbility(step.run);
        if (isStarted) this.runInstantStepParts(step, run);
        return isStarted;
      }
      this.runInstantStepParts(step, run);
      if (step.pose) {
        const seconds = Array.isArray(step.seconds) ? randomBetween(step.seconds[0], step.seconds[1]) : step.seconds ?? 2;
        // 平时的动作受活跃度影响：安静的猫发呆久一点，活泼的猫短一点
        const duration = run.trigger === 'idle' ? this.idleDuration(seconds, seconds) : seconds;
        this.isRunnerChangingBehavior = true;
        this.setBehavior(step.pose as Behavior, duration);
        this.isRunnerChangingBehavior = false;
        run.poseStep = step;
        if (step.face) this.applyFace(step.face); // 放在 setBehavior 后面，因为坐下时会随机转个方向
        return true;
      }
    }
    this.actionRun = null;
    return false;
  }

  /** 一步里"瞬间完成"的部分：说话、冒字、声音、转向 */
  private runInstantStepParts(step: ActionStep, run: { definition: ActionDefinition; trigger: ActionTrigger }): void {
    const pickOne = (value: string | string[] | undefined) => (Array.isArray(value) ? pickRandom(value) : value);
    const text = pickOne(step.text);
    if (step.say) {
      this.effects.sayLine(step.say, { fallbackText: text });
    } else if (text) {
      // 只有文字的台词：平时的动作算闲聊（受"话多程度"限制），对你操作的反应算互动回应
      const lineKey = run.trigger === 'idle' ? `action-${run.definition.id}` : `reaction-${run.definition.id}`;
      this.effects.sayLine(lineKey, { fallbackText: text });
    }
    const floatText = pickOne(step.float);
    if (floatText) this.effects.float(floatText, this.headPosition);
    if (step.burst) this.effects.burst(step.burst, step.burstCount ?? 3);
    if (step.sound) this.playStepSound(step.sound);
    if (step.face && !step.pose) this.applyFace(step.face);
  }

  private playStepSound(sound: string): void {
    if (sound === 'purr') this.effects.purr();
    else if (sound === 'knock' || sound === 'crash' || sound === 'boing') this.effects.playSound(sound);
    else if (sound.startsWith('meow:')) this.effects.meow(sound.slice(5) as MeowKind);
  }

  private applyFace(face: NonNullable<ActionStep['face']>): void {
    if (face === 'user') this.targetYaw = 0;
    else if (face === 'away') this.targetYaw = Math.PI + randomBetween(-.4, .4);
    else if (face === 'random') this.targetYaw = randomBetween(-1.2, 1.2);
    else if (this.cursor.x > -1000) this.targetYaw = Math.atan2(this.cursor.x - this.position.x, this.cursor.y - this.position.y);
  }

  /**
   * 能力：动作配置里写不出来的复杂本事，配置里用 { "run": "名字" } 调用。返回 false 表示现在做不了
   *   wander 溜达 / peek 偷看 / patrol 跳上窗口巡视 / roll 打滚 / sleep 打个盹 / goEdge 去屏幕边上 / flee 跑开
   *   approachCursor 走到鼠标旁边 / dodgeHop 往旁边跳开 / pounceCursor 扑鼠标（逗猫棒）
   *   walkOnWindow 沿窗口顶边溜达 / observe 低头看窗口里 / hopToOtherWindow 跳到别的窗口 / jumpDown 跳下来
   *   mischief:zoomies 满屏乱跑 / mischief:pounce 扑鼠标 / mischief:occupyWindow 霸占窗口 / mischief:pushCup 推杯子 / mischief:follow 跟屁虫
   */
  private runAbility(name: string): boolean {
    if (name.startsWith('mischief:')) return this.tryStartMischief(name.slice(9) as MischiefKind);
    const window = this.surfaceWindow;
    switch (name) {
      case 'wander': this.startWander(); return true;
      case 'peek': return this.tryStartPeek();
      case 'patrol': return this.roamMode === 'free' && !this.isLowProfile && this.tryJumpOntoWindow();
      case 'roll': this.startRoll(); return true;
      case 'sleep': this.setBehavior('sleep', randomBetween(40, 90)); return true;
      case 'goEdge': if (this.roamMode !== 'free' || this.isOnEdge) return false; this.goEdge(); return true;
      case 'flee':
        if (this.roamMode === 'anchored') { this.setBehavior('startled', .9); return true; }
        this.startWander(this.cursor.x > -1000 ? this.cursor : null, RUN_SPEED, 'flee');
        return true;
      case 'approachCursor': {
        if (this.cursor.x < -1000 || this.roamMode !== 'free' || this.surface || this.isOnEdge) return false;
        const path = this.freeSpaceMap.planToward(this.position, this.cursor, catPixels(160));
        if (!path?.length) return false;
        this.moveAlong(path, WALK_SPEED * 1.1, 'wander', () => {
          this.setBehavior('sit', 3);
          this.applyFace('cursor');
          this.effects.meow('call');
        });
        return true;
      }
      case 'dodgeHop': {
        const side = Math.random() < .5 ? -1 : 1;
        this.hopTo({ x: this.position.x + side * catPixels(110), y: this.position.y }, () => this.setBehavior('dodge', 2.5), this.surface);
        return true;
      }
      case 'pounceCursor': {
        if (this.cursor.x < -1000) return false;
        this.lastTeaserPounceTime = this.elapsedSeconds;
        this.teaserPouncesInRow++;
        this.isTeaserPounce = true;
        this.zoomiesLeft = 0;
        this.followSecondsLeft = 0;
        this.setBehavior('pounceWiggle', .55);
        this.targetYaw = Math.atan2(this.cursor.x - this.position.x, this.cursor.y - this.position.y);
        return true;
      }
      case 'walkOnWindow': {
        if (!window) return false;
        const targetX = randomBetween(window.rect.left + 60, window.rect.right - 60);
        this.moveAlong([{ x: targetX, y: window.rect.top }], WALK_SPEED * randomBetween(.8, 1.2), 'wander', () => this.setBehavior('sit', this.idleDuration(2, 4)));
        return true;
      }
      case 'observe': if (!window) return false; this.startObserve(); return true;
      case 'hopToOtherWindow':
        if (!window) return false;
        if (!this.tryJumpOntoWindow(undefined, undefined, window.id)) this.jumpDown();
        return true;
      case 'jumpDown': if (!this.surface) return false; this.jumpDown(); return true;
      default:
        console.warn(`动作配置里写了不认识的能力：${name}`);
        return false;
    }
  }

  /** 你理了它一下（摸摸、抱抱、逗猫、拎起来、喝水）：用来判断"多久没理它了" */
  private noteInteraction(): void {
    this.lastInteractionTime = this.elapsedSeconds;
  }

  /** 右键菜单"表演一个"：从表演类动作里挑一个，不管冷却 */
  performTrick(): boolean {
    if (this.reminder || this.peek || this.jump || this.behavior === 'lifted') return false;
    return !!this.performAction('trick', true);
  }

  startWander(avoidPoint: Point | null = null, speed = WALK_SPEED * randomBetween(.8, 1.25), behavior: Behavior = 'wander'): void {
    const afterArrive = () => this.setBehavior(pickRandom(['sit', 'sit', 'stand'] as const), this.idleDuration(2, 5));
    if (this.isOnEdge) {
      const workArea = this.desktop.workArea;
      let targetX = randomBetween(workArea.left + 100, workArea.right - 100);
      if (avoidPoint) targetX = avoidPoint.x < this.position.x ? Math.min(workArea.right - 80, this.position.x + 300) : Math.max(workArea.left + 80, this.position.x - 300);
      this.moveAlong([{ x: targetX, y: this.edgeLineY }], speed, behavior, afterArrive);
      return;
    }
    const path = this.freeSpaceMap.planWander(this.position, avoidPoint);
    if (!path) { this.setBehavior('sit', 3); return; }
    this.moveAlong(path, speed, behavior, afterArrive);
  }

  goEdge(): void {
    this.isOnEdge = true;
    this.surface = null;
    const workArea = this.desktop.workArea;
    this.moveAlong([{ x: clamp(this.position.x, workArea.left + 90, workArea.right - 90), y: this.edgeLineY }], RUN_SPEED, 'flee', () => this.setBehavior('sit', 2));
  }

  leaveEdge(): void {
    this.isOnEdge = false;
    const cellIndex = this.freeSpaceMap.nearestFreeCell(this.position.x, this.position.y);
    if (cellIndex < 0) { this.isOnEdge = true; this.setBehavior('sit', 3); return; }
    this.moveAlong([this.freeSpaceMap.cellCenter(cellIndex)], WALK_SPEED, 'wander', () => this.setBehavior('sit', 2));
  }

  setRoamMode(mode: RoamMode, shouldAnnounce = true): void {
    const applyMode = () => {
      this.roamMode = mode;
      if (mode === 'free') { if (shouldAnnounce) this.effects.sayLine('mode-free', { isImportant: true }); this.chooseNextBehavior(); }
      if (mode === 'anchored') { if (shouldAnnounce) this.effects.sayLine('mode-anchored', { isImportant: true }); this.setBehavior('sit', 3); }
      if (mode === 'edge') { if (shouldAnnounce) this.effects.sayLine('mode-edge', { isImportant: true }); this.goEdge(); }
    };
    if (this.peek) this.exitPeek(applyMode); else applyMode();
  }

  /** 你切换到另一个窗口时：猫转头看一眼 */
  glanceAt(point: Point): void {
    if (!CALM_BEHAVIORS.has(this.behavior)) return;
    this.glanceTarget = point;
    this.glanceSecondsLeft = 2.2;
  }

  // =====================================================================
  // 跳跃：抛物线飞过去；太远就分几次跳（蹦蹦蹦）
  // =====================================================================
  hopTo(target: Point, onArrive: () => void, landingSurface: WindowSurface | null = null): void {
    const distance = Math.hypot(target.x - this.position.x, target.y - this.position.y);
    if (distance > MAX_HOP_DISTANCE) {
      const ratio = MAX_HOP_DISTANCE / distance;
      const midpoint = { x: this.position.x + (target.x - this.position.x) * ratio, y: this.position.y + (target.y - this.position.y) * ratio };
      this.prepareJump(midpoint, () => this.hopTo(target, onArrive, landingSurface), null, .12);
      return;
    }
    this.prepareJump(target, onArrive, landingSurface, .22);
  }

  private prepareJump(target: Point, onLand: () => void, landingSurface: WindowSurface | null, prepareSeconds: number): void {
    this.surface = null;
    const deltaX = target.x - this.position.x;
    const deltaY = target.y - this.position.y;
    const distance = Math.hypot(deltaX, deltaY);
    this.jump = {
      from: { ...this.position },
      to: target,
      elapsed: 0,
      duration: clamp(distance / 520, .38, .8),
      // 往上跳要跳得更高一点
      arcHeight: 40 + Math.max(0, -deltaY) * .35 + distance * .08,
      landingSurface,
      onLand,
    };
    this.setBehavior('jumpPrep', prepareSeconds);
    // 主要朝左右跳，往上跳时侧着身子
    if (distance > 4) this.targetYaw = Math.atan2(deltaX, deltaY * .35);
  }

  private advanceJump(deltaSeconds: number): void {
    const jump = this.jump;
    if (!jump) return;
    jump.elapsed += deltaSeconds;
    const progress = Math.min(1, jump.elapsed / jump.duration);
    this.position.x = jump.from.x + (jump.to.x - jump.from.x) * progress;
    this.position.y = jump.from.y + (jump.to.y - jump.from.y) * progress - jump.arcHeight * 4 * progress * (1 - progress);
    if (progress < 1) return;
    this.jump = null;
    this.surface = jump.landingSurface;
    if (this.surface) {
      const window = this.surfaceWindow;
      if (window) this.surface.lastAnchor = { x: window.rect.left, y: window.rect.top };
    }
    this.squashAmount = 1; // 落地压扁一下再弹起来
    this.landingCallback = jump.onLand;
    this.setBehavior('landing', .18);
  }

  // =====================================================================
  // 巡视：站在窗口顶边上走、看、跳到别的窗口或跳下去
  // =====================================================================
  private isWindowTopUsable(window: LocalWindow): boolean {
    const workArea = this.desktop.workArea;
    return !window.isMaximized && !window.isFullscreen &&
      window.rect.top >= workArea.top + catPixels(WINDOW_TOP_CLEARANCE) &&
      window.rect.right - window.rect.left >= MIN_WINDOW_WIDTH_FOR_STANDING &&
      !this.isWindowTopCovered(window);
  }

  /**
   * 窗口顶边是不是被上层的窗口挡住了大半（例如被全屏视频、别的窗口盖住）。
   * 被挡住的窗口顶上不能站——不然猫会"浮"在挡住它的窗口上面
   */
  private isWindowTopCovered(window: LocalWindow): boolean {
    const windowIndex = this.desktop.visibleWindows.findIndex(item => item.id === window.id);
    if (windowIndex <= 0) return false;
    const width = window.rect.right - window.rect.left;
    // 窗口顶边上方猫站的那一条区域
    const strip = { left: window.rect.left, right: window.rect.right, top: window.rect.top - catPixels(WINDOW_TOP_CLEARANCE) * .5, bottom: window.rect.top + 4 };
    let coveredWidth = 0;
    for (const above of this.desktop.visibleWindows.slice(0, windowIndex)) {
      const overlapsVertically = above.rect.top < strip.bottom && above.rect.bottom > strip.top;
      if (!overlapsVertically) continue;
      coveredWidth += Math.max(0, Math.min(above.rect.right, strip.right) - Math.max(above.rect.left, strip.left));
    }
    return coveredWidth > width * .5;
  }

  /** 选一个窗口跳上去（优先你正在用的窗口） */
  tryJumpOntoWindow(onLanded?: () => void, preferredWindowId?: string, excludeWindowId?: string): boolean {
    const candidates = this.desktop.visibleWindows.filter(window => window.id !== excludeWindowId && this.isWindowTopUsable(window));
    if (!candidates.length) return false;
    const preferred = candidates.find(window => window.id === preferredWindowId);
    const weighted = candidates.flatMap(window => (window.isForeground ? [window, window, window, window] : [window]));
    const window = preferred ?? pickRandom(weighted);
    const x = clamp(this.cursor.x > -1000 && Math.random() < .5 ? this.cursor.x : randomBetween(window.rect.left, window.rect.right),
      window.rect.left + 70, window.rect.right - 70);
    this.hopTo({ x, y: window.rect.top }, onLanded ?? (() => this.startObserve()), { windowId: window.id, lastAnchor: { x: window.rect.left, y: window.rect.top } });
    return true;
  }

  /** 坐在窗口顶上低头看窗口里的内容，然后根据你在做什么说一句话 */
  private startObserve(): void {
    this.setBehavior('observe', randomBetween(6, 10));
    this.hasReactedInObserve = false;
  }

  /** 从窗口顶跳回地面（空地，没有空地就去底边） */
  jumpDown(onLanded?: () => void): void {
    const after = onLanded ?? (() => this.setBehavior('sit', 2));
    if (this.roamMode !== 'free' || this.freeSpaceMap.freeCellCount === 0) {
      this.isOnEdge = true;
      const workArea = this.desktop.workArea;
      this.hopTo({ x: clamp(this.position.x, workArea.left + 90, workArea.right - 90), y: this.edgeLineY }, after);
      return;
    }
    const cellIndex = this.freeSpaceMap.nearestFreeCell(this.position.x, this.position.y + 80);
    this.isOnEdge = false;
    this.hopTo(this.freeSpaceMap.cellCenter(cellIndex), after);
  }

  /** 站着的窗口被拖动：跟着走；窗口没了 / 最大化：掉下来 */
  private refreshSurface(): void {
    const window = this.surfaceWindow;
    if (!window || !this.isWindowTopUsable(window) || !this.surface) {
      this.surface = null;
      this.effects.sayLine('peek-cover-gone', { isImportant: true });
      this.reminder = null;
      this.jumpDown();
      return;
    }
    const deltaX = window.rect.left - this.surface.lastAnchor.x;
    const deltaY = window.rect.top - this.surface.lastAnchor.y;
    if (deltaX || deltaY) {
      this.position.x += deltaX;
      this.position.y += deltaY;
      this.path.forEach(point => { point.x += deltaX; point.y += deltaY; });
      this.surface.lastAnchor = { x: window.rect.left, y: window.rect.top };
    }
  }

  // =====================================================================
  // 小捣乱
  // =====================================================================
  /** 开始一段捣乱（什么时候捣乱、捣哪种乱，由动作配置决定） */
  tryStartMischief(kind: MischiefKind): boolean {
    if (this.reminder) return false;
    switch (kind) {
      case 'zoomies':
        this.effects.announceMischief('zoomies');
        this.surface = null;
        this.zoomiesLeft = Math.floor(randomBetween(3, 6));
        this.nextZoomiesLeg();
        return true;
      case 'pounce': {
        if (this.cursor.x < -1000) return false;
        this.effects.announceMischief('pounce');
        this.setBehavior('pounceWiggle', .8);
        this.targetYaw = Math.atan2(this.cursor.x - this.position.x, this.cursor.y - this.position.y);
        return true;
      }
      case 'occupyWindow': {
        const foreground = this.desktop.foregroundWindow;
        if (!foreground || !this.isWindowTopUsable(foreground)) return false;
        return this.tryJumpOntoWindow(() => {
          this.effects.announceMischief('occupyWindow');
          this.setBehavior('rest', randomBetween(15, 25));
        }, foreground.id);
      }
      case 'pushCup': {
        const startPush = () => { this.effects.announceMischief('pushCup'); this.startPushCup(); };
        if (this.surface) { startPush(); return true; }
        return this.tryJumpOntoWindow(startPush, this.desktop.foregroundWindow?.id);
      }
      case 'follow':
        if (this.cursor.x < -1000) return false;
        this.effects.announceMischief('follow');
        this.surface = null;
        this.followSecondsLeft = randomBetween(6, 10);
        this.setBehavior('follow');
        return true;
      default:
        return false; // 配置里写了不认识的捣乱种类
    }
  }

  /** 满屏乱跑：一段一段地冲刺，有时跳一下 */
  private nextZoomiesLeg(): void {
    if (this.zoomiesLeft <= 0) { this.setBehavior('sit', 2); this.effects.float('呼～', this.headPosition); return; }
    this.zoomiesLeft--;
    const workArea = this.desktop.workArea;
    const target = {
      x: clamp(this.position.x + randomBetween(-700, 700), workArea.left + 80, workArea.right - 80),
      y: clamp(this.position.y + randomBetween(-300, 300), workArea.top + 150, workArea.bottom),
    };
    if (Math.random() < .35) this.hopTo(target, () => this.nextZoomiesLeg());
    else this.moveAlong([target], RUN_SPEED * 1.3, 'zoomies', () => this.nextZoomiesLeg(), { walkStyle: 'run' });
  }

  private startPushCup(): void {
    this.hasCupCrashed = false;
    this.setBehavior('pushingCup', PUSH_CUP_SECONDS);
    this.targetYaw = .9;
  }

  private startRoll(): void {
    this.setBehavior('rolling', ROLL_SECONDS);
  }

  // =====================================================================
  // 偷看（躲猫猫）
  // =====================================================================
  /** isRequestedByUser：右键菜单"去偷看你在干嘛"，专门去看你正在用的窗口 */
  tryStartPeek(isRequestedByUser = false): boolean {
    if (this.roamMode === 'anchored' && !isRequestedByUser) return false;
    if (isRequestedByUser && this.peek) this.peek = null; // 正在别处偷看：换个地方
    this.surface = null;
    const focusX = this.cursor.x > -1000 ? this.cursor.x : undefined;
    const plan = this.peekPlanner.plan(this.position, this.isOnEdge, this.edgeLineY, isRequestedByUser, focusX);
    if (!plan) return false;
    if (this.roamMode === 'anchored') this.roamMode = 'free';
    const geometry = this.peekPlanner.geometryOf(plan.spot)!;
    this.peek = { spot: plan.spot, peekCount: 0, lastAnchor: { ...geometry.anchor } };
    if (isRequestedByUser) this.effects.sayLine('peek-start-01', { isImportant: true });
    this.moveAlong(plan.path, SNEAK_SPEED, 'sneakTo', () => this.peekSneakIn(), { walkStyle: 'sneak' });
    return true;
  }

  /** 钻进去一半：尾巴还露在外面晃 */
  private peekSneakIn(): void {
    const geometry = this.peekGeometry;
    if (!geometry) { this.abortPeek(); return; }
    this.moveAlong([geometry.tailOutPoint], SNEAK_SPEED, 'sneakIn', () => this.setBehavior('tailOut', randomBetween(1.2, 2)), { walkStyle: 'sneak' });
  }

  /** 整个藏进去，然后在里面转身 */
  private peekSlipIn(): void {
    const geometry = this.peekGeometry;
    if (!geometry) { this.abortPeek(); return; }
    this.moveAlong([geometry.hiddenPoint], 70, 'slipIn', () => {
      this.setBehavior('turnHidden', .9);
      this.targetYaw = geometry.outYaw;
    }, { walkStyle: 'sneak' });
  }

  /** 慢慢探出半个脑袋 */
  private peekPopOut(): void {
    const geometry = this.peekGeometry;
    if (!geometry) { this.abortPeek(); return; }
    this.targetYaw = geometry.outYaw;
    this.moveAlong([geometry.peekPoint], 22, 'peekOut', () => this.setBehavior('peeking', randomBetween(7, 12)), { keepFacing: true, walkStyle: 'sneak' });
  }

  /** 嗖地缩回去（倒退，不转身） */
  private peekDuck(isScared: boolean): void {
    const geometry = this.peekGeometry;
    if (!geometry || !this.peek) { this.abortPeek(); return; }
    this.peek.peekCount++;
    if (isScared) this.effects.float('嗖！', geometry.headPosition);
    this.moveAlong([geometry.hiddenPoint], isScared ? 320 : 110, 'duck', () => this.setBehavior('hiding', randomBetween(1.5, 3)), { keepFacing: true, walkStyle: 'sneak' });
  }

  /**
   * 鼠标是否在猫身上。只在鼠标"移上来"的那一刻算被抓包（边沿触发），
   * 鼠标一直停在那儿不会反复触发，避免"抓包 → 缩回 → 探头 → 又抓包"的抖动循环
   */
  setCursorOverCat(isOver: boolean): void {
    if (isOver && !this.isCursorOverCat) this.peekCaught();
    this.isCursorOverCat = isOver;
  }

  /** 鼠标是否还停在藏身处的出口附近（缩回去后要等鼠标移开再探头） */
  private isCursorNearPeekExit(): boolean {
    const geometry = this.peekGeometry;
    if (!geometry) return false;
    return Math.hypot(this.cursor.x - geometry.headPosition.x, this.cursor.y - geometry.headPosition.y) < 110;
  }

  /** 被鼠标"抓包"：愣住、瞪大眼睛，然后缩回去 */
  private peekCaught(): void {
    if (!PEEK_OUT_BEHAVIORS.has(this.behavior) || this.behavior === 'caught') return;
    this.setBehavior('caught', .75);
    this.effects.float('❗', this.headPosition);
    // 偷看时保持安静，只有被抓包才"喵？"一声再小声辩解
    this.effects.sayLine('peekCaught', { durationMs: 1800, meowKind: 'question' });
  }

  /** 从藏身处走出来 */
  exitPeek(afterExit?: () => void): void {
    const geometry = this.peekGeometry;
    if (!geometry) { this.abortPeek(); afterExit?.(); return; }
    this.moveAlong([geometry.stagingPoint], WALK_SPEED, 'peekExit', () => {
      this.peek = null;
      if (afterExit) afterExit(); else this.setBehavior('sit', randomBetween(2, 4));
    });
  }

  private abortPeek(): void {
    this.peek = null;
    this.setBehavior('landing', .4);
  }

  /** 藏身的窗口被拖动：猫扒着窗口跟着走；窗口没了：掉下来 */
  private refreshPeek(): void {
    const geometry = this.peekGeometry;
    if (!geometry || !this.peek) {
      this.peek = null;
      this.effects.sayLine('peek-cover-gone', { isImportant: true });
      this.setBehavior('landing', .4);
      return;
    }
    const deltaX = geometry.anchor.x - this.peek.lastAnchor.x;
    const deltaY = geometry.anchor.y - this.peek.lastAnchor.y;
    if (deltaX || deltaY) {
      this.position.x += deltaX;
      this.position.y += deltaY;
      this.path.forEach(point => { point.x += deltaX; point.y += deltaY; });
      this.peek.lastAnchor = { ...geometry.anchor };
    }
  }

  // =====================================================================
  // 窗口布局变化
  // =====================================================================
  handleLayoutChange(): void {
    if (!this.isReady || this.behavior === 'lifted' || this.jump) return;
    if (this.elapsedSeconds < this.layoutReactionPausedUntil && !this.peek && !this.surface) return;
    if (this.peek) { this.refreshPeek(); return; }
    if (this.surface) { this.refreshSurface(); return; }
    if (this.roamMode === 'anchored' || this.reminder || this.behavior === 'zoomies' || this.behavior === 'follow') return;
    if (this.isOnEdge) {
      // 全屏切换时边线高度会变（任务栏上沿 ↔ 屏幕底边）
      this.path.forEach(point => { point.y = this.edgeLineY; });
      if (Math.abs(this.position.y - this.edgeLineY) > 1 && !MOVING_BEHAVIORS.has(this.behavior)) {
        this.moveAlong([{ x: this.position.x, y: this.edgeLineY }], RUN_SPEED, 'flee', () => this.setBehavior('sit', 2));
      }
      return;
    }
    if (this.roamMode === 'edge' || this.freeSpaceMap.freeCellCount === 0) { this.goEdge(); return; }
    const isCovered = !this.freeSpaceMap.isPositionFree(this.position.x, this.position.y);
    if (isCovered && this.behavior !== 'flee') {
      const cellIndex = this.freeSpaceMap.nearestFreeCell(this.position.x, this.position.y);
      this.moveAlong([this.freeSpaceMap.cellCenter(cellIndex)], RUN_SPEED, 'flee', () => this.setBehavior('sit', 2));
      this.effects.sayLine('squeezed-01');
    } else if (this.behavior === 'wander' && this.path.some(point => !this.freeSpaceMap.isPositionFree(point.x, point.y))) {
      this.startWander(); // 路线被挡住，重新规划
    }
  }

  // =====================================================================
  // 提醒：根据你在做什么，用不同的方式提醒
  // =====================================================================
  startRemind(request: ReminderRequest): void {
    this.reminder = request;
    this.knockCount = 0;
    this.effects.hideBubble();
    this.zoomiesLeft = 0;
    this.followSecondsLeft = 0;
    if (this.peek) { this.exitPeek(() => this.startRemind(request)); return; }

    const arrive = () => {
      this.setBehavior('remindWaiting');
      if (request.style === 'knock') this.targetYaw = this.position.x < (this.findTargetWindow(request)?.rect.left ?? 0) ? 1.2 : -1.2;
      request.showBubble();
    };
    if (this.roamMode === 'anchored') { arrive(); return; }

    const targetWindow = this.findTargetWindow(request);
    const usableTarget = targetWindow && this.isWindowTopUsable(targetWindow) ? targetWindow : undefined;
    switch (request.style) {
      case 'sign':
      case 'silentSign':
      case 'sitOnWindow':
      case 'pushCup': {
        if (!usableTarget) break; // 没有合适的窗口：退回到普通的跑过来提醒
        const x = clamp(this.cursor.x > -1000 ? this.cursor.x : (usableTarget.rect.left + usableTarget.rect.right) / 2,
          usableTarget.rect.left + 80, usableTarget.rect.right - 80);
        const onArrived = request.style === 'pushCup' ? () => this.startPushCup() : arrive;
        if (this.surface?.windowId === usableTarget.id) {
          this.moveAlong([{ x, y: usableTarget.rect.top }], RUN_SPEED, 'goRemind', onArrived);
        } else {
          this.hopTo({ x, y: usableTarget.rect.top }, onArrived, { windowId: usableTarget.id, lastAnchor: { x: usableTarget.rect.left, y: usableTarget.rect.top } });
        }
        return;
      }
      case 'knock': {
        if (!targetWindow) break;
        // 站到窗口侧边外面，面朝窗口用爪子敲
        const workArea = this.desktop.workArea;
        const isLeftSideFree = targetWindow.rect.left - catPixels(70) > workArea.left + 40;
        const x = isLeftSideFree ? targetWindow.rect.left - catPixels(55) : targetWindow.rect.right + catPixels(55);
        const y = clamp(this.cursor.y > -1000 ? this.cursor.y + 60 : targetWindow.rect.bottom - 40, targetWindow.rect.top + catPixels(140), Math.min(targetWindow.rect.bottom, workArea.bottom));
        this.surface = null;
        this.moveAlong([{ x: clamp(x, workArea.left + 40, workArea.right - 40), y }], RUN_SPEED, 'goRemind', arrive);
        return;
      }
      case 'gentle': {
        if (this.surface) { arrive(); return; }
        if (this.isOnEdge) break;
        const focusPoint = this.cursor.x > -1000 ? this.cursor : { x: this.desktop.workArea.right / 2, y: this.desktop.workArea.bottom / 2 };
        this.moveAlong(this.freeSpaceMap.planToward(this.position, focusPoint, 320), WALK_SPEED, 'goRemind', arrive);
        return;
      }
      case 'lively':
        break;
    }
    // 活泼（默认）：跑到鼠标附近，扭扭屁股，蹦一下
    this.surface = null;
    const afterRun = () => {
      this.setBehavior('pounceWiggle', .6);
      this.pendingPounceArrive = arrive;
    };
    if (this.isOnEdge) {
      const workArea = this.desktop.workArea;
      this.moveAlong([{ x: clamp(this.cursor.x > -1000 ? this.cursor.x : this.position.x, workArea.left + 130, workArea.right - 130), y: this.edgeLineY }], RUN_SPEED, 'goRemind', afterRun);
      return;
    }
    const focusPoint = this.cursor.x > -1000 ? this.cursor : { x: this.desktop.workArea.right / 2, y: this.desktop.workArea.bottom / 2 };
    this.moveAlong(this.freeSpaceMap.planToward(this.position, focusPoint, 190), RUN_SPEED, 'goRemind', afterRun);
  }

  /** 活泼提醒和扑鼠标共用"扭屁股 → 扑"：扭完之后做什么 */
  private pendingPounceArrive: (() => void) | null = null;

  private findTargetWindow(request: ReminderRequest): LocalWindow | undefined {
    return (request.targetWindowId ? this.desktop.findWindow(request.targetWindowId) : undefined) ?? this.desktop.foregroundWindow;
  }

  /** 提醒结束（喝了、稍后、忽略）：收起牌子和杯子 */
  private endReminder(): void {
    this.reminder = null;
    this.pendingPounceArrive = null;
  }

  /** 提醒没人理：委屈一会儿（怎么委屈由动作配置决定） */
  reminderIgnored(): void {
    this.endReminder();
    if (this.behavior !== 'remindWaiting') return;
    if (!this.performAction('reminderIgnored')) this.setBehavior('sulk', 4);
  }

  /** 定时提醒点了"做完啦"：开心一下 */
  customReminderDone(): void {
    this.endReminder();
    this.effects.sayLine('custom-done', { isImportant: true });
    if (!this.performAction('customDone')) { this.setBehavior('happy', 2.4); this.effects.burst('✅', 2); }
  }

  /** 定时提醒点了"等一下嘛"：乖乖等着 */
  customReminderSnoozed(): void {
    this.endReminder();
    this.setBehavior('sit', 3);
    this.effects.sayLine('custom-snooze', { isImportant: true });
  }

  goToSleep(): void {
    this.effects.hideBubble();
    this.endReminder();
    if (this.peek) { this.exitPeek(() => this.goToSleep()); return; }
    if (this.roamMode === 'free' && !this.isOnEdge && !this.surface) {
      this.moveAlong(this.freeSpaceMap.planWander(this.position), WALK_SPEED, 'wander', () => this.setBehavior('sleep'));
    } else {
      this.setBehavior('sleep');
    }
  }

  /** 人回到电脑前：醒来伸个懒腰，打个招呼 */
  wakeUp(): void {
    if (this.behavior !== 'sleep') return;
    this.effects.sayLine('welcome-back-01', { isImportant: true });
    if (!this.performAction('wakeUp')) this.setBehavior('stretch', 2.4);
  }

  /** 喝了一杯 / 达标：开心的反应（打滚、蹦跳、撒花……由动作配置决定） */
  drinkRecorded(isGoalReached: boolean): void {
    this.endReminder();
    this.noteInteraction();
    if (this.peek) { this.effects.burst('💧', 2); return; }
    if (this.performAction(isGoalReached ? 'goalReached' : 'drink')) return;
    this.setBehavior('happy', 2.8);
    this.effects.burst(isGoalReached ? '🎉' : '💧', 3);
  }

  snooze(): void {
    this.endReminder();
    this.effects.sayLine('snooze', { isImportant: true });
    if (!this.performAction('snooze')) this.setBehavior('sulk', 2.8);
  }

  /** 摸摸：心情好就呼噜；发脾气时会躲开 */
  pet(): void {
    this.lastPettedTime = this.elapsedSeconds;
    // 偷看时被摸头：害羞但不出来
    if (this.peek) {
      this.effects.burst('❤', 2);
      this.effects.purr();
      this.effects.sayLine('peek-petted-01');
      if (this.behavior === 'peeking') this.behaviorTimer += 3;
      return;
    }
    if (this.behavior === 'sleep') {
      this.setBehavior('stretch', 2.4);
      this.effects.sayLine('wake-up-01', { durationMs: 3500, isImportant: true });
      return;
    }
    if (this.behavior === 'remindWaiting') return;
    this.noteInteraction();
    // 怎么反应由动作配置决定：呼噜、蹭蹭、翻肚皮、心情不好时躲开……
    if (this.performAction('pet')) return;
    this.setBehavior('petted', 2.4);
    this.effects.burst('❤', 2);
    this.effects.purr();
  }

  // =====================================================================
  // 逗猫棒：你在它旁边快速左右晃鼠标，它会扭屁股扑过来
  // =====================================================================
  /** 控制器发现鼠标在猫附近来回晃：能玩就扑过去；返回 true 表示扑了 */
  playWithTeaser(): boolean {
    const teaser = catConfig.teaser;
    if (this.reminder || this.peek || this.jump || this.cursor.x < -1000) return false;
    if (!CALM_BEHAVIORS.has(this.behavior) && this.behavior !== 'happy' && this.behavior !== 'swat') return false;
    if (this.elapsedSeconds < this.teaserRestUntil) return false;
    if (this.elapsedSeconds - this.lastTeaserPounceTime < teaser.cooldownSeconds) return false;
    // 隔了很久才再逗它：重新计"连续扑了几次"
    if (this.elapsedSeconds - this.lastTeaserPounceTime > 15) this.teaserPouncesInRow = 0;
    this.noteInteraction();
    this.isTeaserPounce = false;
    // 扑过去、盯着看、懒得理你……由动作配置决定；只有真的扑了才算陪它玩
    return !!this.performAction('teaser') && this.isTeaserPounce;
  }

  /** 扑到了：拍一下；连扑好几次就玩累了，趴下休息 */
  private finishTeaserPounce(): void {
    this.isTeaserPounce = false;
    this.effects.float('啪！', this.headPosition);
    const teaser = catConfig.teaser;
    if (this.teaserPouncesInRow >= teaser.maxPouncesInRow) {
      this.teaserPouncesInRow = 0;
      this.teaserRestUntil = this.elapsedSeconds + teaser.restSeconds;
      this.setBehavior('rest', teaser.restSeconds * .6);
      this.effects.sayLine('teaser-tired', { fallbackText: '呼…玩累了，本喵歇会儿' });
      return;
    }
    this.setBehavior('swat', 1);
    this.effects.sayLine('teaser-pounce', { fallbackText: '抓到啦！' });
  }

  // =====================================================================
  // 抱抱：在猫身上按住鼠标不动
  // =====================================================================
  /** 开始抱抱；心情很差时会挣脱。返回 true 表示抱住了 */
  startHug(): boolean {
    if (this.reminder || this.peek || this.jump || this.behavior === 'lifted') return false;
    this.zoomiesLeft = 0;
    this.followSecondsLeft = 0;
    this.lastPettedTime = this.elapsedSeconds;
    this.noteInteraction();
    // 乖乖被抱、挣脱跑开……由动作配置决定（rejectsHold 的动作表示不让抱）
    const definition = this.performAction('hug');
    if (definition) return !definition.rejectsHold && this.behavior === 'hugged';
    this.setBehavior('hugged', 30); // 最多抱 30 秒（万一没收到松开的消息，也不会一直卡在抱抱里）
    this.targetYaw = 0;
    this.effects.purr();
    return true;
  }

  /** 松开了：开心地打个滚或蹦一下 */
  endHug(): void {
    if (this.behavior !== 'hugged') return;
    this.lastPettedTime = this.elapsedSeconds;
    if (!this.performAction('hugEnd')) this.setBehavior('happy', 2);
  }

  // =====================================================================
  // 鼠标猛冲过去：吓一跳
  // =====================================================================
  /** 控制器每收到一次鼠标位置就记一笔 */
  recordCursorSample(x: number, y: number): void {
    const now = this.elapsedSeconds;
    this.cursorTrail.push({ x, y, time: now });
    while (this.cursorTrail.length && now - this.cursorTrail[0].time > CURSOR_TRAIL_SECONDS) this.cursorTrail.shift();
  }

  /** 最近一小段时间鼠标的平均速度（像素/秒），直接按轨迹算、没有滞后；鼠标停下后自然变成 0 */
  get recentCursorSpeed(): number {
    const now = this.elapsedSeconds;
    const samples = this.cursorTrail.filter(sample => now - sample.time <= CURSOR_TRAIL_SECONDS);
    if (samples.length < 2) return 0;
    let distance = 0;
    for (let index = 1; index < samples.length; index++) {
      distance += Math.hypot(samples[index].x - samples[index - 1].x, samples[index].y - samples[index - 1].y);
    }
    return distance / Math.max(now - samples[0].time, .05);
  }

  /** 鼠标轨迹有多"直"：起点到终点的距离 ÷ 实际走过的路程（1 = 一条直线，接近 0 = 来回晃） */
  private get cursorTrailStraightness(): number {
    const trail = this.cursorTrail;
    if (trail.length < 2) return 1;
    let pathLength = 0;
    for (let index = 1; index < trail.length; index++) pathLength += Math.hypot(trail[index].x - trail[index - 1].x, trail[index].y - trail[index - 1].y);
    const netDistance = Math.hypot(trail[trail.length - 1].x - trail[0].x, trail[trail.length - 1].y - trail[0].y);
    return pathLength > 0 ? netDistance / pathLength : 1;
  }

  /** 最近的鼠标轨迹有没有从某个点附近扫过（逐段算点到线段的距离，快速划过也不会漏掉） */
  private didCursorSweepNear(point: Point, radius: number): boolean {
    const trail = this.cursorTrail;
    if (trail.length === 1) return Math.hypot(trail[0].x - point.x, trail[0].y - point.y) < radius;
    for (let index = 1; index < trail.length; index++) {
      const start = trail[index - 1], end = trail[index];
      const segmentX = end.x - start.x, segmentY = end.y - start.y;
      const lengthSquared = segmentX * segmentX + segmentY * segmentY || 1;
      const progress = clamp(((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / lengthSquared, 0, 1);
      const closestX = start.x + segmentX * progress, closestY = start.y + segmentY * progress;
      if (Math.hypot(point.x - closestX, point.y - closestY) < radius) return true;
    }
    return false;
  }

  private checkScare(): void {
    const scare = catConfig.scare;
    if (!this.isScareEnabled || !SCARABLE_BEHAVIORS.has(this.behavior) || this.reminder) return;
    if (this.elapsedSeconds - this.lastPettedTime < 3 || this.elapsedSeconds - this.lastScaredTime < scare.cooldownSeconds) return;
    if (this.recentCursorSpeed < scare.cursorSpeed) return;
    // 要是"冲过去"（轨迹比较直）才算；左右来回晃是在逗它玩，不是吓它
    if (this.cursorTrailStraightness < .7) return;
    const bodyCenter = { x: this.position.x, y: this.position.y - catPixels(50) };
    if (!this.didCursorSweepNear(bodyCenter, catPixels(scare.radius))) return;
    this.lastScaredTime = this.elapsedSeconds;
    // 跑开、从窗口上跳下来、原地吓一跳……由动作配置按位置和状态决定
    if (this.performAction('scare')) return;
    this.effects.float('❗', this.headPosition);
    this.effects.meow('scared');
    if (this.surface) this.jumpDown();
    else if (this.behavior === 'sleep' || this.roamMode === 'anchored') this.setBehavior('startled', .9);
    else this.startWander(this.cursor, RUN_SPEED, 'flee');
  }

  // =====================================================================
  // 作息
  // =====================================================================
  /** 午休：找个地方睡午觉 */
  takeNap(): void {
    if (this.reminder || this.behavior === 'lifted') return;
    this.goToSleep();
  }

  /** 午休结束：醒来伸个懒腰 */
  wakeFromNap(): void {
    if (this.behavior === 'sleep') this.setBehavior('stretch', 2.4);
  }

  /** 快下班了：兴奋地蹦一蹦，在屏幕上跑两圈 */
  getExcited(): void {
    if (this.reminder || this.peek || this.behavior === 'lifted') return;
    this.effects.burst('✨', 3);
    if (this.roamMode === 'free' && !this.isLowProfile && this.mischiefLevel !== 'off') {
      this.surface = null;
      this.zoomiesLeft = 2;
      this.nextZoomiesLeg();
    } else {
      this.setBehavior('happy', 2.5);
    }
  }

  // =====================================================================
  // 容错：卡住、位置算错时自动复位
  // =====================================================================
  private noteBehaviorChange(): void {
    // 不是执行器自己切的行为：说明别的事情（被摸、被拎、提醒……）接管了，当前动作作废
    if (!this.isRunnerChangingBehavior) this.actionRun = null;
    const now = this.elapsedSeconds;
    this.behaviorChangeTimes.push(now);
    while (this.behaviorChangeTimes.length && now - this.behaviorChangeTimes[0] > BEHAVIOR_CHURN_WINDOW_SECONDS) this.behaviorChangeTimes.shift();
  }

  private positionSamples: Point[] = [];
  private positionSampleTimer = 0;

  /** 每帧检查：位置是不是坏了（不是数字、跑到屏幕外很远）、是不是在原地来回抖、行为是不是切换得太频繁 */
  private checkHealth(deltaSeconds: number): void {
    const workArea = this.desktop.workArea;
    const isPositionValid = Number.isFinite(this.position.x) && Number.isFinite(this.position.y);
    const outsideMargin = 400;
    const isFarOutside = this.position.x < workArea.left - outsideMargin || this.position.x > workArea.right + outsideMargin ||
      this.position.y < workArea.top - outsideMargin || this.position.y > workArea.bottom + outsideMargin;
    if (!isPositionValid || (isFarOutside && this.behavior !== 'lifted')) { this.recover('位置异常'); return; }
    if (this.behaviorChangeTimes.length > MAX_BEHAVIOR_CHANGES_IN_WINDOW) { this.recover('行为切换太频繁'); return; }

    // 来回抖动：每 0.1 秒记一次位置，3 秒内来回掉头很多次、却几乎没走远 → 卡住了
    this.positionSampleTimer -= deltaSeconds;
    if (this.positionSampleTimer > 0) return;
    this.positionSampleTimer = .1;
    if (this.behavior === 'lifted' || this.behavior === 'follow') { this.positionSamples = []; return; }
    this.positionSamples.push({ ...this.position });
    if (this.positionSamples.length > 30) this.positionSamples.shift();
    if (this.positionSamples.length < 30) return;
    const countReversals = (axis: 'x' | 'y') => {
      let reversals = 0, previousDirection = 0;
      for (let index = 1; index < this.positionSamples.length; index++) {
        const step = this.positionSamples[index][axis] - this.positionSamples[index - 1][axis];
        if (Math.abs(step) < 1.5) continue;
        const direction = Math.sign(step);
        if (previousDirection && direction !== previousDirection) reversals++;
        previousDirection = direction;
      }
      return reversals;
    };
    const first = this.positionSamples[0], last = this.positionSamples[this.positionSamples.length - 1];
    const netDistance = Math.hypot(last.x - first.x, last.y - first.y);
    if (Math.max(countReversals('x'), countReversals('y')) >= 12 && netDistance < catPixels(120)) this.recover('来回抖动');
  }

  /** 复位：停下手里所有事，回到安全的地方坐一会儿（自动检测到卡住、程序出错、托盘点"让它回到原位"时调用） */
  recover(reason: string): void {
    console.warn(`煤球复位：${reason}`);
    this.peek = null;
    this.surface = null;
    this.jump = null;
    this.endReminder();
    this.zoomiesLeft = 0;
    this.followSecondsLeft = 0;
    this.landingCallback = null;
    this.isTeaserPounce = false;
    this.positionSamples = [];
    this.behaviorChangeTimes = [];
    const workArea = this.desktop.workArea;
    const safeX = Number.isFinite(this.position.x) ? clamp(this.position.x, workArea.left + 90, workArea.right - 90) : workArea.right * .85;
    const safeY = Number.isFinite(this.position.y) ? clamp(this.position.y, workArea.top + 150, workArea.bottom) : workArea.bottom;
    const cellIndex = this.roamMode !== 'edge' && this.freeSpaceMap.freeCellCount > 0 ? this.freeSpaceMap.nearestFreeCell(safeX, safeY) : -1;
    if (cellIndex >= 0) {
      this.position = this.freeSpaceMap.cellCenter(cellIndex);
      this.isOnEdge = false;
    } else {
      this.position = { x: safeX, y: this.edgeLineY };
      this.isOnEdge = true;
    }
    // 复位后 5 秒内不响应窗口变化，避免马上又被挤得来回跑
    this.layoutReactionPausedUntil = this.elapsedSeconds + 5;
    this.setBehavior('sit', 5);
  }

  liftUp(): void {
    this.noteInteraction();
    this.peek = null;
    this.surface = null;
    this.jump = null;
    this.isOnEdge = false;
    this.zoomiesLeft = 0;
    this.followSecondsLeft = 0;
    this.setBehavior('lifted');
    this.effects.sayLine('lifted-01', { meowKind: 'complain', fallbackText: '放本喵下来！' });
  }

  /** 放下：放到窗口顶边 → 站在窗口上；放到底边 → 沿边缘溜达；放到空地 → 自由散步；放到窗口里 → 就待在那儿 */
  dropAt(x: number, y: number): void {
    const workArea = this.desktop.workArea;
    this.position.x = clamp(x, workArea.left + 40, workArea.right - 40);
    this.position.y = clamp(y, workArea.top + 130, workArea.bottom);
    const windowTop = this.desktop.visibleWindows.find(window => this.isWindowTopUsable(window) &&
      Math.abs(this.position.y - window.rect.top) < 30 && this.position.x > window.rect.left + 30 && this.position.x < window.rect.right - 30);
    if (windowTop) {
      this.position.y = windowTop.rect.top;
      this.surface = { windowId: windowTop.id, lastAnchor: { x: windowTop.rect.left, y: windowTop.rect.top } };
      this.roamMode = 'free';
    } else if (this.position.y >= this.edgeLineY - 40) {
      this.position.y = this.edgeLineY;
      this.isOnEdge = true;
      this.roamMode = 'edge';
      this.effects.sayLine('drop-edge', { isImportant: true });
    } else if (this.freeSpaceMap.isPositionFree(this.position.x, this.position.y)) {
      this.roamMode = 'free';
    } else {
      this.roamMode = 'anchored';
      this.effects.sayLine('drop-anchored', { isImportant: true });
    }
    this.squashAmount = 1;
    this.setBehavior('landing', .5);
  }

  private afterLanding(): void {
    if (this.roamMode === 'anchored' || this.isOnEdge || this.surface) this.setBehavior('sit', 2);
    else if (this.freeSpaceMap.freeCellCount === 0) this.goEdge();
    else if (!this.freeSpaceMap.isPositionFree(this.position.x, this.position.y)) this.handleLayoutChange();
    else this.setBehavior('sit', 2);
  }

  // =====================================================================
  // 每帧更新
  // =====================================================================
  /** 定时行为结束后接下来做什么 */
  private handleBehaviorTimeout(): void {
    if (this.actionRun) {
      if (!this.advanceAction()) this.chooseNextBehavior(); // 动作做完了：想想接下来做什么
      return;
    }
    switch (this.behavior) {
      case 'landing': {
        const callback = this.landingCallback;
        this.landingCallback = null;
        if (callback) callback(); else this.afterLanding();
        break;
      }
      case 'jumpPrep':
        this.behavior = 'jumping';
        this.behaviorTimer = Infinity;
        this.effects.playSound('boing');
        break;
      case 'tailOut': this.peekSlipIn(); break;
      case 'turnHidden': this.peekPopOut(); break;
      case 'caught': this.peekDuck(false); break;
      case 'peeking':
        // 偷看够了：有时自己缩回去再探一次（躲猫猫），有时直接出来
        if (this.peek && this.peek.peekCount < 2 && Math.random() < .4) this.peekDuck(false);
        else this.exitPeek();
        break;
      case 'hiding':
        if (this.peek && this.peek.peekCount >= 3) this.exitPeek(() => { this.effects.sayLine('peek-give-up'); this.setBehavior('sit', 3); });
        // 鼠标还守在出口：再等一会儿，等你移开了再偷偷探出来
        else if (this.isCursorNearPeekExit()) this.behaviorTimer = 1;
        else this.peekPopOut();
        break;
      case 'pounceWiggle': {
        // 扭完屁股：扑过去（提醒时扑到鼠标旁边，捣乱时直接扑向鼠标）
        const arriveAfterPounce = this.pendingPounceArrive;
        this.pendingPounceArrive = null;
        const target = arriveAfterPounce
          ? { x: this.position.x + clamp(this.cursor.x - this.position.x, -70, 70), y: this.position.y }
          : { x: this.cursor.x, y: this.cursor.y + catPixels(40) };
        this.hopTo(target, () => {
          if (arriveAfterPounce) { arriveAfterPounce(); return; }
          if (this.isTeaserPounce) { this.finishTeaserPounce(); return; }
          this.setBehavior('swat', 1.2);
          this.effects.float('啪！', this.headPosition);
          this.effects.sayLine('mischief-caught-cursor');
        });
        break;
      }
      case 'pushingCup':
        if (this.reminder) { this.setBehavior('remindWaiting'); this.reminder.showBubble(); }
        else this.setBehavior('sit', 2);
        break;
      case 'startled':
      case 'dodge':
      case 'swat':
      case 'rolling':
        this.setBehavior('sit', 2);
        break;
      default: this.chooseNextBehavior();
    }
  }

  update(deltaSeconds: number): void {
    this.elapsedSeconds += deltaSeconds;
    this.behaviorElapsed += deltaSeconds;
    this.squashAmount = Math.max(0, this.squashAmount - deltaSeconds * 4);
    this.glanceSecondsLeft = Math.max(0, this.glanceSecondsLeft - deltaSeconds);
    if (this.behavior === 'lifted') return;

    if (this.behavior === 'jumping') {
      this.advanceJump(deltaSeconds);
    } else if (this.behavior === 'follow') {
      this.updateFollow(deltaSeconds);
    } else if (this.path.length) {
      this.advanceAlongPath(deltaSeconds);
    } else {
      this.currentSpeed = 0;
      this.behaviorTimer -= deltaSeconds;
      if (this.behaviorTimer <= 0) this.handleBehaviorTimeout();
    }

    this.updateBehaviorEvents();
    this.checkHealth(deltaSeconds);

    // 鼠标高速冲过来：偷看时缩回去，平时吓一跳跑开
    const head = this.headPosition;
    if (PEEK_OUT_BEHAVIORS.has(this.behavior) && this.behavior !== 'caught') {
      if (this.recentCursorSpeed > PEEK_DUCK_CURSOR_SPEED && this.didCursorSweepNear(head, 180)) this.peekDuck(true);
    } else {
      this.checkScare();
    }

    // 定期冒小特效
    this.effectTimer -= deltaSeconds;
    if (this.effectTimer <= 0) {
      this.effectTimer = .5;
      if (this.behavior === 'sleep') { this.effects.float('Z', head); this.effectTimer = 1.4; }
      else if (this.behavior === 'remindWaiting' && this.reminder?.style !== 'silentSign') { this.effects.float('喵～', head); this.effectTimer = 1.8; }
      else if (this.behavior === 'peeking') { this.effects.float(pickRandom(['👀', '？', '…']), head); this.effectTimer = randomBetween(2.5, 4); }
      else if (this.behavior === 'sulk' && this.moodLevel === 'angry') { this.effects.float('💢', head); this.effectTimer = randomBetween(2, 3.5); }
      else if (this.behavior === 'hugged') {
        // 抱着的时候一直冒小爱心、呼噜呼噜
        this.effects.float('❤', head);
        if (Math.random() < .35) this.effects.purr();
        this.effectTimer = randomBetween(1, 1.6);
      }
    }

    // 动作配置里的原地转圈（追尾巴）
    const spinSpeed = this.actionRun?.poseStep?.spin;
    if (spinSpeed && !this.path.length) {
      this.yaw += spinSpeed * deltaSeconds;
      this.targetYaw = this.yaw;
    }
    const turnRate = MOVING_BEHAVIORS.has(this.behavior) || this.behavior === 'jumpPrep' ? 7 : 3.5;
    this.yaw = dampAngle(this.yaw, this.targetYaw, turnRate, deltaSeconds);
  }

  /** 行为过程中按时间触发的事件（观察时说话、敲窗声、杯子掉下去） */
  private updateBehaviorEvents(): void {
    if (this.behavior === 'observe' && !this.hasReactedInObserve && this.behaviorElapsed > 1.2) {
      this.hasReactedInObserve = true;
      const window = this.surfaceWindow;
      if (window) this.effects.reactToWindow(window);
    }
    if (this.behavior === 'remindWaiting' && this.reminder?.style === 'knock' && this.knockCount < 3 && this.behaviorElapsed > this.knockCount * 1.2 + .4) {
      this.knockCount++;
      this.effects.playSound('knock');
      this.effects.float('咚咚', { x: this.headPosition.x + (this.targetYaw > 0 ? 40 : -40), y: this.headPosition.y + 30 });
    }
    if (this.behavior === 'pushingCup' && !this.hasCupCrashed && this.behaviorElapsed / PUSH_CUP_SECONDS > .62) {
      this.hasCupCrashed = true;
      this.effects.playSound('crash');
      this.effects.float('啪！', { x: this.position.x + 50, y: this.position.y + 20 });
      if (!this.reminder) this.effects.sayLine('mischief-cup-down');
    }
  }

  /** 跟屁虫：跟在鼠标后面一段距离 */
  private updateFollow(deltaSeconds: number): void {
    this.followSecondsLeft -= deltaSeconds;
    if (this.followSecondsLeft <= 0 || this.cursor.x < -1000) { this.setBehavior('sit', 2); return; }
    const target = { x: this.cursor.x - catPixels(90), y: this.cursor.y + catPixels(70) };
    const deltaX = target.x - this.position.x;
    const deltaY = target.y - this.position.y;
    const distance = Math.hypot(deltaX, deltaY);
    if (distance < 30) { this.currentSpeed = 0; return; }
    const speed = Math.min(RUN_SPEED, 40 + distance * 1.2);
    const step = Math.min(distance, speed * deltaSeconds);
    this.position.x += deltaX / distance * step;
    this.position.y += deltaY / distance * step;
    this.targetYaw = Math.atan2(deltaX, deltaY);
    this.currentSpeed = speed;
    this.walkPhase += step / catPixels(STRIDE_LENGTH) * Math.PI * 2;
  }

  private advanceAlongPath(deltaSeconds: number): void {
    const target = this.path[0];
    const deltaX = target.x - this.position.x;
    const deltaY = target.y - this.position.y;
    const distance = Math.hypot(deltaX, deltaY);
    let speedFactor = 1;
    if (!this.keepFacing) {
      if (distance > .5) this.targetYaw = Math.atan2(deltaX, deltaY);
      // 转身角度太大时先原地转身再走
      const facingError = Math.abs(Math.atan2(Math.sin(this.targetYaw - this.yaw), Math.cos(this.targetYaw - this.yaw)));
      if (facingError > 1.2) speedFactor = .25;
    }
    const step = this.moveSpeed * speedFactor * deltaSeconds;
    if (distance <= step) {
      this.position.x = target.x;
      this.position.y = target.y;
      this.path.shift();
      if (!this.path.length) {
        const callback = this.onArrive;
        this.onArrive = null;
        this.currentSpeed = 0;
        callback?.();
        return;
      }
    } else {
      this.position.x += deltaX / distance * step;
      this.position.y += deltaY / distance * step;
    }
    this.currentSpeed = step / deltaSeconds;
    this.walkPhase += step / catPixels(STRIDE_LENGTH) * Math.PI * 2;
  }

  // =====================================================================
  // 根据当前行为生成目标姿势
  // =====================================================================
  buildTargetPose(): CatPose {
    const pose = createDefaultPose();
    POSE_NAMES.forEach(name => { pose[name] = 0; });
    const behavior = this.behavior;
    const peekExit = this.peekGeometry?.exit;

    if (MOVING_BEHAVIORS.has(behavior)) {
      pose.stand = 1;
      pose.walkAmount = this.currentSpeed / WALK_SPEED;
      pose.tailLift = this.moodLevel === 'grumpy' || this.moodLevel === 'angry' ? .25 : .95;
      pose.tailSwing = .18;
      pose.tailSpeed = 4;
      if (this.walkStyle === 'run' || behavior === 'zoomies') { pose.tailLift = behavior === 'zoomies' ? 1.2 : .3; pose.earBack = .6; }
      if (this.walkStyle === 'sneak') {
        // 蹑手蹑脚：压低身子、尾巴放低、耳朵朝前、步子小
        pose.crouch = 1;
        pose.tailLift = .1;
        pose.tailSwing = .08;
        pose.earPerk = .7;
        pose.walkAmount = Math.min(pose.walkAmount * 1.3, 1);
      }
      if (behavior === 'duck') pose.walkAmount = 0; // 缩回去是"嗖"地滑回去
    } else if (behavior === 'jumpPrep' || behavior === 'pounceWiggle') {
      // 起跳前蹲下蓄力；扑之前还会扭屁股
      pose.stand = 1;
      pose.crouch = 1;
      pose.tailLift = .2;
      pose.earPerk = 1;
      pose.pupilWidth = 2.1;
      if (behavior === 'pounceWiggle') pose.wiggle = 1;
    } else if (behavior === 'jumping') {
      pose.stand = 1;
      pose.airborne = 1;
      pose.tailLift = 1.1;
      pose.earBack = .3;
    } else if (behavior === 'stand' || behavior === 'landing') {
      pose.stand = 1;
      pose.tailLift = .8;
    } else if (behavior === 'stretch') {
      pose.stretch = 1;
      pose.tailLift = 1.3;
      pose.eyeOpen = .25;
      pose.mouthOpen = .8;
    } else if (behavior === 'rest') {
      pose.lie = 1;
      pose.eyeOpen = .5;
      pose.tailLift = -.25;
      pose.tailWrap = .5;
    } else if (behavior === 'sleep') {
      pose.lie = 1;
      pose.eyeOpen = 0;
      pose.headPitch = .35;
      pose.tailLift = -.3;
      pose.tailWrap = 1;
      pose.tailSwing = .05;
      pose.breathRate = 1.3;
    } else if (behavior === 'rolling') {
      // 打滚：躺着翻一圈，眯着眼很享受
      pose.lie = 1;
      pose.rollAngle = Math.min(1, this.behaviorElapsed / ROLL_SECONDS) * Math.PI * 2;
      pose.squint = 1;
      pose.legKick = .35;
      pose.tailSwing = .6;
    } else if (behavior === 'lifted') {
      pose.lifted = 1;
      pose.legKick = 1;
      pose.earBack = .8;
      pose.eyeOpen = 1.15;
      pose.pupilWidth = 2.2;
      pose.tailLift = -1;
      pose.tailSwing = .5;
      pose.tailSpeed = 6;
    } else if (behavior === 'tailOut' || behavior === 'turnHidden' || behavior === 'hiding') {
      // 藏着：压低身子；藏头露尾时尾巴尖在外面得意地晃
      pose.stand = 1;
      pose.crouch = 1;
      pose.tailLift = behavior === 'tailOut' ? .55 : .1;
      pose.tailSwing = behavior === 'tailOut' ? .75 : .1;
      pose.tailSpeed = 5;
    } else if (behavior === 'peeking' || behavior === 'caught') {
      pose.stand = 1;
      pose.crouch = .6;
    } else {
      pose.sit = 1;
      pose.tailLift = -.15;
    }

    // 从上边沿探头：坐着，两只前爪扒在边沿上
    if (peekExit === 'up' && (PEEK_OUT_BEHAVIORS.has(behavior) || PEEK_HIDDEN_BEHAVIORS.has(behavior))) {
      POSE_NAMES.forEach(name => { pose[name] = 0; });
      pose.sit = 1;
      pose.pawsOnLedge = 1;
      pose.crouch = 0;
      pose.walkAmount = 0;
    }
    if (behavior === 'peeking' || behavior === 'peekOut') {
      pose.earPerk = 1;
      pose.headRoll = .2 + Math.sin(this.elapsedSeconds * 1.3) * .14;
      pose.pupilWidth = 1.5;
    }
    if (behavior === 'caught' || behavior === 'startled') {
      pose.eyeOpen = 1.25;
      pose.pupilWidth = 2.4;
      pose.earBack = behavior === 'startled' ? .9 : .3;
      pose.headRoll = 0;
    }
    if (behavior === 'observe') {
      // 坐在窗口顶上低头看里面在干嘛
      pose.headPitch = .38;
      pose.earPerk = .7;
      pose.headRoll = Math.sin(this.elapsedSeconds * .9) * .15;
      pose.tailLift = -.3;
      pose.tailSwing = .35;
    }
    if (behavior === 'groom') { pose.groom = 1; pose.squint = .6; }
    if (behavior === 'scratch') { pose.legKick = .8; pose.squint = .7; pose.headRoll = .3; }
    if (behavior === 'yawn') { pose.mouthOpen = 1; pose.squint = .9; pose.headPitch = -.25; pose.earBack = .3; }
    if (behavior === 'swat') { pose.knock = 1; pose.earPerk = 1; pose.pupilWidth = 2; }
    if (behavior === 'pushingCup') {
      pose.cupVisible = 1;
      pose.cupPush = Math.min(1, this.behaviorElapsed / PUSH_CUP_SECONDS);
      pose.knock = .6;
      pose.headPitch = -.15; // 一边推一边看着你
    }
    if (behavior === 'remindWaiting') {
      pose.earPerk = 1;
      pose.headPitch = -.2;
      pose.pupilWidth = 1.8;
      const isSilent = this.reminder?.style === 'silentSign';
      pose.mouthOpen = !isSilent && Math.max(0, Math.sin(this.elapsedSeconds * 3.5)) > .6 ? 1 : 0;
      pose.headRoll = Math.sin(this.elapsedSeconds * 1.7) * .18;
      pose.tailLift = .9;
      pose.tailSwing = .45;
      pose.tailSpeed = 3;
      const style = this.reminder?.style;
      if (style === 'sign' || style === 'silentSign') { pose.holdSign = 1; pose.pawsOnLedge = .7; }
      if (style === 'knock') pose.knock = 1;
      // 提醒升级：口渴耳朵耷拉；生气飞机耳、尾巴猛甩
      const level = this.reminder?.escalationLevel ?? 0;
      if (level === 1) { pose.earBack = .4; pose.earPerk = 0; pose.tailLift = .2; }
      if (level >= 2 || style === 'sitOnWindow' || style === 'pushCup') { pose.earBack = .9; pose.earPerk = 0; pose.pupilWidth = .7; pose.tailSwing = .8; pose.tailSpeed = 8; }
    }
    if (behavior === 'happy') { pose.squint = 1; pose.tailLift = 1.4; pose.bounce = 1; pose.headRoll = .2; }
    if (behavior === 'petted') { pose.squint = .9; pose.tailLift = 1.2; pose.headRoll = .28; pose.earBack = .25; }
    if (behavior === 'hugged') {
      // 被抱着：眯眼、脸红、耳朵放松，脑袋慢慢蹭来蹭去，呼吸变慢，尾巴卷起来
      pose.squint = 1;
      pose.earBack = .3;
      pose.headRoll = .25 + Math.sin(this.elapsedSeconds * 1.6) * .15;
      pose.headPitch = -.1;
      pose.tailWrap = .7;
      pose.tailSwing = .12;
      pose.tailSpeed = 1.5;
      pose.breathRate = 1.4;
    }
    if (behavior === 'sulk' || behavior === 'dodge') {
      pose.tailSwing = this.moodLevel === 'angry' ? .9 : .7;
      pose.tailSpeed = this.moodLevel === 'angry' ? 9 : 7;
      pose.earBack = this.moodLevel === 'angry' ? .9 : .5;
      pose.tailLift = .1;
    }
    // 平时的心情也写在脸上：闹别扭耳朵往后、发脾气瞳孔变细
    if (CALM_BEHAVIORS.has(behavior) && behavior !== 'yawn') {
      if (this.moodLevel === 'grumpy') pose.earBack = Math.max(pose.earBack, .3);
      if (this.moodLevel === 'angry') { pose.earBack = Math.max(pose.earBack, .6); pose.pupilWidth = .7; }
      if (this.moodLevel === 'happy' && behavior !== 'rest') pose.tailLift = Math.max(pose.tailLift, .6);
    }

    // 看向目标：你切换窗口时看一眼新窗口；鼠标在附近时转头看你
    const head = this.headPosition;
    const lookTarget = this.glanceSecondsLeft > 0 && this.glanceTarget ? this.glanceTarget : this.cursor;
    const deltaX = lookTarget.x - head.x;
    const deltaY = lookTarget.y - head.y;
    const distanceToTarget = Math.hypot(deltaX, deltaY);
    const lookRange = this.glanceSecondsLeft > 0 ? 3000 : PEEK_OUT_BEHAVIORS.has(behavior) || behavior === 'remindWaiting' ? 900 : 320;
    if (!NO_LOOK_BEHAVIORS.has(behavior) && distanceToTarget < lookRange) {
      const worldYaw = Math.atan2(deltaX, Math.max(deltaY, 30) + 120); // 目标在屏幕上方时也偏向镜头
      const relativeYaw = Math.atan2(Math.sin(worldYaw - this.yaw), Math.cos(worldYaw - this.yaw));
      pose.headYaw = clamp(relativeYaw, -1.1, 1.1);
      pose.headPitch += clamp(deltaY / 260, -.5, .4);
      pose.pupilX = clamp(relativeYaw * .8, -1, 1);
      pose.pupilY = clamp(-deltaY / 200, -1, 1);
      if (distanceToTarget < 120 && CALM_BEHAVIORS.has(behavior)) pose.earPerk = 1;
    }

    // 动作配置里对这个姿势的微调（tweak）和来回摆动（animate），放在最后，优先级最高
    const poseStep = this.actionRun?.poseStep;
    if (poseStep) {
      const poseValues = pose as Record<string, number>;
      for (const [key, value] of Object.entries(poseStep.tweak ?? {})) {
        if (key in poseValues && Number.isFinite(value)) poseValues[key] = value as number;
      }
      for (const [key, wave] of Object.entries(poseStep.animate ?? {})) {
        if (key in poseValues && wave) poseValues[key] += wave.amplitude * Math.sin(this.behaviorElapsed * wave.speed);
      }
    }
    return pose;
  }
}
