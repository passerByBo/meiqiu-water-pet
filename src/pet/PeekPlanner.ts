// 偷看规划：找"藏身处"（窗口侧边/顶边、任务栏、屏幕边缘），算出藏、探头的各个位置
import { catPixels, PEEK_SIDE_DEPTH, PEEK_UP_DEPTH } from './constants';
import type { DesktopLayout } from './DesktopLayout';
import type { FreeSpaceMap, SearchResult } from './FreeSpaceMap';
import type { Point, Rect } from '../shared/geometry';
import { randomBetween, rectangleContains, rectanglesOverlap } from '../shared/geometry';

export type PeekCoverKind = 'window' | 'taskbar' | 'screenBottom' | 'screenLeft' | 'screenRight';
export type PeekExit = 'left' | 'right' | 'up';

/** 藏身处：脑袋从哪个东西的哪条边探出来 */
export interface PeekSpot {
  kind: PeekCoverKind;
  exit: PeekExit;
  /** 沿边线的位置：窗口用 0~1 的比例，其它用逻辑像素坐标 */
  along: number;
  windowId?: string;
  weight: number;
}

export interface PeekGeometry {
  /** 挡住猫身体的区域（猫和它重叠的部分要裁成透明） */
  cover: Rect;
  exit: PeekExit;
  /** 边线上的参考点；窗口被拖动时，猫按它的位移跟着走 */
  anchor: Point;
  /** 藏之前站的位置（在外面） */
  stagingPoint: Point;
  /** 钻进去一半，尾巴还露在外面（藏头露尾） */
  tailOutPoint: Point;
  /** 完全藏好 */
  hiddenPoint: Point;
  /** 探出半个脑袋 */
  peekPoint: Point;
  outYaw: number;
  inYaw: number;
  headPosition: Point;
  headArea: Rect;
  bodyArea: Rect;
}

const FAR_AWAY = 100000;

export class PeekPlanner {
  constructor(private desktop: DesktopLayout, private freeSpaceMap: FreeSpaceMap) {}

  /** 挡住猫身体的那块区域；藏身处失效（窗口关了、最小化、最大化）时返回 null */
  coverRectOf(spot: PeekSpot): Rect | null {
    const screen = this.desktop.screenRect;
    switch (spot.kind) {
      case 'window': {
        const window = spot.windowId ? this.desktop.findWindow(spot.windowId) : undefined;
        if (!window || window.isMaximized || window.isFullscreen) return null;
        return window.rect;
      }
      case 'taskbar': {
        const taskbarRect = this.desktop.taskbarRect;
        return taskbarRect ? { left: -FAR_AWAY, right: FAR_AWAY, top: taskbarRect.top, bottom: FAR_AWAY } : null;
      }
      case 'screenBottom': return { left: -FAR_AWAY, right: FAR_AWAY, top: screen.bottom, bottom: FAR_AWAY };
      case 'screenLeft': return { left: -FAR_AWAY, right: screen.left, top: -FAR_AWAY, bottom: FAR_AWAY };
      case 'screenRight': return { left: screen.right, right: FAR_AWAY, top: -FAR_AWAY, bottom: FAR_AWAY };
    }
  }

