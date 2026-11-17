// Image editor & inspector:
// - 15x11 WeChat/Snipaste-style pixel magnifier loupe (follow cursor or fixed & draggable)
// - RGB / HEX switching (Shift) & one-key copy (C), pure integer pixel coordinates
// - Interactive BBox drawing, editing & JSON export
// - Interactive Image Cropping (with aspect ratios, 8 handles, in-place Undo/Save & Save-As)
// - Format Conversion (PNG / JPG / WebP / BMP / ICO)
import '../shared/base.css';
import './image.css';
import type { ImageExportFormat, LoupePosition } from '../../common/protocol';
import { app, el, errorText, onMessage, post, showStatus, t, toArrayBuffer } from '../shared/api';
import { getAppearance, onAppearanceChange, updateAppearance } from '../shared/appearance';
import { getFileState } from '../shared/fileState';
import { icons } from '../shared/icons';
import { readState, Sidebar, writeState } from '../shared/sidebar';
import {
  customToolbar,
  iconButton,
  moreMenu,
  noticeBanner,
  openExternalButton,
  openExternalMenuItem,
  segmented,
  type MenuItem,
} from '../shared/ui';
import {
  BBOX_PALETTE,
  bboxDimensions,
  clamp,
  cropSvgMarkup,
  encodeBmp,
  encodeIcoFromPng,
  formatBBoxTuple,
  formatRgb,
  parseBBoxInput,
  resizeSvgMarkup,
  rgbToHex,
  type BBox,
  type ImageTransformOp,
  type PixelRect,
} from './bbox';

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, v);
  }
  return node;
};

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
const LOUPE_COLS = 15; // 15x11 landscape pixel grid matching WeChat/Snipaste screenshot loupe
const LOUPE_ROWS = 11;
const LOUPE_HALF_X = 7;
const LOUPE_HALF_Y = 5;
const LOUPE_PX = 10; // 150x110 canvas
const LOUPE_W = LOUPE_COLS * LOUPE_PX;
const LOUPE_H = LOUPE_ROWS * LOUPE_PX;

type ToolMode = 'inspect' | 'bbox' | 'crop';
type AspectPreset = 'free' | '1:1' | '16:9' | '4:3';
type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

// ---------------------------------------------------------------- state

let fileName = '';
let rawFileBytes: Uint8Array | undefined;
let naturalW = 0;
let naturalH = 0;
let zoom = 1;
let blobUrl: string | undefined;
let sourceCanvas: HTMLCanvasElement | undefined;
let sampleCtx: CanvasRenderingContext2D | undefined;

const savedMode = readState().imgMode;
let toolMode: ToolMode = savedMode === 'bbox' || savedMode === 'crop' ? savedMode : 'inspect';
let colorMode: 'rgb' | 'hex' = readState().imgColorMode === 'hex' ? 'hex' : 'rgb';
let showGrid = readState().imgGrid !== false;
let checkerboard = readState().imgChecker !== false;
let fixedLoupeOffset = readState().loupeFixedPos as { x: number; y: number } | undefined;

let boxes: BBox[] = [];
let nextBoxId = 1;
let selectedBoxId: number | undefined;

let cropRect: PixelRect = { x1: 0, y1: 0, x2: 1, y2: 1 };
let cropAspect: AspectPreset = 'free';

let hoverPx: { x: number; y: number } | undefined;
let lastSampledPx: { x: number; y: number } = { x: 0, y: 0 };
let lastPointerClient: { x: number; y: number } | undefined;
let currentColorValues: { rgbDisplay: string; rgbCopy: string; hex: string } | undefined;
let spaceHeld = false;
let pureShiftTap = false;

// ---------------------------------------------------------------- DOM elements

const notice = noticeBanner();
const stage = el('div', { class: 'img-stage' });
const scrollPad = el('div', { class: 'img-scroll-pad' });
const canvasWrap = el('div', { class: 'img-canvas-wrap' });
const imgEl = el('img', { class: 'img-el' });
imgEl.draggable = false;
const gridOverlay = el('div', { class: 'img-grid-overlay' });
gridOverlay.hidden = true;
const overlaySvg = svgEl('svg', { class: 'img-overlay' });
const badgesLayer = el('div', { class: 'img-badges-layer' });

canvasWrap.append(imgEl, gridOverlay, overlaySvg, badgesLayer);
scrollPad.append(canvasWrap);
stage.append(scrollPad);
canvasWrap.hidden = true;

// 15x11 WeChat / Snipaste style Pixel Magnifier Loupe
const loupeCanvas = el('canvas', { class: 'img-loupe-canvas' });
loupeCanvas.width = LOUPE_W;
loupeCanvas.height = LOUPE_H;
const loupeCtx = loupeCanvas.getContext('2d')!;
const loupeCoord = el('div', { class: 'img-loupe-coord' });
const loupeSwatch = el('span', { class: 'img-loupe-swatch' }, [el('span', { class: 'img-loupe-swatch-dot' })]);
const loupeColorText = el('span');
const loupeColorRow = el('div', { class: 'img-loupe-color-row' }, [loupeSwatch, loupeColorText]);
const loupeDragHintEl = el('div', { class: 'img-loupe-hint img-loupe-drag-hint', text: t('loupeDragHint') });
const loupeCard = el('div', { class: 'img-loupe-card' }, [
  loupeCoord,
  loupeColorRow,
  el('div', { class: 'img-loupe-hint', text: t('loupeCopyHint') }),
  el('div', { class: 'img-loupe-hint', text: t('loupeSwitchHint') }),
  loupeDragHintEl,
]);
const loupe = el('div', { class: 'img-loupe' }, [loupeCanvas, loupeCard]);
loupe.hidden = true;

// Allow dragging the loupe when in Fixed Position mode, and clicking to copy/toggle!
loupe.addEventListener('mousedown', (e) => {
  if (getAppearance().loupePosition !== 'fixed' || e.button !== 0) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  const rect = loupe.getBoundingClientRect();
  const startX = e.clientX;
  const startY = e.clientY;
  let moved = false;
  const move = (ev: MouseEvent) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      moved = true;
    }
    const nx = clamp(rect.left + dx, 8, Math.max(8, window.innerWidth - rect.width - 8));
    const ny = clamp(rect.top + dy, 40, Math.max(40, window.innerHeight - rect.height - 34));
    fixedLoupeOffset = { x: nx, y: ny };
    positionLoupe();
  };
  const up = (ev: MouseEvent) => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    if (moved) {
      writeState({ loupeFixedPos: fixedLoupeOffset });
    } else if ((ev.target as HTMLElement | null)?.closest('.img-loupe-coord')) {
      copyText(`${lastSampledPx.x}, ${lastSampledPx.y}`);
    } else if ((ev.target as HTMLElement | null)?.closest('.img-loupe-color-row')) {
      copyActiveColor();
    }
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

// Status bar
const metaLabel = el('span', { class: 'dv-label' });
const coordPill = el('button', { class: 'img-pill', text: '(—, —)' });
coordPill.type = 'button';
const swatchDot = el('span', { class: 'img-color-dot' });
const hexText = el('span', { text: '#------' });
const hexPill = el('button', { class: 'img-pill' }, [swatchDot, hexText]);
hexPill.type = 'button';
const rgbPill = el('button', { class: 'img-pill', text: '—, —, —' });
rgbPill.type = 'button';
const statusBar = el('div', { class: 'img-statusbar' }, [
  metaLabel,
  el('div', { class: 'dv-spacer' }),
  coordPill,
  hexPill,
  rgbPill,
]);

const toast = el('div', { class: 'img-toast' });
toast.hidden = true;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function flashToast(value: string) {
  toast.textContent = t('imgCopied', value);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 1500);
}

function copyText(value: string) {
  if (!value || value.includes('—') || value.includes('--')) {
    return;
  }
  void navigator.clipboard?.writeText(value).then(() => flashToast(value));
}

function copyActiveColor() {
  if (!currentColorValues) {
    return;
  }
  copyText(colorMode === 'hex' ? currentColorValues.hex : currentColorValues.rgbCopy);
}

coordPill.addEventListener('click', () => {
  if (!naturalW) {
    return;
  }
  const pt = hoverPx ?? lastSampledPx;
  copyText(`${pt.x}, ${pt.y}`);
});
hexPill.addEventListener('click', () => copyText(currentColorValues?.hex ?? ''));
rgbPill.addEventListener('click', () => copyText(currentColorValues?.rgbCopy ?? ''));

// ---------------------------------------------------------------- Crop bar

