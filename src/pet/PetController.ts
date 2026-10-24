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
import { catConfig, lineKindOf, loadCatConfig, type RewardRule } from './catConfig';
import { chooseDialogueGroup, type DialogueContext } from './dialogueSelector';
import { DailyRoutine, type RoutineEvent } from './dailyRoutine';
import { actionLibrary } from './actionSystem';
import { adaptTextToSpecies, SPECIES_LIST, speciesInfo, type PetSpecies, type SpeciesInfo } from './species';
import { findSkin, SKINS } from './skins';
import {
  backendApi, type AppSettings, type CursorPayload, type CustomReminderFiredPayload, type DesktopLayoutPayload, type MoodLevel,
  type ReminderFiredPayload, type RoamMode, type Statistics,
} from '../shared/backendApi';
import type { Point } from '../shared/geometry';
import { clamp, pickRandom, pointInRectangle, randomBetween } from '../shared/geometry';

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
/** 每隔多久检查一次要不要保存宠物位置；挪动超过多少像素才保存（避免频繁写数据库） */
const POSITION_SAVE_INTERVAL_MS = 15_000;
const POSITION_SAVE_MIN_DISTANCE = 20;
/** 上次保存的位置离屏幕底边这么近，就当它是待在底边 */
const EDGE_RESTORE_TOLERANCE = 6;

interface PetElements {
  canvas: HTMLCanvasElement;
  effectsLayer: HTMLElement;
  bubble: HTMLElement;
}

interface PressState {
  start: Point;
  isDragging: boolean;
  /** 按住不动够久了，正在抱抱 */
  isHugging: boolean;
}

/** 逗猫棒检测：记录鼠标左右晃动的方向和掉头的时刻 */
interface TeaserSwing {
  /** 当前往哪边晃：-1 左 / 1 右 / 0 还没开始 */
  direction: number;
  /** 这一下晃到的最远位置 */
  extremeX: number;
  reversalTimes: number[];
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
  /** 上次存进数据库的宠物位置 */
  private lastSavedPosition: Point | null = null;
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

  // ---- 逗猫棒、抱抱、作息 ----
  private teaserSwing: TeaserSwing = { direction: 0, extremeX: 0, reversalTimes: [] };
  private hugTimer: number | undefined;
  private readonly routine = new DailyRoutine();
  private lastRoutineCheckTime = -Infinity;
  private lastErrorRecoveryTime = -Infinity;
  private isUserAway = false;

  constructor(private readonly elements: PetElements) {
    this.scene = new PetScene(elements.canvas);
    this.groundPointInWindow = {
      x: CAT_CANVAS_LEFT + this.scene.groundPointOnCanvas.x,
      y: CAT_CANVAS_TOP + this.scene.groundPointOnCanvas.y,
    };
    this.brain = new CatBrain(this.freeSpaceMap, this.desktop, this.peekPlanner, this.effects);
  }

  async start(): Promise<void> {
    await Promise.all([loadCatConfig(), actionLibrary.load()]);
    console.info(`动作库：${actionLibrary.count} 个动作`);
    const settings = await backendApi.getSettings();
    const startSpecies = speciesInfo(settings.petSpecies).id;
    await this.switchSpecies(startSpecies, findSkin(startSpecies, settings.petSkins?.[startSpecies]).id, false);
    this.applySettings(settings);
    const mood = await backendApi.getCatMood();
    this.brain.intimacy = mood.intimacy;
    this.applyMood(mood.level, false);
    this.applyDesktopLayout(await backendApi.getDesktopLayout());
    this.placeCatAtStart(await backendApi.getPetPosition().catch(() => null));

    this.bindBackendEvents();
    this.bindPointerEvents();
    this.renderFrame(0);
    await getCurrentWindow().show();
    requestAnimationFrame(this.loop);
    window.setInterval(() => this.checkSlowConditions(), 500);
    window.setInterval(() => this.savePositionIfMoved(), POSITION_SAVE_INTERVAL_MS);
    window.setTimeout(() => void this.sayGreeting(), 1500);
    // 启动时也检查一次装扮（比如昨天达标后没开程序）
    window.setTimeout(() => void this.checkRewards(), 6000);
  }

