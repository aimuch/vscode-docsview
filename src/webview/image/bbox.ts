// Pure pixel coordinate, bounding-box, cropping, and image format encoding helpers.

export interface BBox {
  id: number;
  /** Inclusive-start, exclusive-end integer pixel bounds: 0 <= x1 < x2 <= imgW, 0 <= y1 < y2 <= imgH. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  /** Optional object detection class / category label (e.g. "person", "car"). */
  label?: string;
}

export interface PixelRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
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

export function rgbToHsl(r: number, g: number, b: number): string {
  const nr = clamp(r, 0, 255) / 255;
  const ng = clamp(g, 0, 255) / 255;
  const nb = clamp(b, 0, 255) / 255;
  const max = Math.max(nr, ng, nb);
  const min = Math.min(nr, ng, nb);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === nr) {
      h = 60 * (((ng - nb) / d) % 6);
    } else if (max === ng) {
      h = 60 * ((nb - nr) / d + 2);
    } else {
      h = 60 * ((nr - ng) / d + 4);
    }
    if (h < 0) {
      h += 360;
    }
  }
  return `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

export function formatBBoxTuple(box: Pick<BBox, 'x1' | 'y1' | 'x2' | 'y2'>): [number, number, number, number] {
  return [Math.round(box.x1), Math.round(box.y1), Math.round(box.x2), Math.round(box.y2)];
}

export function bboxDimensions(box: Pick<BBox, 'x1' | 'y1' | 'x2' | 'y2'>): { w: number; h: number } {
  return {
    w: Math.max(1, Math.round(box.x2 - box.x1)),
    h: Math.max(1, Math.round(box.y2 - box.y1)),
  };
}

/**
 * Parses a pasted pixel BBox string such as `[120, 80, 420, 260]`, `120 80 420 260`, or
 * `{"bbox":[120,80,420,260]}` in integer pixel coordinates.
 */
export function parseBBoxInput(raw: string, imgW: number, imgH: number): PixelRect | undefined {
  if (imgW <= 0 || imgH <= 0) {
    return undefined;
  }
  const nums = [...raw.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  if (nums.length < 4) {
    return undefined;
  }
  const [a, b, c, d] = nums;
  const x1 = clamp(Math.round(Math.min(a, c)), 0, imgW - 1);
  const y1 = clamp(Math.round(Math.min(b, d)), 0, imgH - 1);
  const x2 = clamp(Math.max(x1 + 1, Math.round(Math.max(a, c))), 1, imgW);
  const y2 = clamp(Math.max(y1 + 1, Math.round(Math.max(b, d))), 1, imgH);
  return { x1, y1, x2, y2 };
}

/** Crops an RGBA pixel buffer to `rect`, returning the cropped RGBA buffer and dimensions. */
export function cropRgba(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  rect: PixelRect,
): { data: Uint8ClampedArray; width: number; height: number } {
  const x1 = clamp(Math.round(rect.x1), 0, imgW - 1);
  const y1 = clamp(Math.round(rect.y1), 0, imgH - 1);
  const x2 = clamp(Math.max(x1 + 1, Math.round(rect.x2)), 1, imgW);
  const y2 = clamp(Math.max(y1 + 1, Math.round(rect.y2)), 1, imgH);
  const width = x2 - x1;
  const height = y2 - y1;
  const out = new Uint8ClampedArray(width * height * 4);
  const rowBytes = width * 4;
  for (let row = 0; row < height; row++) {
    const srcStart = ((y1 + row) * imgW + x1) * 4;
    out.set(rgba.subarray(srcStart, srcStart + rowBytes), row * rowBytes);
  }
  return { data: out, width, height };
}

/** Encodes an RGBA pixel buffer into a standard uncompressed 24-bit or 32-bit BMP file. */
export function encodeBmp(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  let hasAlpha = false;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 255) {
      hasAlpha = true;
      break;
    }
  }
  const bpp = hasAlpha ? 32 : 24;
  const bytesPerPixel = bpp >> 3;
  const stride = hasAlpha ? width * 4 : (width * 3 + 3) & ~3;
  const imageSize = stride * height;
  const fileSize = 54 + imageSize;
  const out = new Uint8Array(fileSize);
  const view = new DataView(out.buffer);

  // BITMAPFILEHEADER (14 bytes)
  out[0] = 0x42; // 'B'
  out[1] = 0x4d; // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint32(10, 54, true);

  // BITMAPINFOHEADER (40 bytes)
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // positive = standard bottom-up rows
  view.setUint16(26, 1, true);
  view.setUint16(28, bpp, true);
  view.setUint32(30, 0, true);
  view.setUint32(34, imageSize, true);
  view.setInt32(38, 2835, true);
  view.setInt32(42, 2835, true);

  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * 4;
    const dstRow = 54 + y * stride;
    for (let x = 0; x < width; x++) {
      const si = srcRow + x * 4;
      const di = dstRow + x * bytesPerPixel;
      out[di] = rgba[si + 2]; // B
      out[di + 1] = rgba[si + 1]; // G
      out[di + 2] = rgba[si]; // R
      if (hasAlpha) {
        out[di + 3] = rgba[si + 3]; // A
      }
    }
  }
  return out;
}

/** Wraps PNG image bytes (`<= 256x256`) inside a standard Windows/Web `.ico` container. */
export function encodeIcoFromPng(pngBytes: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(22 + pngBytes.byteLength);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type = 1 (ICO)
  view.setUint16(4, 1, true); // count = 1
  out[6] = width >= 256 ? 0 : Math.max(1, width);
  out[7] = height >= 256 ? 0 : Math.max(1, height);
  out[8] = 0;
  out[9] = 0;
  view.setUint16(10, 1, true); // planes
  view.setUint16(12, 32, true); // 32-bit RGBA
  view.setUint32(14, pngBytes.byteLength, true);
  view.setUint32(18, 22, true); // offset
  out.set(pngBytes, 22);
  return out;
}

export type ImageTransformOp = 'rotCW' | 'rotCCW' | 'flipH' | 'flipV';

/** Pure RGBA pixel rotation (90° CW/CCW) and mirror flip (horizontal/vertical). */
export function transformRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  op: ImageTransformOp,
): { data: Uint8ClampedArray; width: number; height: number } {
  const outW = op === 'rotCW' || op === 'rotCCW' ? height : width;
  const outH = op === 'rotCW' || op === 'rotCCW' ? width : height;
  const out = new Uint8ClampedArray(outW * outH * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let dx = x;
      let dy = y;
      if (op === 'rotCW') {
        dx = height - 1 - y;
        dy = x;
      } else if (op === 'rotCCW') {
        dx = y;
        dy = width - 1 - x;
      } else if (op === 'flipH') {
        dx = width - 1 - x;
      } else if (op === 'flipV') {
        dy = height - 1 - y;
      }
      const si = (y * width + x) * 4;
      const di = (dy * outW + dx) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return { data: out, width: outW, height: outH };
}

/** Transforms existing BBox coordinates in-place so boxes stay glued to image features on Rotate / Flip. */
export function transformBBoxes<T extends Pick<BBox, 'x1' | 'y1' | 'x2' | 'y2'>>(
  boxes: readonly T[],
  imgW: number,
  imgH: number,
  op: ImageTransformOp,
): T[] {
  return boxes.map((b) => {
    if (op === 'rotCW') {
      return { ...b, x1: imgH - b.y2, y1: b.x1, x2: imgH - b.y1, y2: b.x2 };
    }
    if (op === 'rotCCW') {
      return { ...b, x1: b.y1, y1: imgW - b.x2, x2: b.y2, y2: imgW - b.x1 };
    }
    if (op === 'flipH') {
      return { ...b, x1: imgW - b.x2, x2: imgW - b.x1 };
    }
    return { ...b, y1: imgH - b.y2, y2: imgH - b.y1 };
  });
}

/** Crops a vector SVG document losslessly by adjusting its `viewBox`, `width` and `height`. */
export function cropSvgMarkup(svgText: string, imgW: number, imgH: number, rect: PixelRect): Uint8Array {
  const w = Math.max(1, Math.round(rect.x2 - rect.x1));
  const h = Math.max(1, Math.round(rect.y2 - rect.y1));
  const openTagMatch = /<svg\b[^>]*>/i.exec(svgText);
  if (!openTagMatch) {
    return new TextEncoder().encode(svgText);
  }
  let tag = openTagMatch[0];
  let vx = 0;
  let vy = 0;
  let vw = imgW;
  let vh = imgH;
  const vbMatch = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(tag);
  if (vbMatch) {
    const parts = vbMatch[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      [vx, vy, vw, vh] = parts;
    }
  }
  const nx = Number((vx + (rect.x1 / imgW) * vw).toFixed(4));
  const ny = Number((vy + (rect.y1 / imgH) * vh).toFixed(4));
  const nw = Number(((w / imgW) * vw).toFixed(4));
  const nh = Number(((h / imgH) * vh).toFixed(4));
  const nextVb = `${nx} ${ny} ${nw} ${nh}`;

  const setOrReplaceAttr = (src: string, attr: string, val: string): string => {
    const re = new RegExp(`\\b${attr}\\s*=\\s*["'][^"']*["']`, 'i');
    return re.test(src) ? src.replace(re, `${attr}="${val}"`) : src.replace(/\/?>$/, (end) => ` ${attr}="${val}"${end}`);
  };

  tag = setOrReplaceAttr(tag, 'viewBox', nextVb);
  tag = setOrReplaceAttr(tag, 'width', String(w));
  tag = setOrReplaceAttr(tag, 'height', String(h));

  const updated = svgText.slice(0, openTagMatch.index) + tag + svgText.slice(openTagMatch.index + openTagMatch[0].length);
  return new TextEncoder().encode(updated);
}

/** Resizes a vector SVG document losslessly by updating `width` and `height` while preserving `viewBox`. */
export function resizeSvgMarkup(svgText: string, imgW: number, imgH: number, newW: number, newH: number): Uint8Array {
  const w = Math.max(1, Math.round(newW));
  const h = Math.max(1, Math.round(newH));
  const openTagMatch = /<svg\b[^>]*>/i.exec(svgText);
  if (!openTagMatch) {
    return new TextEncoder().encode(svgText);
  }
  let tag = openTagMatch[0];
  const setOrReplaceAttr = (src: string, attr: string, val: string): string => {
    const re = new RegExp(`\\b${attr}\\s*=\\s*["'][^"']*["']`, 'i');
    return re.test(src) ? src.replace(re, `${attr}="${val}"`) : src.replace(/\/?>$/, (end) => ` ${attr}="${val}"${end}`);
  };
  if (!/\bviewBox\s*=/i.test(tag)) {
    tag = setOrReplaceAttr(tag, 'viewBox', `0 0 ${imgW} ${imgH}`);
  }
  tag = setOrReplaceAttr(tag, 'width', String(w));
  tag = setOrReplaceAttr(tag, 'height', String(h));
  const updated = svgText.slice(0, openTagMatch.index) + tag + svgText.slice(openTagMatch.index + openTagMatch[0].length);
  return new TextEncoder().encode(updated);
}
