// 桌面布局：把 Rust 推送的物理像素数据，换算成"猫所在显示器"的逻辑像素坐标。
// 多显示器时猫一次只住在一块屏幕上，坐标以这块屏幕左上角为原点（0, 0）。
import type { DesktopLayoutPayload, MonitorInfo, PhysicalRect } from '../shared/backendApi';
import type { Point, Rect } from '../shared/geometry';
import { rectanglesOverlap } from '../shared/geometry';
import { classifyActivity, type ActivityCategory } from './appClassifier';

export interface LocalWindow {
  id: string;
  title: string;
  rect: Rect;
  isMaximized: boolean;
  isFullscreen: boolean;
  /** 是不是你正在用的窗口（前台窗口） */
  isForeground: boolean;
  processName: string;
  /** 你在用它做什么（聊天、看视频、写代码……） */
  category: ActivityCategory;
}

export interface Obstacle {
  windowId: string;
  rect: Rect;
}

export class DesktopLayout {
  monitors: MonitorInfo[] = [];
  currentMonitor: MonitorInfo | null = null;
  /** 当前显示器上的可见窗口（按层叠顺序，从上到下） */
  visibleWindows: LocalWindow[] = [];

  /** 用 Rust 推送的最新布局更新；返回猫原来所在的显示器是否还在 */
  update(payload: DesktopLayoutPayload): boolean {
    this.monitors = payload.monitors;
    const previousMonitorId = this.currentMonitor?.id;
    const sameMonitor = payload.monitors.find(monitor => monitor.id === previousMonitorId);
    const isMonitorStillPresent = !previousMonitorId || !!sameMonitor;
    this.currentMonitor = sameMonitor ?? payload.monitors.find(monitor => monitor.isPrimary) ?? payload.monitors[0] ?? null;

    const monitor = this.currentMonitor;
    this.visibleWindows = monitor
      ? payload.windows
          .filter(window => rectanglesOverlap(window.bounds, monitor.bounds))
          .map(window => ({
            id: window.id,
            title: window.title,
            rect: this.toLocalRect(window.bounds),
            isMaximized: window.isMaximized,
            isFullscreen: window.isFullscreen && window.monitorId === monitor.id,
            isForeground: window.isForeground,
            processName: window.processName,
            category: classifyActivity(window.processName, window.title),
          }))
      : [];
    return isMonitorStillPresent;
  }

  /** 切换到另一块显示器（猫被拎到别的屏幕上时）；需要随后用 update 刷新窗口列表 */
  switchMonitor(monitorId: string): boolean {
    const monitor = this.monitors.find(item => item.id === monitorId);
    if (!monitor || monitor.id === this.currentMonitor?.id) return false;
    this.currentMonitor = monitor;
    return true;
  }

  get scaleFactor(): number {
    return this.currentMonitor?.scaleFactor ?? 1;
  }

  /** 整块屏幕（逻辑像素，原点在屏幕左上角） */
  get screenRect(): Rect {
    if (!this.currentMonitor) return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    return this.toLocalRect(this.currentMonitor.bounds);
  }

  get hasFullscreenWindow(): boolean {
    return this.visibleWindows.some(window => window.isFullscreen);
  }

  /** 可用区域：全屏应用会盖住任务栏，此时就是整块屏幕 */
  get workArea(): Rect {
    if (!this.currentMonitor || this.hasFullscreenWindow) return this.screenRect;
    return this.toLocalRect(this.currentMonitor.workArea);
  }

  /** 屏幕底部的任务栏区域；任务栏不在底部、副屏没有任务栏、全屏时返回 null */
  get taskbarRect(): Rect | null {
    if (this.hasFullscreenWindow) return null;
    const screen = this.screenRect;
    const workArea = this.workArea;
    if (screen.bottom - workArea.bottom < 2) return null;
    return { left: screen.left, top: workArea.bottom, right: screen.right, bottom: screen.bottom };
  }

  getObstacles(): Obstacle[] {
    return this.visibleWindows.map(window => ({ windowId: window.id, rect: window.rect }));
  }

  /** 你正在用的窗口（在当前显示器上才算） */
  get foregroundWindow(): LocalWindow | undefined {
    return this.visibleWindows.find(window => window.isForeground);
  }

  findWindow(windowId: string): LocalWindow | undefined {
    return this.visibleWindows.find(window => window.id === windowId);
  }

  /** 物理像素 → 当前显示器的逻辑坐标 */
  toLocal(physicalX: number, physicalY: number): Point {
    const monitor = this.currentMonitor;
    if (!monitor) return { x: physicalX, y: physicalY };
    return {
      x: (physicalX - monitor.bounds.left) / monitor.scaleFactor,
      y: (physicalY - monitor.bounds.top) / monitor.scaleFactor,
    };
  }

  /** 当前显示器的逻辑坐标 → 物理像素 */
  toPhysical(localX: number, localY: number): Point {
    const monitor = this.currentMonitor;
    if (!monitor) return { x: localX, y: localY };
    return {
      x: Math.round(monitor.bounds.left + localX * monitor.scaleFactor),
      y: Math.round(monitor.bounds.top + localY * monitor.scaleFactor),
    };
  }

  toLocalRect(rect: PhysicalRect): Rect {
    const topLeft = this.toLocal(rect.left, rect.top);
    const bottomRight = this.toLocal(rect.right, rect.bottom);
    return { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y };
  }

  /** 物理坐标落在哪块显示器上 */
  monitorAtPhysicalPoint(physicalX: number, physicalY: number): MonitorInfo | undefined {
    return this.monitors.find(monitor =>
      physicalX >= monitor.bounds.left && physicalX < monitor.bounds.right &&
      physicalY >= monitor.bounds.top && physicalY < monitor.bounds.bottom);
  }
}