function makeCropNumInput(label: string, onChange: (val: number) => void): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = el('input', { class: 'dv-input img-crop-num' });
  input.type = 'number';
  input.min = '0';
  input.step = '1';
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) {
      onChange(Math.round(v));
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
      void applyCropInPlace();
    }
    e.stopPropagation();
  });
  const wrap = el('label', { class: 'img-crop-field' }, [el('span', { text: label }), input]);
  return { wrap, input };
}

const cropXField = makeCropNumInput('X', (v) => {
  const w = cropRect.x2 - cropRect.x1;
  cropRect.x1 = clamp(v, 0, Math.max(0, naturalW - 1));
  cropRect.x2 = clamp(cropRect.x1 + w, cropRect.x1 + 1, naturalW);
  syncCropUi();
});
const cropYField = makeCropNumInput('Y', (v) => {
  const h = cropRect.y2 - cropRect.y1;
  cropRect.y1 = clamp(v, 0, Math.max(0, naturalH - 1));
  cropRect.y2 = clamp(cropRect.y1 + h, cropRect.y1 + 1, naturalH);
  syncCropUi();
});
const cropWField = makeCropNumInput('W', (v) => {
  const w = clamp(v, 1, Math.max(1, naturalW - cropRect.x1));
  cropRect.x2 = cropRect.x1 + w;
  if (cropAspect !== 'free') {
    const ratio = aspectValue(cropAspect)!;
    cropRect.y2 = clamp(cropRect.y1 + Math.max(1, Math.round(w / ratio)), cropRect.y1 + 1, naturalH);
  }
  syncCropUi();
});
const cropHField = makeCropNumInput('H', (v) => {
  const h = clamp(v, 1, Math.max(1, naturalH - cropRect.y1));
  cropRect.y2 = cropRect.y1 + h;
  if (cropAspect !== 'free') {
    const ratio = aspectValue(cropAspect)!;
    cropRect.x2 = clamp(cropRect.x1 + Math.max(1, Math.round(h * ratio)), cropRect.x1 + 1, naturalW);
  }
  syncCropUi();
});

function aspectValue(preset: AspectPreset): number | undefined {
  switch (preset) {
    case '1:1':
      return 1;
    case '16:9':
      return 16 / 9;
    case '4:3':
      return 4 / 3;
    default:
      return undefined;
  }
}

const aspectSeg = segmented<AspectPreset>(
  'Aspect ratio',
  [
    ['free', t('imgRatioFree')],
    ['1:1', '1:1'],
    ['16:9', '16:9'],
    ['4:3', '4:3'],
  ],
  cropAspect,
  (next) => {
    cropAspect = next;
    const ratio = aspectValue(next);
    if (ratio && naturalW && naturalH) {
      let w = cropRect.x2 - cropRect.x1;
      let h = Math.max(1, Math.round(w / ratio));
      if (cropRect.y1 + h > naturalH) {
        h = naturalH - cropRect.y1;
        w = Math.max(1, Math.round(h * ratio));
      }
      cropRect.x2 = clamp(cropRect.x1 + w, cropRect.x1 + 1, naturalW);
      cropRect.y2 = clamp(cropRect.y1 + h, cropRect.y1 + 1, naturalH);
      syncCropUi();
    }
  },
);

const applyCropBtn = el('button', { class: 'dv-btn dv-cm-primary', text: t('imgApplyCrop') });
applyCropBtn.type = 'button';
applyCropBtn.addEventListener('click', () => void applyCropInPlace());

const saveCropAsBtn = el('button', { class: 'dv-btn', text: t('imgSaveCropAs') });
saveCropAsBtn.type = 'button';
saveCropAsBtn.addEventListener('click', () => void saveCropCopy());

const cancelCropBtn = el('button', { class: 'dv-btn', text: t('cancel') });
cancelCropBtn.type = 'button';
cancelCropBtn.addEventListener('click', () => setToolMode('inspect'));

const cropBar = el('div', { class: 'img-crop-bar' }, [
  cropXField.wrap,
  cropYField.wrap,
  cropWField.wrap,
  cropHField.wrap,
  aspectSeg.node,
  el('div', { class: 'dv-spacer' }),
  cancelCropBtn,
  saveCropAsBtn,
  applyCropBtn,
]);
cropBar.hidden = true;

function initDefaultCropRect(fromBox?: PixelRect) {
  if (!naturalW || !naturalH) {
    return;
  }
  if (fromBox) {
    cropRect = {
      x1: clamp(Math.round(fromBox.x1), 0, naturalW - 1),
      y1: clamp(Math.round(fromBox.y1), 0, naturalH - 1),
      x2: clamp(Math.round(fromBox.x2), 1, naturalW),
      y2: clamp(Math.round(fromBox.y2), 1, naturalH),
    };
  } else {
    const mx = naturalW >= 20 ? Math.round(naturalW * 0.1) : 0;
    const my = naturalH >= 20 ? Math.round(naturalH * 0.1) : 0;
    cropRect = {
      x1: mx,
      y1: my,
      x2: Math.max(mx + 1, naturalW - mx),
      y2: Math.max(my + 1, naturalH - my),
    };
  }
  syncCropUi();
}

function syncCropUi() {
  cropXField.input.value = String(cropRect.x1);
  cropYField.input.value = String(cropRect.y1);
  cropWField.input.value = String(Math.max(1, cropRect.x2 - cropRect.x1));
  cropHField.input.value = String(Math.max(1, cropRect.y2 - cropRect.y1));
  renderOverlay();
}

// ---------------------------------------------------------------- encoding & conversion

function currentExt(): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : 'png';
}

function currentNativeFormat(): ImageExportFormat {
  const ext = currentExt();
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg';
  if (ext === 'webp') return 'webp';
  if (ext === 'bmp') return 'bmp';
  if (ext === 'ico') return 'ico';
  return 'png';
}

function canvasToBytes(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error(`Failed to encode ${mime}`));
          return;
        }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      },
      mime,
      quality,
    );
  });
}

async function encodeCanvas(canvas: HTMLCanvasElement, format: ImageExportFormat): Promise<Uint8Array> {
  const w = canvas.width;
  const h = canvas.height;
  if (format === 'bmp') {
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.getImageData(0, 0, w, h);
    return encodeBmp(imgData.data, imgData.width, imgData.height);
  }
  if (format === 'ico') {
    const maxSide = 256;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const iw = Math.max(1, Math.round(w * scale));
    const ih = Math.max(1, Math.round(h * scale));
    const iconCanvas = document.createElement('canvas');
    iconCanvas.width = iw;
    iconCanvas.height = ih;
    iconCanvas.getContext('2d')!.drawImage(canvas, 0, 0, w, h, 0, 0, iw, ih);
    const pngBytes = await canvasToBytes(iconCanvas, 'image/png');
    return encodeIcoFromPng(pngBytes, iw, ih);
  }
  if (format === 'jpg') {
    const jpgCanvas = document.createElement('canvas');
    jpgCanvas.width = w;
    jpgCanvas.height = h;
    const ctx = jpgCanvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(canvas, 0, 0);
    return canvasToBytes(jpgCanvas, 'image/jpeg', 0.92);
  }
  if (format === 'webp') {
    return canvasToBytes(canvas, 'image/webp', 0.92);
  }
  return canvasToBytes(canvas, 'image/png');
}

async function encodeRegion(rect: PixelRect, format: ImageExportFormat): Promise<Uint8Array> {
  if (!sourceCanvas || !sampleCtx) {
    throw new Error('Image is not ready');
  }
  const w = Math.max(1, Math.round(rect.x2 - rect.x1));
  const h = Math.max(1, Math.round(rect.y2 - rect.y1));

  if (format === 'bmp') {
    const imgData = sampleCtx.getImageData(rect.x1, rect.y1, w, h);
    return encodeBmp(imgData.data, imgData.width, imgData.height);
  }

  const outCanvas = document.createElement('canvas');
  outCanvas.width = w;
  outCanvas.height = h;
  outCanvas.getContext('2d')!.drawImage(sourceCanvas, rect.x1, rect.y1, w, h, 0, 0, w, h);
  return encodeCanvas(outCanvas, format);
}

function fullRect(): PixelRect {
  return { x1: 0, y1: 0, x2: naturalW, y2: naturalH };
}

async function convertCurrentImageTo(format: ImageExportFormat): Promise<void> {
  if (!naturalW || !naturalH) {
    return;
  }
  const bytes = await encodeRegion(fullRect(), format);
  post({ type: 'saveImageAs', format, bytes });
}

async function saveCropCopy(): Promise<void> {
  if (!naturalW || !naturalH) {
    return;
  }
  const fmt = currentNativeFormat();
  const bytes = await encodeRegion(cropRect, fmt);
  post({ type: 'saveImageAs', format: fmt, bytes, suffix: '-crop' });
}

