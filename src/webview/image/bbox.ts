// Pure coordinate, bounding-box and colour helpers for the Image & BBox inspector.

export type CoordScale = 'px' | 'norm';

export interface BBox {
  id: number;
  /** Inclusive-start, exclusive-end pixel bounds: 0 <= x1 < x2 <= imgW, 0 <= y1 < y2 <= imgH. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}

export const BBOX_PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4'];

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function rgbToHex(r: number, g: number, b: number): string {
  const hex = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function formatRgb(r: number, g: number, b: number, a = 255): string {
  if (a >= 255) {
    return `rgb(${r}, ${g}, ${b})`;
  }
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`;
}

export function toScaledPoint(
  x: number,
  y: number,
  imgW: number,
  imgH: number,
  scale: CoordScale,
): [number, number] {
  if (scale === 'norm' && imgW > 0 && imgH > 0) {
    return [Math.round((x / imgW) * 1000), Math.round((y / imgH) * 1000)];
  }
  return [Math.round(x), Math.round(y)];
}

export function formatBBoxTuple(
  box: Pick<BBox, 'x1' | 'y1' | 'x2' | 'y2'>,
  imgW: number,
  imgH: number,
  scale: CoordScale,
): [number, number, number, number] {
  const [sx1, sy1] = toScaledPoint(box.x1, box.y1, imgW, imgH, scale);
  const [sx2, sy2] = toScaledPoint(box.x2, box.y2, imgW, imgH, scale);
  return [sx1, sy1, sx2, sy2];
}

export function bboxDimensions(box: Pick<BBox, 'x1' | 'y1' | 'x2' | 'y2'>): { w: number; h: number } {
  return {
    w: Math.max(1, Math.round(box.x2 - box.x1)),
    h: Math.max(1, Math.round(box.y2 - box.y1)),
  };
}

/**
 * Parses a pasted BBox string such as `[120, 80, 420, 260]`, `120 80 420 260`, or
 * `{"bbox":[120,80,420,260]}` in either pixel (`px`) or `0–1000` normalised (`norm`) coordinates.
 */
export function parseBBoxInput(
  raw: string,
  imgW: number,
  imgH: number,
  scale: CoordScale,
): { x1: number; y1: number; x2: number; y2: number } | undefined {
  if (imgW <= 0 || imgH <= 0) {
    return undefined;
  }
  const nums = [...raw.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  if (nums.length < 4) {
    return undefined;
  }
  let [a, b, c, d] = nums;
  if (scale === 'norm') {
    a = (a / 1000) * imgW;
    b = (b / 1000) * imgH;
    c = (c / 1000) * imgW;
    d = (d / 1000) * imgH;
  }
  const x1 = clamp(Math.round(Math.min(a, c)), 0, imgW - 1);
  const y1 = clamp(Math.round(Math.min(b, d)), 0, imgH - 1);
  const x2 = clamp(Math.max(x1 + 1, Math.round(Math.max(a, c))), 1, imgW);
  const y2 = clamp(Math.max(y1 + 1, Math.round(Math.max(b, d))), 1, imgH);
  return { x1, y1, x2, y2 };
}
