// Image viewer with live pixel coordinates, 9x9 magnifier loupe, RGB/HEX extraction,
// and interactive bounding-box (BBox) drawing & measurement (px and 0–1000 normalised).
import '../shared/base.css';
import './image.css';
import { app, el, errorText, onMessage, post, showStatus, t, toArrayBuffer } from '../shared/api';
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
let showGrid = readState().imgGrid !== false;
let checkerboard = readState().imgChecker !== false;

let boxes: BBox[] = [];
let nextBoxId = 1;
let selectedBoxId: number | undefined;
let hoverPx: { x: number; y: number } | undefined;
let spaceHeld = false;

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

// Loupe magnifier (9x9 pixels)
const loupeCanvas = el('canvas', { class: 'img-loupe-canvas' });
loupeCanvas.width = 9;
loupeCanvas.height = 9;
const loupeCtx = loupeCanvas.getContext('2d')!;
const loupeDot = el('span', { class: 'img-color-dot' });
const loupeHex = el('span');
const loupeCoord = el('span');
const loupeRgb = el('span');
const loupe = el('div', { class: 'img-loupe' }, [
  loupeCanvas,
  el('div', { class: 'img-loupe-meta' }, [
    el('span', { class: 'img-loupe-hex-row' }, [loupeDot, loupeHex]),
    loupeRgb,
    loupeCoord,
  ]),
]);
loupe.hidden = true;

// Status bar
const metaLabel = el('span', { class: 'dv-label' });
const coordPill = el('button', { class: 'img-pill', text: 'XY: —' });
coordPill.type = 'button';
const swatchDot = el('span', { class: 'img-color-dot' });
const hexText = el('span', { text: '#------' });
const hexPill = el('button', { class: 'img-pill' }, [swatchDot, hexText]);
hexPill.type = 'button';
const rgbPill = el('button', { class: 'img-pill', text: 'rgb(—, —, —)' });
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

coordPill.addEventListener('click', () => {
  if (!hoverPx) {
    return;
  }
  const [sx, sy] = toScaledPoint(hoverPx.x, hoverPx.y, naturalW, naturalH, coordScale);
  copyText(`${sx}, ${sy}`);
});
hexPill.addEventListener('click', () => copyText(hexText.textContent ?? ''));
rgbPill.addEventListener('click', () => copyText(rgbPill.textContent ?? ''));

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
    color: BBOX_PALETTE[(boxes.length) % BBOX_PALETTE.length],
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
    { id: 'bbox', nodes: [scaleSeg.node, copyJsonBtn, clearBtn] },
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
  const fx = focalClientX !== undefined ? (focalClientX - rect.left) / prevZoom : (stage.clientWidth / 2) / prevZoom;
  const fy = focalClientY !== undefined ? (focalClientY - rect.top) / prevZoom : (stage.clientHeight / 2) / prevZoom;

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

// ---------------------------------------------------------------- pixel sampling & loupe

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

function paintLoupe(cx: number, cy: number) {
  const imgData = loupeCtx.createImageData(9, 9);
  const out = imgData.data;
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      const off = ((dy + 4) * 9 + (dx + 4)) * 4;
      if (x < 0 || y < 0 || x >= naturalW || y >= naturalH) {
        out[off] = 40;
        out[off + 1] = 40;
        out[off + 2] = 40;
        out[off + 3] = 255;
      } else {
        const [r, g, b, a] = samplePixel(x, y);
        // Blend alpha over subtle checker so transparent pixels remain legible in the loupe.
        const bg = (x + y) % 2 === 0 ? 220 : 170;
        const alpha = a / 255;
        out[off] = Math.round(r * alpha + bg * (1 - alpha));
        out[off + 1] = Math.round(g * alpha + bg * (1 - alpha));
        out[off + 2] = Math.round(b * alpha + bg * (1 - alpha));
        out[off + 3] = 255;
      }
    }
  }
  loupeCtx.putImageData(imgData, 0, 0);
  // Highlight center pixel (4, 4)
  loupeCtx.strokeStyle = 'rgba(255,255,255,0.95)';
  loupeCtx.lineWidth = 0.22;
  loupeCtx.strokeRect(4.05, 4.05, 0.9, 0.9);
}

function updatePixelReadout(x: number, y: number) {
  const [r, g, b, a] = samplePixel(x, y);
  const hex = rgbToHex(r, g, b);
  const rgb = formatRgb(r, g, b, a);
  const [sx, sy] = toScaledPoint(x, y, naturalW, naturalH, coordScale);
  const coordStr =
    coordScale === 'norm' ? `Norm: (${sx}, ${sy}) · px: (${x}, ${y})` : `XY: (${x}, ${y})`;

  coordPill.textContent = coordStr;
  swatchDot.style.background = hex;
  hexText.textContent = hex;
  rgbPill.textContent = rgb;

  loupeDot.style.background = hex;
  loupeHex.textContent = hex;
  loupeRgb.textContent = rgb;
  loupeCoord.textContent = `(${x}, ${y}) px`;
  paintLoupe(x, y);
  loupe.hidden = false;
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
      const hs = 7;
      for (const [corner, cx, cy, cursor] of [
        ['nw', rx, ry, 'nwse-resize'],
        ['ne', rx + rw, ry, 'nesw-resize'],
        ['sw', rx, ry + rh, 'nesw-resize'],
        ['se', rx + rw, ry + rh, 'nwse-resize'],
      ] as const) {
        const h = svgEl('rect', {
          class: 'img-bbox-handle',
          x: String(cx - hs / 2),
          y: String(cy - hs / 2),
          width: String(hs),
          height: String(hs),
          fill: b.color,
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
  const pt = clientToImageFloat(e.clientX, e.clientY);
  if (pt.x >= 0 && pt.y >= 0 && pt.x < naturalW && pt.y < naturalH) {
    const ix = Math.floor(pt.x);
    const iy = Math.floor(pt.y);
    if (!hoverPx || hoverPx.x !== ix || hoverPx.y !== iy) {
      hoverPx = { x: ix, y: iy };
      updatePixelReadout(ix, iy);
      renderOverlay();
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

  // 4. Pan stage (or single-click to copy pixel HEX in inspect mode)
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
      copyText(hexText.textContent ?? '');
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
  if (e.key === ' ') {
    spaceHeld = true;
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
