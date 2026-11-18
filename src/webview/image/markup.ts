// Image Markup & Privacy Redaction (Arrow, Rectangle, Mosaic Pixelation, Text) helpers.
import { clamp, type PixelRect } from './bbox';

export type MarkupTool = 'arrow' | 'rect' | 'mosaic' | 'text';

export interface MarkupItem {
  id: number;
  kind: MarkupTool;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  text?: string;
}

export const MARKUP_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#ffffff', '#111827'];

/** Applies block-average mosaic pixelation in-place over `rect` on an RGBA buffer. */
export function applyMosaicRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  rect: PixelRect,
  blockSize = 12,
): void {
  const x1 = clamp(Math.round(Math.min(rect.x1, rect.x2)), 0, Math.max(0, width - 1));
  const y1 = clamp(Math.round(Math.min(rect.y1, rect.y2)), 0, Math.max(0, height - 1));
  const x2 = clamp(Math.round(Math.max(rect.x1, rect.x2)), x1 + 1, width);
  const y2 = clamp(Math.round(Math.max(rect.y1, rect.y2)), y1 + 1, height);
  const step = Math.max(2, Math.round(blockSize));

  for (let by = y1; by < y2; by += step) {
    const endY = Math.min(y2, by + step);
    for (let bx = x1; bx < x2; bx += step) {
      const endX = Math.min(x2, bx + step);
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;
      let count = 0;
      for (let y = by; y < endY; y++) {
        for (let x = bx; x < endX; x++) {
          const i = (y * width + x) * 4;
          rSum += rgba[i];
          gSum += rgba[i + 1];
          bSum += rgba[i + 2];
          aSum += rgba[i + 3];
          count++;
        }
      }
      if (!count) {
        continue;
      }
      const rAvg = Math.round(rSum / count);
      const gAvg = Math.round(gSum / count);
      const bAvg = Math.round(bSum / count);
      const aAvg = Math.round(aSum / count);
      for (let y = by; y < endY; y++) {
        for (let x = bx; x < endX; x++) {
          const i = (y * width + x) * 4;
          rgba[i] = rAvg;
          rgba[i + 1] = gAvg;
          rgba[i + 2] = bAvg;
          rgba[i + 3] = aAvg;
        }
      }
    }
  }
}

/** Rasterises all `MarkupItem` strokes & mosaic regions onto a cloned canvas ready for encoding. */
export function renderMarkupToCanvas(sourceCanvas: HTMLCanvasElement, items: readonly MarkupItem[]): HTMLCanvasElement {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(sourceCanvas, 0, 0);

  const mosaics = items.filter((i) => i.kind === 'mosaic');
  if (mosaics.length) {
    const imgData = ctx.getImageData(0, 0, w, h);
    const block = Math.max(8, Math.round(Math.max(w, h) / 64));
    for (const m of mosaics) {
      applyMosaicRgba(imgData.data, w, h, m, block);
    }
    ctx.putImageData(imgData, 0, 0);
  }

  const baseStroke = Math.max(2, Math.round(Math.max(w, h) / 320));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const item of items) {
    if (item.kind === 'mosaic') {
      continue;
    }
    ctx.strokeStyle = item.color;
    ctx.fillStyle = item.color;
    ctx.lineWidth = baseStroke;

    if (item.kind === 'rect') {
      const rx = Math.min(item.x1, item.x2);
      const ry = Math.min(item.y1, item.y2);
      const rw = Math.max(1, Math.abs(item.x2 - item.x1));
      const rh = Math.max(1, Math.abs(item.y2 - item.y1));
      ctx.strokeRect(rx, ry, rw, rh);
    } else if (item.kind === 'arrow') {
      const dx = item.x2 - item.x1;
      const dy = item.y2 - item.y1;
      const len = Math.hypot(dx, dy);
      if (len < 2) {
        continue;
      }
      const headLen = Math.min(len * 0.45, Math.max(10, baseStroke * 4.5));
      const angle = Math.atan2(dy, dx);
      ctx.beginPath();
      ctx.moveTo(item.x1, item.y1);
      ctx.lineTo(item.x2 - headLen * 0.55 * Math.cos(angle), item.y2 - headLen * 0.55 * Math.sin(angle));
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(item.x2, item.y2);
      ctx.lineTo(item.x2 - headLen * Math.cos(angle - Math.PI / 6), item.y2 - headLen * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(item.x2 - headLen * Math.cos(angle + Math.PI / 6), item.y2 - headLen * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
    } else if (item.kind === 'text' && item.text) {
      const fontSize = Math.max(14, Math.round(Math.max(w, h) / 36));
      ctx.font = `700 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'top';
      ctx.lineWidth = Math.max(2, Math.round(fontSize / 8));
      ctx.strokeStyle = item.color === '#111827' ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.72)';
      ctx.strokeText(item.text, item.x1, item.y1);
      ctx.fillStyle = item.color;
      ctx.fillText(item.text, item.x1, item.y1);
    }
  }
  return out;
}
