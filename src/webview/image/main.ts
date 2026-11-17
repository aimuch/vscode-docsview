// Image viewer with WeChat/Snipaste-style 11x11 pixel magnifier loupe (follow cursor or fixed),
// RGB/HEX switching & one-key copy, and interactive bounding-box (BBox) drawing & measurement.
import '../shared/base.css';
import './image.css';
import type { LoupePosition } from '../../common/protocol';
import { app, el, errorText, onMessage, post, showStatus, t, toArrayBuffer } from '../shared/api';
import { getAppearance, onAppearanceChange, updateAppearance } from '../shared/appearance';
import { icons } from '../shared/icons';
import { readState, Sidebar, writeState } from '../shared/sidebar';
import { customToolbar, iconButton, segmented } from '../shared/ui';
import {
  BBOX_PALETTE,
  bboxDimensions,
  clamp,
  formatBBoxTuple,
  formatRgb,
  parseBBoxInput,
  rgbToHex,
  toScaledPoint,
  type BBox,
  type CoordScale,
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
const LOUPE_CELLS = 11; // 11x11 neighbourhood (radius 5 around cursor)
const LOUPE_HALF = 5;
const LOUPE_PX = 11; // 11 screen px per magnified pixel -> 121x121 canvas
const LOUPE_SIZE = LOUPE_CELLS * LOUPE_PX;

// ---------------------------------------------------------------- state

let fileName = '';
let naturalW = 0;
let naturalH = 0;
let zoom = 1;
let blobUrl: string | undefined;
/** Full RGBA pixel buffer when naturalW * naturalH <= 36M, else sampled via 2D context. */
let pixelBuffer: Uint8ClampedArray | undefined;
let sampleCtx: CanvasRenderingContext2D | undefined;

let toolMode: 'inspect' | 'bbox' = readState().imgMode === 'bbox' ? 'bbox' : 'inspect';
let coordScale: CoordScale = readState().imgScale === 'norm' ? 'norm' : 'px';
/** Active colour readout mode inside the loupe: RGB tuple (`7, 7, 8`) or `#HEX` (`#070708`), toggled via Shift. */
let colorMode: 'rgb' | 'hex' = readState().imgColorMode === 'hex' ? 'hex' : 'rgb';
let showGrid = readState().imgGrid !== false;
let checkerboard = readState().imgChecker !== false;

let boxes: BBox[] = [];
let nextBoxId = 1;
let selectedBoxId: number | undefined;
let hoverPx: { x: number; y: number } | undefined;
let lastPointerClient: { x: number; y: number } | undefined;
let currentColorValues: { rgbShort: string; rgbCss: string; hex: string } | undefined;
let spaceHeld = false;
/** True when a bare Shift press started with no drag or other key yet (toggles RGB/HEX on keyup). */
let pureShiftTap = false;

// ---------------------------------------------------------------- DOM elements

const stage = el('div', { class: 'img-stage img-mode-inspect' });
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

// WeChat / Snipaste style 11x11 Pixel Magnifier Loupe
const loupeCanvas = el('canvas', { class: 'img-loupe-canvas' });
loupeCanvas.width = LOUPE_SIZE;
loupeCanvas.height = LOUPE_SIZE;
const loupeCtx = loupeCanvas.getContext('2d')!;
const loupeCoord = el('div', { class: 'img-loupe-coord' });
const loupeSwatch = el('span', { class: 'img-loupe-swatch' });
const loupeColorText = el('span');
const loupeCard = el('div', { class: 'img-loupe-card' }, [
  loupeCoord,
  el('div', { class: 'img-loupe-color-row' }, [loupeSwatch, loupeColorText]),
  el('div', { class: 'img-loupe-hint', text: t('loupeCopyHint') }),
  el('div', { class: 'img-loupe-hint', text: t('loupeSwitchHint') }),
]);
const loupe = el('div', { class: 'img-loupe' }, [loupeCanvas, loupeCard]);
loupe.hidden = true;

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
  copyText(colorMode === 'hex' ? currentColorValues.hex : currentColorValues.rgbShort);
}

