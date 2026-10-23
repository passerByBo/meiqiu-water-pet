// 猫咪窗口的总控制器：把 Rust 推送的桌面布局 / 鼠标 / 打字状态、猫的大脑、3D 渲染、声音、提醒、心情串起来
import { reactive } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  ACTIVE_FPS, CAT_CANVAS_LEFT, CAT_CANVAS_SIZE, CAT_CANVAS_TOP, catDisplay, catPixels, DRAG_GROUND_OFFSET, PET_WINDOW_HEIGHT,
  PET_WINDOW_WIDTH, REMINDER_BUBBLE_TIMEOUT_MS, SLEEP_FPS,
} from './constants';
import { CatBrain, type CatEffects, type MischiefKind, type ReminderStyle } from './CatBrain';
import { catVoice, type MeowKind } from './catVoice';
import { DesktopLayout, type LocalWindow } from './DesktopLayout';
import { FreeSpaceMap } from './FreeSpaceMap';
import { PeekPlanner } from './PeekPlanner';
import { PetScene } from './petScene';
import { showSkillMenu, type CatSkill, type SkillMenuEntry } from './skills';
import { isBusyCategory, isQuietCategory, isWatchingCategory, type ActivityCategory } from './appClassifier';
import { catConfig, lineKindOf, loadCatConfig } from './catConfig';
import { chooseDialogueGroup, type DialogueContext } from './dialogueSelector';
import {
  backendApi, type AppSettings, type CursorPayload, type CustomReminderFiredPayload, type DesktopLayoutPayload, type MoodLevel,
  type ReminderFiredPayload, type RoamMode,
} from '../shared/backendApi';
import type { Point } from '../shared/geometry';
import { clamp, damp, pickRandom, pointInRectangle, randomBetween } from '../shared/geometry';

/** 界面状态（对话气泡），由 PetView.vue 渲染 */
export const petUiState = reactive({
  bubbleText: '',
  isBubbleVisible: false,
  showReminderActions: false,
  /** 当前气泡对应的定时提醒 id；为 null 时是喝水提醒 */
  activeCustomReminderId: null as string | null,
  /** 气泡尖角指向的位置（窗口内坐标，猫头顶） */
  bubbleAnchorX: PET_WINDOW_WIDTH / 2,
  bubbleAnchorY: CAT_CANVAS_TOP,
});

/** 提醒升级等级 → 牌子上的字 */
const SIGN_TEXTS = ['喝水！', '渴了…', '快喝！'];
/** 打字停下来多久之后再提醒 */
const TYPING_PAUSE_BEFORE_REMIND_MS = 2500;
/** 最多为了等你打完字推迟多久 */
const MAX_TYPING_WAIT_MS = 3 * 60_000;
/** 屏幕适配的基准：有效高度（逻辑像素）为这么多时，猫按设置的大小显示；屏幕"更小"（缩放比大）时等比缩小 */
const REFERENCE_SCREEN_HEIGHT = 1040;
/** 一直用同一个软件多久，提醒你休息一下 */
const LONG_FOCUS_MS = 60 * 60_000;

interface PetElements {
  canvas: HTMLCanvasElement;
  effectsLayer: HTMLElement;
  bubble: HTMLElement;
}

interface PressState {
  start: Point;
  isDragging: boolean;
}

export class PetController {
  private readonly desktop = new DesktopLayout();
  private readonly freeSpaceMap = new FreeSpaceMap();
  private readonly peekPlanner = new PeekPlanner(this.desktop, this.freeSpaceMap);
  private readonly scene: PetScene;
  private readonly brain: CatBrain;
  /** 脚底中心在猫咪窗口里的位置 */
  private readonly groundPointInWindow: Point;

  private settings: AppSettings | null = null;
  private moodLevel: MoodLevel = 'normal';
  /** 猫咪窗口左上角在当前显示器上的逻辑坐标 */
  private windowOrigin: Point = { x: 0, y: 0 };
  private lastSentPhysicalPosition = { x: Number.NaN, y: Number.NaN };
  private isClickThrough = true;
  private pressState: PressState | null = null;
  private lastClickTime = 0;
  private singleClickTimer: number | undefined;
  private bubbleHideTimer: number | undefined;
  private reminderTimeoutTimer: number | undefined;
  private lastCursorTime = performance.now();
  private lastFrameTime = performance.now();
  private lastRenderTime = 0;

