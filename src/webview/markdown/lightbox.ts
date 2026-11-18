// Interactive fullscreen Mermaid Diagram Lightbox with pan, wheel zoom, SVG & 2x PNG export.
import { el, post, t } from '../shared/api';
import { icons } from '../shared/icons';
import { iconButton } from '../shared/ui';

let modal: HTMLElement | undefined;
let canvasStage: HTMLElement | undefined;
let svgWrap: HTMLElement | undefined;
let zoomBtn: HTMLButtonElement | undefined;
let currentSvgMarkup = '';
let scale = 1;
let panX = 0;
let panY = 0;

function applyTransform() {
  if (!svgWrap || !zoomBtn) {
    return;
  }
  svgWrap.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  zoomBtn.textContent = `${Math.round(scale * 100)}%`;
}

function serializeCleanSvg(svgNode: SVGSVGElement): { markup: string; width: number; height: number } {
  const clone = svgNode.cloneNode(true) as SVGSVGElement;
  if (!clone.getAttribute('xmlns')) {
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }
  const rect = svgNode.getBoundingClientRect();
  let width = Math.round(rect.width) || 800;
  let height = Math.round(rect.height) || 600;
  const vb = clone.getAttribute('viewBox');
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      width = Math.round(parts[2]);
      height = Math.round(parts[3]);
    }
  }
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  return { markup: new XMLSerializer().serializeToString(clone), width, height };
}

async function exportCurrentPng2x(width: number, height: number): Promise<void> {
  if (!currentSvgMarkup) {
    return;
  }
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(currentSvgMarkup)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('SVG rasterisation failed'));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width * 2);
  canvas.height = Math.max(1, height * 2);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(2, 2);
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  post({ type: 'saveBytesExport', ext: 'png', suffix: '-diagram', bytes });
}

let currentDims = { width: 800, height: 600 };

function ensureModal(): HTMLElement {
  if (modal) {
    return modal;
  }
  svgWrap = el('div', { class: 'md-lightbox-svg' });
  canvasStage = el('div', { class: 'md-lightbox-stage' }, [svgWrap]);

  zoomBtn = el('button', { class: 'dv-btn dv-label', text: '100%', title: t('zoomReset') });
  zoomBtn.type = 'button';
  zoomBtn.addEventListener('click', () => {
    scale = 1;
    panX = 0;
    panY = 0;
    applyTransform();
  });

  const exportSvgBtn = el('button', { class: 'dv-btn', text: t('mdExportSvg') });
  exportSvgBtn.type = 'button';
  exportSvgBtn.addEventListener('click', () => {
    if (currentSvgMarkup) {
      post({ type: 'saveTextExport', ext: 'svg', suffix: '-diagram', content: currentSvgMarkup });
    }
  });

  const exportPngBtn = el('button', { class: 'dv-btn dv-cm-primary', text: t('mdExportPng') });
  exportPngBtn.type = 'button';
  exportPngBtn.addEventListener('click', () => {
    void exportCurrentPng2x(currentDims.width, currentDims.height);
  });

  const bar = el('div', { class: 'dv-present-hud md-lightbox-hud' }, [
    iconButton('minus', t('zoomOut'), () => {
      scale = Math.max(0.2, scale / 1.25);
      applyTransform();
    }),
    zoomBtn,
    iconButton('plus', t('zoomIn'), () => {
      scale = Math.min(16, scale * 1.25);
      applyTransform();
    }),
    exportSvgBtn,
    exportPngBtn,
    iconButton('close', t('cancel'), () => closeMermaidLightbox()),
  ]);

  modal = el('div', { class: 'md-lightbox' }, [canvasStage, bar]);
  modal.hidden = true;
  document.body.append(modal);

  canvasStage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      scale = Math.max(0.2, Math.min(16, scale * factor));
      applyTransform();
    },
    { passive: false },
  );

  canvasStage.addEventListener('mousedown', (e) => {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    const startX = e.clientX - panX;
    const startY = e.clientY - panY;
    const move = (ev: MouseEvent) => {
      panX = ev.clientX - startX;
      panY = ev.clientY - startY;
      applyTransform();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  window.addEventListener('keydown', (e) => {
    if (modal && !modal.hidden && e.key === 'Escape') {
      e.preventDefault();
      closeMermaidLightbox();
    }
  });

  return modal;
}

export function openMermaidLightbox(mermaidContainer: HTMLElement): void {
  const svg = mermaidContainer.querySelector('svg');
  if (!svg) {
    return;
  }
  const m = ensureModal();
  const serialized = serializeCleanSvg(svg);
  currentSvgMarkup = serialized.markup;
  currentDims = { width: serialized.width, height: serialized.height };
  svgWrap!.innerHTML = serialized.markup;
  scale = 1;
  panX = 0;
  panY = 0;
  applyTransform();
  m.hidden = false;
}

export function closeMermaidLightbox(): void {
  if (modal) {
    modal.hidden = true;
  }
}

export function decorateMermaidDiagrams(article: HTMLElement): void {
  for (const node of article.querySelectorAll<HTMLElement>('.mermaid:not(.mermaid-error)')) {
    if (!node.querySelector('svg') || node.querySelector('.md-mermaid-expand')) {
      continue;
    }
    const btn = el('button', { class: 'md-mermaid-expand', title: t('mdZoomDiagram') });
    btn.type = 'button';
    btn.innerHTML = icons.expand;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMermaidLightbox(node);
    });
    node.append(btn);
  }
}
