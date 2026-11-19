import * as pdfjs from 'pdfjs-dist';
import {
  EventBus,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
  ScrollMode,
} from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import '../shared/base.css';
import './pdf.css';
import type { DocComment } from '../../common/protocol';
import { InteractionModeMachine } from '../../common/stateMachine';
import { createAiAssistant } from '../shared/aiAssistant';
import { app, config, el, errorText, onMessage, post, t, toArrayBuffer } from '../shared/api';
import {
  attachSurfaceAnnotator,
  closeFloatingEditors,
  CommentsPanel,
  openCommentComposer,
  renderSurfaceAnnotations,
} from '../shared/comments';
import { getFileState } from '../shared/fileState';
import { createFindBar } from '../shared/find';
import { icons, type IconName } from '../shared/icons';
import { bindLiveViewerStatus, overlayStack } from '../shared/overlayStack';
import { Outline, readState, Sidebar, writeState, type OutlineItem } from '../shared/sidebar';
import {
  customToolbar,
  iconButton,
  moreMenu,
  noticeBanner,
  openExternalButton,
  openExternalMenuItem,
  segmented,
  toggleButton,
} from '../shared/ui';
import { createPager } from '../shared/zoom';

const assets = `${config.assets}/pdfjs`;

// ---------------------------------------------------------------- layout

const notice = noticeBanner();
const stage = el('div', { class: 'pdf-stage' });
// PDFViewer requires an absolutely positioned scroll container with one child element.
const container = el('div', { class: 'pdf-container' });
const viewerEl = el('div', { class: 'pdfViewer dv-page-invert' });
container.append(viewerEl);
const status = el('div', { class: 'dv-status', text: t('loading') });
stage.append(container, status);

const sidebar = new Sidebar(t('nav'), [
  { id: 'outline', label: t('toc') },
  { id: 'pages', label: t('navPages') },
  { id: 'comments', label: t('comments') },
]);
const thumbs = el('div', { class: 'pdf-thumbs' });
sidebar.panel('pages').append(thumbs);

// ---------------------------------------------------------------- pdf.js wiring

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
const findController = new PDFFindController({ eventBus, linkService });
const viewer = new PDFViewer({
  container,
  viewer: viewerEl,
  eventBus,
  linkService,
  findController,
});
linkService.setViewer(viewer);

const outline = new Outline(
  (key) => {
    const dest = outlineDests[Number(key)];
    if (dest) {
      void linkService.goToDestination(dest);
    }
  },
  { emptyText: t('noOutline'), countText: (n) => t('headingCount', n) },
);
sidebar.panel('outline').append(outline.node);

// ---------------------------------------------------------------- annotations / comments

let docFileName = 'Document.pdf';
const modeMachine = new InteractionModeMachine();
let comments: DocComment[] = [];

const annotateToggle = toggleButton('commentPlus', t('addComment'), (on) => {
  modeMachine.setMode(on ? 'annotate' : 'read');
});

modeMachine.onChange((mode) => {
  const on = mode === 'annotate';
  annotateToggle.set(on);
  viewerEl.classList.toggle('pdf-annotating', on);
  closeFloatingEditors();
  hideSelectionBar();
  if (on) {
    sidebar.setOpen(true);
    sidebar.setTab('comments');
    notice.flash(t('annotatePdfHint'), 2800);
  }
});

const commentsPanel = new CommentsPanel({
  docName: () => docFileName,
  editable: () => modeMachine.isEditable,
  targetLabel: (c) => (c.page ? t('pageN', c.page) : ''),
  onSelect: (c) => {
    if (c.page && viewer.pagesCount) {
      viewer.currentPageNumber = Math.max(1, Math.min(viewer.pagesCount, c.page));
    }
    syncAllPageAnnotations();
  },
  onUpdate: (id, text) => post({ type: 'docMutate', mutation: { kind: 'updateComment', id, text } }),
  onDelete: (id) => post({ type: 'docMutate', mutation: { kind: 'deleteComment', id } }),
  onToggleAddMode: () => {
    modeMachine.toggle('annotate');
  },
  onAiDigest: (md) => {
    ai.open({
      presetAction: 'summarize',
      initialPrompt: `Summarize all PDF review comments below into key themes and a prioritised action-item checklist:\n\n${md}`,
      autoRun: true,
    });
  },
});
sidebar.panel('comments').append(commentsPanel.node);