async function applyCropInPlace(): Promise<void> {
  if (!naturalW || !naturalH) {
    return;
  }
  const w = cropRect.x2 - cropRect.x1;
  const h = cropRect.y2 - cropRect.y1;
  if (w <= 0 || h <= 0 || (w === naturalW && h === naturalH)) {
    setToolMode('inspect');
    return;
  }
  const ext = currentExt();
  if (ext === 'svg' && rawFileBytes) {
    const svgText = new TextDecoder().decode(rawFileBytes);
    const nextSvg = cropSvgMarkup(svgText, naturalW, naturalH, cropRect);
    setToolMode('inspect');
    post({ type: 'imageReplace', bytes: nextSvg, label: 'Crop SVG' });
    return;
  }
  if (ext === 'gif' || ext === 'avif') {
    notice.flash(t('imgCropReadonlyFmt'), 4200);
    await saveCropCopy();
    return;
  }
  const bytes = await encodeRegion(cropRect, currentNativeFormat());
  setToolMode('inspect');
  post({ type: 'imageReplace', bytes, label: 'Crop image' });
}

// ---------------------------------------------------------------- Rotate, Flip & Resize

async function applyTransform(op: ImageTransformOp): Promise<void> {
  if (!sourceCanvas || !naturalW || !naturalH) {
    return;
  }
  const outW = op === 'rotCW' || op === 'rotCCW' ? naturalH : naturalW;
  const outH = op === 'rotCW' || op === 'rotCCW' ? naturalW : naturalH;
  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  const ctx = outCanvas.getContext('2d')!;
  ctx.save();
  if (op === 'rotCW') {
    ctx.translate(outW, 0);
    ctx.rotate(Math.PI / 2);
  } else if (op === 'rotCCW') {
    ctx.translate(0, outH);
    ctx.rotate(-Math.PI / 2);
  } else if (op === 'flipH') {
    ctx.translate(outW, 0);
    ctx.scale(-1, 1);
  } else if (op === 'flipV') {
    ctx.translate(0, outH);
    ctx.scale(1, -1);
  }
  ctx.drawImage(sourceCanvas, 0, 0);
  ctx.restore();

  const ext = currentExt();
  if (ext === 'gif' || ext === 'avif' || ext === 'svg') {
    notice.flash(t('imgCropReadonlyFmt'), 4200);
    const pngBytes = await encodeCanvas(outCanvas, 'png');
    post({ type: 'saveImageAs', format: 'png', bytes: pngBytes, suffix: `-${op}` });
    return;
  }

  // Keep existing BBoxes aligned with the rotated/flipped image!
  if (boxes.length > 0) {
    boxes = boxes.map((b) => {
      if (op === 'rotCW') {
        return { ...b, x1: naturalH - b.y2, y1: b.x1, x2: naturalH - b.y1, y2: b.x2 };
      }
      if (op === 'rotCCW') {
        return { ...b, x1: b.y1, y1: naturalW - b.x2, x2: b.y2, y2: naturalW - b.x1 };
      }
      if (op === 'flipH') {
        return { ...b, x1: naturalW - b.x2, x2: naturalW - b.x1 };
      }
      return { ...b, y1: naturalH - b.y2, y2: naturalH - b.y1 };
    });
  }

  const labelKey =
    op === 'rotCCW' ? 'imgRotateCCW' : op === 'rotCW' ? 'imgRotateCW' : op === 'flipH' ? 'imgFlipH' : 'imgFlipV';
  const bytes = await encodeCanvas(outCanvas, currentNativeFormat());
  post({ type: 'imageReplace', bytes, label: t(labelKey) });
}

let resizeOpen = false;
let lockResizeRatio = true;

const resizeWInput = el('input', { class: 'dv-input img-crop-num' });
resizeWInput.type = 'number';
resizeWInput.min = '1';
resizeWInput.max = '16384';
resizeWInput.step = '1';

const resizeHInput = el('input', { class: 'dv-input img-crop-num' });
resizeHInput.type = 'number';
resizeHInput.min = '1';
resizeHInput.max = '16384';
resizeHInput.step = '1';

resizeWInput.addEventListener('input', () => {
  const w = Number(resizeWInput.value);
  if (lockResizeRatio && naturalW > 0 && naturalH > 0 && Number.isFinite(w) && w > 0) {
    resizeHInput.value = String(Math.max(1, Math.round((w * naturalH) / naturalW)));
  }
});

resizeHInput.addEventListener('input', () => {
  const h = Number(resizeHInput.value);
  if (lockResizeRatio && naturalW > 0 && naturalH > 0 && Number.isFinite(h) && h > 0) {
    resizeWInput.value = String(Math.max(1, Math.round((h * naturalW) / naturalH)));
  }
});

for (const inp of [resizeWInput, resizeHInput]) {
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      inp.blur();
      void applyResizeInPlace();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setResizeOpen(false);
    }
    e.stopPropagation();
  });
}

const lockRatioChk = el('input');
lockRatioChk.type = 'checkbox';
lockRatioChk.checked = true;
lockRatioChk.addEventListener('change', () => {
  lockResizeRatio = lockRatioChk.checked;
  if (lockResizeRatio && naturalW > 0 && naturalH > 0) {
    const w = Number(resizeWInput.value);
    if (Number.isFinite(w) && w > 0) {
      resizeHInput.value = String(Math.max(1, Math.round((w * naturalH) / naturalW)));
    }
  }
});

function makeResizeScaleBtn(pct: number): HTMLButtonElement {
  const btn = el('button', { class: 'dv-btn', text: `${pct}%` });
  btn.type = 'button';
  btn.addEventListener('click', () => {
    if (!naturalW || !naturalH) return;
    resizeWInput.value = String(Math.max(1, Math.round((naturalW * pct) / 100)));
    resizeHInput.value = String(Math.max(1, Math.round((naturalH * pct) / 100)));
  });
  return btn;
}

const cancelResizeBtn = el('button', { class: 'dv-btn', text: t('cancel') });
cancelResizeBtn.type = 'button';
cancelResizeBtn.addEventListener('click', () => setResizeOpen(false));

const applyResizeBtn = el('button', { class: 'dv-btn dv-cm-primary', text: t('imgApplyResize') });
applyResizeBtn.type = 'button';
applyResizeBtn.addEventListener('click', () => void applyResizeInPlace());

const resizeBar = el('div', { class: 'img-crop-bar img-resize-bar' }, [
  el('label', { class: 'img-crop-field' }, [el('span', { text: 'W' }), resizeWInput]),
  el('span', { class: 'dv-label', text: '×' }),
  el('label', { class: 'img-crop-field' }, [el('span', { text: 'H' }), resizeHInput]),
  el('span', { class: 'dv-label', text: 'px' }),
  el('label', { class: 'img-lock-ratio' }, [lockRatioChk, el('span', { text: t('imgLockRatio') })]),
  makeResizeScaleBtn(50),
  makeResizeScaleBtn(200),
  el('div', { class: 'dv-spacer' }),
  cancelResizeBtn,
  applyResizeBtn,
]);
resizeBar.hidden = true;

const resizeBtn = iconButton('resize', t('imgResize'), () => setResizeOpen(!resizeOpen));

function setResizeOpen(open: boolean) {
  resizeOpen = open;
  resizeBar.hidden = !open;
  resizeBtn.classList.toggle('dv-active', open);
  if (open) {
    if (toolMode === 'crop') {
      setToolMode('inspect');
    }
    if (naturalW && naturalH) {
      resizeWInput.value = String(naturalW);
      resizeHInput.value = String(naturalH);
    }
    resizeWInput.focus();
    resizeWInput.select();
  }
}

