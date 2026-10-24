// 窗口动态跟踪：根据每次桌面布局刷新（大约每 0.14 秒，有变化才刷新）记下的窗口位置，
// 算出每个窗口移动得多快、是不是正在被拖动、是不是被来回甩，以及有没有窗口新弹出来、被关掉、一下子全部最小化。
// 宠物据此做出"像真的一样"的反应（躲着的窗口被拖开、站着的窗口被甩、盯着被拖动的窗口看……）
import type { LocalWindow } from './DesktopLayout';
import type { Rect } from '../shared/geometry';

/** 多久没动就算停下来了（秒） */
const STOPPED_AFTER_SECONDS = .35;
/** 桌面布局的刷新间隔（和后端 desktop_layout.rs 的 LAYOUT_POLL_INTERVAL 一致） */
const LAYOUT_REFRESH_SECONDS = .14;
/** 位置变化小于这个像素数不算移动（避免窗口阴影、边框重绘的小抖动） */
const MIN_MOVE_PIXELS = 3;
/** 甩窗口：一段时间内水平方向来回掉头几次 */
const SHAKE_WINDOW_SECONDS = 1.2;
const SHAKE_REVERSALS = 3;
/** 每一下至少移动多少像素才算一次"甩" */
const SHAKE_STEP_PIXELS = 25;

export type WindowMotionEvent =
  | { type: 'dragStart'; windowId: string }
  | { type: 'shake'; windowId: string }
  | { type: 'appeared'; windowId: string; rect: Rect }
  | { type: 'closed'; windowId: string; rect: Rect }
  | { type: 'desktopCleared' };

interface WindowMotion {
  rect: Rect;
  /** 移动速度（逻辑像素/秒，平滑过的） */
  speed: number;
  lastUpdateTime: number;
  lastMoveTime: number;
  lastStepX: number;
  reversalTimes: number[];
}

export class WindowMotionTracker {
  private motions = new Map<string, WindowMotion>();
  private hasSnapshot = false;

  /** 收到新的窗口列表：更新每个窗口的运动状态，返回这一次发生的事件 */
  update(windows: readonly LocalWindow[], now: number): WindowMotionEvent[] {
    const events: WindowMotionEvent[] = [];
    const seenIds = new Set<string>();
    for (const window of windows) {
      seenIds.add(window.id);
      const motion = this.motions.get(window.id);
      if (!motion) {
        this.motions.set(window.id, { rect: { ...window.rect }, speed: 0, lastUpdateTime: now, lastMoveTime: -99, lastStepX: 0, reversalTimes: [] });
        if (this.hasSnapshot) events.push({ type: 'appeared', windowId: window.id, rect: { ...window.rect } });
        continue;
      }
      const stepX = window.rect.left - motion.rect.left;
      const stepY = window.rect.top - motion.rect.top;
      const distance = Math.hypot(stepX, stepY);
      // 只算"挪动"：大小变了（拉伸窗口）不算拖动
      const isSameSize = Math.abs((window.rect.right - window.rect.left) - (motion.rect.right - motion.rect.left)) < 2
        && Math.abs((window.rect.bottom - window.rect.top) - (motion.rect.bottom - motion.rect.top)) < 2;
      if (distance >= MIN_MOVE_PIXELS && isSameSize) {
        const wasMoving = now - motion.lastMoveTime < STOPPED_AFTER_SECONDS;
        // 刚开始拖时，上一次记录的位置可能是很久以前的：按正常的刷新间隔算速度，避免算出来特别慢
        const seconds = wasMoving ? Math.min(Math.max(now - motion.lastUpdateTime, .05), .2) : LAYOUT_REFRESH_SECONDS;
        motion.speed = wasMoving ? motion.speed * .4 + distance / seconds * .6 : distance / seconds;
        if (!wasMoving) events.push({ type: 'dragStart', windowId: window.id });
        // 来回甩：水平方向掉头
        if (Math.abs(stepX) >= SHAKE_STEP_PIXELS) {
          if (motion.lastStepX && Math.sign(stepX) !== Math.sign(motion.lastStepX)) {
            motion.reversalTimes = motion.reversalTimes.filter(time => now - time < SHAKE_WINDOW_SECONDS);
            motion.reversalTimes.push(now);
            if (motion.reversalTimes.length >= SHAKE_REVERSALS) {
              motion.reversalTimes = [];
              events.push({ type: 'shake', windowId: window.id });
            }
          }
          motion.lastStepX = stepX;
        }
        motion.lastMoveTime = now;
      }
      motion.rect = { ...window.rect };
      motion.lastUpdateTime = now;
    }
    // 不见了的窗口：关掉或最小化了
    let disappearedCount = 0;
    for (const [id, motion] of this.motions) {
      if (seenIds.has(id)) continue;
      this.motions.delete(id);
      disappearedCount++;
      events.push({ type: 'closed', windowId: id, rect: motion.rect });
    }
    // 一下子全没了（显示桌面 / 全部最小化）
    if (this.hasSnapshot && disappearedCount >= 2 && windows.length === 0) events.push({ type: 'desktopCleared' });
    this.hasSnapshot = true;
    return events;
  }

  /** 窗口现在是不是在移动（被拖着走） */
  isMoving(windowId: string, now: number): boolean {
    const motion = this.motions.get(windowId);
    return !!motion && now - motion.lastMoveTime < STOPPED_AFTER_SECONDS;
  }

  /** 窗口现在的移动速度（停下来了就是 0） */
  speedOf(windowId: string, now: number): number {
    return this.isMoving(windowId, now) ? this.motions.get(windowId)!.speed : 0;
  }

  /** 正在移动的窗口里速度最快的一个（用来让宠物盯着看） */
  fastestMovingWindowId(now: number): string | null {
    let bestId: string | null = null;
    let bestSpeed = 0;
    for (const [id, motion] of this.motions) {
      if (now - motion.lastMoveTime < STOPPED_AFTER_SECONDS && motion.speed > bestSpeed) { bestSpeed = motion.speed; bestId = id; }
    }
    return bestId;
  }
}