  geometryOf(spot: PeekSpot): PeekGeometry | null {
    const cover = this.coverRectOf(spot);
    if (!cover) return null;
    // 下面的数字都是 100% 大小时的像素数，用 size() 按猫咪大小换算
    const size = catPixels;
    if (spot.exit === 'left' || spot.exit === 'right') {
      const direction = spot.exit === 'left' ? -1 : 1;
      const edgeX = spot.exit === 'left' ? cover.left : cover.right;
      const y = spot.kind === 'window' ? cover.top + spot.along * (cover.bottom - cover.top) : spot.along;
      const pointAt = (offset: number): Point => ({ x: edgeX + direction * size(offset), y });
      return {
        cover, exit: spot.exit, anchor: { x: edgeX, y },
        stagingPoint: pointAt(88), tailOutPoint: pointAt(-78), hiddenPoint: pointAt(-150), peekPoint: pointAt(-PEEK_SIDE_DEPTH),
        outYaw: direction * 1.05, inYaw: -direction * Math.PI / 2,
        headPosition: { x: edgeX + direction * size(32), y: y - size(80) },
        headArea: { left: direction < 0 ? edgeX - size(90) : edgeX, right: direction < 0 ? edgeX : edgeX + size(90), top: y - size(140), bottom: y },
        bodyArea: { left: direction < 0 ? edgeX : edgeX - size(175), right: direction < 0 ? edgeX + size(175) : edgeX, top: y - size(140), bottom: y + size(15) },
      };
    }
    const edgeY = cover.top;
    const x = spot.kind === 'window' ? cover.left + spot.along * (cover.right - cover.left) : spot.along;
    const pointAt = (offset: number): Point => ({ x, y: edgeY + size(offset) });
    return {
      cover, exit: 'up', anchor: { x, y: edgeY },
      stagingPoint: pointAt(spot.kind === 'window' ? -20 : -2), tailOutPoint: pointAt(100), hiddenPoint: pointAt(190), peekPoint: pointAt(PEEK_UP_DEPTH),
      outYaw: 0, inYaw: 0,
      headPosition: { x, y: edgeY - size(40) },
      headArea: { left: x - size(75), right: x + size(75), top: edgeY - size(95), bottom: edgeY },
      bodyArea: { left: x - size(85), right: x + size(85), top: edgeY, bottom: edgeY + size(190) },
    };
  }

  /** 藏身处是否合适：脑袋探出去的地方要在屏幕内、不被别的窗口挡；身体要能完全藏进窗口 */
  isSpotUsable(spot: PeekSpot, geometry: PeekGeometry): boolean {
    const screen = this.desktop.screenRect;
    const visibleArea: Rect = { left: screen.left, top: screen.top, right: screen.right, bottom: this.desktop.workArea.bottom };
    if (!rectangleContains(visibleArea, geometry.headArea)) return false;
    // 没有空地时（例如全屏工作），猫浮在所有窗口上面，屏幕边缘的藏身处不需要避开窗口
    const isFloatingOverWindows = spot.kind !== 'window' && this.freeSpaceMap.freeCellCount === 0;
    if (!isFloatingOverWindows) {
      const blockers = this.desktop.getObstacles().filter(obstacle => spot.kind !== 'window' || obstacle.windowId !== spot.windowId);
      if (blockers.some(obstacle => rectanglesOverlap(obstacle.rect, geometry.headArea))) return false;
    }
    if (spot.kind === 'window' && !rectangleContains(geometry.cover, geometry.bodyArea)) return false;
    return true;
  }