function syncPageAnnotation(pageNumber: number): void {
  const pageEl = viewerEl.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`);
  if (!pageEl) {
    return;
  }
  const entries = comments
    .map((comment, idx) => ({ comment, badgeIndex: idx + 1 }))
    .filter((e) => e.comment.page === pageNumber);
  renderSurfaceAnnotations(
    pageEl,
    entries,
    commentsPanel.active,
    (comment) => {
      sidebar.setOpen(true);
      sidebar.setTab('comments');
      commentsPanel.setActive(comment.id, true);
      syncAllPageAnnotations();
    },
    { bakedPdfStream: true },
  );
}

function syncAllPageAnnotations(): void {
  for (const pageEl of viewerEl.querySelectorAll<HTMLElement>('.page[data-page-number]')) {
    const num = Number(pageEl.dataset.pageNumber);
    if (num > 0) {
      syncPageAnnotation(num);
    }
  }
}

function syncCommentsUi(): void {
  commentsPanel.setComments(comments);
  sidebar.setTabLabel('comments', comments.length ? t('commentsCount', comments.length) : t('comments'));
  syncAllPageAnnotations();
}

attachSurfaceAnnotator({
  root: viewerEl,
  allowBox: true,
  isActive: () => modeMachine.isEditable && modeMachine.mode === 'annotate',
  resolveSurface: (target) => {
    const elTarget = target instanceof HTMLElement ? target : undefined;
    const pageEl = elTarget?.closest<HTMLElement>('.page[data-page-number]');
    if (!pageEl) {
      return undefined;
    }
    const page = Number(pageEl.dataset.pageNumber);
    return page > 0 ? { surface: pageEl, page } : undefined;
  },
  titleForPage: (page) => t('pageN', page),
  onCreate: (page, rect, text) => {
    post({ type: 'docMutate', mutation: { kind: 'addComment', page, rect, text } });
  },
});

// Floating mouse text-selection highlighter & AI bar
interface PdfSelectionSnap {
  page: number;
  rect: { x: number; y: number; w: number; h: number };
  quads: { x: number; y: number; w: number; h: number }[];
  quote: string;
  fullText: string;
  clientX: number;
  clientY: number;
}

let pendingSel: PdfSelectionSnap | undefined;

const hlYellowBtn = el('button', { class: 'pdf-sel-btn', title: t('pdfHighlightYellow') });
hlYellowBtn.type = 'button';
hlYellowBtn.append(el('span', { class: 'pdf-sel-dot pdf-sel-yellow' }));

const hlGreenBtn = el('button', { class: 'pdf-sel-btn', title: t('pdfHighlightGreen') });
hlGreenBtn.type = 'button';
hlGreenBtn.append(el('span', { class: 'pdf-sel-dot pdf-sel-green' }));

const hlCommentBtn = iconButton('commentPlus', t('pdfHighlightComment'), () => {
  if (!pendingSel) {
    return;
  }
  const snap = pendingSel;
  hideSelectionBar();
  window.getSelection()?.removeAllRanges();
  openCommentComposer({
    anchor: { x: snap.clientX, y: snap.clientY + 12 },
    title: `${t('pdfHighlightComment')} · ${t('pageN', snap.page)}`,
    onSubmit: (text) => {
      post({
        type: 'docMutate',
        mutation: {
          kind: 'addComment',
          page: snap.page,
          rect: snap.rect,
          quads: snap.quads,
          quote: snap.quote,
          text,
          color: '#fde047',
          subtype: 'highlight',
        },
      });
    },
  });
});
hlCommentBtn.classList.add('pdf-sel-btn');

function applyQuickHighlight(color: string) {
  if (!pendingSel) {
    return;
  }
  const snap = pendingSel;
  hideSelectionBar();
  window.getSelection()?.removeAllRanges();
  post({
    type: 'docMutate',
    mutation: {
      kind: 'addComment',
      page: snap.page,
      rect: snap.rect,
      quads: snap.quads,
      quote: snap.quote,
      text: snap.quote,
      color,
      subtype: 'highlight',
    },
  });
}
hlYellowBtn.addEventListener('click', () => applyQuickHighlight('#fde047'));
hlGreenBtn.addEventListener('click', () => applyQuickHighlight('#4ade80'));

const hlAiBtn = iconButton('sparkle', t('aiOpenTip'), () => {
  if (!pendingSel) {
    return;
  }
  const snap = pendingSel;
  hideSelectionBar();
  ai.open({
    presetAction: 'explain',
    capturedOverride: {
      selection: snap.fullText,
      surrounding: extractVisiblePdfContext(),
      badge: `${t('pageN', snap.page)} (${snap.fullText.length})`,
      meta: snap,
    },
  });
});
hlAiBtn.classList.add('pdf-sel-btn');

const pdfSelBar = el('div', { class: 'pdf-sel-bar' }, [hlYellowBtn, hlGreenBtn, hlCommentBtn, hlAiBtn]);
pdfSelBar.hidden = true;
pdfSelBar.addEventListener('mousedown', (e) => {
  e.preventDefault();
  e.stopPropagation();
});
document.body.append(pdfSelBar);

function hideSelectionBar() {
  pendingSel = undefined;
  pdfSelBar.hidden = true;
}

function collectLineQuads(
  range: Range,
  pageBounds: DOMRect,
): { x: number; y: number; w: number; h: number }[] {
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const raw = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
  if (!raw.length) {
    return [];
  }
  raw.sort((a, b) => (Math.abs(a.top - b.top) > 3 ? a.top - b.top : a.left - b.left));
  const lines: { left: number; top: number; right: number; bottom: number }[] = [];
  for (const r of raw) {
    const prev = lines[lines.length - 1];
    const prevH = prev ? prev.bottom - prev.top : 0;
    if (prev && Math.abs(r.top - prev.top) <= Math.max(4, prevH * 0.45)) {
      prev.left = Math.min(prev.left, r.left);
      prev.top = Math.min(prev.top, r.top);
      prev.right = Math.max(prev.right, r.right);
      prev.bottom = Math.max(prev.bottom, r.bottom);
    } else {
      lines.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
  }
  return lines.map((l) => {
    const x = clamp01((l.left - pageBounds.left) / pageBounds.width);
    const y = clamp01((l.top - pageBounds.top) / pageBounds.height);
    const w = clamp01((l.right - l.left) / pageBounds.width);
    const h = clamp01((l.bottom - l.top) / pageBounds.height);
    return { x, y, w: Math.max(0.01, w), h: Math.max(0.008, h) };
  });
}

viewerEl.addEventListener('mouseup', (e) => {
  if (modeMachine.mode === 'annotate') {
    hideSelectionBar();
    return;
  }
  setTimeout(() => {
    const sel = window.getSelection();
    const rawText = sel?.toString().replace(/\s+/g, ' ').trim() ?? '';
    if (!sel || sel.isCollapsed || !rawText || sel.rangeCount === 0) {
      hideSelectionBar();
      return;
    }
    const range = sel.getRangeAt(0);
    const startNode = range.startContainer instanceof HTMLElement ? range.startContainer : range.startContainer.parentElement;
    const pageEl = startNode?.closest<HTMLElement>('.page[data-page-number]');
    if (!pageEl) {
      hideSelectionBar();
      return;
    }
    const page = Number(pageEl.dataset.pageNumber);
    const pageBounds = pageEl.getBoundingClientRect();
    const selBounds = range.getBoundingClientRect();
    if (!page || pageBounds.width <= 0 || pageBounds.height <= 0 || selBounds.width <= 0 || selBounds.height <= 0) {
      hideSelectionBar();
      return;
    }
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    const rx = clamp01((selBounds.left - pageBounds.left) / pageBounds.width);
    const ry = clamp01((selBounds.top - pageBounds.top) / pageBounds.height);
    const rw = clamp01(selBounds.width / pageBounds.width);
    const rh = clamp01(selBounds.height / pageBounds.height);
    const overallRect = { x: rx, y: ry, w: Math.max(0.01, rw), h: Math.max(0.008, rh) };
    const quads = collectLineQuads(range, pageBounds);
    pendingSel = {
      page,
      rect: overallRect,
      quads: quads.length > 0 ? quads : [overallRect],
      quote: rawText.slice(0, 180),
      fullText: rawText,
      clientX: e.clientX,
      clientY: e.clientY,
    };
    const canAnnotate = modeMachine.isEditable;
    hlYellowBtn.hidden = !canAnnotate;
    hlGreenBtn.hidden = !canAnnotate;
    hlCommentBtn.hidden = !canAnnotate;
    pdfSelBar.hidden = false;
    const left = Math.max(8, Math.min(window.innerWidth - 156, selBounds.left + selBounds.width / 2 - 64));
    const top = Math.max(42, selBounds.top - 36);
    pdfSelBar.style.left = `${left}px`;
    pdfSelBar.style.top = `${top}px`;
  }, 10);
});

container.addEventListener('scroll', hideSelectionBar, { passive: true });

let restore: { page: number; scale: string } | undefined;
let currentDoc: pdfjs.PDFDocumentProxy | undefined;
let outlineDests: (string | unknown[] | null)[] = [];
let outlinePages: number[] = [];

const pager = createPager((n) => {
  viewer.currentPageNumber = n;
}, t('page'));

let singlePage = readState().pdfSingle === true;
const view = segmented<'continuous' | 'single'>(
  t('view'),
  [
    ['continuous', t('viewContinuous')],
    ['single', t('viewSingle')],
  ],
  singlePage ? 'single' : 'continuous',
  (mode) => {
    singlePage = mode === 'single';
    writeState({ pdfSingle: singlePage });
    applyScrollMode();
  },
);

function applyScrollMode() {
  if (viewer.pagesCount) {
    viewer.scrollMode = singlePage ? ScrollMode.PAGE : ScrollMode.VERTICAL;
  }
}

eventBus.on('pagesinit', () => {
  applyScrollMode();
  viewer.currentScaleValue = restore?.scale ?? 'page-width';
  if (restore) {
    viewer.currentPageNumber = Math.max(1, Math.min(restore.page, viewer.pagesCount));
  }
  pager.update(viewer.currentPageNumber, viewer.pagesCount);
  syncAllPageAnnotations();
  if (findWidget.input.value) {
    dispatchPdfFind(findWidget.input.value, '');
  }
});
let reported = false;
eventBus.on('pagerendered', (e: { pageNumber: number; error?: unknown }) => {
  syncPageAnnotation(e.pageNumber);
  if (!reported) {
    reported = true;
    post({
      type: 'status',
      ok: !e.error,
      detail: e.error ? errorText(e.error) : `${viewer.pagesCount} pages, ${outline.size} outline items`,
      mode: modeMachine.mode,
      overlays: overlayStack.getOpenIds(),
    });
  }
});
eventBus.on('pagechanging', (e: { pageNumber: number }) => {
  pager.update(e.pageNumber, viewer.pagesCount);
  highlightThumb(e.pageNumber);
  highlightOutline(e.pageNumber);
});

const zoomLabel = el('button', { class: 'dv-btn dv-label dv-zoom-label', title: t('zoomReset') });
zoomLabel.type = 'button';
zoomLabel.textContent = '100%';
zoomLabel.addEventListener('click', () => {
  viewer.currentScaleValue = '1';
});
eventBus.on('scalechanging', (e: { scale: number }) => {
  zoomLabel.textContent = `${Math.round(e.scale * 100)}%`;
});

// ---------------------------------------------------------------- find

container.tabIndex = -1;
let pdfMatchText = '';

function dispatchPdfFind(query: string, type: '' | 'again', findPrevious = false) {
  eventBus.dispatch('find', {
    source: window,
    type,
    query,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious,
    matchDiacritics: false,
  });
}

const findWidget = createFindBar(
  {
    onInput: (q) => {
      if (!q) {
        pdfMatchText = '';
      }
      dispatchPdfFind(q, '');
    },
    step: (backwards) => {
      if (findWidget.input.value) {
        dispatchPdfFind(findWidget.input.value, 'again', backwards);
      }
    },
    clear: () => {
      pdfMatchText = '';
      dispatchPdfFind('', '');
      eventBus.dispatch('findbarclose', { source: window });
    },
    status: () => pdfMatchText,
  },
  container,
);

function showMatches(e: { matchesCount: { current: number; total: number } }) {
  pdfMatchText = e.matchesCount.total
    ? `${e.matchesCount.current}/${e.matchesCount.total}`
    : findWidget.input.value
      ? t('noMatch')
      : '';
  findWidget.refreshCount(pdfMatchText);
}
eventBus.on('updatefindmatchescount', showMatches);
eventBus.on('updatefindcontrolstate', showMatches);

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) {
    return;
  }
  if (e.key === '=' || e.key === '+') {
    e.preventDefault();
    viewer.increaseScale();
  } else if (e.key === '-' || e.key === '_') {
    e.preventDefault();
    viewer.decreaseScale();
  } else if (e.key === '0') {
    e.preventDefault();
    viewer.currentScaleValue = '1';
  }
});

container.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (e.deltaY < 0) {
        viewer.increaseScale();
      } else {
        viewer.decreaseScale();
      }
    }
  },
  { passive: false },
);

// ---------------------------------------------------------------- outline & thumbnails

function flattenOutline(
  items: { title: string; dest: string | unknown[] | null; items: unknown[] }[],
  level: number,
  out: OutlineItem[],
) {
  for (const item of items) {
    out.push({ level, text: item.title.trim() || '—', key: String(outlineDests.length) });
    outlineDests.push(item.dest);
    flattenOutline(item.items as typeof items, level + 1, out);
  }
}

async function buildOutline(doc: pdfjs.PDFDocumentProxy) {
  outlineDests = [];
  const items: OutlineItem[] = [];
  try {
    flattenOutline(((await doc.getOutline()) ?? []) as never, 1, items);
  } catch {
    // Damaged outline should not fail preview.
  }
  outline.setItems(items);
  void resolveOutlinePages(doc);
  if (!items.length && sidebar.activeTab === 'outline' && !readState().sidebar?.tab) {
    sidebar.setTab('pages', false);
  }
}

async function resolveOutlinePages(doc: pdfjs.PDFDocumentProxy) {
  const dests = outlineDests;
  const pages = new Array<number>(dests.length).fill(0);
  const batchSize = 8;
  for (let start = 0; start < dests.length; start += batchSize) {
    if (dests !== outlineDests || doc !== currentDoc) {
      return;
    }
    await Promise.all(
      dests.slice(start, start + batchSize).map(async (dest, offset) => {
        try {
          const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
          const target = explicit?.[0];
          pages[start + offset] =
            typeof target === 'number' ? target + 1 : target ? (await doc.getPageIndex(target as never)) + 1 : 0;
        } catch {
          pages[start + offset] = 0;
        }
      }),
    );
  }
  if (dests === outlineDests) {
    outlinePages = pages;
    highlightOutline(viewer.currentPageNumber || 1);
  }
}

function highlightOutline(page: number) {
  let best = -1;
  outlinePages.forEach((p, i) => {
    if (p && p <= page && (best < 0 || p >= outlinePages[best])) {
      best = i;
    }
  });
  outline.setActive(best >= 0 ? String(best) : undefined);
}

const THUMB_WIDTH = 120;
let thumbObserver: IntersectionObserver | undefined;

function buildThumbnails(doc: pdfjs.PDFDocumentProxy) {
  thumbObserver?.disconnect();
  thumbs.replaceChildren();
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          thumbObserver?.unobserve(entry.target);
          void renderThumb(doc, entry.target as HTMLElement);
        }
      }
    },
    { root: thumbs, rootMargin: '300px 0px' },
  );
  let dragFromPage = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    const canvasBox = el('span', { class: 'pdf-thumb-page dv-page-invert' });
    const wrap = el('div', { class: 'pdf-thumb-wrap' });
    const link = el('button', { class: 'pdf-thumb', title: t('pageN', n) }, [
      canvasBox,
      el('span', { class: 'pdf-thumb-num', text: String(n) }),
    ]);
    link.type = 'button';
    link.dataset.page = String(n);
    link.addEventListener('click', () => {
      viewer.currentPageNumber = n;
    });
    wrap.append(link);

    if (modeMachine.isEditable) {
      wrap.draggable = true;
      wrap.addEventListener('dragstart', (ev) => {
        dragFromPage = n;
        ev.dataTransfer?.setData('text/plain', String(n));
      });
      wrap.addEventListener('dragover', (ev) => {
        if (dragFromPage && dragFromPage !== n) {
          ev.preventDefault();
          wrap.classList.add('pdf-thumb-drop');
        }
      });
      wrap.addEventListener('dragleave', () => wrap.classList.remove('pdf-thumb-drop'));
      wrap.addEventListener('drop', (ev) => {
        ev.preventDefault();
        wrap.classList.remove('pdf-thumb-drop');
        if (dragFromPage && dragFromPage !== n) {
          post({ type: 'docMutate', mutation: { kind: 'movePdfPage', fromPage: dragFromPage, toPage: n } });
        }
        dragFromPage = 0;
      });

      const miniBtn = (icon: IconName, tip: string, disabled: boolean, fn: () => void) => {
        const b = el('button', { class: 'pdf-thumb-act', title: tip });
        b.type = 'button';
        b.innerHTML = icons[icon];
        b.disabled = disabled;
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          fn();
        });
        return b;
      };
      const tools = el('div', { class: 'pdf-thumb-tools' }, [
        miniBtn('rotateCW', t('pdfSaveRotateCW'), false, () =>
          post({ type: 'docMutate', mutation: { kind: 'rotatePdfPages', pages: [n], delta: 90 } }),
        ),
        miniBtn('up', t('pdfMoveUp'), n === 1, () =>
          post({ type: 'docMutate', mutation: { kind: 'movePdfPage', fromPage: n, toPage: n - 1 } }),
        ),
        miniBtn('down', t('pdfMoveDown'), n === doc.numPages, () =>
          post({ type: 'docMutate', mutation: { kind: 'movePdfPage', fromPage: n, toPage: n + 1 } }),
        ),
        miniBtn('close', t('pdfDeletePage'), doc.numPages <= 1, () =>
          post({ type: 'docMutate', mutation: { kind: 'deletePdfPage', page: n } }),
        ),
      ]);
      wrap.append(tools);
    }

    thumbs.append(wrap);
    thumbObserver.observe(link);
  }
  highlightThumb(viewer.currentPageNumber || 1);
}

async function renderThumb(doc: pdfjs.PDFDocumentProxy, link: HTMLElement) {
  if (doc !== currentDoc) {
    return;
  }
  try {
    const page = await doc.getPage(Number(link.dataset.page));
    const base = page.getViewport({ scale: 1 });
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: (THUMB_WIDTH / base.width) * ratio });
    const canvas = el('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = `${THUMB_WIDTH}px`;
    canvas.style.height = `${Math.round(viewport.height / ratio)}px`;
    await page.render({ canvas, viewport }).promise;
    link.querySelector('.pdf-thumb-page')?.replaceChildren(canvas);
  } catch {
    // Leave blank placeholder.
  }
}

function highlightThumb(page: number) {
  for (const thumb of thumbs.querySelectorAll<HTMLElement>('.pdf-thumb')) {
    const on = thumb.dataset.page === String(page);
    thumb.classList.toggle('pdf-thumb-active', on);
    if (on) {
      thumb.setAttribute('aria-current', 'page');
      if (!sidebar.node.hidden && sidebar.activeTab === 'pages') {
        thumb.scrollIntoView({ block: 'nearest' });
      }
    } else {
      thumb.removeAttribute('aria-current');
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && thumbObserver) {
    for (const thumb of thumbs.querySelectorAll<HTMLElement>('.pdf-thumb')) {
      const box = thumb.querySelector('.pdf-thumb-page');
      const canvas = box?.querySelector('canvas');
      if (canvas && box) {
        canvas.width = 0;
        canvas.height = 0;
        box.replaceChildren();
        thumbObserver.observe(thumb);
      }
    }
  }
});

// ---------------------------------------------------------------- loading

let workerReady: Promise<void> | undefined;
let pendingWorkerBlobUrl: string | undefined;

function ensureWorker(): Promise<void> {
  workerReady ??= (async () => {
    const res = await fetch(`${assets}/pdf.worker.min.mjs`);
    if (!res.ok) {
      throw new Error(`pdf worker: HTTP ${res.status}`);
    }
    const blob = new Blob([await res.text()], { type: 'text/javascript' });
    pendingWorkerBlobUrl = URL.createObjectURL(blob);
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(pendingWorkerBlobUrl, { type: 'module' });
  })();
  return workerReady;
}

let loadGeneration = 0;

async function load(bytes: Uint8Array, initialPage?: number) {
  const myGen = ++loadGeneration;
  try {
    await ensureWorker();
    if (myGen !== loadGeneration) {
      return;
    }
    if (initialPage && initialPage >= 1) {
      restore = { page: initialPage, scale: viewer.currentScaleValue || 'page-width' };
    } else if (currentDoc) {
      restore = { page: viewer.currentPageNumber, scale: viewer.currentScaleValue || 'page-width' };
    }
    const doc = await pdfjs.getDocument({
      data: toArrayBuffer(bytes),
      cMapUrl: `${assets}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assets}/standard_fonts/`,
      wasmUrl: `${assets}/wasm/`,
      iccUrl: `${assets}/iccs/`,
      useWorkerFetch: false,
    }).promise;
    if (myGen !== loadGeneration) {
      void doc.loadingTask.destroy();
      return;
    }
    if (pendingWorkerBlobUrl) {
      URL.revokeObjectURL(pendingWorkerBlobUrl);
      pendingWorkerBlobUrl = undefined;
    }
    const previous = currentDoc;
    currentDoc = doc;
    reported = false;
    status.hidden = true;
    await buildOutline(doc);
    if (myGen !== loadGeneration) {
      return;
    }
    viewer.setDocument(doc);
    linkService.setDocument(doc, null);
    buildThumbnails(doc);
    syncCommentsUi();
    void previous?.loadingTask.destroy();
  } catch (err) {
    if (myGen !== loadGeneration) {
      return;
    }
    status.hidden = false;
    status.classList.add('dv-error');
    status.textContent = t('loadFailed', errorText(err));
    post({ type: 'status', ok: false, detail: errorText(err) });
  }
}

// ---------------------------------------------------------------- toolbar

function rotatePdfPages() {
  if (viewer.pagesCount) {
    viewer.pagesRotation = (viewer.pagesRotation + 90) % 360;
  }
}

const zoomGroup = el('div', { class: 'dv-zoom' }, [
  iconButton('minus', t('zoomOut'), () => viewer.decreaseScale()),
  zoomLabel,
  iconButton('plus', t('zoomIn'), () => viewer.increaseScale()),
  iconButton('fitWidth', t('fitWidth'), () => {
    viewer.currentScaleValue = 'page-width';
  }),
  iconButton('rotateCW', t('pdfRotateCW'), rotatePdfPages),
]);

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function mkOption(val: string, label: string): HTMLOptionElement {
  const o = el('option', { text: label }) as HTMLOptionElement;
  o.value = val;
  return o;
}

function openPdfTextBoxModal() {
  const backdrop = el('div', { class: 'dv-modal-backdrop' });
  const textArea = el('textarea', { class: 'dv-input' }) as HTMLTextAreaElement;
  textArea.placeholder = t('pdfAddText');
  textArea.rows = 3;
  const colorSelect = el('select', { class: 'dv-input' }, [
    mkOption('#111827', 'Black'),
    mkOption('#1d4ed8', 'Blue'),
    mkOption('#dc2626', 'Red'),
  ]) as HTMLSelectElement;
  colorSelect.style.width = 'auto';
  const posSelect = el('select', { class: 'dv-input' }, [
    mkOption('top', 'Top'),
    mkOption('center', 'Center'),
    mkOption('bottom', 'Bottom'),
  ]) as HTMLSelectElement;
  posSelect.style.width = 'auto';

  const close = () => {
    overlayStack.remove('pdfTextBoxModal');
    backdrop.remove();
  };

  const applyBtn = el('button', { class: 'dv-btn dv-btn-primary', text: t('pdfSignaturePlace') });
  applyBtn.type = 'button';
  applyBtn.addEventListener('click', () => {
    const raw = textArea.value.trim();
    if (!raw) return;
    const lines = raw.split(/\r?\n/);
    const canvas = document.createElement('canvas');
    const pad = 18;
    const fontSize = 32;
    const lineH = 42;
    const ctx = canvas.getContext('2d')!;
    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif`;
    const maxW = Math.max(160, ...lines.map((l) => ctx.measureText(l).width));
    canvas.width = Math.min(1200, Math.ceil(maxW + pad * 2));
    canvas.height = Math.ceil(lines.length * lineH + pad * 2);
    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif`;
    ctx.fillStyle = colorSelect.value;
    ctx.textBaseline = 'top';
    lines.forEach((line, idx) => ctx.fillText(line, pad, pad + idx * lineH));

    void canvasToPngBytes(canvas).then((pngBytes) => {
      const y = posSelect.value === 'top' ? 0.08 : posSelect.value === 'bottom' ? 0.8 : 0.44;
      const w = Math.min(0.75, Math.max(0.22, canvas.width / 1100));
      const h = Math.min(0.25, Math.max(0.04, canvas.height / 1500));
      post({
        type: 'docMutate',
        mutation: {
          kind: 'addPdfImageStamp',
          page: viewer.currentPageNumber || 1,
          rect: { x: 0.12, y, w, h },
          pngBytes,
        },
      });
      close();
    });
  });

  const controlsRow = el('div', {}, [colorSelect, posSelect]);
  controlsRow.style.cssText = 'display:flex;gap:8px;align-items:center';
  const body = el('div', { class: 'dv-modal-body' }, [textArea, controlsRow]);
  body.style.cssText = 'display:flex;flex-direction:column;gap:8px';
  const modal = el('div', { class: 'dv-modal' }, [
    el('div', { class: 'dv-modal-header' }, [
      el('span', { class: 'dv-modal-title', text: t('pdfAddText') }),
      iconButton('close', t('cancel'), close),
    ]),
    body,
    el('div', { class: 'dv-modal-footer' }, [applyBtn]),
  ]);
  modal.style.width = 'min(440px,92vw)';
  backdrop.append(modal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.body.append(backdrop);
  overlayStack.push({ id: 'pdfTextBoxModal', isOpen: () => backdrop.isConnected, close });
  textArea.focus();
}

function openPdfSignatureModal() {
  const backdrop = el('div', { class: 'dv-modal-backdrop' });
  const canvas = document.createElement('canvas');
  canvas.width = 560;
  canvas.height = 200;
  canvas.style.cssText =
    'width:100%;height:170px;background:#fff;border:1px solid var(--dv-border);border-radius:6px;cursor:crosshair;touch-action:none;';
  const ctx = canvas.getContext('2d')!;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = '#111827';
  let drawing = false;
  let hasInk = false;
  let uploadedPng: Uint8Array | undefined;

  const pt = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * canvas.width) / Math.max(1, r.width),
      y: ((e.clientY - r.top) * canvas.height) / Math.max(1, r.height),
    };
  };
  canvas.addEventListener('pointerdown', (e) => {
    uploadedPng = undefined;
    drawing = true;
    hasInk = true;
    canvas.setPointerCapture(e.pointerId);
    const p = pt(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = pt(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });
  const stop = () => {
    drawing = false;
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  const fileInput = el('input') as HTMLInputElement;
  fileInput.type = 'file';
  fileInput.accept = 'image/png';
  fileInput.hidden = true;
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    void f.arrayBuffer().then((ab) => {
      uploadedPng = new Uint8Array(ab);
      hasInk = true;
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        ctx.drawImage(img, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
        URL.revokeObjectURL(url);
      };
      img.src = url;
    });
  });

  const close = () => {
    overlayStack.remove('pdfSignatureModal');
    backdrop.remove();
  };

  const clearBtn = el('button', { class: 'dv-btn', text: t('pdfSignatureClear') });
  clearBtn.type = 'button';
  clearBtn.addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasInk = false;
    uploadedPng = undefined;
  });

  const loadBtn = el('button', { class: 'dv-btn', text: t('pdfSignatureLoadPng') });
  loadBtn.type = 'button';
  loadBtn.addEventListener('click', () => fileInput.click());

  const applyBtn = el('button', { class: 'dv-btn dv-btn-primary', text: t('pdfSignaturePlace') });
  applyBtn.type = 'button';
  applyBtn.addEventListener('click', () => {
    if (!hasInk) return;
    const finish = (pngBytes: Uint8Array) => {
      post({
        type: 'docMutate',
        mutation: {
          kind: 'addPdfImageStamp',
          page: viewer.currentPageNumber || 1,
          rect: { x: 0.62, y: 0.78, w: 0.28, h: 0.1 },
          pngBytes,
        },
      });
      close();
    };
    if (uploadedPng) {
      finish(uploadedPng);
    } else {
      void canvasToPngBytes(canvas).then(finish);
    }
  });

  const sigBody = el('div', { class: 'dv-modal-body' }, [
    el('div', { class: 'dv-label', text: t('pdfSignatureHint') }),
    canvas,
    fileInput,
  ]);
  sigBody.style.cssText = 'display:flex;flex-direction:column;gap:8px';
  const modal = el('div', { class: 'dv-modal' }, [
    el('div', { class: 'dv-modal-header' }, [
      el('span', { class: 'dv-modal-title', text: t('pdfAddSignature') }),
      iconButton('close', t('cancel'), close),
    ]),
    sigBody,
    el('div', { class: 'dv-modal-footer' }, [clearBtn, loadBtn, applyBtn]),
  ]);
  modal.style.width = 'min(520px,92vw)';
  backdrop.append(modal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.body.append(backdrop);
  overlayStack.push({ id: 'pdfSignatureModal', isOpen: () => backdrop.isConnected, close });
}

function openPdfWatermarkModal() {
  const backdrop = el('div', { class: 'dv-modal-backdrop' });
  const textInput = el('input', { class: 'dv-input' }) as HTMLInputElement;
  textInput.placeholder = t('pdfWatermarkText');
  textInput.value = 'CONFIDENTIAL';
  const pageNumCb = el('input') as HTMLInputElement;
  pageNumCb.type = 'checkbox';
  pageNumCb.checked = true;

  const close = () => {
    overlayStack.remove('pdfWatermarkModal');
    backdrop.remove();
  };

  const applyBtn = el('button', { class: 'dv-btn dv-btn-primary', text: t('pdfWatermarkApply') });
  applyBtn.type = 'button';
  applyBtn.addEventListener('click', () => {
    const label = textInput.value.trim();
    const pageNumbers = pageNumCb.checked;
    if (!label && !pageNumbers) return;
    const send = (watermarkPngBytes?: Uint8Array) => {
      post({
        type: 'docMutate',
        mutation: {
          kind: 'addPdfWatermark',
          watermarkPngBytes,
          pageNumbers,
        },
      });
      close();
    };
    if (!label) {
      send(undefined);
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 800;
    const ctx = canvas.getContext('2d')!;
    ctx.translate(400, 400);
    ctx.rotate(-Math.PI / 5);
    ctx.font = '700 84px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';
    ctx.fillStyle = '#334155';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 0);
    void canvasToPngBytes(canvas).then(send);
  });

  const wmBody = el('div', { class: 'dv-modal-body' }, [
    textInput,
    el('label', { class: 'dv-check' }, [pageNumCb, el('span', { text: t('pdfWatermarkPageNums') })]),
  ]);
  wmBody.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  const modal = el('div', { class: 'dv-modal' }, [
    el('div', { class: 'dv-modal-header' }, [
      el('span', { class: 'dv-modal-title', text: t('pdfAddWatermark') }),
      iconButton('close', t('cancel'), close),
    ]),
    wmBody,
    el('div', { class: 'dv-modal-footer' }, [applyBtn]),
  ]);
  modal.style.width = 'min(420px,92vw)';
  backdrop.append(modal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.body.append(backdrop);
  overlayStack.push({ id: 'pdfWatermarkModal', isOpen: () => backdrop.isConnected, close });
  textInput.focus();
  textInput.select();
}

const pdfToolsDropdown = moreMenu(
  t('moreTools'),
  [
    {
      icon: 'pencil',
      label: t('pdfAddText'),
      visible: () => modeMachine.isEditable,
      onClick: openPdfTextBoxModal,
    },
    {
      icon: 'signature',
      label: t('pdfAddSignature'),
      visible: () => modeMachine.isEditable,
      onClick: openPdfSignatureModal,
    },
    {
      icon: 'watermark',
      label: t('pdfAddWatermark'),
      visible: () => modeMachine.isEditable,
      onClick: openPdfWatermarkModal,
    },
    '-',
    {
      icon: 'rotateCW',
      label: t('pdfSaveRotateCW'),
      visible: () => modeMachine.isEditable,
      onClick: () =>
        post({
          type: 'docMutate',
          mutation: { kind: 'rotatePdfPages', pages: [viewer.currentPageNumber || 1], delta: 90 },
        }),
    },
    {
      icon: 'export',
      label: t('pdfExtractPages'),
      visible: () => modeMachine.isEditable,
      onClick: () =>
        post({
          type: 'extractPdfPages',
          currentPage: viewer.currentPageNumber || 1,
          totalPages: viewer.pagesCount || 1,
        }),
    },
    {
      icon: 'plus',
      label: t('pdfMerge'),
      visible: () => modeMachine.isEditable,
      onClick: () => post({ type: 'mergePdfs' }),
    },
    '-',
    {
      icon: 'export',
      label: t('exportCommentsMd'),
      visible: () => comments.length > 0,
      onClick: () => commentsPanel.exportMarkdown(),
    },
  ],
  'export',
  { compact: true },
);

const historyBtn = iconButton('history', t('history'), () => post({ type: 'history' }));

function extractVisiblePdfContext(): string {
  const curPage = viewer.currentPageNumber || 1;
  const chunks: string[] = [];
  for (const p of [curPage - 1, curPage, curPage + 1]) {
    const pageNode = viewerEl.querySelector<HTMLElement>(`.page[data-page-number="${p}"] .textLayer`);
    const txt = pageNode?.textContent?.replace(/\s+/g, ' ').trim();
    if (txt) {
      chunks.push(`[Page ${p}]\n${txt}`);
    }
  }
  return chunks.join('\n\n').slice(0, 12_000);
}

let openPdfDrawerFn: (() => void) | undefined;

const ai = createAiAssistant({
  viewerKind: 'pdf',
  getFileName: () => docFileName,
  onOpenSettings: () => openPdfDrawerFn?.(),
  focusReturnTarget: () => container,
  captureContext: () => {
    const curPage = viewer.currentPageNumber || 1;
    const selText = window.getSelection()?.toString().replace(/\s+/g, ' ').trim() ?? '';
    if (pendingSel) {
      return {
        selection: pendingSel.fullText,
        surrounding: extractVisiblePdfContext(),
        badge: `${t('pageN', pendingSel.page)} (${pendingSel.fullText.length})`,
        meta: pendingSel,
      };
    }
    if (selText) {
      return {
        selection: selText,
        surrounding: extractVisiblePdfContext(),
        badge: `${t('pageN', curPage)} (${selText.length})`,
      };
    }
    return {
      surrounding: extractVisiblePdfContext(),
      badge: t('pageN', curPage),
    };
  },
  applyActions: [
    {
      id: 'save-pdf-comment',
      label: () => t('aiApplyComment'),
      primary: true,
      visible: () => modeMachine.isEditable,
      onApply: ({ text, captured }) => {
        const snap = captured.meta as PdfSelectionSnap | undefined;
        sidebar.setOpen(true);
        sidebar.setTab('comments');
        if (snap) {
          post({
            type: 'docMutate',
            mutation: {
              kind: 'addComment',
              page: snap.page,
              rect: snap.rect,
              quads: snap.quads,
              quote: snap.quote,
              text: text.trim(),
              color: '#fde047',
              subtype: 'highlight',
            },
          });
        } else {
          post({
            type: 'docMutate',
            mutation: {
              kind: 'addComment',
              page: viewer.currentPageNumber || 1,
              rect: { x: 0.88, y: 0.08, w: 0, h: 0 },
              text: text.trim(),
            },
          });
        }
      },
    },
  ],
});

const topBar = customToolbar({
  subtitle: 'PDF',
  slots: [
    { id: 'nav', nodes: [sidebar.toggle] },
    { id: 'view', nodes: [view.node] },
    { id: 'pager', nodes: [pager.node] },
    { id: 'zoom', nodes: [zoomGroup] },
    { id: 'find', nodes: findWidget.nodes },
    { id: 'comments', nodes: [annotateToggle.node], visible: () => modeMachine.isEditable },
    { id: 'ai', nodes: [ai.button] },
    { id: 'actions', nodes: [pdfToolsDropdown], visible: () => modeMachine.isEditable || comments.length > 0 },
    { id: 'history', nodes: [historyBtn], visible: () => getFileState().history },
    { id: 'openApp', nodes: [openExternalButton()] },
  ],
  documentActions: [
    { label: t('aiAssistant'), icon: 'sparkle', onClick: () => ai.open() },
    openExternalMenuItem(),
    { label: t('pdfRotateCW'), icon: 'rotateCW', onClick: rotatePdfPages },
    {
      label: t('pdfSaveRotateCW'),
      icon: 'rotateCW',
      visible: () => modeMachine.isEditable,
      onClick: () =>
        post({
          type: 'docMutate',
          mutation: { kind: 'rotatePdfPages', pages: [viewer.currentPageNumber || 1], delta: 90 },
        }),
    },
    {
      label: t('pdfExtractPages'),
      icon: 'export',
      visible: () => modeMachine.isEditable,
      onClick: () =>
        post({
          type: 'extractPdfPages',
          currentPage: viewer.currentPageNumber || 1,
          totalPages: viewer.pagesCount || 1,
        }),
    },
    { label: t('pdfMerge'), icon: 'plus', visible: () => modeMachine.isEditable, onClick: () => post({ type: 'mergePdfs' }) },
    {
      label: t('exportCommentsMd'),
      icon: 'export',
      visible: () => comments.length > 0,
      onClick: () => commentsPanel.exportMarkdown(),
    },
    { label: t('history'), icon: 'history', visible: () => getFileState().history, onClick: () => post({ type: 'history' }) },
  ],
});

modeMachine.onChange(() => {
  if (reported) {
    post({ type: 'status', ok: true, mode: modeMachine.mode, overlays: overlayStack.getOpenIds() });
  }
});
bindLiveViewerStatus(
  (mode, overlays) => post({ type: 'status', ok: true, mode, overlays }),
  () => modeMachine.mode,
  () => reported,
);
openPdfDrawerFn = () => topBar.openDrawer();
app.append(
  topBar.node,
  notice.node,
  el('div', { class: 'dv-body' }, [sidebar.node, el('div', { class: 'dv-main' }, [sidebar.expandBtn, stage])]),
);

onMessage((message) => {
  if (message.type === 'load') {
    docFileName = message.name || 'Document.pdf';
    modeMachine.setEditable(message.editable === true);
    comments = message.comments ?? [];
    topBar.refresh();
    void load(message.bytes, message.initialPage);
  } else if (message.type === 'comments') {
    comments = message.comments;
    topBar.refresh();
    syncCommentsUi();
  } else if (message.type === 'error') {
    status.hidden = false;
    status.classList.add('dv-error');
    status.textContent = message.message;
  }
});

post({ type: 'ready' });
