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
import { app, config, el, errorText, onMessage, post, t, toArrayBuffer } from '../shared/api';
import {
  attachSurfaceAnnotator,
  closeFloatingEditors,
  CommentsPanel,
  renderSurfaceAnnotations,
} from '../shared/comments';
import { getFileState } from '../shared/fileState';
import { icons } from '../shared/icons';
import { Outline, readState, Sidebar, writeState, type OutlineItem } from '../shared/sidebar';
import {
  customToolbar,
  iconButton,
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

let editable = false;
let annotateMode = false;
let comments: DocComment[] = [];

const annotateToggle = toggleButton('commentPlus', t('addComment'), (on) => {
  annotateMode = on;
  viewerEl.classList.toggle('pdf-annotating', on);
  closeFloatingEditors();
  if (on) {
    sidebar.setOpen(true);
    sidebar.setTab('comments');
    notice.flash(t('annotatePdfHint'), 2800);
  }
});

const commentsPanel = new CommentsPanel({
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
    annotateMode = !annotateMode;
    annotateToggle.set(annotateMode);
    viewerEl.classList.toggle('pdf-annotating', annotateMode);
    if (annotateMode) {
      notice.flash(t('annotatePdfHint'), 2800);
    }
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
  renderSurfaceAnnotations(pageEl, entries, commentsPanel.active, (comment) => {
    sidebar.setOpen(true);
    sidebar.setTab('comments');
    commentsPanel.setActive(comment.id, true);
    syncAllPageAnnotations();
  });
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
  isActive: () => editable && annotateMode,
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
    viewer.currentPageNumber = Math.min(restore.page, viewer.pagesCount);
  }
  pager.update(viewer.currentPageNumber, viewer.pagesCount);
  syncAllPageAnnotations();
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

const findInput = el('input');
findInput.type = 'search';
findInput.placeholder = t('find');
findInput.setAttribute('aria-label', t('find'));
const findIcon = el('span', { class: 'pdf-find-icon' });
findIcon.innerHTML = icons.search;
const findBox = el('label', { class: 'dv-search pdf-find' }, [findIcon, findInput]);
const findStatus = el('span', { class: 'dv-label' });

function showMatches(e: { matchesCount: { current: number; total: number } }) {
  findStatus.textContent = e.matchesCount.total
    ? `${e.matchesCount.current}/${e.matchesCount.total}`
    : findInput.value
      ? t('noMatch')
      : '';
}
eventBus.on('updatefindmatchescount', showMatches);
eventBus.on('updatefindcontrolstate', showMatches);

function find(type: '' | 'again', findPrevious = false) {
  eventBus.dispatch('find', {
    source: window,
    type,
    query: findInput.value,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious,
    matchDiacritics: false,
  });
}

findInput.addEventListener('input', () => find(''));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    find('again', e.shiftKey);
  }
});

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    findInput.focus();
    findInput.select();
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
  for (let n = 1; n <= doc.numPages; n++) {
    const canvasBox = el('span', { class: 'pdf-thumb-page dv-page-invert' });
    const link = el('button', { class: 'pdf-thumb', title: t('pageN', n) }, [
      canvasBox,
      el('span', { class: 'pdf-thumb-num', text: String(n) }),
    ]);
    link.type = 'button';
    link.dataset.page = String(n);
    link.addEventListener('click', () => {
      viewer.currentPageNumber = n;
    });
    thumbs.append(link);
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

async function load(bytes: Uint8Array) {
  try {
    await ensureWorker();
    if (currentDoc) {
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
    if (pendingWorkerBlobUrl) {
      URL.revokeObjectURL(pendingWorkerBlobUrl);
      pendingWorkerBlobUrl = undefined;
    }
    const previous = currentDoc;
    currentDoc = doc;
    reported = false;
    status.hidden = true;
    await buildOutline(doc);
    viewer.setDocument(doc);
    linkService.setDocument(doc, null);
    buildThumbnails(doc);
    syncCommentsUi();
    void previous?.loadingTask.destroy();
  } catch (err) {
    status.hidden = false;
    status.classList.add('dv-error');
    status.textContent = t('loadFailed', errorText(err));
    post({ type: 'status', ok: false, detail: errorText(err) });
  }
}

// ---------------------------------------------------------------- toolbar

const zoomGroup = el('div', { class: 'dv-zoom' }, [
  iconButton('minus', t('zoomOut'), () => viewer.decreaseScale()),
  zoomLabel,
  iconButton('plus', t('zoomIn'), () => viewer.increaseScale()),
  iconButton('fitWidth', t('fitWidth'), () => {
    viewer.currentScaleValue = 'page-width';
  }),
]);

const historyBtn = iconButton('history', t('history'), () => post({ type: 'history' }));

const topBar = customToolbar({
  subtitle: 'PDF',
  slots: [
    { id: 'nav', nodes: [sidebar.toggle] },
    { id: 'view', nodes: [view.node] },
    { id: 'pager', nodes: [pager.node] },
    { id: 'zoom', nodes: [zoomGroup] },
    { id: 'find', nodes: [findBox, findStatus] },
    { id: 'comments', nodes: [annotateToggle.node], visible: () => editable },
    { id: 'history', nodes: [historyBtn], visible: () => getFileState().history },
    { id: 'openApp', nodes: [openExternalButton()] },
  ],
  documentActions: [
    openExternalMenuItem(),
    { label: t('history'), icon: 'history', visible: () => getFileState().history, onClick: () => post({ type: 'history' }) },
  ],
});

app.append(
  topBar.node,
  notice.node,
  el('div', { class: 'dv-body' }, [sidebar.node, el('div', { class: 'dv-main' }, [sidebar.expandBtn, stage])]),
);

onMessage((message) => {
  if (message.type === 'load') {
    editable = message.editable === true;
    comments = message.comments ?? [];
    topBar.refresh();
    void load(message.bytes);
  } else if (message.type === 'comments') {
    comments = message.comments;
    syncCommentsUi();
  } else if (message.type === 'error') {
    status.hidden = false;
    status.classList.add('dv-error');
    status.textContent = message.message;
  }
});

post({ type: 'ready' });