  // ---------------- 设置与心情 ----------------
  private applySettings(settings: AppSettings): void {
    const previousRoamMode = this.settings?.defaultRoamMode;
    this.settings = settings;
    if (previousRoamMode && settings.defaultRoamMode !== previousRoamMode && settings.defaultRoamMode !== this.brain.roamMode) {
      this.brain.setRoamMode(settings.defaultRoamMode);
    }
    // 设置里换了宠物：马上换模型、换声音、换口吻；只换了皮肤：换个外观，开心地展示一下
    const targetSpecies = speciesInfo(settings.petSpecies).id;
    const targetSkin = findSkin(targetSpecies, settings.petSkins?.[targetSpecies]);
    if (targetSpecies !== this.scene.species) void this.switchSpecies(targetSpecies, targetSkin.id, true);
    else if (targetSkin.id !== this.scene.skinId) this.changeSkin(targetSkin.id, targetSkin.name);
    catVoice.isEnabled = settings.voiceEnabled;
    catVoice.mode = settings.voiceMode;
    catVoice.volume = settings.voiceVolume / 100;
    if (!settings.voiceEnabled) catVoice.stopAll();
    this.brain.activityLevel = settings.activityLevel;
    this.brain.isScareEnabled = settings.scareEnabled;
    this.brain.mischiefLevel = settings.mischiefLevel;
    this.userCatScale = settings.catSizePercent / 100;
    this.applyCatSize();
    this.scene.petModel.setAccessory(settings.equippedAccessory);
  }

  /** 现在这只宠物的种类信息 */
  private get species(): SpeciesInfo {
    return speciesInfo(this.scene.species);
  }

  /** 现在这只宠物的名字（设置里没改过就用默认名字） */
  private get petName(): string {
    return this.settings?.petNames?.[this.scene.species] || this.species.defaultName;
  }

  /**
   * 换一种宠物：换 3D 模型、换叫声和语音、换动作库里的特有动作。
   * 喝水数据大家共用；心情和亲密度由后端按动物分开记（换了之后会推送这只动物自己的心情）
   */
  private async switchSpecies(species: PetSpecies, skinId: string, shouldGreet: boolean): Promise<void> {
    const model = this.scene.setSpecies(species, skinId);
    this.brain.species = species;
    this.brain.hasLegs = speciesInfo(species).hasLegs;
    if (this.settings) model.setAccessory(this.settings.equippedAccessory);
    await catVoice.loadManifest(species);
    if (shouldGreet) {
      this.brain.setBehavior('happy', 2);
      this.effects.say(`我是${this.petName}！以后由我陪你喝水～`, 3500);
    }
  }

  /** 同一只宠物换一套皮肤：换模型外观（装扮照旧），开心地转一圈给你看 */
  private changeSkin(skinId: string, skinName: string): void {
    const model = this.scene.setSpecies(this.scene.species, skinId);
    if (this.settings) model.setAccessory(this.settings.equippedAccessory);
    this.brain.setBehavior('happy', 2);
    this.effects.say(`换上「${skinName}」啦，好看吗？`, 3000);
  }

