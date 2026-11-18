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
import { customToolbar, iconButton, openExternalButton, openExternalMenuItem, segmented } from '../shared/ui';
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
let currentChapter = Number(readState().epubChapter ?? 0) || 0;
let singleMode = readState().epubSingle === true;

function domNodeToMarkdown(root: HTMLElement): string {
  const blocks: string[] = [];
  const inlineText = (elNode: Node): string => {
    if (elNode.nodeType === 3) {
      return (elNode.nodeValue ?? '').replace(/\s+/g, ' ');
    }
    if (elNode.nodeType !== 1) return '';
    const elem = elNode as HTMLElement;
    const tag = elem.tagName.toLowerCase();
    if (tag === 'br') return '\n';
    const inner = Array.from(elem.childNodes).map(inlineText).join('');
    if (!inner.trim()) return inner;
    if (tag === 'strong' || tag === 'b') return `**${inner.trim()}**`;
    if (tag === 'em' || tag === 'i') return `*${inner.trim()}*`;
    if (tag === 'code') return `\`${inner.trim()}\``;
    if (tag === 'a') {
      const href = elem.getAttribute('href') ?? '';
      return /^https?:/i.test(href) ? `[${inner.trim()}](${href})` : inner;
    }
    return inner;
  };
  const walkBlock = (parent: HTMLElement) => {
    for (const child of Array.from(parent.children) as HTMLElement[]) {
      const tag = child.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const lvl = Number(tag[1]);
        const txt = inlineText(child).trim();
        if (txt) blocks.push(`${'#'.repeat(lvl)} ${txt}`);
      } else if (tag === 'p') {
        const txt = inlineText(child).trim();
        if (txt) blocks.push(txt);
      } else if (tag === 'pre') {
        const code = (child.textContent ?? '').replace(/\n+$/, '');
        if (code) blocks.push(`\`\`\`\n${code}\n\`\`\``);
      } else if (tag === 'blockquote') {
        const txt = inlineText(child).trim();
        if (txt) blocks.push(txt.split('\n').map((l) => `> ${l}`).join('\n'));
      } else if (tag === 'ul' || tag === 'ol') {
        const items = Array.from(child.querySelectorAll(':scope > li'))
          .map((li, idx) => `${tag === 'ol' ? `${idx + 1}.` : '-'} ${inlineText(li).trim()}`)
          .filter((s) => s.length > 2);
        if (items.length) blocks.push(items.join('\n'));
      } else if (child.children.length > 0) {
        walkBlock(child);
      } else {
        const txt = inlineText(child).trim();
        if (txt) blocks.push(txt);
      }
    }
  };
  walkBlock(root);
  return blocks.length ? blocks.join('\n\n') : (root.textContent ?? '').trim();
}

function exportBookAsMarkdown() {
  if (!book || !chapterSections.length) return;
  const parts: string[] = [`# ${book.title}`];
  if (book.author) {
    parts.push(`*${book.author}*`);
  }
  chapterSections.forEach((sec, idx) => {
    const ch = book!.chapters[idx];
    const md = domNodeToMarkdown(sec);
    if (md) {
      if (ch?.title && !md.startsWith('#')) {
        parts.push(`## ${ch.title}\n\n${md}`);
      } else {
        parts.push(md);
      }
    }
  });
  post({ type: 'saveTextExport', ext: 'md', content: `${parts.join('\n\n---\n\n')}\n` });
}

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

const pager = createPager((n) => goToChapter(n - 1), t('chapter'));
const zoom = createZoom((v) => {
  article.style.setProperty('zoom', String(v));
  writeState({ epubZoom: v });
}, scroller);
const exportMdBtn = iconButton('export', t('exportMarkdown'), exportBookAsMarkdown);

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
    { id: 'actions', label: t('exportMenu'), nodes: [exportMdBtn] },
    { id: 'theme', nodes: [themeToolbarButton()] },
    { id: 'openApp', nodes: [openExternalButton()] },
  ],
  documentActions: [
    { icon: 'export', label: t('exportMarkdown'), onClick: exportBookAsMarkdown },
    openExternalMenuItem(),
  ],
});

const statusLabel = el('span', { class: 'dv-label' });
const statusBar = el('div', { class: 'dv-statusbar' }, [el('div', { class: 'dv-spacer' }), statusLabel]);

app.append(
  topBar.node,
  el('div', { class: 'dv-body' }, [sidebar.node, el('div', { class: 'dv-main' }, [sidebar.expandBtn, scroller])]),
  statusBar,
);
showStatus(article, t('loading'));

function setCurrentChapter(idx: number) {
  if (!chapterSections.length) return;
  currentChapter = Math.max(0, Math.min(chapterSections.length - 1, idx));
  writeState({ epubChapter: currentChapter });
  pager.update(currentChapter + 1, chapterSections.length);
  if (book) {
    let exactFirstKey: string | undefined;
    let fallbackPrevKey: string | undefined;
    book.toc.forEach((item, i) => {
      const key = `${item.chapterIndex}${item.anchor ? `#${item.anchor}` : `#toc-${i}`}`;
      if (item.chapterIndex === currentChapter && !exactFirstKey) {
        exactFirstKey = key;
      } else if (item.chapterIndex < currentChapter) {
        fallbackPrevKey = key;
      }
    });
    outline.setActive(exactFirstKey ?? fallbackPrevKey);
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
  const href = (link.getAttribute('href') ?? '').trim();
  if (!href) return;
  const m = /^#epub-ch-(\d+)(?:::(.+))?$/.exec(href);
  if (m) {
    e.preventDefault();
    goToChapter(Number(m[1]), m[2]);
    return;
  }
  if (href.startsWith('#')) {
    e.preventDefault();
    const id = href.slice(1);
    const sec = link.closest<HTMLElement>('.epub-chapter') ?? article;
    const target =
      sec.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`) ??
      article.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    target?.scrollIntoView({ block: 'start' });
    return;
  }
  if (/^(?:https?:|mailto:)/i.test(href)) {
    e.preventDefault();
    post({ type: 'openLink', href });
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
  if (!singleMode || target?.closest('input, textarea, select, button, [role="menu"], [role="dialog"]')) return;
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

  setCurrentChapter(Math.min(currentChapter, Math.max(0, chapterSections.length - 1)));
  const savedZoom = Number(readState().epubZoom);
  if (Number.isFinite(savedZoom) && savedZoom >= 0.25 && savedZoom <= 4) {
    article.style.setProperty('zoom', String(savedZoom));
  }
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
