// 猫的"大脑"：决定去哪儿、做什么、什么姿势
// 包含：日常行为、巡视（跳上窗口顶）、偷看、多种提醒方式、心情影响、小捣乱、逗猫棒、抱抱、作息、卡住后复位。
// 各种行为的概率都在 cat-config.json 的 behavior / teaser / routine 里配置
import {
  CALM_IDLE_MULTIPLIER, LIVELY_IDLE_MULTIPLIER, PEEK_DUCK_CURSOR_SPEED, RUN_SPEED, SNEAK_SPEED,
  STRIDE_LENGTH, WALK_SPEED, catPixels,
} from './constants';
import { catConfig, pickWeighted, type IdleAction, type RoutinePhase } from './catConfig';
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
  // 日常行为
  // =====================================================================
  chooseNextBehavior(): void {
    if (this.roamMode === 'anchored') { this.idleInPlace(); return; }
    if (this.surface) { this.chooseOnWindowBehavior(); return; }
    // 自由模式下蹲在边缘时，一旦桌面有了空地就回去
    if (this.roamMode === 'free' && this.isOnEdge && this.freeSpaceMap.freeCellCount > 0) { this.leaveEdge(); return; }

    const behaviorConfig = catConfig.behavior;
    if (Math.random() < this.mischiefChance() && this.tryStartMischief()) return;
    // 活跃度 × 作息（午休没精神、快下班很兴奋……）
    const routineFactor = catConfig.routine.phaseActivityFactor[this.routinePhase] ?? 1;
    const activityFactor = (behaviorConfig.activityFactor[this.activityLevel] ?? 1) * routineFactor;
    // 全屏 / 边缘模式时更低调：更多时间躲起来只露出脑袋
    const peekChances = behaviorConfig.peekChance;
    const peekChance = (this.desktop.hasFullscreenWindow ? peekChances.fullscreen : this.isOnEdge ? peekChances.onEdge : peekChances.normal) * activityFactor;
    if (Math.random() < peekChance && this.tryStartPeek()) return;
    // 巡视：跳到窗口顶上看看你在干嘛
    const patrolChance = this.roamMode === 'free' && !this.isLowProfile ? behaviorConfig.patrolChance * activityFactor : 0;
    if (Math.random() < patrolChance && this.tryJumpOntoWindow()) return;

    const wanderChance = ((behaviorConfig.wanderChance[this.activityLevel] ?? .5) + (behaviorConfig.wanderMoodBonus[this.moodLevel] ?? 0)) * routineFactor;
    if (Math.random() < wanderChance) this.startWander();
    else this.idleInPlace();
  }

  idleInPlace(): void {
    const behaviorConfig = catConfig.behavior;
    // 心情不好：经常背对着你生闷气
    if (Math.random() < (behaviorConfig.sulkChance[this.moodLevel] ?? 0)) { this.setBehavior('sulk', this.idleDuration(4, 8)); return; }
    // 心情好：偶尔打个滚
    if (this.moodLevel === 'happy' && Math.random() < behaviorConfig.happyRollChance) { this.startRoll(); return; }
    // 发呆的小动作：基础权重 × 当前作息阶段的倍数（早上爱打哈欠、快下班会开心地蹦）
    const multipliers = catConfig.routine.phaseIdleMultipliers[this.routinePhase] ?? {};
    const weights: Partial<Record<IdleAction, number>> = {};
    for (const [action, weight] of Object.entries(behaviorConfig.idleWeights) as [IdleAction, number][]) {
      weights[action] = weight * (multipliers[action] ?? 1);
    }
    switch (pickWeighted(weights) ?? 'sit') {
      case 'sit': this.setBehavior('sit', this.idleDuration(3, 6)); break;
      case 'stand': this.setBehavior('stand', this.idleDuration(2, 4)); break;
      case 'groom': this.setBehavior('groom', this.idleDuration(3, 5)); break;
      case 'scratch': this.setBehavior('scratch', 1.6); break;
      case 'yawn': this.setBehavior('yawn', 1.8); break;
      case 'stretch': this.setBehavior('stretch', 2.4); break;
      case 'rest': this.setBehavior('rest', this.idleDuration(5, 9)); break;
      case 'happy': this.setBehavior('happy', 1.6); this.effects.float(pickRandom(['♪', '✨', '♡']), this.headPosition); break;
    }
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
      window.rect.right - window.rect.left >= MIN_WINDOW_WIDTH_FOR_STANDING;
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

  private chooseOnWindowBehavior(): void {
    const window = this.surfaceWindow;
    if (!window || !this.isWindowTopUsable(window)) { this.jumpDown(); return; }
    if (Math.random() < this.mischiefChance() && this.tryStartMischief()) return;
    switch (pickWeighted(catConfig.behavior.onWindowWeights) ?? 'idle') {
      case 'walk': {
        // 沿着窗口顶边溜达
        const targetX = randomBetween(window.rect.left + 60, window.rect.right - 60);
        this.moveAlong([{ x: targetX, y: window.rect.top }], WALK_SPEED * randomBetween(.8, 1.2), 'wander', () => this.setBehavior('sit', this.idleDuration(2, 4)));
        break;
      }
      case 'observe': this.startObserve(); break;
      case 'hopToOther': if (!this.tryJumpOntoWindow(undefined, undefined, window.id)) this.jumpDown(); break;
      case 'idle': this.idleInPlace(); break;
      case 'jumpDown': this.jumpDown(); break;
    }
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
  private mischiefChance(): number {
    if (this.isLowProfile || this.mischiefLevel === 'off' || this.roamMode !== 'free' || this.reminder) return 0;
    if (this.routinePhase === 'lunch') return 0; // 午休不捣乱
    const behaviorConfig = catConfig.behavior;
    const base = this.mischiefLevel === 'often' ? behaviorConfig.mischiefChance.often : behaviorConfig.mischiefChance.sometimes;
    return base * (behaviorConfig.mischiefMoodFactor[this.moodLevel] ?? 1);
  }

  tryStartMischief(requestedKind?: MischiefKind): boolean {
    const kind = requestedKind ?? (pickWeighted(catConfig.behavior.mischiefKinds) as MischiefKind | null);
    switch (kind) {
      case null:
        return false;
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

  /** 提醒没人理：坐着委屈一会儿 */
  reminderIgnored(): void {
    this.endReminder();
    if (this.behavior === 'remindWaiting') this.setBehavior('sulk', 4);
  }

  /** 定时提醒点了"做完啦"：开心一下 */
  customReminderDone(): void {
    this.endReminder();
    this.setBehavior('happy', 2.4);
    this.effects.burst('✅', 2);
    this.effects.sayLine('custom-done', { isImportant: true });
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
    this.setBehavior('stretch', 2.4);
    this.effects.sayLine('welcome-back-01', { isImportant: true });
  }

  /** 喝了一杯：心情好就打个滚，否则开心地跳一跳 */
  drinkRecorded(isGoalReached: boolean): void {
    this.endReminder();
    if (this.peek) { this.effects.burst('💧', 2); return; }
    if (isGoalReached || this.moodLevel === 'happy') {
      this.startRoll();
      this.effects.burst(isGoalReached ? '🎉' : '💧', 3);
    } else {
      this.setBehavior('happy', 2.8);
      this.effects.burst('💧', 3);
    }
  }

  snooze(): void {
    this.endReminder();
    this.setBehavior('sulk', 2.8);
    this.effects.sayLine('snooze', { isImportant: true });
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
    if (Math.random() < (catConfig.behavior.dodgePetChance[this.moodLevel] ?? 0)) {
      // 发脾气：扭头躲开，往旁边跳一小步
      this.effects.sayLine('mood-dodge', { isImportant: true, fallbackText: '哼！现在不想理你' });
      const side = Math.random() < .5 ? -1 : 1;
      this.hopTo({ x: this.position.x + side * 90, y: this.position.y }, () => this.setBehavior('dodge', 2.5), this.surface);
      return;
    }
    this.setBehavior('petted', 2.4);
    this.effects.burst('❤', 2);
    this.effects.purr(); // 被摸只呼噜，不说话
    this.effects.say(pickRandom(['喵呜～再摸一下 🥰', '呼噜呼噜…', '就摸一下下哦～']));
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
    if (this.moodLevel === 'angry' && Math.random() < .6) return false; // 发脾气时懒得理你
    // 隔了很久才再逗它：重新计"连续扑了几次"
    if (this.elapsedSeconds - this.lastTeaserPounceTime > 15) this.teaserPouncesInRow = 0;
    this.lastTeaserPounceTime = this.elapsedSeconds;
    this.teaserPouncesInRow++;
    this.zoomiesLeft = 0;
    this.followSecondsLeft = 0;
    this.isTeaserPounce = true;
    this.setBehavior('pounceWiggle', .55);
    this.targetYaw = Math.atan2(this.cursor.x - this.position.x, this.cursor.y - this.position.y);
    return true;
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
    if (Math.random() < (catConfig.behavior.dodgePetChance[this.moodLevel] ?? 0)) {
      this.effects.sayLine('mood-dodge', { isImportant: true, fallbackText: '哼！现在不想理你' });
      this.setBehavior('dodge', 2.5);
      return false;
    }
    this.zoomiesLeft = 0;
    this.followSecondsLeft = 0;
    this.setBehavior('hugged', 30); // 最多抱 30 秒（万一没收到松开的消息，也不会一直卡在抱抱里）
    this.targetYaw = 0;
    this.lastPettedTime = this.elapsedSeconds;
    this.effects.purr();
    this.effects.burst('❤', 3);
    this.effects.sayLine('hug-start', { fallbackText: '呼噜呼噜…抱抱好舒服' });
    return true;
  }

  /** 松开了：开心地打个滚或蹦一下 */
  endHug(): void {
    if (this.behavior !== 'hugged') return;
    this.lastPettedTime = this.elapsedSeconds;
    this.effects.sayLine('hug-end', { fallbackText: '还要抱抱～' });
    if (Math.random() < .5) this.startRoll(); else this.setBehavior('happy', 2);
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
    const scare = catConfig.behavior.scare;
    if (!this.isScareEnabled || !SCARABLE_BEHAVIORS.has(this.behavior) || this.reminder) return;
    if (this.elapsedSeconds - this.lastPettedTime < 3 || this.elapsedSeconds - this.lastScaredTime < scare.cooldownSeconds) return;
    if (this.recentCursorSpeed < scare.cursorSpeed) return;
    // 要是"冲过去"（轨迹比较直）才算；左右来回晃是在逗它玩，不是吓它
    if (this.cursorTrailStraightness < .7) return;
    const bodyCenter = { x: this.position.x, y: this.position.y - catPixels(50) };
    if (!this.didCursorSweepNear(bodyCenter, catPixels(scare.radius))) return;
    this.lastScaredTime = this.elapsedSeconds;
    this.effects.float('❗', this.headPosition);
    this.effects.meow('scared');
    this.effects.sayLine('scared', { fallbackText: '哇！吓死本喵了！' });
    if (this.surface) { this.jumpDown(); return; }                         // 在窗口上：吓得跳下去
    if (this.behavior === 'sleep' || this.roamMode === 'anchored') { this.setBehavior('startled', .9); return; }
    this.startWander(this.cursor, RUN_SPEED, 'flee');                        // 往反方向跑开
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
    return pose;
  }
}