  // ---- 你在做什么 ----
  private isTyping = false;
  private lastTypingTime = 0;
  private foregroundWindowId: string | null = null;
  private foregroundSince = performance.now();
  private hasNotifiedLongFocus = false;
  private readonly lastReactionByCategory = new Map<ActivityCategory, number>();
  /** 上一句闲聊 / 互动回应的时间（按"话多程度"控制说话频率） */
  private lastAmbientSpeechTime = -Infinity;
  private lastInteractionSpeechTime = -Infinity;
  /** 当前这次喝水提醒是什么时候弹出来的（用来判断你喝得快不快） */
  private waterReminderShownAt: number | null = null;
  /** 设置里的猫咪大小（不含屏幕适配） */
  private userCatScale = catDisplay.scale;
  /** 等你打完字再开始的提醒 */
  private pendingReminderStart: (() => void) | null = null;
  private pendingReminderSince = 0;

  constructor(private readonly elements: PetElements) {
    this.scene = new PetScene(elements.canvas);
    this.groundPointInWindow = {
      x: CAT_CANVAS_LEFT + this.scene.groundPointOnCanvas.x,
      y: CAT_CANVAS_TOP + this.scene.groundPointOnCanvas.y,
    };
    this.brain = new CatBrain(this.freeSpaceMap, this.desktop, this.peekPlanner, this.effects);
  }

  async start(): Promise<void> {
    await Promise.all([catVoice.loadManifest(), loadCatConfig()]);
    this.applySettings(await backendApi.getSettings());
    this.applyMood((await backendApi.getCatMood()).level, false);
    this.applyDesktopLayout(await backendApi.getDesktopLayout());
    this.placeCatAtStart();

    this.bindBackendEvents();
    this.bindPointerEvents();
    this.renderFrame(0);
    await getCurrentWindow().show();
    requestAnimationFrame(this.loop);
    window.setInterval(() => this.checkSlowConditions(), 500);
    window.setTimeout(() => void this.sayGreeting(), 1500);
  }

  // ---------------- 设置与心情 ----------------
  private applySettings(settings: AppSettings): void {
    this.settings = settings;
    catVoice.isEnabled = settings.voiceEnabled;
    catVoice.mode = settings.voiceMode;
    catVoice.volume = settings.voiceVolume / 100;
    if (!settings.voiceEnabled) catVoice.stopAll();
    this.brain.activityLevel = settings.activityLevel;
    this.brain.isScareEnabled = settings.scareEnabled;
    this.brain.mischiefLevel = settings.mischiefLevel;
    this.userCatScale = settings.catSizePercent / 100;
    this.applyCatSize();
  }

  /**
   * 猫咪大小 = 设置的大小 × 屏幕适配系数。
   * 屏幕缩放比很大时（例如 1920×1080 开 150%，程序看到的只有 1280×720），猫会占掉很大一块屏幕，
   * 所以按屏幕的有效高度等比缩小，让猫在不同缩放比下占屏幕的比例差不多
   */
  private applyCatSize(): void {
    const screenHeight = this.desktop.currentMonitor ? this.desktop.screenRect.bottom - this.desktop.screenRect.top : REFERENCE_SCREEN_HEIGHT;
    const screenFitFactor = Math.min(1, Math.max(.5, screenHeight / REFERENCE_SCREEN_HEIGHT));
    const scale = Math.round(this.userCatScale * screenFitFactor * 100) / 100;
    if (scale === catDisplay.scale && this.elements.canvas.style.transform) return;
    catDisplay.scale = scale;
    const canvasStyle = this.elements.canvas.style;
    canvasStyle.transformOrigin = `${this.scene.groundPointOnCanvas.x}px ${this.scene.groundPointOnCanvas.y}px`;
    canvasStyle.transform = `scale(${scale})`;
    if (this.desktop.currentMonitor) {
      this.freeSpaceMap.rebuild(this.desktop.workArea, this.desktop.getObstacles().map(obstacle => obstacle.rect));
      this.brain.handleLayoutChange();
    }
  }

  /** 心情变化：变成发脾气 / 开心的那一刻说一句 */
  private applyMood(level: MoodLevel, shouldAnnounce = true): void {
    const previousLevel = this.moodLevel;
    this.moodLevel = level;
    this.brain.moodLevel = level;
    if (!shouldAnnounce || level === previousLevel) return;
    if (level === 'angry') this.effects.sayLine('mood-angry', { isImportant: true, fallbackText: '哼！本喵生气了！' });
    else if (level === 'grumpy' && previousLevel !== 'angry') this.effects.sayLine('mood-grumpy', { fallbackText: '喵…有点不开心' });
    else if (level === 'happy') this.effects.sayLine('mood-happy', { fallbackText: '本喵今天心情超好～' });
  }

  // ---------------- 桌面布局 ----------------
  private applyDesktopLayout(payload: DesktopLayoutPayload): void {
    const isMonitorStillPresent = this.desktop.update(payload);
    this.applyCatSize(); // 换了显示器或改了缩放比：重新适配猫咪大小
    this.freeSpaceMap.rebuild(this.desktop.workArea, this.desktop.getObstacles().map(obstacle => obstacle.rect));
    this.updateForegroundActivity();
    if (!isMonitorStillPresent) {
      // 猫所在的显示器被拔掉了：回到主屏底边
      this.brain.peek = null;
      this.brain.surface = null;
      this.brain.position = { x: this.desktop.workArea.right * .8, y: this.desktop.workArea.bottom };
      this.brain.isOnEdge = true;
      this.brain.setBehavior('sit', 2);
      return;
    }
    this.brain.handleLayoutChange();
  }