  /**
   * 气泡文字个性化：先换成这种动物的口吻（本喵 → 本汪……），再把对主人的称呼换成设置里填的名字；
   * addressOwner 时有一半概率在前面加上称呼
   */
  private personalize(text: string, addressOwner = false): string {
    if (!text) return text;
    const adapted = adaptTextToSpecies(text, this.species);
    const ownerName = this.settings?.ownerName?.trim();
    if (!ownerName) return adapted;
    const replaced = adapted.replace(/两脚兽|铲屎官|主人/g, ownerName);
    if (addressOwner && replaced === adapted && Math.random() < .5) return `${ownerName}，${adapted}`;
    return replaced;
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
    this.brain.foregroundCategory = category;
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

  /**
   * 启动时把宠物放到哪儿：上次退出前的位置还在现在的屏幕范围内就回到原地（附近的空地，或者屏幕底边），
   * 否则（第一次启动、换了显示器）放在右下角
   */
  private placeCatAtStart(savedPosition: Point | null): void {
    const workArea = this.desktop.workArea;
    const isSavedPositionUsable = !!savedPosition
      && savedPosition.x >= workArea.left && savedPosition.x <= workArea.right
      && savedPosition.y >= workArea.top && savedPosition.y <= workArea.bottom + 1;
    const preferred = isSavedPositionUsable ? savedPosition : { x: workArea.right * .85, y: workArea.bottom * .85 };
    const wasOnEdge = isSavedPositionUsable && workArea.bottom - savedPosition.y < EDGE_RESTORE_TOLERANCE;
    const startCell = this.freeSpaceMap.nearestFreeCell(preferred.x, preferred.y);
    if (startCell >= 0 && !wasOnEdge && this.settings?.defaultRoamMode !== 'edge') {
      this.brain.position = this.freeSpaceMap.cellCenter(startCell);
    } else {
      this.brain.position = { x: Math.min(Math.max(preferred.x, workArea.left + 60), workArea.right - 60), y: workArea.bottom };
      this.brain.isOnEdge = true;
    }
    this.lastSavedPosition = { ...this.brain.position };
    const where = isSavedPositionUsable ? '回到上次的位置' : '默认位置';
    console.info(`启动：${this.species.label}${this.petName}，${where}（${Math.round(this.brain.position.x)}, ${Math.round(this.brain.position.y)}）`);
    this.brain.roamMode = this.settings?.defaultRoamMode ?? 'free';
    this.brain.setBehavior('sit', 2);
    this.brain.isReady = true;
  }

  /**
   * 宠物挪了地方就把位置存下来（下次启动回到原地）。偷看时不存（那时躲在窗口后面）；
   * 站在窗口上的位置照样存，下次启动时窗口不一定还在，会落到附近的空地上
   */
  private savePositionIfMoved(): void {
    if (!this.brain.isReady || this.brain.peek) return;
    const position = this.brain.position;
    const last = this.lastSavedPosition;
    if (last && Math.hypot(position.x - last.x, position.y - last.y) < POSITION_SAVE_MIN_DISTANCE) return;
    this.lastSavedPosition = { ...position };
    void backendApi.savePetPosition(position).catch(() => {});
  }

  // ---------------- 后端事件 ----------------
  private bindBackendEvents(): void {
    void backendApi.onDesktopLayoutChanged(payload => this.applyDesktopLayout(payload));
    void backendApi.onCursorMoved(cursor => this.handleCursor(cursor));
    void backendApi.onTypingChanged(isTyping => {
      this.isTyping = isTyping;
      this.brain.isUserTyping = isTyping;
      this.lastTypingTime = performance.now();
    });
    void backendApi.onReminderFired(payload => this.handleWaterReminder(payload));
    void backendApi.onCustomReminderFired(payload => this.startCustomReminder(payload));
    void backendApi.onUserAway(() => { this.isUserAway = true; this.brain.goToSleep(); });
    void backendApi.onUserBack(() => { this.isUserAway = false; this.brain.wakeUp(); });
    void backendApi.onSettingsChanged(settings => this.applySettings(settings));
    void backendApi.onCatMoodChanged(mood => {
      this.brain.intimacy = mood.intimacy;
      this.applyMood(mood.level);
    });
    void backendApi.onTrayAction(action => {
      if (action === 'record-drink') void this.recordDrink('tray');
      if (action === 'reset-pet') this.resetPet('托盘手动复位');
    });
  }

  /** 复位：结束拖拽 / 抱抱，打开点击穿透（不挡你点别的东西），猫回到安全的地方 */
  private resetPet(reason: string): void {
    window.clearTimeout(this.hugTimer);
    this.pressState = null;
    this.isClickThrough = true;
    void backendApi.setClickThrough(true);
    this.brain.recover(reason);
  }

  /** 每半秒检查一次：等打字停下的提醒、同一个软件用了太久、作息 */
  private checkSlowConditions(): void {
    const now = performance.now();
    if (this.settings && now - this.lastRoutineCheckTime > 10_000) {
      this.lastRoutineCheckTime = now;
      const events = this.routine.update(this.settings, !this.isUserAway);
      this.brain.routinePhase = this.routine.phase;
      events.forEach(event => this.handleRoutineEvent(event));
    }
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

  /** 作息事件：上班伸懒腰、午休睡午觉、快下班兴奋、加班催你回家 */
  private handleRoutineEvent(event: RoutineEvent): void {
    if (this.brain.isReminding) return; // 正在提醒时不打断
    // 偷看、跳跃、被拎着的时候不改动作（只说话），免得打乱正在进行的动作
    const canChangeBehavior = !this.brain.peek && !this.brain.jump && this.brain.behavior !== 'lifted' && this.brain.behavior !== 'hugged';
    switch (event) {
      case 'workStart':
        if (canChangeBehavior) this.brain.setBehavior('stretch', 2.4);
        this.effects.sayLine('routine-work-start', { addressOwner: true, fallbackText: '上班时间到啦，本喵陪你开工！' });
        break;
      case 'lunchStart':
        this.effects.sayLine('routine-lunch-start', { addressOwner: true, fallbackText: '午休时间到啦，本喵也要睡个午觉…' });
        if (canChangeBehavior) window.setTimeout(() => this.brain.takeNap(), 4000); // 说完再去睡
        break;
      case 'lunchEnd':
        this.brain.wakeFromNap();
        this.effects.sayLine('routine-lunch-end', { fallbackText: '睡醒啦…下午也一起加油吧' });
        break;
      case 'almostOff':
        if (canChangeBehavior) this.brain.getExcited();
        this.effects.sayLine('routine-almost-off', { fallbackText: '快下班啦，本喵好兴奋！' });
        break;
      case 'overtime':
        if (canChangeBehavior) this.brain.setBehavior('yawn', 1.8);
        this.effects.sayLine('routine-overtime', { addressOwner: true, fallbackText: '已经下班啦，还不回家吗？' });
        break;
      case 'offDayHello':
        this.effects.sayLine('routine-off-day', { addressOwner: true, fallbackText: '今天是休息日，还在忙呀？本喵陪你' });
        break;
    }
  }

  // ---------------- 鼠标（Rust 推送的全局位置） ----------------
  private handleCursor(cursor: CursorPayload): void {
    const local = this.desktop.toLocal(cursor.x, cursor.y);
    const now = performance.now();
    const brainCursor = this.brain.cursor;
    brainCursor.x = local.x;
    brainCursor.y = local.y;
    this.brain.recordCursorSample(local.x, local.y); // 速度和"有没有冲过去"都按最近的轨迹算

    if (this.pressState) {
      // 抱着的时候：松开就结束抱抱；挪动鼠标就变成拎起来
      if (this.pressState.isHugging && !cursor.isLeftButtonDown) { this.finishPress(); return; }
      if (!this.pressState.isDragging && Math.hypot(local.x - this.pressState.start.x, local.y - this.pressState.start.y) > 6) {
        window.clearTimeout(this.hugTimer);
        this.pressState.isDragging = true;
        this.pressState.isHugging = false;
        this.brain.liftUp();
        void backendApi.recordInteraction('lift');
      }
      if (this.pressState.isDragging) {
        this.brain.position = { x: local.x, y: local.y + catPixels(DRAG_GROUND_OFFSET) };
        if (!cursor.isLeftButtonDown) void this.finishDrag(cursor);
        return;
      }
      // 网页没收到松开事件时（例如鼠标移出窗口），以这里为准
      if (!cursor.isLeftButtonDown) { window.clearTimeout(this.hugTimer); this.pressState = null; }
    }

    const isOverCat = this.isPointOnCat(local);
    this.setClickThrough(!(isOverCat || this.isPointOnBubble(local)));
    this.brain.setCursorOverCat(isOverCat); // 偷看时鼠标移到它头上：抓包！
    this.detectTeaser(local, now);
  }

  /**
   * 逗猫棒：鼠标在猫附近快速左右来回晃。
   * 每次往一个方向晃够距离、再往回晃，算"掉头"一次；一小段时间内掉头够多次 → 猫扑过来
   */
  private detectTeaser(local: Point, now: number): void {
    const teaser = catConfig.teaser;
    const swing = this.teaserSwing;
    const distanceToCat = Math.hypot(local.x - this.brain.position.x, local.y - (this.brain.position.y - catPixels(50)));
    if (distanceToCat > teaser.maxDistance || this.pressState) {
      swing.direction = 0;
      swing.extremeX = local.x;
      swing.reversalTimes = [];
      return;
    }
    const offset = local.x - swing.extremeX;
    const direction = Math.sign(offset);
    if (swing.direction === 0) {
      // 还没开始晃：从起点往某个方向晃够距离才算开始
      if (Math.abs(offset) >= teaser.minSwingPixels) { swing.direction = direction; swing.extremeX = local.x; }
    } else if (direction === swing.direction) {
      swing.extremeX = local.x; // 继续往同一个方向晃：更新最远点
    } else if (Math.abs(offset) >= teaser.minSwingPixels) {
      swing.reversalTimes.push(now); // 往回晃够距离：掉头一次
      swing.direction = direction;
      swing.extremeX = local.x;
    }
    swing.reversalTimes = swing.reversalTimes.filter(time => now - time < teaser.windowSeconds * 1000);
    if (swing.reversalTimes.length >= teaser.minReversals) {
      swing.reversalTimes = [];
      if (this.brain.playWithTeaser()) void backendApi.recordInteraction('play');
    }
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
      this.pressState = { start: toLocal(event), isDragging: false, isHugging: false };
      // 按住不动够久：抱抱
      window.clearTimeout(this.hugTimer);
      this.hugTimer = window.setTimeout(() => {
        if (!this.pressState || this.pressState.isDragging) return;
        if (this.brain.startHug()) {
          this.pressState.isHugging = true;
          void backendApi.recordInteraction('hug');
        } else {
          this.pressState = null; // 它躲开了：这次按压作废，松开时不再算成点击
        }
      }, catConfig.hug.holdSeconds * 1000);
    });

    window.addEventListener('pointerup', event => {
      if (event.button !== 0 || !this.pressState || this.pressState.isDragging) return;
      if (this.pressState.isHugging) { this.finishPress(); return; } // 抱完松开，不算点击
      window.clearTimeout(this.hugTimer);
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

  /** 松开鼠标：如果正在抱抱，就结束抱抱 */
  private finishPress(): void {
    window.clearTimeout(this.hugTimer);
    const wasHugging = this.pressState?.isHugging ?? false;
    this.pressState = null;
    if (wasHugging) this.brain.endHug();
  }

  // ---------------- 技能菜单 ----------------
  private buildSkillMenu(): SkillMenuEntry[] {
    const roamSkill = (id: string, icon: string, label: string, mode: RoamMode): CatSkill =>
      ({ id, icon, label, isChecked: () => this.brain.roamMode === mode, run: () => void this.changeRoamMode(mode) });
    return [
      { id: 'drinkWater', icon: '💧', label: '我喝了一杯', run: () => void this.recordDrink('menu') },
      { id: 'undoDrink', icon: '↩', label: '撤销上一杯', run: () => void this.undoDrink() },
      { id: 'petCat', icon: '🤚', label: `摸摸${this.petName}`, run: () => { this.brain.pet(); void backendApi.recordInteraction('pet'); } },
      { id: 'peekNow', icon: '👀', label: '去偷看你在干嘛', run: () => { if (!this.brain.tryStartPeek(true)) this.effects.say('那边没有好藏的地方…'); } },
      { id: 'zoomies', icon: '💨', label: '撒个欢', run: () => void this.brain.tryStartMischief('zoomies') },
      { id: 'trick', icon: '🎲', label: '表演一个小动作', run: () => { if (!this.brain.performTrick()) this.effects.say('现在不想表演嘛…'); } },
      { type: 'separator' },
      {
        type: 'submenu', id: 'switchPet', icon: '🐾', label: '换宠物',
        entries: SPECIES_LIST.map(species => ({
          id: `pet-${species.id}`, icon: species.icon, label: `${this.settings?.petNames?.[species.id] || species.defaultName}（${species.label}）`,
          isChecked: () => this.scene.species === species.id,
          run: () => void this.saveAppearance({ petSpecies: species.id }),
        })),
      },
      {
        type: 'submenu', id: 'switchSkin', icon: '🎨', label: '换肤',
        entries: SKINS[this.scene.species].map(skin => ({
          id: `skin-${skin.id}`, icon: skin.icon, label: skin.name,
          isChecked: () => this.scene.skinId === skin.id,
          run: () => void this.saveAppearance({ petSkins: { ...this.settings?.petSkins, [this.scene.species]: skin.id } }),
        })),
      },
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

  /** 右键菜单换宠物 / 换肤：保存到设置（退出再打开还是它），换模型由 applySettings 统一处理 */
  private async saveAppearance(change: Partial<AppSettings>): Promise<void> {
    if (!this.settings) return;
    this.applySettings(await backendApi.updateSettings({ ...this.settings, ...change }));
  }

  /** 右键菜单换活动方式：马上生效，并保存成默认活动方式（退出再打开还是它） */
  private async changeRoamMode(mode: RoamMode): Promise<void> {
    this.brain.setRoamMode(mode);
    if (!this.settings || this.settings.defaultRoamMode === mode) return;
    this.applySettings(await backendApi.updateSettings({ ...this.settings, defaultRoamMode: mode }));
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
      petUiState.bubbleText = this.personalize(line?.text ?? fallbackText, true);
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
    this.scene.petModel.setSignText(signText);
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
      petUiState.bubbleText = `⏰ ${this.personalize(payload.message)}`;
      petUiState.activeCustomReminderId = payload.id;
      petUiState.showReminderActions = true;
      petUiState.isBubbleVisible = true;
      // 定时提醒很重要：插队播放。用户自己加的提醒没有预生成语音，先喵一声再用系统语音念
      const line = payload.voiceLineId ? catVoice.pickLine(payload.voiceLineId) : null;
      catVoice.speak({ line, fallbackText: payload.message, shouldSpeakFallback: true, meowKind: 'call', priority: 'high' });
    };
    const signText = (payload.title || '提醒').slice(0, 5);
    this.scene.petModel.setSignText(signText);
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
    // 刚达标：说完话再看看有没有解锁新装扮
    if (isGoalReached) window.setTimeout(() => void this.checkRewards(), 4000);
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
    this.effects.sayLine(group, { isImportant: true, addressOwner: true });
  }

  // ---------------- 装扮奖励 ----------------
  /** 看看有没有满足条件、还没解锁的装扮：解锁后自动穿上，开心地庆祝一下 */
  private async checkRewards(knownStatistics?: Statistics): Promise<void> {
    try {
      const [statistics, unlocked] = await Promise.all([
        knownStatistics ? Promise.resolve(knownStatistics) : backendApi.getStatistics(),
        backendApi.getUnlockedRewards(),
      ]);
      const unlockedIds = new Set(unlocked.map(reward => reward.id));
      const isQualified = (rule: RewardRule) =>
        (rule.goalDaysAtLeast !== undefined || rule.streakAtLeast !== undefined) &&
        (rule.goalDaysAtLeast === undefined || statistics.goalDaysTotal >= rule.goalDaysAtLeast) &&
        (rule.streakAtLeast === undefined || statistics.streakDays >= rule.streakAtLeast);
      const newlyUnlocked: RewardRule[] = [];
      for (const rule of catConfig.rewards.filter(rule => !unlockedIds.has(rule.id) && isQualified(rule))) {
        if (await backendApi.unlockReward(rule.id)) newlyUnlocked.push(rule);
      }
      const latest = newlyUnlocked[newlyUnlocked.length - 1];
      if (!latest || !this.settings) return;
      this.applySettings(await backendApi.updateSettings({ ...this.settings, equippedAccessory: latest.id }));
      this.effects.burst('🎁', 3);
      this.effects.sayLine('reward-unlock', { isImportant: true, durationMs: 4500, fallbackText: '哇！解锁新装扮啦！' });
      window.setTimeout(() => this.effects.say(`${latest.icon} 解锁新装扮：${latest.name}！（${latest.description}）`, 4500), 3500);
    } catch (error) {
      console.warn('检查装扮奖励失败', error);
    }
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
        petUiState.bubbleText = this.personalize(text);
        petUiState.showReminderActions = false;
        petUiState.isBubbleVisible = true;
        this.bubbleHideTimer = window.setTimeout(() => { petUiState.isBubbleVisible = false; }, durationMs);
      },
      sayLine: (key, { durationMs = 2600, count, isImportant = false, meowKind = undefined, fallbackText = '', addressOwner = false } = {}) => {
        // 提醒气泡正在等你回应时，别的话不要把它盖掉
        if (petUiState.showReminderActions && !isImportant) return;
        // 按"话多程度"控制闲聊和互动回应的频率（必须说的不受限制）
        if (!isImportant && !this.isAllowedToSpeak(key)) return;
        const line = catVoice.pickLine(key, count);
        // 语音是预先生成的，只能叫"你"；气泡文字里换成主人的称呼
        const text = this.personalize(line?.text ?? fallbackText, addressOwner);
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
    // 容错：大脑或渲染里任何一处出错，都不能让整个循环停掉（停掉就是猫"冻住"、点不动）；出错就复位（2 秒内最多复位一次）
    try {
      this.brain.update(deltaSeconds);
      this.brain.cursor.speed = this.brain.recentCursorSpeed;
      const frameInterval = 1000 / (this.brain.isSleeping ? SLEEP_FPS : ACTIVE_FPS);
      if (now - this.lastRenderTime < frameInterval - 1) return;
      this.renderFrame(Math.min(.12, (now - this.lastRenderTime) / 1000));
      this.lastRenderTime = now;
    } catch (error) {
      console.error('煤球主循环出错', error);
      if (now - this.lastErrorRecoveryTime < 2000) return;
      this.lastErrorRecoveryTime = now;
      try { this.resetPet(`主循环出错：${String(error)}`); } catch (recoveryError) { console.error('复位也失败了', recoveryError); }
    }
  };

  private renderFrame(renderDeltaSeconds: number): void {
    const petModel = this.scene.petModel;
    petModel.root.rotation.y = this.brain.yaw;
    // 落地时压扁一下再弹回来（像小皮球）
    const squash = Math.sin(this.brain.squashAmount * Math.PI) * .16;
    petModel.root.scale.set(1 + squash * .7, 1 - squash, 1 + squash * .7);
    petModel.update(this.brain.buildTargetPose(), this.brain.walkPhase, this.brain.elapsedSeconds, renderDeltaSeconds);
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
    if (!Number.isFinite(physical.x) || !Number.isFinite(physical.y)) return; // 位置坏了不发给系统，大脑的自检会复位
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