async function applyResizeInPlace(): Promise<void> {
  if (!sourceCanvas || !naturalW || !naturalH) {
    return;
  }
  const targetW = clamp(Math.round(Number(resizeWInput.value) || naturalW), 1, 16384);
  const targetH = clamp(Math.round(Number(resizeHInput.value) || naturalH), 1, 16384);
  if (targetW === naturalW && targetH === naturalH) {
    setResizeOpen(false);
    return;
  }
  const ext = currentExt();
  if (boxes.length > 0) {
    const sx = targetW / naturalW;
    const sy = targetH / naturalH;
    boxes = boxes.map((b) => ({
      ...b,
      x1: clamp(Math.round(b.x1 * sx), 0, targetW - 1),
      y1: clamp(Math.round(b.y1 * sy), 0, targetH - 1),
      x2: clamp(Math.max(1, Math.round(b.x2 * sx)), 1, targetW),
      y2: clamp(Math.max(1, Math.round(b.y2 * sy)), 1, targetH),
    }));
  }
  if (ext === 'svg' && rawFileBytes) {
    const svgText = new TextDecoder().decode(rawFileBytes);
    const nextSvg = resizeSvgMarkup(svgText, naturalW, naturalH, targetW, targetH);
    setResizeOpen(false);
    post({ type: 'imageReplace', bytes: nextSvg, label: t('imgApplyResize') });
    return;
  }
  const outCanvas = document.createElement('canvas');
  outCanvas.width = targetW;
  outCanvas.height = targetH;
  const ctx = outCanvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, naturalW, naturalH, 0, 0, targetW, targetH);

  setResizeOpen(false);
  if (ext === 'gif' || ext === 'avif') {
    notice.flash(t('imgCropReadonlyFmt'), 4200);
    const pngBytes = await encodeCanvas(outCanvas, 'png');
    post({ type: 'saveImageAs', format: 'png', bytes: pngBytes, suffix: `-${targetW}x${targetH}` });
    return;
  }
  const bytes = await encodeCanvas(outCanvas, currentNativeFormat());
  post({ type: 'imageReplace', bytes, label: t('imgApplyResize') });
}

// ---------------------------------------------------------------- BBox sidebar

const sidebar = new Sidebar(t('imgBoxes', 0), undefined, { defaultOpen: false });
const sideTitleEl = sidebar.node.querySelector('.dv-side-title');

function clearAllBoxes() {
  boxes = [];
  selectedBoxId = undefined;
  renderBoxes();
}

function copyBoxesJson() {
  if (!boxes.length) {
    return;
  }
  const payload = boxes.map((b) => {
    const [x1, y1, x2, y2] = formatBBoxTuple(b);
    const { w, h } = bboxDimensions(b);
    return { id: b.id, bbox: [x1, y1, x2, y2], width: w, height: h };
  });
  copyText(JSON.stringify(payload));
}

const boxInput = el('input', { class: 'dv-input' });
boxInput.type = 'text';
boxInput.placeholder = '[x1, y1, x2, y2] (px)';
boxInput.setAttribute('aria-label', '[x1, y1, x2, y2]');
const addBoxBtn = iconButton('plus', t('imgModeBbox'), () => addBoxFromInput());

const sidebarCopyJsonBtn = el('button', { class: 'dv-btn', text: t('imgCopyJson') });
sidebarCopyJsonBtn.type = 'button';
sidebarCopyJsonBtn.addEventListener('click', copyBoxesJson);

const sidebarClearBtn = el('button', { class: 'dv-btn', text: t('imgClearBoxes') });
sidebarClearBtn.type = 'button';
sidebarClearBtn.addEventListener('click', clearAllBoxes);

const boxList = el('div', { class: 'img-box-list' });
sidebar.panel().append(
  el('div', { class: 'img-side-wrap' }, [
    el('div', { class: 'img-add-box-row' }, [boxInput, addBoxBtn]),
    el('div', { class: 'img-side-actions' }, [sidebarCopyJsonBtn, sidebarClearBtn]),
    boxList,
  ]),
);

function addBoxFromInput() {
  const parsed = parseBBoxInput(boxInput.value, naturalW, naturalH);
  if (!parsed) {
    return;
  }
  const box: BBox = {
    id: nextBoxId++,
    ...parsed,
    color: BBOX_PALETTE[boxes.length % BBOX_PALETTE.length],
  };
  boxes.push(box);
  selectedBoxId = box.id;
  boxInput.value = '';
  renderBoxes();
}

boxInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addBoxFromInput();
  }
  e.stopPropagation();
});

// ---------------------------------------------------------------- toolbar

const modeSeg = segmented<ToolMode>(
  t('view'),
  [
    ['inspect', t('imgModePan')],
    ['bbox', t('imgModeBbox')],
    ['crop', t('imgModeCrop')],
  ],
  toolMode,
  (mode) => setToolMode(mode),
);

const loupePosSeg = segmented<LoupePosition>(
  t('loupePosition'),
  [
    ['follow', t('loupeFollow')],
    ['fixed', t('loupeFixed')],
  ],
  getAppearance().loupePosition,
  (pos) => {
    updateAppearance({ loupePosition: pos });
    syncLoupeVisibility();
  },
);

onAppearanceChange((a) => {
  loupePosSeg.set(a.loupePosition);
  syncLoupeVisibility();
});

const zoomLabel = el('button', { class: 'dv-btn dv-label dv-zoom-label', text: '100%', title: t('zoomReset') });
zoomLabel.type = 'button';
zoomLabel.addEventListener('click', () => setZoom(1));

const zoomGroup = el('div', { class: 'dv-zoom' }, [
  iconButton('minus', t('zoomOut'), () => stepZoom(-1)),
  zoomLabel,
  iconButton('plus', t('zoomIn'), () => stepZoom(1)),
  iconButton('fitWidth', t('fitWidth'), () => fitToStage()),
]);

const IMAGE_CONVERT_FORMATS: ImageExportFormat[] = ['png', 'jpg', 'webp', 'bmp', 'ico'];

function convertMenuItems(): MenuItem[] {
  return IMAGE_CONVERT_FORMATS.map((fmt) => ({
    icon: 'export' as const,
    label: () => t('convertTo', fmt.toUpperCase()),
    visible: () => {
      const ext = currentExt();
      const normExt = ext === 'jpeg' ? 'jpg' : ext;
      return normExt !== fmt;
    },
    onClick: () => void convertCurrentImageTo(fmt),
  }));
}

const convertDropdown = moreMenu(t('convertMenu'), convertMenuItems(), 'export');
const rotCCWBtn = iconButton('rotateCCW', t('imgRotateCCW'), () => void applyTransform('rotCCW'));
const rotCWBtn = iconButton('rotateCW', t('imgRotateCW'), () => void applyTransform('rotCW'));
const flipHBtn = iconButton('flipH', t('imgFlipH'), () => void applyTransform('flipH'));
const flipVBtn = iconButton('flipV', t('imgFlipV'), () => void applyTransform('flipV'));

const clearBtn = el('button', { class: 'dv-btn', text: t('imgClearBoxes') });
clearBtn.type = 'button';
clearBtn.addEventListener('click', clearAllBoxes);

const copyJsonBtn = el('button', { class: 'dv-btn', text: t('imgCopyJson') });
copyJsonBtn.type = 'button';
copyJsonBtn.addEventListener('click', copyBoxesJson);

const historyBtn = iconButton('history', t('history'), () => post({ type: 'history' }));

const topBar = customToolbar({
  subtitle: () => (fileName ? fileName : 'IMAGE'),
  slots: [
    { id: 'nav', nodes: [sidebar.toggle] },
    { id: 'view', nodes: [modeSeg.node] },
    { id: 'zoom', nodes: [zoomGroup] },
    {
      id: 'bbox',
      nodes: [rotCCWBtn, rotCWBtn, flipHBtn, flipVBtn, resizeBtn, loupePosSeg.node, convertDropdown, copyJsonBtn, clearBtn],
    },
    { id: 'history', nodes: [historyBtn], visible: () => getFileState().history },
    { id: 'openApp', nodes: [openExternalButton()] },
  ],
  documentActions: [
    openExternalMenuItem(),
    { label: t('imgRotateCCW'), icon: 'rotateCCW', onClick: () => void applyTransform('rotCCW') },
    { label: t('imgRotateCW'), icon: 'rotateCW', onClick: () => void applyTransform('rotCW') },
    { label: t('imgFlipH'), icon: 'flipH', onClick: () => void applyTransform('flipH') },
    { label: t('imgFlipV'), icon: 'flipV', onClick: () => void applyTransform('flipV') },
    { label: t('imgResize'), icon: 'resize', onClick: () => setResizeOpen(true) },
    ...convertMenuItems(),
    { label: t('history'), icon: 'history', visible: () => getFileState().history, onClick: () => post({ type: 'history' }) },
  ],
  documentOptions: [
    {
      label: t('imgGrid'),
      checked: () => showGrid,
      onChange: (on) => {
        showGrid = on;
        writeState({ imgGrid: on });
        applyZoomLayout();
      },
    },
    {
      label: t('imgChecker'),
      checked: () => checkerboard,
      onChange: (on) => {
        checkerboard = on;
        writeState({ imgChecker: on });
        canvasWrap.classList.toggle('img-checker', checkerboard);
      },
    },
  ],
});

function syncBboxToolbarButtons() {
  const showBboxBtns = toolMode === 'bbox' || boxes.length > 0;
  if (copyJsonBtn.hidden === showBboxBtns || clearBtn.hidden === showBboxBtns) {
    copyJsonBtn.hidden = !showBboxBtns;
    clearBtn.hidden = !showBboxBtns;
    topBar.refresh();
  }
}

