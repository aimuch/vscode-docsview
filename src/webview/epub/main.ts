// EPUB 2 / EPUB 3 e-book reader webview: chapter & TOC navigation, continuous or paged chapter
// reading, full-text search across chapters, theme palettes (Editor / GitHub / Paper / Academic),
// and keyboard navigation.
import '../shared/base.css';
import '../markdown/markdown.css';
import './epub.css';
import type { EpubBookData } from '../../common/protocol';
import { app, el, onMessage, post, showStatus, t } from '../shared/api';
import { themeToolbarButton } from '../shared/appearance';
import { createFindWidget, PreviewFind } from '../shared/find';
import { Outline, readState, Sidebar, writeState } from '../shared/sidebar';
import { customToolbar, openExternalButton, openExternalMenuItem, segmented } from '../shared/ui';
import { createPager, createZoom } from '../shared/zoom';

const scroller = el('div', { class: 'md-scroll epub-scroll' });
scroller.tabIndex = -1;
const article = el('article', { class: 'markdown-body epub-body' });
scroller.append(article);

const sidebar = new Sidebar(t('toc'), undefined, { defaultOpen: true });
const outline = new Outline(
  (key) => {
    const [chStr, anchor] = key.split('#');
    goToChapter(Number(chStr), anchor);
  },
  { countText: (n) => t('epubChapters', n) },
);
sidebar.panel().append(outline.node);

let book: EpubBookData | undefined;
let chapterSections: HTMLElement[] = [];
let currentChapter = 0;
let singleMode = readState().epubSingle === true;

const viewSeg = segmented<'continuous' | 'single'>(
  t('view'),
  [
    ['continuous', t('viewContinuous')],
    ['single', t('viewSingle')],
  ],
  singleMode ? 'single' : 'continuous',
  (mode) => {
    singleMode = mode === 'single';
    writeState({ epubSingle: singleMode });
    applyChapterVisibility();
  },
);

const pager = createPager((n) => goToChapter(n - 1), t('page'));
const zoom = createZoom((v) => article.style.setProperty('zoom', String(v)), scroller);

const epubFind = new PreviewFind(article, scroller, {
  includeHidden: true,
  onReveal: (range) => {
    const sec = range.startContainer.parentElement?.closest<HTMLElement>('.epub-chapter');
    if (sec) {
      const idx = Number(sec.dataset.chapter);
      if (Number.isFinite(idx) && idx !== currentChapter) {
        setCurrentChapter(idx);
        if (singleMode) {
          applyChapterVisibility();
        }
      }
    }
  },
});
const findWidget = createFindWidget(epubFind, scroller);

const topBar = customToolbar({
  subtitle: () => (book ? book.title : 'EPUB'),
  slots: [
    { id: 'nav', nodes: [sidebar.toggle] },
    { id: 'view', nodes: [viewSeg.node] },
    { id: 'pager', nodes: [pager.node] },
    { id: 'zoom', nodes: zoom.nodes },
    { id: 'find', nodes: findWidget.nodes },
    { id: 'theme', nodes: [themeToolbarButton()] },
    { id: 'openApp', nodes: [openExternalButton()] },
  ],
  documentActions: [openExternalMenuItem()],
});

const statusLabel = el('span', { class: 'dv-label' });
const statusBar = el('div', { class: 'md-statusbar' }, [el('div', { class: 'dv-spacer' }), statusLabel]);

app.append(
  topBar.node,
  el('div', { class: 'dv-body' }, [sidebar.node, el('div', { class: 'dv-main' }, [sidebar.expandBtn, scroller])]),
  statusBar,
);
showStatus(article, t('loading'));