coordPill.addEventListener('click', () => {
  if (!hoverPx) {
    return;
  }
  const [sx, sy] = toScaledPoint(hoverPx.x, hoverPx.y, naturalW, naturalH, coordScale);
  copyText(`${sx}, ${sy}`);
});
hexPill.addEventListener('click', () => copyText(currentColorValues?.hex ?? ''));
rgbPill.addEventListener('click', () => copyText(currentColorValues?.rgbShort ?? ''));

// ---------------------------------------------------------------- BBox sidebar

const sidebar = new Sidebar(t('imgBoxes', 0), undefined, { defaultOpen: false });
const sideTitleEl = sidebar.node.querySelector('.dv-side-title');

const boxInput = el('input', { class: 'dv-input' });
boxInput.type = 'text';
boxInput.placeholder = '[x1, y1, x2, y2]';
boxInput.setAttribute('aria-label', '[x1, y1, x2, y2]');
const addBoxBtn = iconButton('plus', t('imgModeBbox'), () => addBoxFromInput());
const boxList = el('div', { class: 'img-box-list' });
sidebar.panel().append(
  el('div', { class: 'img-side-wrap' }, [
    el('div', { class: 'img-add-box-row' }, [boxInput, addBoxBtn]),
    boxList,
  ]),
);

function addBoxFromInput() {
  const parsed = parseBBoxInput(boxInput.value, naturalW, naturalH, coordScale);
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

const modeSeg = segmented<'inspect' | 'bbox'>(
  t('view'),
  [
    ['inspect', t('imgModePan')],
    ['bbox', t('imgModeBbox')],
  ],
  toolMode,
  (mode) => {
    toolMode = mode;
    writeState({ imgMode: mode });
    stage.classList.toggle('img-mode-inspect', mode === 'inspect');
    stage.classList.toggle('img-mode-bbox', mode === 'bbox');
  },
);
stage.classList.toggle('img-mode-inspect', toolMode === 'inspect');
stage.classList.toggle('img-mode-bbox', toolMode === 'bbox');

const scaleSeg = segmented<'px' | 'norm'>(
  'Coordinate scale',
  [
    ['px', t('imgCoordPx')],
    ['norm', t('imgCoordNorm')],
  ],
  coordScale,
  (s) => {
    coordScale = s;
    writeState({ imgScale: s });
    if (hoverPx) {
      updatePixelReadout(hoverPx.x, hoverPx.y);
    }
    renderBoxes();
  },
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
    positionLoupe();
  },
);

