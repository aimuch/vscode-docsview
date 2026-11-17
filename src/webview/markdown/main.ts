import 'katex/dist/katex.min.css';
import morphdom from 'morphdom';
import type { TocEntry } from '../../common/protocol';
import '../shared/base.css';
import './markdown.css';
import { app, el, errorText, isDark, onMessage, onThemeChange, post, t } from '../shared/api';
import { getAppearance, highlightToggle, onAppearanceChange, updateAppearance } from '../shared/appearance';
import { getFileState } from '../shared/fileState';
import { icons } from '../shared/icons';
import { Outline, readState, Sidebar, writeState } from '../shared/sidebar';
import { customToolbar, iconButton, moreMenu, segmented, toggleButton } from '../shared/ui';
import { createZoom } from '../shared/zoom';
import { PreviewFind } from './find';
import { attachTableHighlight } from './tableHighlight';

const scroller = el('div', { class: 'md-scroll' });
const article = el('article', { class: 'markdown-body' });
scroller.append(article);

const sidebar = new Sidebar(t('toc'), undefined, { defaultOpen: true });
const outline = new Outline((id) => scrollToAnchor(`#${id}`));
sidebar.panel().append(outline.node);

// Preview: this tab only. Split: the text editor beside it. Source: the text editor instead.
const view = segmented<'preview' | 'split' | 'source'>(
  t('view'),
  [
    ['preview', t('viewPreview')],
    ['split', t('viewSplit')],
    ['source', t('viewSource')],
  ],
  'preview',
  (mode) => {
    if (mode === 'preview') {
      post({ type: 'closeSource' });
    } else {
      post({ type: 'showSource', beside: mode === 'split' });
      if (mode === 'source') {
        view.set('preview');
      }
    }
  },
);

const zoom = createZoom((value) => article.style.setProperty('zoom', String(value)), scroller);

const tableHighlight = attachTableHighlight(article, () => getAppearance().highlight);
onAppearanceChange((a) => {
  if (!a.highlight) {
    tableHighlight.clear();
  }
});

// ---------------------------------------------------------------- find

const find = new PreviewFind(article, scroller);
const findInput = el('input');
findInput.type = 'search';
findInput.placeholder = t('find');
findInput.setAttribute('aria-label', t('findInPreview'));
const findIcon = el('span', { class: 'md-find-icon' });
findIcon.innerHTML = icons.search;
const findBox = el('label', { class: 'dv-search md-find' }, [findIcon, findInput]);
const findCount = el('span', { class: 'dv-label md-find-count' });

function showFindCount() {
  findCount.textContent = findInput.value ? (find.total ? `${find.current}/${find.total}` : t('noMatch')) : '';
}

findInput.addEventListener('input', () => {
  find.search(findInput.value);
  showFindCount();
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    find.next(e.shiftKey);
    showFindCount();
  } else if (e.key === 'Escape') {
    findInput.value = '';
    find.clear();
    showFindCount();
    scroller.focus();
  }
});
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    findInput.focus();
    findInput.select();
  }
});
const findPrev = iconButton('up', t('findPrev'), () => {
  find.next(true);
  showFindCount();
});
const findNext = iconButton('down', t('findNext'), () => {
  find.next();
  showFindCount();
});

// ---------------------------------------------------------------- edit mode

/** Full Markdown source of the last render, split lazily only when editing a block in place. */
let rawSource = '';
let cachedSourceLines: string[] | undefined;
let editing: { block: HTMLElement; box: HTMLElement } | undefined;
/** A render that arrived while a block was being edited; applied once editing ends. */
let deferredRender: { html: string; toc: TocEntry[] } | undefined;

function getSourceLines(): string[] {
  return (cachedSourceLines ??= rawSource.split(/\r?\n/));
}

const editToggle = toggleButton('pencil', t('editMode'), (on) => setEditMode(on));

function setEditMode(on: boolean) {
  scroller.classList.toggle('md-editing', on);
  editToggle.set(on);
  writeState({ mdEdit: on });
  if (!on) {
    closeEditor();
  }
}

/** The top-level block (a direct child of the article) that carries source line numbers. */
function blockAt(target: Element | null): HTMLElement | undefined {
  let node = target;
  while (node && node.parentElement !== article) {
    node = node.parentElement;
  }
  return node instanceof HTMLElement && node.dataset.lineEnd !== undefined ? node : undefined;
}

function closeEditor() {
  if (!editing) {
    return;
  }
  editing.box.remove();
  editing.block.hidden = false;
  editing = undefined;
  if (deferredRender) {
    const { html, toc } = deferredRender;
    deferredRender = undefined;
    render(html, toc);
  }
}

