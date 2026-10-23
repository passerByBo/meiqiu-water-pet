// 空闲区域地图：把桌面切成网格，算出猫能完整站下、又不碰任何窗口的格子，并做寻路
import { CAT_FOOTPRINT, catPixels, GRID_CELL_SIZE, OBSTACLE_MARGIN } from './constants';
import type { Point, Rect } from '../shared/geometry';
import { clamp, pickRandom, rectanglesOverlap } from '../shared/geometry';

export interface SearchResult {
  distances: Int32Array;
  previous: Int32Array;
}

export class FreeSpaceMap {
  workArea: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  obstacleRects: Rect[] = [];
  columnCount = 0;
  rowCount = 0;
  freeCells = new Uint8Array(0);
  freeCellCount = 0;

  rebuild(workArea: Rect, obstacleRects: Rect[]): void {
    this.workArea = workArea;
    this.obstacleRects = obstacleRects.map(rect => ({
      left: rect.left - OBSTACLE_MARGIN, top: rect.top - OBSTACLE_MARGIN,
      right: rect.right + OBSTACLE_MARGIN, bottom: rect.bottom + OBSTACLE_MARGIN,
    }));
    this.columnCount = Math.max(1, Math.floor(workArea.right / GRID_CELL_SIZE));
    this.rowCount = Math.max(1, Math.floor(workArea.bottom / GRID_CELL_SIZE));
    this.freeCells = new Uint8Array(this.columnCount * this.rowCount);
    this.freeCellCount = 0;
    for (let cellIndex = 0; cellIndex < this.freeCells.length; cellIndex++) {
      const center = this.cellCenter(cellIndex);
      if (this.isPositionFree(center.x, center.y)) {
        this.freeCells[cellIndex] = 1;
        this.freeCellCount++;
      }
    }
  }

  footprintAt(x: number, y: number): Rect {
    const halfWidth = catPixels(CAT_FOOTPRINT.halfWidth);
    return { left: x - halfWidth, right: x + halfWidth, top: y - catPixels(CAT_FOOTPRINT.heightAbove), bottom: y + catPixels(CAT_FOOTPRINT.depthBelow) };
  }

  /** 猫的脚底站在 (x, y) 时，整只猫是否完全不碰窗口、也不出可用区域 */
  isPositionFree(x: number, y: number): boolean {
    const footprint = this.footprintAt(x, y);
    if (footprint.left < this.workArea.left || footprint.right > this.workArea.right ||
        footprint.top < this.workArea.top || footprint.bottom > this.workArea.bottom) return false;
    return !this.obstacleRects.some(rect => rectanglesOverlap(rect, footprint));
  }

  cellCenter(cellIndex: number): Point {
    return {
      x: (cellIndex % this.columnCount) * GRID_CELL_SIZE + GRID_CELL_SIZE / 2,
      y: Math.floor(cellIndex / this.columnCount) * GRID_CELL_SIZE + GRID_CELL_SIZE / 2,
    };
  }

  cellIndexAt(x: number, y: number): number {
    const column = clamp(Math.floor(x / GRID_CELL_SIZE), 0, this.columnCount - 1);
    const row = clamp(Math.floor(y / GRID_CELL_SIZE), 0, this.rowCount - 1);
    return row * this.columnCount + column;
  }