  /** 你切换了窗口：猫转头看一眼；开会 / 全屏时保持低调 */
  private updateForegroundActivity(): void {
    const foreground = this.desktop.foregroundWindow;
    const category = foreground?.category ?? 'other';
    const isMeeting = isQuietCategory(category);
    catVoice.isQuietMode = isMeeting;
    this.brain.isLowProfile = isMeeting || this.desktop.hasFullscreenWindow;
    const foregroundId = foreground?.id ?? null;
    if (foregroundId === this.foregroundWindowId) return;
    this.foregroundWindowId = foregroundId;
    this.foregroundSince = performance.now();
    this.hasNotifiedLongFocus = false;
    if (foreground && this.brain.isReady) {
      this.brain.glanceAt({ x: (foreground.rect.left + foreground.rect.right) / 2, y: foreground.rect.top + 60 });
    }
  }

  private placeCatAtStart(): void {
    const workArea = this.desktop.workArea;
    const startCell = this.freeSpaceMap.nearestFreeCell(workArea.right * .85, workArea.bottom * .85);
    if (startCell >= 0 && this.settings?.defaultRoamMode !== 'edge') {
      this.brain.position = this.freeSpaceMap.cellCenter(startCell);
    } else {
      this.brain.position = { x: workArea.right * .85, y: workArea.bottom };
      this.brain.isOnEdge = true;
    }
    this.brain.roamMode = this.settings?.defaultRoamMode ?? 'free';
    this.brain.setBehavior('sit', 2);
    this.brain.isReady = true;
  }

  // ---------------- 后端事件 ----------------
  private bindBackendEvents(): void {
    void backendApi.onDesktopLayoutChanged(payload => this.applyDesktopLayout(payload));
    void backendApi.onCursorMoved(cursor => this.handleCursor(cursor));
    void backendApi.onTypingChanged(isTyping => {
      this.isTyping = isTyping;
      this.lastTypingTime = performance.now();
    });
    void backendApi.onReminderFired(payload => this.handleWaterReminder(payload));
    void backendApi.onCustomReminderFired(payload => this.startCustomReminder(payload));
    void backendApi.onUserAway(() => this.brain.goToSleep());
    void backendApi.onUserBack(() => this.brain.wakeUp());
    void backendApi.onSettingsChanged(settings => this.applySettings(settings));
    void backendApi.onCatMoodChanged(mood => this.applyMood(mood.level));
    void backendApi.onTrayAction(action => {
      if (action === 'record-drink') void this.recordDrink('tray');
    });
  }

  /** 每半秒检查一次：等打字停下的提醒、同一个软件用了太久 */
  private checkSlowConditions(): void {
    const now = performance.now();
    if (this.pendingReminderStart) {
      const hasPaused = !this.isTyping && now - this.lastTypingTime > TYPING_PAUSE_BEFORE_REMIND_MS;
      if (hasPaused || now - this.pendingReminderSince > MAX_TYPING_WAIT_MS) {
        const start = this.pendingReminderStart;
        this.pendingReminderStart = null;
        start();
      }
    }
    const foreground = this.desktop.foregroundWindow;
    if (foreground && foreground.category !== 'other' && !this.hasNotifiedLongFocus && now - this.foregroundSince > LONG_FOCUS_MS &&
        !this.brain.isReminding && !this.brain.isSleeping) {
      this.hasNotifiedLongFocus = true;
      this.effects.sayLine('focus-long', { isImportant: true, fallbackText: '你已经盯着屏幕一个小时啦，站起来走走吧' });
    }
  }

  // ---------------- 鼠标（Rust 推送的全局位置） ----------------
  private handleCursor(cursor: CursorPayload): void {
    const local = this.desktop.toLocal(cursor.x, cursor.y);
    const now = performance.now();
    const elapsedSeconds = Math.max(1, now - this.lastCursorTime) / 1000;
    const brainCursor = this.brain.cursor;
    const instantSpeed = Math.hypot(local.x - brainCursor.x, local.y - brainCursor.y) / elapsedSeconds;
    brainCursor.speed = brainCursor.x < -1000 ? 0 : damp(brainCursor.speed, instantSpeed, 12, elapsedSeconds);
    brainCursor.x = local.x;
    brainCursor.y = local.y;
    this.lastCursorTime = now;

    if (this.pressState) {
      if (!this.pressState.isDragging && Math.hypot(local.x - this.pressState.start.x, local.y - this.pressState.start.y) > 6) {
        this.pressState.isDragging = true;
        this.brain.liftUp();
        void backendApi.recordInteraction('lift');
      }
      if (this.pressState.isDragging) {
        this.brain.position = { x: local.x, y: local.y + catPixels(DRAG_GROUND_OFFSET) };
        if (!cursor.isLeftButtonDown) void this.finishDrag(cursor);
        return;
      }
      // 网页没收到松开事件时（例如鼠标移出窗口），以这里为准
      if (!cursor.isLeftButtonDown) this.pressState = null;
    }

    const isOverCat = this.isPointOnCat(local);
    this.setClickThrough(!(isOverCat || this.isPointOnBubble(local)));
    this.brain.setCursorOverCat(isOverCat); // 偷看时鼠标移到它头上：抓包！
  }