function setCurrentChapter(idx: number) {
  if (!chapterSections.length) return;
  currentChapter = Math.max(0, Math.min(chapterSections.length - 1, idx));
  pager.update(currentChapter + 1, chapterSections.length);
  if (book) {
    let bestKey: string | undefined;
    book.toc.forEach((item, i) => {
      if (item.chapterIndex <= currentChapter) {
        bestKey = `${item.chapterIndex}${item.anchor ? `#${item.anchor}` : `#toc-${i}`}`;
      }
    });
    outline.setActive(bestKey);
  }
}

function applyChapterVisibility() {
  chapterSections.forEach((sec, idx) => {
    sec.hidden = singleMode && idx !== currentChapter;
  });
  if (singleMode) {
    scroller.scrollTop = 0;
  } else {
    chapterSections[currentChapter]?.scrollIntoView({ block: 'start' });
  }
}

function goToChapter(idx: number, anchor?: string) {
  if (!chapterSections.length) return;
  setCurrentChapter(idx);
  if (singleMode) {
    applyChapterVisibility();
  }
  const sec = chapterSections[currentChapter];
  if (anchor && !anchor.startsWith('toc-')) {
    const target = sec?.querySelector<HTMLElement>(`[id="${CSS.escape(anchor)}"]`);
    if (target) {
      target.scrollIntoView({ block: 'start' });
      return;
    }
  }
  if (!singleMode) {
    sec?.scrollIntoView({ block: 'start' });
  }
}

article.addEventListener('click', (e) => {
  const link = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[href]');
  if (!link) return;
  const href = link.getAttribute('href') ?? '';
  const m = /^#epub-ch-(\d+)(?:-(.+))?$/.exec(href);
  if (m) {
    e.preventDefault();
    goToChapter(Number(m[1]), m[2]);
  }
});

let scrollFrame = 0;
scroller.addEventListener('scroll', () => {
  if (singleMode || scrollFrame || !chapterSections.length) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    const top = scroller.getBoundingClientRect().top + 48;
    let activeIdx = 0;
    chapterSections.forEach((sec, idx) => {
      if (sec.getBoundingClientRect().top <= top) {
        activeIdx = idx;
      }
    });
    if (activeIdx !== currentChapter) {
      setCurrentChapter(activeIdx);
    }
  });
});

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  if (!singleMode || target?.closest('input, textarea')) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') {
    e.preventDefault();
    goToChapter(currentChapter + 1);
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    e.preventDefault();
    goToChapter(currentChapter - 1);
  }
});

function renderBook(data: EpubBookData) {
  book = data;
  topBar.refresh();

  const header = el('header', { class: 'epub-book-head' }, [
    el('h1', { class: 'epub-book-title', text: data.title }),
    ...(data.author ? [el('div', { class: 'epub-book-author', text: data.author })] : []),
  ]);

  chapterSections = data.chapters.map((ch, idx) => {
    const sec = el('section', { class: 'epub-chapter' });
    sec.dataset.chapter = String(idx);
    sec.innerHTML = ch.html;
    return sec;
  });

  article.replaceChildren(header, ...chapterSections);
  outline.setItems(
    data.toc.map((item, idx) => ({
      level: item.level,
      text: item.text,
      key: `${item.chapterIndex}${item.anchor ? `#${item.anchor}` : `#toc-${idx}`}`,
    })),
  );

  setCurrentChapter(0);
  applyChapterVisibility();
  epubFind.refresh();
  findWidget.refreshCount();

  const text = article.textContent ?? '';
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = (text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ').match(/[A-Za-z0-9_'-]+/g) ?? []).length;
  statusLabel.textContent = `${data.title}${data.author ? ` · ${data.author}` : ''} · ${t('epubChapters', data.chapters.length)} · ${t('mdWords', (cjk + latin).toLocaleString())}`;

  post({ type: 'status', ok: true, detail: `${data.chapters.length} chapters` });
}

onMessage((message) => {
  if (message.type === 'epub') {
    renderBook(message.book);
  } else if (message.type === 'error') {
    showStatus(article, message.message, true);
    post({ type: 'status', ok: false, detail: message.message });
  }
});

post({ type: 'ready' });