function setToolMode(mode: ToolMode, seedCrop?: PixelRect) {
  toolMode = mode;
  modeSeg.set(mode);
  writeState({ imgMode: mode });
  stage.classList.toggle('img-mode-inspect', mode === 'inspect');
  stage.classList.toggle('img-mode-bbox', mode === 'bbox');
  stage.classList.toggle('img-mode-crop', mode === 'crop');
  cropBar.hidden = mode !== 'crop';
  if (mode === 'crop') {
    if (resizeOpen) {
      setResizeOpen(false);
    }
    const activeBox = seedCrop ?? boxes.find((b) => b.id === selectedBoxId);
    initDefaultCropRect(activeBox);
    if (getAppearance().loupePosition === 'follow') {
      loupe.hidden = true;
    }
  } else {
    syncLoupeVisibility();
    renderOverlay();
  }
  syncBboxToolbarButtons();
}

canvasWrap.classList.toggle('img-checker', checkerboard);

app.append(
  topBar.node,
  cropBar,
  resizeBar,
  notice.node,
  el('div', { class: 'dv-body' }, [sidebar.node, el('div', { class: 'dv-main' }, [sidebar.expandBtn, stage])]),
  loupe,
  toast,
  statusBar,
);

// ---------------------------------------------------------------- zoom & layout

function updateMetaLabel() {
  if (!naturalW || !naturalH) {
    metaLabel.textContent = fileName;
    return;
  }
  metaLabel.textContent = `${fileName} · ${naturalW} × ${naturalH} px`;
}

function applyZoomLayout() {
  if (!naturalW || !naturalH) {
    return;
  }
  const dispW = Math.max(1, Math.round(naturalW * zoom));
  const dispH = Math.max(1, Math.round(naturalH * zoom));
  canvasWrap.style.width = `${dispW}px`;
  canvasWrap.style.height = `${dispH}px`;
  canvasWrap.classList.toggle('img-pixelated', zoom >= 3);
  overlaySvg.setAttribute('viewBox', `0 0 ${dispW} ${dispH}`);
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;

  if (showGrid && zoom >= 8) {
    gridOverlay.hidden = false;
    gridOverlay.style.backgroundSize = `${zoom}px ${zoom}px`;
  } else {
    gridOverlay.hidden = true;
  }
  renderOverlay();
}

function setZoom(next: number, focalClientX?: number, focalClientY?: number) {
  const clamped = clamp(next, 0.05, 64);
  if (!naturalW || !naturalH) {
    zoom = clamped;
    return;
  }
  const prevZoom = zoom;
  const rect = canvasWrap.getBoundingClientRect();
  const fx = focalClientX !== undefined ? (focalClientX - rect.left) / prevZoom : stage.clientWidth / 2 / prevZoom;
  const fy = focalClientY !== undefined ? (focalClientY - rect.top) / prevZoom : stage.clientHeight / 2 / prevZoom;

  zoom = clamped;
  applyZoomLayout();

  if (focalClientX !== undefined && focalClientY !== undefined) {
    const afterRect = canvasWrap.getBoundingClientRect();
    stage.scrollLeft += afterRect.left + fx * zoom - focalClientX;
    stage.scrollTop += afterRect.top + fy * zoom - focalClientY;
  }
}

function stepZoom(dir: -1 | 1) {
  if (dir > 0) {
    const next = ZOOM_STEPS.find((z) => z > zoom + 0.01) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
    setZoom(next);
  } else {
    const prev = [...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.01) ?? ZOOM_STEPS[0];
    setZoom(prev);
  }
}

function fitToStage() {
  if (!naturalW || !naturalH) {
    return;
  }
  const availW = Math.max(64, stage.clientWidth - 64);
  const availH = Math.max(64, stage.clientHeight - 64);
  setZoom(Math.min(1, availW / naturalW, availH / naturalH));
}

stage.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      setZoom(zoom * factor, e.clientX, e.clientY);
    }
  },
  { passive: false },
);

// ---------------------------------------------------------------- pixel sampling & 15x11 loupe