  /** 拖拽结束：如果放到了另一块显示器上，猫就搬过去 */
  private async finishDrag(cursor: CursorPayload): Promise<void> {
    this.pressState = null;
    const targetMonitor = this.desktop.monitorAtPhysicalPoint(cursor.x, cursor.y);
    if (targetMonitor && this.desktop.switchMonitor(targetMonitor.id)) {
      const layout = await backendApi.getDesktopLayout();
      this.desktop.update(layout);
      this.applyCatSize();
      this.freeSpaceMap.rebuild(this.desktop.workArea, this.desktop.getObstacles().map(obstacle => obstacle.rect));
    }
    const local = this.desktop.toLocal(cursor.x, cursor.y);
    this.brain.dropAt(local.x, local.y + catPixels(DRAG_GROUND_OFFSET));
  }

  private setClickThrough(enabled: boolean): void {
    if (enabled === this.isClickThrough || this.pressState) return;
    this.isClickThrough = enabled;
    void backendApi.setClickThrough(enabled);
  }

  /** 当前显示器上的逻辑坐标是否点在猫身上（被藏身窗口挡住的部分不算） */
  private isPointOnCat(local: Point): boolean {
    const clipRect = this.brain.clipRect;
    if (clipRect && pointInRectangle(local.x, local.y, clipRect)) return false;
    const canvasPoint = this.toCanvasPoint(local);
    return this.scene.hitTest(canvasPoint.x, canvasPoint.y);
  }

  /** 当前显示器上的逻辑坐标 → 缩放前的 3D 画布坐标（画布以脚底为中心按猫咪大小缩放） */
  private toCanvasPoint(local: Point): Point {
    const ground = this.scene.groundPointOnCanvas;
    return {
      x: ground.x + (local.x - this.brain.position.x) / catDisplay.scale,
      y: ground.y + (local.y - this.brain.position.y) / catDisplay.scale,
    };
  }

  private isPointOnBubble(local: Point): boolean {
    if (!petUiState.isBubbleVisible) return false;
    const bubbleRect = this.elements.bubble.getBoundingClientRect();
    return pointInRectangle(local.x - this.windowOrigin.x, local.y - this.windowOrigin.y, bubbleRect);
  }

