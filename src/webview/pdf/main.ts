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
import { app, config, el, errorText, onMessage, post, t, toArrayBuffer } from '../shared/api';
import { icons } from '../shared/icons';
import { Outline, readState, Sidebar, writeState, type OutlineItem } from '../shared/sidebar';
import { iconButton, segmented, toolbar } from '../shared/ui';
import { createPager } from '../shared/zoom';

const assets = `${config.assets}/pdfjs`;

// ---------------------------------------------------------------- layout

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

const outline = new Outline((key) => {
  const dest = outlineDests[Number(key)];
  if (dest) {
    void linkService.goToDestination(dest);
  }
}, { emptyText: t('noOutline'), countText: (n) => t('headingCount', n) });
sidebar.panel('outline').append(outline.node);

let restore: { page: number; scale: string } | undefined;
let currentDoc: pdfjs.PDFDocumentProxy | undefined;
let outlineDests: (string | unknown[] | null)[] = [];
/** Page number (1-based) each outline entry points at, once resolved; 0 when unknown. */
let outlinePages: number[] = [];

const pager = createPager((n) => {
  viewer.currentPageNumber = n;
}, t('page'));

let singlePage = readState().pdfSingle === true;
// Continuous: all pages in one scroll. Single page: one page at a time.
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
});
let reported = false;
eventBus.on('pagerendered', (e: { pageNumber: number; error?: unknown }) => {
  // The first painted page proves the worker, fonts and decoders all loaded.
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
    // A damaged outline is not worth failing the preview over.
  }
  outline.setItems(items);
  void resolveOutlinePages(doc);
  // Documents without bookmarks open on the page thumbnails instead.
  if (!items.length && sidebar.activeTab === 'outline' && !readState().sidebar?.tab) {
    sidebar.setTab('pages', false);
  }
}

async function resolveOutlinePages(doc: pdfjs.PDFDocumentProxy) {
  const dests = outlineDests;
  const pages = await Promise.all(
    dests.map(async (dest) => {
      try {
        const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
        const target = explicit?.[0];
        if (typeof target === 'number') {
          return target + 1;
        }
        return target ? (await doc.getPageIndex(target as never)) + 1 : 0;
      } catch {
        return 0;
      }
    }),
  );
  if (dests === outlineDests) {
    outlinePages = pages;
    highlightOutline(viewer.currentPageNumber || 1);
  }
}

/** Marks the last bookmark that starts on or before the current page. */
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
    // Leave the blank placeholder.
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

// ---------------------------------------------------------------- loading

let workerReady: Promise<void> | undefined;

/** Webviews can only start workers from blob: URLs, so load the script text first. */
function ensureWorker(): Promise<void> {
  workerReady ??= (async () => {
    const res = await fetch(`${assets}/pdf.worker.min.mjs`);
    if (!res.ok) {
      throw new Error(`pdf worker: HTTP ${res.status}`);
    }
    const blob = new Blob([await res.text()], { type: 'text/javascript' });
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(blob), { type: 'module' });
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
      // Resource fetches go through the page, where the webview resource origin is reachable.
      useWorkerFetch: false,
    }).promise;
    const previous = currentDoc;
    currentDoc = doc;
    reported = false;
    status.hidden = true;
    await buildOutline(doc);
    viewer.setDocument(doc);
    linkService.setDocument(doc, null);
    buildThumbnails(doc);
    void previous?.loadingTask.destroy();
  } catch (err) {
    status.hidden = false;
    status.classList.add('dv-error');
    status.textContent = t('loadFailed', errorText(err));
    post({ type: 'status', ok: false, detail: errorText(err) });
  }
}

// ---------------------------------------------------------------- toolbar

app.append(
  toolbar(
    sidebar.toggle,
    view.node,
    '|',
    pager.node,
    '|',
    el('div', { class: 'dv-zoom' }, [
      iconButton('minus', t('zoomOut'), () => viewer.decreaseScale()),
      zoomLabel,
      iconButton('plus', t('zoomIn'), () => viewer.increaseScale()),
      iconButton('fitWidth', t('fitWidth'), () => {
        viewer.currentScaleValue = 'page-width';
      }),
    ]),
    '|',
    findBox,
    findStatus,
  ),
  el('div', { class: 'dv-body' }, [sidebar.node, el('div', { class: 'dv-main' }, [stage])]),
);

onMessage((message) => {
  if (message.type === 'load') {
    void load(message.bytes);
  } else if (message.type === 'error') {
    status.hidden = false;
    status.classList.add('dv-error');
    status.textContent = message.message;
  }
});

post({ type: 'ready' });