function samplePixel(x: number, y: number): [number, number, number, number] {
  const px = clamp(x, 0, naturalW - 1);
  const py = clamp(y, 0, naturalH - 1);
  if (sampleCtx) {
    const d = sampleCtx.getImageData(px, py, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }
  return [0, 0, 0, 255];
}

function syncLoupeVisibility() {
  if (!naturalW || !naturalH || canvasWrap.hidden) {
    loupe.hidden = true;
    return;
  }
  const fixed = getAppearance().loupePosition === 'fixed';
  loupe.classList.toggle('img-loupe-fixed', fixed);
  loupeDragHintEl.hidden = !fixed;
  if (fixed) {
    const pt = hoverPx ?? lastSampledPx;
    updatePixelReadout(pt.x, pt.y);
    loupe.hidden = false;
    positionLoupe();
  } else {
    loupe.style.right = '';
    loupe.style.bottom = '';
    if (hoverPx && toolMode !== 'crop') {
      loupe.hidden = false;
      positionLoupe();
    } else {
      loupe.hidden = true;
    }
  }
}

function positionLoupe() {
  const fixed = getAppearance().loupePosition === 'fixed';
  loupe.classList.toggle('img-loupe-fixed', fixed);
  loupeDragHintEl.hidden = !fixed;
  if (fixed) {
    if (fixedLoupeOffset) {
      const w = loupe.offsetWidth || 160;
      const h = loupe.offsetHeight || 215;
      loupe.style.left = `${clamp(fixedLoupeOffset.x, 8, Math.max(8, window.innerWidth - w - 8))}px`;
      loupe.style.top = `${clamp(fixedLoupeOffset.y, 40, Math.max(40, window.innerHeight - h - 34))}px`;
      loupe.style.right = 'auto';
      loupe.style.bottom = 'auto';
    } else {
      loupe.style.left = '';
      loupe.style.top = '';
      loupe.style.right = '18px';
      loupe.style.bottom = '42px';
    }
    return;
  }
  loupe.style.right = '';
  loupe.style.bottom = '';
  if (!lastPointerClient || loupe.hidden) {
    return;
  }
  const offset = 20;
  const w = loupe.offsetWidth || 160;
  const h = loupe.offsetHeight || 210;
  let left = lastPointerClient.x + offset;
  let top = lastPointerClient.y + offset;
  if (left + w + 8 > window.innerWidth) {
    left = Math.max(8, lastPointerClient.x - w - offset);
  }
  if (top + h + 32 > window.innerHeight) {
    top = Math.max(8, lastPointerClient.y - h - offset);
  }
  loupe.style.left = `${left}px`;
  loupe.style.top = `${top}px`;
}

function paintLoupe(cx: number, cy: number) {
  loupeCtx.clearRect(0, 0, LOUPE_W, LOUPE_H);

  // Read only the <= 15x11 visible pixel patch once per frame (<= 660 bytes, zero full-image buffer!).
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

  // 4. Center pixel [·] reticle matching reference screenshot
  loupeCtx.strokeStyle = 'rgba(0, 0, 0, 0.78)';
  loupeCtx.lineWidth = 1;
  loupeCtx.strokeRect(cxPx - 0.5, cyPx - 0.5, LOUPE_PX + 1, LOUPE_PX + 1);
  loupeCtx.strokeStyle = '#ffffff';
  loupeCtx.lineWidth = 1.6;
  loupeCtx.strokeRect(cxPx + 0.5, cyPx + 0.5, LOUPE_PX - 1, LOUPE_PX - 1);
}

function refreshLoupeColorLabel() {
  if (!currentColorValues) {
    return;
  }
  loupeColorText.textContent = colorMode === 'hex' ? currentColorValues.hex : currentColorValues.rgbDisplay;
}

function updatePixelReadout(x: number, y: number) {
  lastSampledPx = { x, y };
  const [r, g, b, a] = samplePixel(x, y);
  const hex = rgbToHex(r, g, b);
  const rgbDisplay = a >= 255 ? `${r},  ${g},  ${b}` : `${r}, ${g}, ${b}, ${(a / 255).toFixed(2)}`;
  const rgbCopy = a >= 255 ? `${r}, ${g}, ${b}` : formatRgb(r, g, b, a);
  currentColorValues = { rgbDisplay, rgbCopy, hex };

  const coordStr = `(${x} ,  ${y})`;
  coordPill.textContent = `(${x}, ${y})`;
  swatchDot.style.background = hex;
  hexText.textContent = hex;
  rgbPill.textContent = rgbCopy;

  loupeCoord.textContent = coordStr;
  loupeSwatch.style.background = hex;
  loupeColorText.textContent = colorMode === 'hex' ? hex : rgbDisplay;
  paintLoupe(x, y);

  if (getAppearance().loupePosition === 'fixed' || toolMode !== 'crop') {
    loupe.hidden = false;
    positionLoupe();
  }
}

// ---------------------------------------------------------------- overlay (BBox & Crop) rendering

let draftBox: { x1: number; y1: number; x2: number; y2: number; color: string } | undefined;

function clientToImageFloat(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvasWrap.getBoundingClientRect();
  return {
    x: (clientX - rect.left) / zoom,
    y: (clientY - rect.top) / zoom,
  };
}

function renderOverlay() {
  if (!naturalW || !naturalH) {
    overlaySvg.replaceChildren();
    badgesLayer.replaceChildren();
    return;
  }
  const dispW = Math.max(1, Math.round(naturalW * zoom));
  const dispH = Math.max(1, Math.round(naturalH * zoom));
  const svgNodes: SVGElement[] = [];
  const badgeNodes: HTMLElement[] = [];

  if (toolMode === 'crop') {
    const cx1 = cropRect.x1 * zoom;
    const cy1 = cropRect.y1 * zoom;
    const cw = Math.max(1, (cropRect.x2 - cropRect.x1) * zoom);
    const ch = Math.max(1, (cropRect.y2 - cropRect.y1) * zoom);
    const cx2 = cx1 + cw;
    const cy2 = cy1 + ch;

    // 4 dark outside masks
    const masks: [number, number, number, number][] = [
      [0, 0, dispW, cy1],
      [0, cy2, dispW, Math.max(0, dispH - cy2)],
      [0, cy1, cx1, ch],
      [cx2, cy1, Math.max(0, dispW - cx2), ch],
    ];
    for (const [mx, my, mw, mh] of masks) {
      if (mw > 0 && mh > 0) {
        svgNodes.push(
          svgEl('rect', {
            class: 'img-crop-mask',
            x: String(mx),
            y: String(my),
            width: String(mw),
            height: String(mh),
          }),
        );
      }
    }

    const g = svgEl('g', { class: 'img-crop-group' });
    const bodyRect = svgEl('rect', {
      class: 'img-crop-rect',
      x: String(cx1),
      y: String(cy1),
      width: String(cw),
      height: String(ch),
    });
    bodyRect.dataset.cropMove = '1';
    g.append(bodyRect);

    // Rule of thirds (3x3 guide lines)
    for (const frac of [1 / 3, 2 / 3]) {
      const gx = cx1 + cw * frac;
      const gy = cy1 + ch * frac;
      g.append(
        svgEl('line', { class: 'img-crop-guide', x1: String(gx), y1: String(cy1), x2: String(gx), y2: String(cy2) }),
        svgEl('line', { class: 'img-crop-guide', x1: String(cx1), y1: String(gy), x2: String(cx2), y2: String(gy) }),
      );
    }

    const handles: [ResizeHandle, number, number, string][] = [
      ['nw', cx1, cy1, 'nwse-resize'],
      ['n', cx1 + cw / 2, cy1, 'ns-resize'],
      ['ne', cx2, cy1, 'nesw-resize'],
      ['e', cx2, cy1 + ch / 2, 'ew-resize'],
      ['se', cx2, cy2, 'nwse-resize'],
      ['s', cx1 + cw / 2, cy2, 'ns-resize'],
      ['sw', cx1, cy2, 'nesw-resize'],
      ['w', cx1, cy1 + ch / 2, 'ew-resize'],
    ];
    for (const [kind, hx, hy, cursor] of handles) {
      const hNode = svgEl('rect', {
        class: 'img-crop-handle',
        x: String(hx - 4.5),
        y: String(hy - 4.5),
        width: '9',
        height: '9',
        rx: '1.5',
        style: `cursor:${cursor}`,
      });
      hNode.dataset.cropHandle = kind;
      g.append(hNode);
    }
    svgNodes.push(g);

    const { w, h } = bboxDimensions(cropRect);
    const cropBadge = el('div', {
      class: 'img-bbox-badge img-crop-badge',
      text: `${w} × ${h} px  (${cropRect.x1}, ${cropRect.y1})`,
    });
    cropBadge.style.left = `${cx1}px`;
    cropBadge.style.top = `${cy1 >= 24 ? cy1 - 24 : cy1 + 4}px`;
    badgeNodes.push(cropBadge);

    overlaySvg.replaceChildren(...svgNodes);
    badgesLayer.replaceChildren(...badgeNodes);
    return;
  }

  // Crosshair & hovered pixel frame
  if (hoverPx) {
    const sx = (hoverPx.x + 0.5) * zoom;
    const sy = (hoverPx.y + 0.5) * zoom;
    svgNodes.push(
      svgEl('line', { class: 'img-crosshair', x1: String(sx), y1: '0', x2: String(sx), y2: String(dispH) }),
      svgEl('line', { class: 'img-crosshair', x1: '0', y1: String(sy), x2: String(dispW), y2: String(sy) }),
    );
    if (zoom >= 4) {
      svgNodes.push(
        svgEl('rect', {
          class: 'img-hover-px',
          x: String(hoverPx.x * zoom),
          y: String(hoverPx.y * zoom),
          width: String(zoom),
          height: String(zoom),
        }),
      );
    }
  }

  const drawOneBox = (
    b: { id?: number; x1: number; y1: number; x2: number; y2: number; color: string },
    selected: boolean,
  ) => {
    const rx = b.x1 * zoom;
    const ry = b.y1 * zoom;
    const rw = Math.max(1, (b.x2 - b.x1) * zoom);
    const rh = Math.max(1, (b.y2 - b.y1) * zoom);

    const g = svgEl('g', {
      class: selected ? 'img-bbox-group img-bbox-selected' : 'img-bbox-group',
    });
    const rect = svgEl('rect', {
      class: 'img-bbox-rect',
      x: String(rx),
      y: String(ry),
      width: String(rw),
      height: String(rh),
      stroke: b.color,
      fill: b.color,
    });
    if (b.id !== undefined) {
      rect.dataset.boxId = String(b.id);
    }
    g.append(rect);

    if (b.id !== undefined && selected) {
      for (const [corner, cx, cy, cursor] of [
        ['nw', rx, ry, 'nwse-resize'],
        ['ne', rx + rw, ry, 'nesw-resize'],
        ['sw', rx, ry + rh, 'nesw-resize'],
        ['se', rx + rw, ry + rh, 'nwse-resize'],
      ] as const) {
        const h = svgEl('circle', {
          class: 'img-bbox-handle',
          cx: String(cx),
          cy: String(cy),
          r: '4',
          fill: '#ffffff',
          stroke: b.color,
          style: `cursor:${cursor}`,
        });
        h.dataset.boxId = String(b.id);
        h.dataset.handle = corner;
        g.append(h);
      }
    }
    svgNodes.push(g);

    const tuple = formatBBoxTuple(b);
    const { w, h } = bboxDimensions(b);
    const tupleText = `[${tuple.join(', ')}]`;
    const prefix = b.id !== undefined ? `#${b.id} ` : '';
    const badge = el('div', {
      class: 'img-bbox-badge',
      text: `${prefix}${tupleText} · ${w}×${h}`,
      title: tupleText,
    });
    badge.style.background = b.color;
    badge.style.left = `${rx}px`;
    badge.style.top = `${ry >= 22 ? ry - 22 : ry + 2}px`;
    badge.addEventListener('mousedown', (ev) => ev.stopPropagation());
    badge.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (b.id !== undefined) {
        selectedBoxId = b.id;
        renderBoxes();
      }
      copyText(tupleText);
    });
    badgeNodes.push(badge);
  };

  for (const b of boxes) {
    drawOneBox(b, b.id === selectedBoxId);
  }
  if (draftBox) {
    drawOneBox(draftBox, true);
  }

  overlaySvg.replaceChildren(...svgNodes);
  badgesLayer.replaceChildren(...badgeNodes);
}