function openEditor(block: HTMLElement) {
  closeEditor();
  const lines = getSourceLines();
  const start = Number(block.dataset.line);
  const end = Math.min(Number(block.dataset.lineEnd), lines.length);
  if (!Number.isFinite(start) || end <= start) {
    return;
  }
  const original = lines.slice(start, end).join('\n');
  // Blocks end with blank separator lines; edit the text, keep the separation.
  const text = original.replace(/\n+$/, '');
  const lastLine = start + text.split('\n').length;
  const label = lastLine === start + 1 ? t('editLine', start + 1) : t('editLines', start + 1, lastLine);
  const textarea = el('textarea', { class: 'md-edit-text' });
  textarea.value = text;
  textarea.spellcheck = false;
  textarea.setAttribute('aria-label', label);
  const save = el('button', { class: 'dv-btn md-edit-save', text: `${t('save')} ⌘↵` });
  save.type = 'button';
  const cancel = el('button', { class: 'dv-btn', text: `${t('cancel')} Esc` });
  cancel.type = 'button';
  const box = el('div', { class: 'md-edit' }, [
    el('div', { class: 'md-edit-head' }, [
      el('span', { text: label }),
      el('span', { class: 'md-edit-actions' }, [cancel, save]),
    ]),
    textarea,
  ]);
  const commit = () => {
    const value = textarea.value;
    if (value !== text) {
      const trailing = original.slice(text.length);
      const nextText = value === '' ? '' : value + trailing;
      post({ type: 'editBlock', start, end: start + original.split('\n').length, text: nextText, expected: original });
    }
    closeEditor();
  };
  save.addEventListener('click', commit);
  cancel.addEventListener('click', closeEditor);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeEditor();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    }
    e.stopPropagation();
  });
  const fit = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight + 2, 480)}px`;
  };
  textarea.addEventListener('input', fit);
  block.after(box);
  block.hidden = true;
  editing = { block, box };
  fit();
  textarea.focus();
}

article.addEventListener('dblclick', (event) => {
  if (!scroller.classList.contains('md-editing')) {
    return;
  }
  const block = blockAt(event.target as Element);
  if (block && !block.closest('.md-edit')) {
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    openEditor(block);
  }
});

// ---------------------------------------------------------------- right-to-left

let rtl = readState().rtl === true;
const rtlToggle = toggleButton('rtl', t('rtl'), (on) => setRtl(on));

function setRtl(on: boolean) {
  rtl = on;
  rtlToggle.set(on);
  writeState({ rtl });
  article.dir = on ? 'rtl' : '';
}

// ---------------------------------------------------------------- export

function exportAs(format: 'html' | 'pdf') {
  const copy = article.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.md-copy, .md-edit').forEach((n) => n.remove());
  copy.querySelectorAll<HTMLElement>('[hidden]').forEach((n) => (n.hidden = false));
  copy.querySelectorAll('.md-hl-row, .md-hl-col, .md-hl-cell').forEach((n) =>
    n.classList.remove('md-hl-row', 'md-hl-col', 'md-hl-cell'),
  );
  post({ type: 'export', format, html: copy.innerHTML, theme: getAppearance().theme, dark: isDark(), rtl });
}

const exportDropdown = moreMenu(
  t('exportMenu'),
  [
    { label: t('exportHtml'), onClick: () => exportAs('html') },
    { label: t('exportPdf'), hint: t('exportPdfHint'), onClick: () => exportAs('pdf') },
  ],
  'export',
);

const historyBtn = iconButton('history', t('slotHistory'), () => post({ type: 'history' }));

const topBar = customToolbar({
  subtitle: 'Markdown',
  slots: [
    { id: 'nav', nodes: [sidebar.toggle] },
    { id: 'view', nodes: [view.node] },
    { id: 'zoom', nodes: zoom.nodes },
    { id: 'find', nodes: [findBox, findCount, findPrev, findNext] },
    { id: 'edit', label: t('editMode'), nodes: [editToggle.node] },
    { id: 'highlight', nodes: [highlightToggle()] },
    { id: 'actions', label: t('exportMenu'), nodes: [exportDropdown] },
    { id: 'history', nodes: [historyBtn], visible: () => getFileState().history },
    { id: 'rtl', nodes: [rtlToggle.node] },
  ],
  documentActions: [
    { label: t('exportHtml'), icon: 'export', onClick: () => exportAs('html') },
    { label: t('exportPdf'), hint: t('exportPdfHint'), icon: 'export', onClick: () => exportAs('pdf') },
    { label: t('history'), icon: 'history', visible: () => getFileState().history, onClick: () => post({ type: 'history' }) },
  ],
  documentOptions: [
    {
      label: () => t('setDefault', getFileState().ext || 'md'),
      visible: () => getFileState().isDefault !== undefined,
      checked: () => getFileState().isDefault === true,
      onChange: (on) => post({ type: 'setDefault', on }),
    },
    {
      label: t('editMode'),
      checked: () => scroller.classList.contains('md-editing'),
      onChange: (on) => setEditMode(on),
    },
    {
      label: t('highlightRowCol'),
      checked: () => getAppearance().highlight,
      onChange: (on) => updateAppearance({ highlight: on }),
    },
    {
      label: t('rtl'),
      checked: () => rtl,
      onChange: (on) => setRtl(on),
    },
  ],
});

scroller.tabIndex = -1;
app.append(
  topBar.node,
  el('div', { class: 'dv-body' }, [sidebar.node, el('div', { class: 'dv-main' }, [sidebar.expandBtn, scroller])]),
);
setEditMode(readState().mdEdit === true);
setRtl(rtl);

// ---------------------------------------------------------------- rendering

function render(html: string, toc: TocEntry[]) {
  // Never morph the document under an open block editor; catch up when it closes.
  if (editing) {
    deferredRender = { html, toc };
    return;
  }
  // The new HTML replaces the marked cells; start from a clean slate.
  tableHighlight.clear();
  const next = document.createElement('article');
  next.className = 'markdown-body';
  // morphdom also syncs the root's attributes: carry over zoom and text direction.
  next.style.cssText = article.style.cssText;
  next.dir = article.dir;
  next.innerHTML = html;
  morphdom(article, next, {
    onBeforeElUpdated(from, to) {
      // Keep an already rendered diagram when its source did not change.
      if (
        from.classList.contains('mermaid') &&
        to.classList.contains('mermaid') &&
        from.dataset.src === to.dataset.src &&
        from.dataset.rendered
      ) {
        const line = to.getAttribute('data-line');
        if (line !== null) {
          from.setAttribute('data-line', line);
        }
        return false;
      }
      return !from.isEqualNode(to);
    },
  });
  renderToc(toc);
  addCopyButtons();
  find.refresh();
  showFindCount();
  invalidateLineIndex();
  void Promise.all([renderMermaid(), imagesSettled()]).then(
    () => {
      const failed = article.querySelectorAll('.mermaid-error').length;
      const diagrams = article.querySelectorAll('.mermaid svg').length;
      const images = [...article.querySelectorAll('img')];
      const loaded = images.filter((img) => img.complete && img.naturalWidth > 0).length;
      post({
        type: 'status',
        ok: failed === 0,
        detail:
          `${toc.length} headings, ${diagrams} diagrams, ` +
          `${article.querySelectorAll('.katex').length} formulas, ${loaded}/${images.length} images`,
      });
    },
    (err) => post({ type: 'status', ok: false, detail: errorText(err) }),
  );
}

/** Resolves once every image has loaded or failed (bounded, so a slow host cannot stall it). */
function imagesSettled(): Promise<void> {
  const pending = [...article.querySelectorAll('img')].filter((img) => !img.complete);
  if (!pending.length) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let left = pending.length;
    const timer = setTimeout(resolve, 5000);
    const done = () => {
      if (--left <= 0) {
        clearTimeout(timer);
        resolve();
      }
    };
    for (const img of pending) {
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    }
  });
}

function renderToc(toc: TocEntry[]) {
  outline.setItems(toc.map((e) => ({ level: e.level, text: e.text, key: e.id })));
  updateActiveHeading();
}

/** Copy buttons on code blocks (re-added after every update, since morphdom strips them). */
function addCopyButtons() {
  for (const pre of article.querySelectorAll<HTMLElement>('pre:not(.md-frontmatter)')) {
    if (pre.closest('.mermaid') || pre.querySelector('.md-copy')) {
      continue;
    }
    const button = el('button', { class: 'md-copy', text: t('copy') });
    button.type = 'button';
    button.addEventListener('click', () => {
      const code = pre.querySelector('code')?.textContent ?? '';
      void navigator.clipboard.writeText(code).then(() => {
        button.textContent = t('copied');
        setTimeout(() => (button.textContent = t('copy')), 1500);
      });
    });
    pre.append(button);
  }
}

// ---------------------------------------------------------------- mermaid

type Mermaid = (typeof import('mermaid'))['default'];
let mermaidLoader: Promise<Mermaid> | undefined;
let mermaidSeq = 0;

async function renderMermaid(force = false) {
  const nodes = [...article.querySelectorAll<HTMLElement>('.mermaid')];
  const theme = isDark() ? 'dark' : 'default';
  const pending = nodes.filter((n) => force || n.dataset.rendered !== theme);
  if (!pending.length) {
    return;
  }
  // Mermaid is several MB; only load it for documents that contain a diagram.
  mermaidLoader ??= import('mermaid').then((m) => m.default);
  const mermaid = await mermaidLoader;
  mermaid.initialize({ startOnLoad: false, theme, securityLevel: 'strict' });
  for (const node of pending) {
    const src = node.dataset.src ?? '';
    const id = `dv-mermaid-${++mermaidSeq}`;
    try {
      const { svg } = await mermaid.render(id, src);
      node.innerHTML = svg;
      node.classList.remove('mermaid-error');
    } catch (err) {
      // Mermaid leaves its temporary measuring nodes in <body> when rendering throws.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
      node.replaceChildren(
        el('div', { class: 'mermaid-error-title', text: t('mermaidError') }),
        el('pre', { text: errorText(err) }),
      );
      node.classList.add('mermaid-error');
    }
    node.dataset.rendered = theme;
    invalidateLineIndex();
  }
}

onThemeChange(() => void renderMermaid());

// ---------------------------------------------------------------- scroll sync

interface LineMark {
  line: number;
  top: number;
}

let lineIndex: LineMark[] | undefined;
/** scrollTop we set ourselves; the scroll event it causes must not be echoed back to the editor. */
let programmaticTop: number | undefined;

function invalidateLineIndex() {
  lineIndex = undefined;
}

function getLineIndex(): LineMark[] {
  if (!lineIndex) {
    const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
    lineIndex = [];
    for (const node of article.querySelectorAll<HTMLElement>('[data-line]')) {
      const line = Number(node.dataset.line);
      const top = node.getBoundingClientRect().top - base;
      const last = lineIndex[lineIndex.length - 1];
      // Nested blocks share lines; keep the index strictly increasing in both dimensions.
      if (!last || (line > last.line && top >= last.top)) {
        lineIndex.push({ line, top });
      }
    }
  }
  return lineIndex;
}

new ResizeObserver(invalidateLineIndex).observe(article);
article.addEventListener('load', invalidateLineIndex, true); // images

function scrollToLine(line: number) {
  const index = getLineIndex();
  if (!index.length) {
    return;
  }
  let i = 0;
  while (i + 1 < index.length && index[i + 1].line <= line) {
    i++;
  }
  const prev = index[i];
  const next = index[i + 1];
  let top = prev.top;
  if (line <= index[0].line) {
    top = line <= 0 ? 0 : index[0].top;
  } else if (next) {
    top += ((line - prev.line) / (next.line - prev.line)) * (next.top - prev.top);
  }
  scroller.scrollTop = top;
  // Read back: the browser clamps and rounds the value.
  programmaticTop = scroller.scrollTop;
}

function lineAtScrollTop(): number {
  const index = getLineIndex();
  const y = scroller.scrollTop;
  if (!index.length || y <= 0) {
    return 0;
  }
  let i = 0;
  while (i + 1 < index.length && index[i + 1].top <= y) {
    i++;
  }
  const prev = index[i];
  const next = index[i + 1];
  if (!next || next.top === prev.top) {
    return prev.line;
  }
  return prev.line + ((y - prev.top) / (next.top - prev.top)) * (next.line - prev.line);
}

function updateActiveHeading() {
  const y = scroller.getBoundingClientRect().top + 12;
  let active: string | undefined;
  for (const heading of article.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]')) {
    if (heading.getBoundingClientRect().top > y) {
      break;
    }
    active = heading.id;
  }
  outline.setActive(active);
}

let scrollFrame = 0;
scroller.addEventListener('scroll', () => {
  if (scrollFrame) {
    return;
  }
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    updateActiveHeading();
    if (programmaticTop !== undefined && Math.abs(scroller.scrollTop - programmaticTop) < 2) {
      return;
    }
    programmaticTop = undefined;
    post({ type: 'revealLine', line: lineAtScrollTop() });
  });
});

// ---------------------------------------------------------------- links

function scrollToAnchor(hash: string) {
  let id = hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // use as-is
  }
  const target = document.getElementById(id) ?? document.getElementsByName(id)[0];
  target?.scrollIntoView({ block: 'start' });
}

// With <base> pointing at the document folder, every link (even "#x") would navigate
// the webview away, so all clicks are handled here.
document.addEventListener('click', (event) => {
  const link = (event.target as Element | null)?.closest?.('a[href]');
  if (!link) {
    return;
  }
  event.preventDefault();
  const href = link.getAttribute('href') ?? '';
  if (href.startsWith('#')) {
    scrollToAnchor(href);
  } else if (href) {
    post({ type: 'openLink', href });
  }
});

// ---------------------------------------------------------------- messages

onMessage((message) => {
  if (message.type === 'render') {
    rawSource = message.source;
    cachedSourceLines = undefined;
    render(message.html, message.toc);
  } else if (message.type === 'scrollTo') {
    scrollToLine(message.line);
  } else if (message.type === 'viewState') {
    view.set(message.split ? 'split' : 'preview');
  }
});

post({ type: 'ready' });
