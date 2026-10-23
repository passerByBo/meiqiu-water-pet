// 通用的几何与数学小工具

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const randomBetween = (min: number, max: number): number => min + Math.random() * (max - min);

export const pickRandom = <Item>(list: readonly Item[]): Item => list[Math.floor(Math.random() * list.length)];

export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** 按指数衰减向目标靠近，与帧率无关 */
export const damp = (current: number, target: number, rate: number, deltaSeconds: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * deltaSeconds));

/** 角度插值时走最短的方向 */
export const dampAngle = (current: number, target: number, rate: number, deltaSeconds: number): number => {
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + difference * (1 - Math.exp(-rate * deltaSeconds));
};

export const rectanglesOverlap = (first: Rect, second: Rect): boolean =>
  first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;

export const rectangleContains = (outer: Rect, inner: Rect): boolean =>
  inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom;

export const pointInRectangle = (x: number, y: number, rect: Rect): boolean =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