function renderBoxes() {
  if (sideTitleEl) {
    sideTitleEl.textContent = t('imgBoxes', boxes.length);
  }
  const empty = boxes.length === 0;
  clearBtn.disabled = empty;
  copyJsonBtn.disabled = empty;
  sidebarClearBtn.disabled = empty;
  sidebarCopyJsonBtn.disabled = empty;
  syncBboxToolbarButtons();
  if (fileName) {
    writeState({ savedBoxesFile: fileName, savedBoxes: boxes });
  }

  if (!boxes.length) {
    boxList.replaceChildren(el('div', { class: 'img-box-empty', text: t('imgNoBoxes') }));
  } else {
    boxList.replaceChildren(
      ...boxes.map((b) => {
        const tuple = formatBBoxTuple(b);
        const tupleStr = `[${tuple.join(', ')}]`;
        const { w, h } = bboxDimensions(b);

        const dot = el('span', { class: 'img-color-dot' });
        dot.style.background = b.color;

        const cropToBtn = iconButton('crop', t('imgCropToBox'), () => {
          setToolMode('crop', b);
        });
        cropToBtn.classList.add('img-box-mini');
        cropToBtn.addEventListener('click', (e) => e.stopPropagation());

        const copyBtn = iconButton('check', t('copy'), () => copyText(tupleStr));
        copyBtn.innerHTML = icons.export;
        copyBtn.classList.add('img-box-mini');
        copyBtn.addEventListener('click', (e) => e.stopPropagation());

        const delBtn = iconButton('close', t('imgDeleteBox'), () => {
          boxes = boxes.filter((x) => x.id !== b.id);
          if (selectedBoxId === b.id) {
            selectedBoxId = boxes[boxes.length - 1]?.id;
          }
          renderBoxes();
        });
        delBtn.classList.add('img-box-mini');
        delBtn.addEventListener('click', (e) => e.stopPropagation());

        const card = el(
          'div',
          { class: b.id === selectedBoxId ? 'img-box-card img-box-active' : 'img-box-card' },
          [
            el('div', { class: 'img-box-head' }, [
              dot,
              el('span', { text: `#${b.id}` }),
              el('span', { class: 'img-box-dim', text: `${w} × ${h} px` }),
              el('span', { class: 'img-box-actions' }, [cropToBtn, copyBtn, delBtn]),
            ]),
            el('div', { class: 'img-box-coords', text: tupleStr }),
          ],
        );
        card.addEventListener('click', () => {
          selectedBoxId = b.id;
          renderBoxes();
        });
        return card;
      }),
    );
  }
  renderOverlay();
}

// ---------------------------------------------------------------- pointer & keyboard handlers

stage.addEventListener('mousemove', (e) => {
  if (!naturalW || !naturalH || canvasWrap.hidden) {
    return;
  }
  lastPointerClient = { x: e.clientX, y: e.clientY };
  const pt = clientToImageFloat(e.clientX, e.clientY);
  if (pt.x >= 0 && pt.y >= 0 && pt.x < naturalW && pt.y < naturalH) {
    const ix = Math.floor(pt.x);
    const iy = Math.floor(pt.y);
    if (!hoverPx || hoverPx.x !== ix || hoverPx.y !== iy) {
      hoverPx = { x: ix, y: iy };
      updatePixelReadout(ix, iy);
      if (toolMode !== 'crop') {
        renderOverlay();
      }
    } else if (getAppearance().loupePosition === 'follow' && toolMode !== 'crop') {
      positionLoupe();
    }
  } else if (hoverPx) {
    hoverPx = undefined;
    if (getAppearance().loupePosition === 'follow') {
      loupe.hidden = true;
    }
    if (toolMode !== 'crop') {
      renderOverlay();
    }
  }
});

stage.addEventListener('mouseleave', () => {
  hoverPx = undefined;
  if (getAppearance().loupePosition === 'follow') {
    loupe.hidden = true;
  }
  if (toolMode !== 'crop') {
    renderOverlay();
  }
});