  // ---------------- 网页里的鼠标事件（只有关闭点击穿透时才会收到） ----------------
  private bindPointerEvents(): void {
    const toLocal = (event: MouseEvent): Point => ({ x: this.windowOrigin.x + event.clientX, y: this.windowOrigin.y + event.clientY });

    window.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !this.isPointOnCat(toLocal(event))) return;
      event.preventDefault();
      this.pressState = { start: toLocal(event), isDragging: false };
    });

    window.addEventListener('pointerup', event => {
      if (event.button !== 0 || !this.pressState || this.pressState.isDragging) return;
      this.pressState = null;
      // 300 毫秒内第二次点击算双击：记一杯；否则算单击：摸摸
      const now = performance.now();
      if (now - this.lastClickTime < 300) {
        window.clearTimeout(this.singleClickTimer);
        this.lastClickTime = 0;
        void this.recordDrink('doubleClick');
      } else {
        this.lastClickTime = now;
        this.singleClickTimer = window.setTimeout(() => {
          this.brain.pet();
          void backendApi.recordInteraction('pet');
        }, 300);
      }
    });

    window.addEventListener('contextmenu', event => {
      event.preventDefault(); // 不显示浏览器自带的右键菜单
      if (this.isPointOnCat(toLocal(event))) void showSkillMenu(this.buildSkillMenu(), skill => this.onComingSoonSkill(skill));
    });
  }

  // ---------------- 技能菜单 ----------------
  private buildSkillMenu(): SkillMenuEntry[] {
    const roamSkill = (id: string, icon: string, label: string, mode: RoamMode): CatSkill =>
      ({ id, icon, label, isChecked: () => this.brain.roamMode === mode, run: () => this.brain.setRoamMode(mode) });
    return [
      { id: 'drinkWater', icon: '💧', label: '我喝了一杯', run: () => void this.recordDrink('menu') },
      { id: 'undoDrink', icon: '↩', label: '撤销上一杯', run: () => void this.undoDrink() },
      { id: 'petCat', icon: '🤚', label: '摸摸煤球', run: () => { this.brain.pet(); void backendApi.recordInteraction('pet'); } },
      { id: 'peekNow', icon: '👀', label: '去偷看你在干嘛', run: () => { if (!this.brain.tryStartPeek(true)) this.effects.say('那边没有好藏的地方…'); } },
      { id: 'zoomies', icon: '💨', label: '撒个欢', run: () => void this.brain.tryStartMischief('zoomies') },
      { type: 'separator' },
      roamSkill('roamFree', '🐾', '自由散步', 'free'),
      roamSkill('roamAnchored', '📌', '待在这里别动', 'anchored'),
      roamSkill('roamEdge', '⬇', '去屏幕边缘待着', 'edge'),
      { type: 'separator' },
      { id: 'statistics', icon: '📊', label: '喝水统计', run: () => void backendApi.openStatisticsWindow() },
      { id: 'toggleVoice', icon: '🔊', label: '声音', isChecked: () => !!this.settings?.voiceEnabled, run: () => void this.toggleVoice() },
      { id: 'openSettings', icon: '⚙', label: '设置…', run: () => void backendApi.openSettingsWindow() },
      { type: 'separator' },
      { id: 'screenshot', icon: '📷', label: '截屏', comingSoon: true },
      { id: 'aiChat', icon: '💬', label: 'AI 对话', comingSoon: true },
    ];
  }

  private onComingSoonSkill(_skill: CatSkill): void {
    this.effects.sayLine('coming-soon', { isImportant: true });
  }

  private async toggleVoice(): Promise<void> {
    if (!this.settings) return;
    this.applySettings(await backendApi.updateSettings({ ...this.settings, voiceEnabled: !this.settings.voiceEnabled }));
  }

  // ---------------- 喝水提醒：看你在做什么，换着方式提醒 ----------------
  private handleWaterReminder(payload: ReminderFiredPayload): void {
    window.clearTimeout(this.reminderTimeoutTimer);
    const start = () => this.startWaterReminder(payload);
    // 你正在打字：等你停下来再提醒，不打断思路（已经升级的提醒不再等）
    if (this.isTyping && payload.escalationLevel === 0) {
      this.pendingReminderStart = start;
      this.pendingReminderSince = performance.now();
      return;
    }
    start();
  }

  /** 根据提醒升级等级和你正在做的事，选择提醒方式 */
  private chooseReminderStyle(escalationLevel: number): ReminderStyle {
    const category = this.desktop.foregroundWindow?.category ?? 'other';
    if (escalationLevel >= 2) return pickRandom<ReminderStyle>(['sitOnWindow', 'pushCup']);
    if (escalationLevel === 1) return 'knock';
    if (isQuietCategory(category) || isWatchingCategory(category)) return 'silentSign';
    if (category === 'chat') return 'sign';
    const wasTypingRecently = performance.now() - this.lastTypingTime < 30_000;
    if (isBusyCategory(category) || wasTypingRecently) return 'gentle';
    return 'lively';
  }

  private startWaterReminder(payload: ReminderFiredPayload): void {
    const style = this.chooseReminderStyle(payload.escalationLevel);
    const remaining = Math.max(0, payload.dailyGoal - payload.cupsToday);
    // 说什么：按配置里的规则，结合时间、进度、你在做什么、心情、提醒方式来选
    const context: DialogueContext = {
      activity: this.desktop.foregroundWindow?.category ?? 'other',
      mood: this.moodLevel,
      reason: payload.reason,
      style,
      escalationLevel: payload.escalationLevel,
      cupsToday: payload.cupsToday,
      dailyGoal: payload.dailyGoal,
      expectedCups: payload.expectedCups,
    };
    const situation = payload.reason === 'goalCheck' ? 'goalCheck' : 'waterReminder';
    const lineKey = chooseDialogueGroup(situation, context, group => catVoice.hasGroup(group)) ?? 'remind';
    // 牌子上写什么
    let signText = SIGN_TEXTS[clamp(payload.escalationLevel, 0, 2)];
    if (payload.reason === 'firstCup') signText = '第一杯！';
    if (payload.reason === 'goalCheck') signText = `差${remaining}杯`;
    const fallbackText = payload.reason === 'goalCheck' ? `快下班啦，今天还差 ${remaining} 杯哦！` : '喵～两脚兽，该喝水啦！';

    const showBubble = () => {
      window.clearTimeout(this.bubbleHideTimer);
      const line = catVoice.pickLine(lineKey) ?? catVoice.pickLine('remind');
      petUiState.bubbleText = line?.text ?? fallbackText;
      petUiState.activeCustomReminderId = null;
      petUiState.showReminderActions = true;
      petUiState.isBubbleVisible = true;
      this.waterReminderShownAt = performance.now();
      // 安静举牌（看视频、开会）不出声；轻柔提醒只短短喵一声
      if (style === 'silentSign') return;
      catVoice.speak({ line, meowKind: style === 'gentle' ? 'short' : 'call', priority: 'high' });
    };
    this.brain.startRemind({
      escalationLevel: payload.escalationLevel,
      style,
      signText,
      targetWindowId: this.desktop.foregroundWindow?.id,
      showBubble,
    });
    this.scene.catModel.setSignText(signText);
    // 一直没人理：算"忽略"，升级后下次再提醒
    this.reminderTimeoutTimer = window.setTimeout(() => {
      if (!petUiState.showReminderActions || petUiState.activeCustomReminderId) return;
      this.effects.hideBubble();
      this.brain.reminderIgnored();
      void backendApi.reminderIgnored();
    }, REMINDER_BUBBLE_TIMEOUT_MS);
  }

  /** 定时提醒（录单子、下班打卡等）：举着写了标题的牌子提醒，直到点"做完啦"为止 */
  private startCustomReminder(payload: CustomReminderFiredPayload): void {
    window.clearTimeout(this.reminderTimeoutTimer);
    const showBubble = () => {
      window.clearTimeout(this.bubbleHideTimer);
      petUiState.bubbleText = `⏰ ${payload.message}`;
      petUiState.activeCustomReminderId = payload.id;
      petUiState.showReminderActions = true;
      petUiState.isBubbleVisible = true;
      // 定时提醒很重要：插队播放。用户自己加的提醒没有预生成语音，先喵一声再用系统语音念
      const line = payload.voiceLineId ? catVoice.pickLine(payload.voiceLineId) : null;
      catVoice.speak({ line, fallbackText: payload.message, shouldSpeakFallback: true, meowKind: 'call', priority: 'high' });
    };
    const signText = (payload.title || '提醒').slice(0, 5);
    this.scene.catModel.setSignText(signText);
    this.brain.startRemind({ escalationLevel: 0, style: 'sign', signText, targetWindowId: this.desktop.foregroundWindow?.id, showBubble });
    // 一直没人理：当作"等一下嘛"，过一会儿再提醒
    this.reminderTimeoutTimer = window.setTimeout(() => {
      if (petUiState.activeCustomReminderId !== payload.id) return;
      this.effects.hideBubble();
      this.brain.reminderIgnored();
      void backendApi.snoozeCustomReminder(payload.id);
    }, REMINDER_BUBBLE_TIMEOUT_MS);
  }

  async recordDrink(source: string): Promise<void> {
    window.clearTimeout(this.reminderTimeoutTimer);
    this.pendingReminderStart = null;
    this.effects.hideBubble();
    const progress = await backendApi.recordDrink(source);
    const isGoalReached = progress.cupsToday === progress.dailyGoal;
    this.brain.drinkRecorded(isGoalReached);
    // 说什么：按配置规则，看进度、是不是被提醒后喝的、喝得快不快
    const hadReminder = this.waterReminderShownAt !== null;
    const context: DialogueContext = {
      cupsToday: progress.cupsToday,
      dailyGoal: progress.dailyGoal,
      hadReminder,
      responseSeconds: hadReminder ? (performance.now() - this.waterReminderShownAt!) / 1000 : undefined,
      mood: this.moodLevel,
    };
    this.waterReminderShownAt = null;
    const group = chooseDialogueGroup('drinkResponse', context,
      candidate => (candidate === 'drinkCount' ? catVoice.hasCountLine('drinkCount', progress.cupsToday) : catVoice.hasGroup(candidate))) ?? 'drink-generic';
    this.effects.sayLine(group, {
      durationMs: isGoalReached ? 3500 : 2600,
      count: group === 'drinkCount' ? progress.cupsToday : undefined,
      isImportant: true,
      fallbackText: `呼噜呼噜～今天第 ${progress.cupsToday} 杯啦 💦`,
    });
  }

  private async undoDrink(): Promise<void> {
    const progress = await backendApi.undoLastDrink();
    this.effects.say(`好吧，撤销了一杯，今天是 ${progress.cupsToday} 杯～`);
  }

  /** 气泡主按钮：喝水提醒是"喝完啦"，定时提醒是"做完啦" */
  onPrimaryClicked(): void {
    window.clearTimeout(this.reminderTimeoutTimer);
    const customReminderId = petUiState.activeCustomReminderId;
    this.effects.hideBubble();
    if (customReminderId) {
      void backendApi.completeCustomReminder(customReminderId);
      this.brain.customReminderDone();
    } else {
      void this.recordDrink('bubble');
    }
  }

  /** 气泡次按钮："等一下嘛" */
  onSnoozeClicked(): void {
    window.clearTimeout(this.reminderTimeoutTimer);
    const customReminderId = petUiState.activeCustomReminderId;
    this.effects.hideBubble();
    if (customReminderId) {
      void backendApi.snoozeCustomReminder(customReminderId);
      this.brain.customReminderSnoozed();
    } else {
      void backendApi.snoozeReminder();
      this.brain.snooze();
    }
  }

  // ---------------- 开场问候与说话频率 ----------------
  /** 开场问候：按时间段、星期几、昨天有没有达标、连续达标天数来选 */
  private async sayGreeting(): Promise<void> {
    let context: DialogueContext = { mood: this.moodLevel };
    try {
      const statistics = await backendApi.getStatistics();
      const yesterday = statistics.lastSevenDays[statistics.lastSevenDays.length - 2];
      context = {
        ...context,
        cupsToday: statistics.today.cups,
        dailyGoal: statistics.dailyGoal,
        yesterdayReached: yesterday ? yesterday.cups >= statistics.dailyGoal : undefined,
        hasHistory: statistics.totalDays > 1,
        streakDays: statistics.streakDays,
      };
    } catch (error) {
      console.warn('读取统计失败，开场问候只按时间段选', error);
    }
    const group = chooseDialogueGroup('greeting', context, candidate => catVoice.hasGroup(candidate)) ?? 'greeting';
    this.effects.sayLine(group, { isImportant: true });
  }

  /** 闲聊、互动回应能不能说：按"话多程度"限制间隔，闲聊还要过一道概率 */
  private isAllowedToSpeak(key: string): boolean {
    const kind = lineKindOf(key);
    if (kind === 'essential') return true;
    const level = catConfig.chattiness.levels[this.settings?.chattiness ?? 'normal'];
    if (!level) return true;
    const now = performance.now();
    if (kind === 'interaction') {
      if (now - this.lastInteractionSpeechTime < level.interactionMinGapSeconds * 1000) return false;
      this.lastInteractionSpeechTime = now;
      return true;
    }
    if (now - this.lastAmbientSpeechTime < level.ambientMinGapSeconds * 1000) return false;
    if (Math.random() > level.ambientChance) return false;
    this.lastAmbientSpeechTime = now;
    return true;
  }

  // ---------------- 巡视时的点评 ----------------
  private reactToWindow(window: LocalWindow): void {
    const now = performance.now();
    const sameCategoryGapMs = catConfig.reactions.sameCategoryMinGapSeconds * 1000;
    if (now - (this.lastReactionByCategory.get(window.category) ?? -Infinity) < sameCategoryGapMs) return;
    this.lastReactionByCategory.set(window.category, now);
    this.effects.sayLine(`react-${window.category}`, { fallbackText: '你在忙什么呀？' });
  }

  // ---------------- 界面特效（交给大脑调用） ----------------
  private readonly effects: CatEffects = this.createEffects();

  private createEffects(): CatEffects {
    const effects: CatEffects = {
      say: (text, durationMs = 2600) => {
        window.clearTimeout(this.bubbleHideTimer);
        petUiState.bubbleText = text;
        petUiState.showReminderActions = false;
        petUiState.isBubbleVisible = true;
        this.bubbleHideTimer = window.setTimeout(() => { petUiState.isBubbleVisible = false; }, durationMs);
      },
      sayLine: (key, { durationMs = 2600, count, isImportant = false, meowKind = undefined, fallbackText = '' } = {}) => {
        // 提醒气泡正在等你回应时，别的话不要把它盖掉
        if (petUiState.showReminderActions && !isImportant) return;
        // 按"话多程度"控制闲聊和互动回应的频率（必须说的不受限制）
        if (!isImportant && !this.isAllowedToSpeak(key)) return;
        const line = catVoice.pickLine(key, count);
        const text = line?.text ?? fallbackText;
        const showSubtitle = (estimatedDurationMs: number) => {
          if (text && !petUiState.showReminderActions) effects.say(text, Math.max(durationMs, estimatedDurationMs + 900));
        };
        // 不能出声（关了声音、开会）：直接显示文字
        if (!catVoice.canMakeSound) { showSubtitle(0); return; }
        // 能出声：排进播放队列，真正开始说的时候才显示字幕，保证字幕和声音同步
        catVoice.speak({ line, fallbackText: text, meowKind: meowKind ?? null, priority: isImportant ? 'high' : 'normal', onStart: showSubtitle });
      },
      hideBubble: () => {
        window.clearTimeout(this.bubbleHideTimer);
        petUiState.isBubbleVisible = false;
        petUiState.showReminderActions = false;
        petUiState.activeCustomReminderId = null;
      },
      float: (text, position) => {
        const element = document.createElement('div');
        element.className = 'floating-effect';
        element.textContent = text;
        element.style.left = `${position.x - this.windowOrigin.x + randomBetween(-5, 25)}px`;
        element.style.top = `${position.y - this.windowOrigin.y - 40}px`;
        element.style.setProperty('--drift-x', `${randomBetween(-10, 25)}px`);
        this.elements.effectsLayer.appendChild(element);
        window.setTimeout(() => element.remove(), 1700);
      },
      burst: (text, count) => {
        for (let index = 0; index < count; index++) {
          window.setTimeout(() => {
            const head = this.brain.headPosition;
            effects.float(text, { x: head.x - 30 + index * 15, y: head.y });
          }, index * 180);
        }
      },
      meow: (kind: MeowKind) => catVoice.meow(kind),
      purr: () => catVoice.purr(),
      playSound: kind => catVoice.playEffect(kind),
      reactToWindow: window => this.reactToWindow(window),
      announceMischief: (kind: MischiefKind) => effects.sayLine(`mischief-${kind}`),
    };
    return effects;
  }

  // ---------------- 主循环 ----------------
  private readonly loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    const deltaSeconds = Math.min(.05, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    this.brain.cursor.speed = damp(this.brain.cursor.speed, 0, 4, deltaSeconds); // 鼠标停下后速度逐渐归零
    this.brain.update(deltaSeconds);

    const frameInterval = 1000 / (this.brain.isSleeping ? SLEEP_FPS : ACTIVE_FPS);
    if (now - this.lastRenderTime < frameInterval - 1) return;
    this.renderFrame(Math.min(.12, (now - this.lastRenderTime) / 1000));
    this.lastRenderTime = now;
  };

  private renderFrame(renderDeltaSeconds: number): void {
    const catModel = this.scene.catModel;
    catModel.root.rotation.y = this.brain.yaw;
    // 落地时压扁一下再弹回来（像小皮球）
    const squash = Math.sin(this.brain.squashAmount * Math.PI) * .16;
    catModel.root.scale.set(1 + squash * .7, 1 - squash, 1 + squash * .7);
    catModel.update(this.brain.buildTargetPose(), this.brain.walkPhase, this.brain.elapsedSeconds, renderDeltaSeconds);
    this.scene.render();
    this.syncWindowPosition();
    this.updateCanvasClip();
    this.updateBubbleAnchor();
  }

  /** 猫咪窗口跟着猫走：窗口左上角 = 猫脚底位置 - 脚底在窗口里的位置 */
  private syncWindowPosition(): void {
    this.windowOrigin = {
      x: this.brain.position.x - this.groundPointInWindow.x,
      y: this.brain.position.y - this.groundPointInWindow.y,
    };
    const physical = this.desktop.toPhysical(this.windowOrigin.x, this.windowOrigin.y);
    if (physical.x === this.lastSentPhysicalPosition.x && physical.y === this.lastSentPhysicalPosition.y) return;
    this.lastSentPhysicalPosition = physical;
    void backendApi.movePetWindow(physical.x, physical.y);
  }

  /** 偷看时：把猫和藏身窗口重叠的部分裁成透明（用 evenodd 在画布上挖一个洞） */
  private updateCanvasClip(): void {
    const canvas = this.elements.canvas;
    const clipRect = this.brain.clipRect;
    if (!clipRect) {
      canvas.style.clipPath = '';
      return;
    }
    // clip-path 作用在缩放前的画布坐标上，所以要先把屏幕上的矩形换算过去
    const size = CAT_CANVAS_SIZE;
    const topLeft = this.toCanvasPoint({ x: clipRect.left, y: clipRect.top });
    const bottomRight = this.toCanvasPoint({ x: clipRect.right, y: clipRect.bottom });
    const holeLeft = clamp(topLeft.x, 0, size);
    const holeRight = clamp(bottomRight.x, 0, size);
    const holeTop = clamp(topLeft.y, 0, size);
    const holeBottom = clamp(bottomRight.y, 0, size);
    canvas.style.clipPath = `polygon(evenodd, 0 0, ${size}px 0, ${size}px ${size}px, 0 ${size}px, 0 0, ` +
      `${holeLeft}px ${holeTop}px, ${holeRight}px ${holeTop}px, ${holeRight}px ${holeBottom}px, ${holeLeft}px ${holeBottom}px, ${holeLeft}px ${holeTop}px)`;
  }

  /** 气泡跟在猫头顶 */
  private updateBubbleAnchor(): void {
    const head = this.brain.headPosition;
    petUiState.bubbleAnchorX = clamp(head.x - this.windowOrigin.x, 120, PET_WINDOW_WIDTH - 120);
    petUiState.bubbleAnchorY = clamp(head.y - this.windowOrigin.y - 55, 90, PET_WINDOW_HEIGHT);
  }
}
