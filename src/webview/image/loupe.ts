// 15x11 WeChat/Snipaste-style pixel magnifier loupe renderer (zero full-image buffer copy).
import { clamp } from './bbox';

export const LOUPE_COLS = 15;
export const LOUPE_ROWS = 11;
export const LOUPE_HALF_X = 7;
export const LOUPE_HALF_Y = 5;
export const LOUPE_PX = 10;
export const LOUPE_W = LOUPE_COLS * LOUPE_PX;
export const LOUPE_H = LOUPE_ROWS * LOUPE_PX;

export function sampleCanvasPixel(
  sampleCtx: CanvasRenderingContext2D | undefined,
  naturalW: number,
  naturalH: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const px = clamp(x, 0, naturalW - 1);
  const py = clamp(y, 0, naturalH - 1);
  if (sampleCtx) {
    const d = sampleCtx.getImageData(px, py, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }
  return [0, 0, 0, 255];
}

export function paintPixelLoupe(
  loupeCtx: CanvasRenderingContext2D,
  sampleCtx: CanvasRenderingContext2D | undefined,
  naturalW: number,
  naturalH: number,
  cx: number,
  cy: number,
): void {
  loupeCtx.clearRect(0, 0, LOUPE_W, LOUPE_H);

  // Read only the <= 15x11 visible pixel patch once per frame (<= 660 bytes).
  const sx0 = clamp(cx - LOUPE_HALF_X, 0, naturalW);
  const sy0 = clamp(cy - LOUPE_HALF_Y, 0, naturalH);
  const sx1 = clamp(cx + LOUPE_HALF_X + 1, 0, naturalW);
  const sy1 = clamp(cy + LOUPE_HALF_Y + 1, 0, naturalH);
  const sw = sx1 - sx0;
  const sh = sy1 - sy0;
  const patch = sampleCtx && sw > 0 && sh > 0 ? sampleCtx.getImageData(sx0, sy0, sw, sh).data : undefined;

  // 1. Draw magnified 15x11 pixel cells
  for (let dy = -LOUPE_HALF_Y; dy <= LOUPE_HALF_Y; dy++) {
    for (let dx = -LOUPE_HALF_X; dx <= LOUPE_HALF_X; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      const px = (dx + LOUPE_HALF_X) * LOUPE_PX;
      const py = (dy + LOUPE_HALF_Y) * LOUPE_PX;
      if (!patch || x < sx0 || y < sy0 || x >= sx1 || y >= sy1) {
        loupeCtx.fillStyle = '#18181b';
      } else {
        const pi = ((y - sy0) * sw + (x - sx0)) * 4;
        const r = patch[pi];
        const g = patch[pi + 1];
        const b = patch[pi + 2];
        const a = patch[pi + 3];
        if (a >= 255) {
          loupeCtx.fillStyle = `rgb(${r},${g},${b})`;
        } else {
          const bg = (x + y) % 2 === 0 ? 220 : 170;
          const alpha = a / 255;
          loupeCtx.fillStyle = `rgb(${Math.round(r * alpha + bg * (1 - alpha))},${Math.round(g * alpha + bg * (1 - alpha))},${Math.round(b * alpha + bg * (1 - alpha))})`;
        }
      }
      loupeCtx.fillRect(px, py, LOUPE_PX, LOUPE_PX);
    }
  }

  // 2. Royal-blue translucent crosshair bands (leaving center pixel true-colour)
  const cxPx = LOUPE_HALF_X * LOUPE_PX;
  const cyPx = LOUPE_HALF_Y * LOUPE_PX;
  loupeCtx.fillStyle = 'rgba(37, 99, 235, 0.52)';
  loupeCtx.fillRect(0, cyPx, cxPx, LOUPE_PX);
  loupeCtx.fillRect(cxPx + LOUPE_PX, cyPx, LOUPE_W - (cxPx + LOUPE_PX), LOUPE_PX);
  loupeCtx.fillRect(cxPx, 0, LOUPE_PX, cyPx);
  loupeCtx.fillRect(cxPx, cyPx + LOUPE_PX, LOUPE_PX, LOUPE_H - (cyPx + LOUPE_PX));

  // 3. Crisp 1px pixel grid lines
  loupeCtx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  loupeCtx.lineWidth = 1;
  loupeCtx.beginPath();
  for (let i = 1; i < LOUPE_COLS; i++) {
    const pos = i * LOUPE_PX + 0.5;
    loupeCtx.moveTo(pos, 0);
    loupeCtx.lineTo(pos, LOUPE_H);
  }
  for (let j = 1; j < LOUPE_ROWS; j++) {
    const pos = j * LOUPE_PX + 0.5;
    loupeCtx.moveTo(0, pos);
    loupeCtx.lineTo(LOUPE_W, pos);
  }
  loupeCtx.stroke();

  // 4. Center pixel [·] reticle
  loupeCtx.strokeStyle = 'rgba(0, 0, 0, 0.78)';
  loupeCtx.lineWidth = 1;
  loupeCtx.strokeRect(cxPx - 0.5, cyPx - 0.5, LOUPE_PX + 1, LOUPE_PX + 1);
  loupeCtx.strokeStyle = '#ffffff';
  loupeCtx.lineWidth = 1.6;
  loupeCtx.strokeRect(cxPx + 0.5, cyPx + 0.5, LOUPE_PX - 1, LOUPE_PX - 1);
}