stage.addEventListener('mousedown', (e) => {
  if (e.button !== 0 && e.button !== 1) {
    return;
  }
  pureShiftTap = false;
  if (!naturalW || !naturalH || canvasWrap.hidden) {
    return;
  }
  const target = e.target as Element | null;

  // --- Crop Mode interactions (8-handle resize, move inside, or drag new crop rect) ---
  if (toolMode === 'crop' && e.button === 0 && !spaceHeld) {
    const cropHandle = target?.getAttribute('data-crop-handle') as ResizeHandle | null;
    if (cropHandle) {
      e.preventDefault();
      const orig = { ...cropRect };
      const ratio = aspectValue(cropAspect);
      const move = (ev: MouseEvent) => {
        const p = clientToImageFloat(ev.clientX, ev.clientY);
        const px = clamp(Math.round(p.x), 0, naturalW);
        const py = clamp(Math.round(p.y), 0, naturalH);
        let { x1, y1, x2, y2 } = orig;
        if (cropHandle.includes('w')) x1 = clamp(px, 0, orig.x2 - 1);
        if (cropHandle.includes('e')) x2 = clamp(px, orig.x1 + 1, naturalW);
        if (cropHandle.includes('n')) y1 = clamp(py, 0, orig.y2 - 1);
        if (cropHandle.includes('s')) y2 = clamp(py, orig.y1 + 1, naturalH);
        if (ratio) {
          const w = x2 - x1;
          const desiredH = Math.max(1, Math.round(w / ratio));
          if (cropHandle.includes('n')) {
            y1 = clamp(y2 - desiredH, 0, y2 - 1);
          } else {
            y2 = clamp(y1 + desiredH, y1 + 1, naturalH);
          }
        }
        cropRect = { x1, y1, x2, y2 };
        syncCropUi();
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }

    if (target?.getAttribute('data-crop-move')) {
      e.preventDefault();
      const startPt = clientToImageFloat(e.clientX, e.clientY);
      const orig = { ...cropRect };
      const w = orig.x2 - orig.x1;
      const h = orig.y2 - orig.y1;
      const move = (ev: MouseEvent) => {
        const cur = clientToImageFloat(ev.clientX, ev.clientY);
        const dx = Math.round(cur.x - startPt.x);
        const dy = Math.round(cur.y - startPt.y);
        const x1 = clamp(orig.x1 + dx, 0, naturalW - w);
        const y1 = clamp(orig.y1 + dy, 0, naturalH - h);
        cropRect = { x1, y1, x2: x1 + w, y2: y1 + h };
        syncCropUi();
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }

    // Drag outside current crop box -> draw a brand-new crop box
    const start = clientToImageFloat(e.clientX, e.clientY);
    if (start.x >= 0 && start.y >= 0 && start.x <= naturalW && start.y <= naturalH) {
      e.preventDefault();
      const sx = clamp(Math.round(start.x), 0, naturalW - 1);
      const sy = clamp(Math.round(start.y), 0, naturalH - 1);
      const ratio = aspectValue(cropAspect);
      const move = (ev: MouseEvent) => {
        const cur = clientToImageFloat(ev.clientX, ev.clientY);
        const ex = clamp(Math.round(cur.x), 0, naturalW);
        const ey = clamp(Math.round(cur.y), 0, naturalH);
        const x1 = clamp(Math.min(sx, ex), 0, naturalW - 1);
        let x2 = clamp(Math.max(x1 + 1, Math.max(sx, ex)), 1, naturalW);
        let y1 = clamp(Math.min(sy, ey), 0, naturalH - 1);
        let y2 = clamp(Math.max(y1 + 1, Math.max(sy, ey)), 1, naturalH);
        if (ratio) {
          const w = x2 - x1;
          const h = Math.max(1, Math.round(w / ratio));
          if (ey >= sy) {
            y2 = clamp(y1 + h, y1 + 1, naturalH);
            x2 = clamp(x1 + Math.max(1, Math.round((y2 - y1) * ratio)), x1 + 1, naturalW);
          } else {
            y1 = clamp(y2 - h, 0, y2 - 1);
          }
        }
        cropRect = { x1, y1, x2, y2 };
        syncCropUi();
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }
  }

  const handleBoxId = Number(target?.getAttribute('data-box-id') ?? '0');
  const handleKind = target?.getAttribute('data-handle') as 'nw' | 'ne' | 'sw' | 'se' | null;

  // 1. Resize corner handle of selected BBox
  if (handleBoxId && handleKind) {
    const box = boxes.find((b) => b.id === handleBoxId);
    if (box) {
      e.preventDefault();
      const orig = { ...box };
      const move = (ev: MouseEvent) => {
        const p = clientToImageFloat(ev.clientX, ev.clientY);
        const px = clamp(Math.round(p.x), 0, naturalW);
        const py = clamp(Math.round(p.y), 0, naturalH);
        const ax = handleKind.includes('w') ? orig.x2 : orig.x1;
        const ay = handleKind.includes('n') ? orig.y2 : orig.y1;
        box.x1 = clamp(Math.min(px, ax - 1), 0, naturalW - 1);
        box.y1 = clamp(Math.min(py, ay - 1), 0, naturalH - 1);
        box.x2 = clamp(Math.max(box.x1 + 1, Math.max(px, ax + 1)), 1, naturalW);
        box.y2 = clamp(Math.max(box.y1 + 1, Math.max(py, ay + 1)), 1, naturalH);
        renderBoxes();
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }
  }

  // 2. Move existing BBox
  if (handleBoxId && !e.shiftKey) {
    const box = boxes.find((b) => b.id === handleBoxId);
    if (box) {
      e.preventDefault();
      selectedBoxId = box.id;
      renderBoxes();
      const startPt = clientToImageFloat(e.clientX, e.clientY);
      const orig = { ...box };
      const w = orig.x2 - orig.x1;
      const h = orig.y2 - orig.y1;
      const move = (ev: MouseEvent) => {
        const cur = clientToImageFloat(ev.clientX, ev.clientY);
        const dx = Math.round(cur.x - startPt.x);
        const dy = Math.round(cur.y - startPt.y);
        box.x1 = clamp(orig.x1 + dx, 0, naturalW - w);
        box.y1 = clamp(orig.y1 + dy, 0, naturalH - h);
        box.x2 = box.x1 + w;
        box.y2 = box.y1 + h;
        renderBoxes();
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }
  }

  // 3. Draw new BBox (in 'bbox' mode or when holding Shift in 'inspect' mode)
  const wantBbox = e.button === 0 && !spaceHeld && (toolMode === 'bbox' || (toolMode === 'inspect' && e.shiftKey));
  if (wantBbox) {
    const start = clientToImageFloat(e.clientX, e.clientY);
    if (start.x < 0 || start.y < 0 || start.x > naturalW || start.y > naturalH) {
      return;
    }
    e.preventDefault();
    const sx = clamp(Math.round(start.x), 0, naturalW - 1);
    const sy = clamp(Math.round(start.y), 0, naturalH - 1);
    const color = BBOX_PALETTE[boxes.length % BBOX_PALETTE.length];
    const move = (ev: MouseEvent) => {
      const cur = clientToImageFloat(ev.clientX, ev.clientY);
      const ex = clamp(Math.round(cur.x), 0, naturalW);
      const ey = clamp(Math.round(cur.y), 0, naturalH);
      const x1 = clamp(Math.min(sx, ex), 0, naturalW - 1);
      const y1 = clamp(Math.min(sy, ey), 0, naturalH - 1);
      const x2 = clamp(Math.max(x1 + 1, Math.max(sx, ex)), 1, naturalW);
      const y2 = clamp(Math.max(y1 + 1, Math.max(sy, ey)), 1, naturalH);
      draftBox = { x1, y1, x2, y2, color };
      renderOverlay();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (draftBox && (draftBox.x2 - draftBox.x1 >= 2 || draftBox.y2 - draftBox.y1 >= 2)) {
        const created: BBox = { id: nextBoxId++, ...draftBox };
        boxes.push(created);
        selectedBoxId = created.id;
        if (!sidebar.open && boxes.length === 1) {
          sidebar.setOpen(true);
        }
      }
      draftBox = undefined;
      renderBoxes();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return;
  }

  // 4. Pan stage (or single-click to copy active colour value in inspect mode)
  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  const startLeft = stage.scrollLeft;
  const startTop = stage.scrollTop;
  let moved = false;
  stage.classList.add('img-panning');
  const move = (ev: MouseEvent) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      moved = true;
    }
    stage.scrollLeft = startLeft - dx;
    stage.scrollTop = startTop - dy;
  };
  const up = () => {
    stage.classList.remove('img-panning');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    if (!moved && e.button === 0 && toolMode === 'inspect' && hoverPx) {
      copyActiveColor();
    }
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

window.addEventListener('keydown', (e) => {
  const activeTag = (e.target as HTMLElement | null)?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') {
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      stepZoom(1);
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      stepZoom(-1);
      return;
    }
    if (e.key === '0') {
      e.preventDefault();
      setZoom(1);
      return;
    }
  }
  if (e.key === 'Shift' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
    pureShiftTap = true;
    return;
  }
  pureShiftTap = false;

  if (e.key === ' ') {
    spaceHeld = true;
  } else if (resizeOpen && e.key === 'Escape') {
    e.preventDefault();
    setResizeOpen(false);
  } else if (toolMode === 'crop' && e.key === 'Enter') {
    e.preventDefault();
    void applyCropInPlace();
  } else if (toolMode === 'crop' && e.key === 'Escape') {
    e.preventDefault();
    setToolMode('inspect');
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'c') {
    if (hoverPx || getAppearance().loupePosition === 'fixed') {
      e.preventDefault();
      copyActiveColor();
    }
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && toolMode !== 'crop' && selectedBoxId !== undefined) {
    e.preventDefault();
    boxes = boxes.filter((b) => b.id !== selectedBoxId);
    selectedBoxId = boxes[boxes.length - 1]?.id;
    renderBoxes();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    spaceHeld = false;
  } else if (e.key === 'Shift') {
    if (pureShiftTap) {
      pureShiftTap = false;
      colorMode = colorMode === 'rgb' ? 'hex' : 'rgb';
      writeState({ imgColorMode: colorMode });
      if (hoverPx) {
        updatePixelReadout(hoverPx.x, hoverPx.y);
      } else {
        refreshLoupeColorLabel();
      }
    }
  }
});

// ---------------------------------------------------------------- image loading

const statusHost = el('div');
stage.append(statusHost);
showStatus(statusHost, t('loading'));

async function loadImage(name: string, bytes: Uint8Array) {
  const prevName = fileName;
  fileName = name;
  rawFileBytes = bytes;
  if (prevName && prevName !== name) {
    boxes = [];
    selectedBoxId = undefined;
  } else if (!prevName && boxes.length === 0) {
    const st = readState();
    if (st.savedBoxesFile === name && Array.isArray(st.savedBoxes)) {
      boxes = st.savedBoxes as BBox[];
      nextBoxId = boxes.reduce((m, b) => Math.max(m, b.id || 0), 0) + 1;
    }
  }
  topBar.refresh();
  const ext = currentExt();
  const mime = MIME_BY_EXT[ext] ?? 'image/png';
  if (blobUrl) {
    URL.revokeObjectURL(blobUrl);
    blobUrl = undefined;
  }
  const blob = new Blob([toArrayBuffer(bytes)], { type: mime });
  const nextUrl = URL.createObjectURL(blob);
  blobUrl = nextUrl;

  try {
    await new Promise<void>((resolve, reject) => {
      imgEl.onload = () => resolve();
      imgEl.onerror = () => reject(new Error('Image decode failed'));
      imgEl.src = nextUrl;
    });
    naturalW = imgEl.naturalWidth || (ext === 'svg' ? 800 : 0);
    naturalH = imgEl.naturalHeight || (ext === 'svg' ? 600 : 0);
    if (!naturalW || !naturalH) {
      throw new Error('Zero-sized image');
    }

    const offscreen = document.createElement('canvas');
    offscreen.width = naturalW;
    offscreen.height = naturalH;
    sourceCanvas = offscreen;
    sampleCtx = offscreen.getContext('2d', { willReadFrequently: true }) ?? undefined;
    if (sampleCtx) {
      sampleCtx.drawImage(imgEl, 0, 0, naturalW, naturalH);
    }
    if (resizeOpen) {
      resizeWInput.value = String(naturalW);
      resizeHInput.value = String(naturalH);
    }

    // Clamp or discard out-of-bounds BBoxes after a crop/reload
    boxes = boxes
      .map((b) => ({
        ...b,
        x1: clamp(b.x1, 0, Math.max(0, naturalW - 1)),
        y1: clamp(b.y1, 0, Math.max(0, naturalH - 1)),
        x2: clamp(b.x2, 1, naturalW),
        y2: clamp(b.y2, 1, naturalH),
      }))
      .filter((b) => b.x2 > b.x1 && b.y2 > b.y1);

    lastSampledPx = { x: Math.floor(naturalW / 2), y: Math.floor(naturalH / 2) };
    statusHost.hidden = true;
    canvasWrap.hidden = false;
    updateMetaLabel();
    fitToStage();
    setToolMode(toolMode);
    renderBoxes();
    syncLoupeVisibility();
    post({ type: 'status', ok: true, detail: `${naturalW}x${naturalH}` });
  } catch (err) {
    canvasWrap.hidden = true;
    statusHost.hidden = false;
    showStatus(statusHost, t('loadFailed', errorText(err)), true);
    post({ type: 'status', ok: false, detail: errorText(err) });
  }
}

onMessage((message) => {
  if (message.type === 'load') {
    void loadImage(message.name, message.bytes);
  } else if (message.type === 'error') {
    canvasWrap.hidden = true;
    statusHost.hidden = false;
    showStatus(statusHost, message.message, true);
    post({ type: 'status', ok: false, detail: message.message });
  }
});

setToolMode(toolMode);
renderBoxes();
post({ type: 'ready' });