  /**
   * 从当前位置出发，挑一个能走过去的藏身处。
   * isFocusingForeground：去看"你正在用的窗口"（右键菜单"去偷看你在干嘛"）。
   *   前台窗口有边可以藏 → 只在它旁边挑；前台窗口最大化 / 全屏 → 从它正下方的任务栏或屏幕底边冒头
   * focusX：在底边冒头时尽量靠近这个横坐标（通常是鼠标所在位置）
   */
  plan(fromPosition: Point, isOnEdge: boolean, edgeLineY: number, isFocusingForeground = false, focusX?: number): { spot: PeekSpot; path: Point[] } | null {
    const workArea = this.desktop.workArea;
    const screen = this.desktop.screenRect;
    const foregroundWindow = this.desktop.foregroundWindow;
    const windowSpots = (windowId: string, weight: number): PeekSpot[] => [
      ...[0.45, 0.65, 0.85].flatMap(along => [
        { kind: 'window' as const, windowId, exit: 'left' as const, along, weight },
        { kind: 'window' as const, windowId, exit: 'right' as const, along, weight },
      ]),
      ...[0.3, 0.5, 0.7].map(along => ({ kind: 'window' as const, windowId, exit: 'up' as const, along, weight })),
    ];
    const bottomKind: PeekCoverKind = this.desktop.taskbarRect ? 'taskbar' : 'screenBottom';
    const clampToScreen = (x: number) => Math.min(Math.max(x, screen.left + 160), screen.right - 160);

    let candidates: PeekSpot[] = [];
    if (isFocusingForeground) {
      // 去看你正在用的窗口
      const isForegroundHideable = foregroundWindow && !foregroundWindow.isMaximized && !foregroundWindow.isFullscreen;
      if (isForegroundHideable) candidates = windowSpots(foregroundWindow.id, 1);
      const bottomCenterX = clampToScreen(focusX ?? (foregroundWindow ? (foregroundWindow.rect.left + foregroundWindow.rect.right) / 2 : (screen.left + screen.right) / 2));
      // 前台窗口没法藏（或者旁边都没地方）时的备选：从它正下方的底边冒头
      for (const offset of [0, -160, 160]) {
        candidates.push({ kind: bottomKind, exit: 'up', along: clampToScreen(bottomCenterX + offset), weight: isForegroundHideable ? .01 : 1 });
      }
    } else {
      for (const window of this.desktop.visibleWindows) {
        if (window.isMaximized || window.isFullscreen) continue;
        // 你正在用的窗口更有"偷看主人"的感觉，权重最高
        candidates.push(...windowSpots(window.id, window.isForeground ? 6 : 2));
      }
      for (let index = 0; index < 3; index++) {
        candidates.push({ kind: bottomKind, exit: 'up', along: randomBetween(screen.left + 160, screen.right - 160), weight: 1 });
      }
      const sideHeights = isOnEdge ? [edgeLineY] : [edgeLineY, randomBetween(workArea.top + 220, edgeLineY), randomBetween(workArea.top + 220, edgeLineY)];
      for (const y of sideHeights) {
        candidates.push({ kind: 'screenLeft', exit: 'right', along: y, weight: 1 });
        candidates.push({ kind: 'screenRight', exit: 'left', along: y, weight: 1 });
      }
    }

    const searchResult = isOnEdge ? null : this.freeSpaceMap.breadthFirstSearch(this.freeSpaceMap.startCellFor(fromPosition));
    const reachable: { spot: PeekSpot; path: Point[] }[] = [];
    for (const spot of candidates) {
      const geometry = this.geometryOf(spot);
      if (!geometry || !this.isSpotUsable(spot, geometry)) continue;
      const path = this.pathToStaging(fromPosition, geometry.stagingPoint, isOnEdge, edgeLineY, searchResult);
      if (path) reachable.push({ spot, path });
    }
    if (!reachable.length) return null;
    // 按权重随机（窗口旁边更有"偷看主人"的感觉，权重更高）
    const totalWeight = reachable.reduce((sum, item) => sum + item.spot.weight, 0);
    let roll = Math.random() * totalWeight;
    for (const item of reachable) {
      roll -= item.spot.weight;
      if (roll <= 0) return item;
    }
    return reachable[reachable.length - 1];
  }

  private pathToStaging(fromPosition: Point, stagingPoint: Point, isOnEdge: boolean, edgeLineY: number, searchResult: SearchResult | null): Point[] | null {
    if (isOnEdge || !searchResult) {
      // 在边缘模式下只能沿着边线走过去
      if (Math.abs(stagingPoint.y - edgeLineY) > 25) return null;
      return [{ x: stagingPoint.x, y: edgeLineY }, stagingPoint];
    }
    const map = this.freeSpaceMap;
    const centerCell = map.cellIndexAt(stagingPoint.x, stagingPoint.y);
    let bestCell = -1;
    let bestDistance = 40;
    for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
      for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
        const cell = centerCell + rowOffset * map.columnCount + columnOffset;
        if (cell < 0 || cell >= map.freeCells.length || searchResult.distances[cell] < 0) continue;
        const center = map.cellCenter(cell);
        const distance = Math.hypot(center.x - stagingPoint.x, center.y - stagingPoint.y);
        if (distance < bestDistance) { bestDistance = distance; bestCell = cell; }
      }
    }
    if (bestCell < 0) return null;
    return [...map.buildPath(fromPosition, searchResult, bestCell), stagingPoint];
  }
}