  nearestFreeCell(x: number, y: number): number {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let cellIndex = 0; cellIndex < this.freeCells.length; cellIndex++) {
      if (!this.freeCells[cellIndex]) continue;
      const center = this.cellCenter(cellIndex);
      const distance = Math.hypot(center.x - x, center.y - y);
      if (distance < bestDistance) { bestDistance = distance; bestIndex = cellIndex; }
    }
    return bestIndex;
  }

  startCellFor(position: Point): number {
    return this.isPositionFree(position.x, position.y)
      ? this.cellIndexAt(position.x, position.y)
      : this.nearestFreeCell(position.x, position.y);
  }

  /** 广度优先搜索：从起点格子出发，算出到每个可达格子的步数和来源 */
  breadthFirstSearch(startIndex: number): SearchResult {
    const distances = new Int32Array(this.freeCells.length).fill(-1);
    const previous = new Int32Array(this.freeCells.length).fill(-1);
    if (startIndex < 0) return { distances, previous };
    const queue = [startIndex];
    distances[startIndex] = 0;
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      const column = current % this.columnCount;
      const neighbors = [
        current - this.columnCount, current + this.columnCount,
        column > 0 ? current - 1 : -1, column < this.columnCount - 1 ? current + 1 : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || neighbor >= this.freeCells.length || !this.freeCells[neighbor] || distances[neighbor] !== -1) continue;
        distances[neighbor] = distances[current] + 1;
        previous[neighbor] = current;
        queue.push(neighbor);
      }
    }
    return { distances, previous };
  }

  /** 两点之间是否一路都是空地（用来把网格路线拉直） */
  hasClearLine(from: Point, to: Point): boolean {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const sampleCount = Math.ceil(distance / 8);
    for (let sample = 1; sample <= sampleCount; sample++) {
      const ratio = sample / sampleCount;
      if (!this.isPositionFree(from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio)) return false;
    }
    return true;
  }

  /** 生成一条从当前位置到目标格子的平滑路线（绕开窗口） */
  buildPath(fromPosition: Point, searchResult: SearchResult, targetIndex: number): Point[] {
    const cellChain: Point[] = [];
    for (let cellIndex = targetIndex; cellIndex !== -1; cellIndex = searchResult.previous[cellIndex]) cellChain.unshift(this.cellCenter(cellIndex));
    const smoothedPath: Point[] = [];
    let anchor = fromPosition;
    let cursor = 0;
    while (cursor < cellChain.length) {
      let farthest = cursor;
      for (let probe = cellChain.length - 1; probe > cursor; probe--) {
        if (this.hasClearLine(anchor, cellChain[probe])) { farthest = probe; break; }
      }
      smoothedPath.push(cellChain[farthest]);
      anchor = cellChain[farthest];
      cursor = farthest + 1;
    }
    return smoothedPath;
  }

  /** 随机挑一个散步目的地；传入 avoidPoint 时尽量远离它（被吓跑） */
  planWander(fromPosition: Point, avoidPoint: Point | null = null): Point[] | null {
    const startIndex = this.startCellFor(fromPosition);
    if (startIndex < 0) return null;
    const searchResult = this.breadthFirstSearch(startIndex);
    let candidates: number[] = [];
    for (let cellIndex = 0; cellIndex < searchResult.distances.length; cellIndex++) {
      const steps = searchResult.distances[cellIndex];
      if (steps >= 4 && steps <= 28) candidates.push(cellIndex);
    }
    if (!candidates.length) {
      for (let cellIndex = 0; cellIndex < searchResult.distances.length; cellIndex++) if (searchResult.distances[cellIndex] > 0) candidates.push(cellIndex);
    }
    if (!candidates.length) return null;
    if (avoidPoint) {
      const distanceFromAvoid = (cellIndex: number) => {
        const center = this.cellCenter(cellIndex);
        return Math.hypot(center.x - avoidPoint.x, center.y - avoidPoint.y);
      };
      candidates.sort((first, second) => distanceFromAvoid(second) - distanceFromAvoid(first));
      candidates = candidates.slice(0, Math.max(1, Math.floor(candidates.length * 0.15)));
    }
    return this.buildPath(fromPosition, searchResult, pickRandom(candidates));
  }

  /** 找一个离 focusPoint 约 preferredDistance 像素的可达空地 */
  planToward(fromPosition: Point, focusPoint: Point, preferredDistance: number): Point[] | null {
    const startIndex = this.startCellFor(fromPosition);
    if (startIndex < 0) return null;
    const searchResult = this.breadthFirstSearch(startIndex);
    let bestIndex = startIndex;
    let bestScore = Infinity;
    for (let cellIndex = 0; cellIndex < searchResult.distances.length; cellIndex++) {
      if (searchResult.distances[cellIndex] < 0) continue;
      const center = this.cellCenter(cellIndex);
      const score = Math.abs(Math.hypot(center.x - focusPoint.x, center.y - focusPoint.y) - preferredDistance);
      if (score < bestScore) { bestScore = score; bestIndex = cellIndex; }
    }
    return this.buildPath(fromPosition, searchResult, bestIndex);
  }
}