onAppearanceChange((a) => {
  loupePosSeg.set(a.loupePosition);
  positionLoupe();
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

const clearBtn = el('button', { class: 'dv-btn', text: t('imgClearBoxes') });
clearBtn.type = 'button';
clearBtn.addEventListener('click', () => {
  boxes = [];
  selectedBoxId = undefined;
  renderBoxes();
});

const copyJsonBtn = el('button', { class: 'dv-btn', text: t('imgCopyJson') });
copyJsonBtn.type = 'button';
copyJsonBtn.addEventListener('click', () => {
  if (!boxes.length) {
    return;
  }
  const payload = boxes.map((b) => {
    const [x1, y1, x2, y2] = formatBBoxTuple(b, naturalW, naturalH, coordScale);
    const { w, h } = bboxDimensions(b);
    return { id: b.id, bbox: [x1, y1, x2, y2], width: w, height: h, scale: coordScale };
  });
  copyText(JSON.stringify(payload));
});

const topBar = customToolbar({
  subtitle: () => (fileName ? fileName : 'IMAGE'),
  slots: [
    { id: 'nav', nodes: [sidebar.toggle] },
    { id: 'view', nodes: [modeSeg.node] },
    { id: 'zoom', nodes: [zoomGroup] },
    { id: 'bbox', nodes: [loupePosSeg.node, scaleSeg.node, copyJsonBtn, clearBtn] },
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

canvasWrap.classList.toggle('img-checker', checkerboard);

app.append(
  topBar.node,
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

// ---------------------------------------------------------------- pixel sampling & 11x11 loupe

function samplePixel(x: number, y: number): [number, number, number, number] {
  const px = clamp(x, 0, naturalW - 1);
  const py = clamp(y, 0, naturalH - 1);
  if (pixelBuffer) {
    const idx = (py * naturalW + px) * 4;
    return [pixelBuffer[idx], pixelBuffer[idx + 1], pixelBuffer[idx + 2], pixelBuffer[idx + 3]];
  }
  if (sampleCtx) {
    const d = sampleCtx.getImageData(px, py, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }
  return [0, 0, 0, 255];
}

function positionLoupe() {
  const fixed = getAppearance().loupePosition === 'fixed';
  loupe.classList.toggle('img-loupe-fixed', fixed);
  if (fixed) {
    loupe.style.left = '';
    loupe.style.top = '';
    return;
  }
  if (!lastPointerClient || loupe.hidden) {
    return;
  }
  const offset = 20;
  const w = loupe.offsetWidth || 138;
  const h = loupe.offsetHeight || 215;
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
  loupeCtx.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);

  // 1. Draw magnified 11x11 pixel cells
  for (let dy = -LOUPE_HALF; dy <= LOUPE_HALF; dy++) {
    for (let dx = -LOUPE_HALF; dx <= LOUPE_HALF; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      const px = (dx + LOUPE_HALF) * LOUPE_PX;
      const py = (dy + LOUPE_HALF) * LOUPE_PX;
      if (x < 0 || y < 0 || x >= naturalW || y >= naturalH) {
        loupeCtx.fillStyle = '#1c1c1e';
      } else {
        const [r, g, b, a] = samplePixel(x, y);
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

  // 2. Blue translucent crosshair row & column bands (leaving center pixel true-colour!)
  const cStart = LOUPE_HALF * LOUPE_PX;
  loupeCtx.fillStyle = 'rgba(59, 130, 246, 0.42)';
  // Horizontal arms (left and right of center cell)
  loupeCtx.fillRect(0, cStart, cStart, LOUPE_PX);
  loupeCtx.fillRect(cStart + LOUPE_PX, cStart, LOUPE_SIZE - (cStart + LOUPE_PX), LOUPE_PX);
  // Vertical arms (above and below center cell)
  loupeCtx.fillRect(cStart, 0, LOUPE_PX, cStart);
  loupeCtx.fillRect(cStart, cStart + LOUPE_PX, LOUPE_PX, LOUPE_SIZE - (cStart + LOUPE_PX));

  // 3. Crisp 1px pixel grid lines
  loupeCtx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  loupeCtx.lineWidth = 1;
  loupeCtx.beginPath();
  for (let i = 1; i < LOUPE_CELLS; i++) {
    const pos = i * LOUPE_PX + 0.5;
    loupeCtx.moveTo(pos, 0);
    loupeCtx.lineTo(pos, LOUPE_SIZE);
    loupeCtx.moveTo(0, pos);
    loupeCtx.lineTo(LOUPE_SIZE, pos);
  }
  loupeCtx.stroke();

  // 4. Dual-contrast reticle around the exact center pixel
  loupeCtx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  loupeCtx.lineWidth = 1;
  loupeCtx.strokeRect(cStart - 0.5, cStart - 0.5, LOUPE_PX + 1, LOUPE_PX + 1);
  loupeCtx.strokeStyle = '#ffffff';
  loupeCtx.lineWidth = 1.5;
  loupeCtx.strokeRect(cStart + 0.5, cStart + 0.5, LOUPE_PX - 1, LOUPE_PX - 1);
}

function refreshLoupeColorLabel() {
  if (!currentColorValues) {
    return;
  }
  loupeColorText.textContent = colorMode === 'hex' ? currentColorValues.hex : currentColorValues.rgbShort;
}

function updatePixelReadout(x: number, y: number) {
  const [r, g, b, a] = samplePixel(x, y);
  const hex = rgbToHex(r, g, b);
  const rgbShort = a >= 255 ? `${r},  ${g},  ${b}` : `${r}, ${g}, ${b}, ${(a / 255).toFixed(2)}`;
  const rgbCss = formatRgb(r, g, b, a);
  currentColorValues = { rgbShort: a >= 255 ? `${r}, ${g}, ${b}` : rgbCss, rgbCss, hex };

  const [sx, sy] = toScaledPoint(x, y, naturalW, naturalH, coordScale);
  const coordStr = coordScale === 'norm' ? `(${sx}, ${sy}) · px (${x}, ${y})` : `(${x}, ${y})`;

  coordPill.textContent = coordStr;
  swatchDot.style.background = hex;
  hexText.textContent = hex;
  rgbPill.textContent = currentColorValues.rgbShort;

  loupeCoord.textContent = coordStr;
  loupeSwatch.style.background = hex;
  loupeColorText.textContent = colorMode === 'hex' ? hex : rgbShort;
  paintLoupe(x, y);
  loupe.hidden = false;
  positionLoupe();
}

// ---------------------------------------------------------------- overlay & BBox rendering

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

    const tuple = formatBBoxTuple(b, naturalW, naturalH, coordScale);
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
  clearBtn.disabled = boxes.length === 0;
  copyJsonBtn.disabled = boxes.length === 0;

  if (!boxes.length) {
    boxList.replaceChildren(el('div', { class: 'img-box-empty', text: t('imgNoBoxes') }));
  } else {
    boxList.replaceChildren(
      ...boxes.map((b) => {
        const tuple = formatBBoxTuple(b, naturalW, naturalH, coordScale);
        const tupleStr = `[${tuple.join(', ')}]`;
        const { w, h } = bboxDimensions(b);

        const dot = el('span', { class: 'img-color-dot' });
        dot.style.background = b.color;

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
              el('span', { class: 'img-box-actions' }, [copyBtn, delBtn]),
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
      renderOverlay();
    } else {
      positionLoupe();
    }
  } else if (hoverPx) {
    hoverPx = undefined;
    loupe.hidden = true;
    renderOverlay();
  }
});

stage.addEventListener('mouseleave', () => {
  hoverPx = undefined;
  loupe.hidden = true;
  renderOverlay();
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
        box.x1 = Math.min(px, ax - 1);
        box.x2 = Math.max(px, ax + 1);
        box.y1 = Math.min(py, ay - 1);
        box.y2 = Math.max(py, ay + 1);
        box.x1 = clamp(box.x1, 0, naturalW - 1);
        box.y1 = clamp(box.y1, 0, naturalH - 1);
        box.x2 = clamp(Math.max(box.x1 + 1, box.x2), 1, naturalW);
        box.y2 = clamp(Math.max(box.y1 + 1, box.y2), 1, naturalH);
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
  const wantBbox = e.button === 0 && !spaceHeld && (toolMode === 'bbox' || e.shiftKey);
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
    if (!moved && e.button === 0 && hoverPx) {
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
  if (e.key === 'Shift' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
    pureShiftTap = true;
    return;
  }
  pureShiftTap = false;

  if (e.key === ' ') {
    spaceHeld = true;
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'c') {
    // Press C to copy active colour value (WeChat / Snipaste shortcut)
    if (hoverPx) {
      e.preventDefault();
      copyActiveColor();
    }
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedBoxId !== undefined) {
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
  fileName = name;
  topBar.refresh();
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
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

    // Rasterise onto an offscreen canvas for O(1) pixel RGB/HEX sampling.
    const offscreen = document.createElement('canvas');
    offscreen.width = naturalW;
    offscreen.height = naturalH;
    sampleCtx = offscreen.getContext('2d', { willReadFrequently: true }) ?? undefined;
    pixelBuffer = undefined;
    if (sampleCtx) {
      sampleCtx.drawImage(imgEl, 0, 0, naturalW, naturalH);
      if (naturalW * naturalH <= 36_000_000) {
        pixelBuffer = sampleCtx.getImageData(0, 0, naturalW, naturalH).data;
      }
    }

    statusHost.hidden = true;
    canvasWrap.hidden = false;
    updateMetaLabel();
    fitToStage();
    renderBoxes();
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

renderBoxes();
post({ type: 'ready' });
