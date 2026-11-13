import 'katex/dist/katex.min.css';
import morphdom from 'morphdom';
import type { TocEntry } from '../../common/protocol';
import '../shared/base.css';
import './markdown.css';
import { app, el, errorText, isDark, onMessage, onThemeChange, post, t } from '../shared/api';
import { getAppearance, highlightToggle, onAppearanceChange } from '../shared/appearance';
import { Outline, Sidebar } from '../shared/sidebar';
import { attachTableHighlight } from './tableHighlight';
import { segmented, toolbar } from '../shared/ui';
import { createZoom } from '../shared/zoom';

const scroller = el('div', { class: 'md-scroll' });
const article = el('article', { class: 'markdown-body' });
scroller.append(article);

const sidebar = new Sidebar(t('toc'));
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

app.append(
  toolbar(sidebar.toggle, view.node, '|', ...zoom.nodes, '|', highlightToggle()),
  el('div', { class: 'dv-body' }, [sidebar.node, el('div', { class: 'dv-main' }, [scroller])]),
);

// ---------------------------------------------------------------- rendering

function render(html: string, toc: TocEntry[]) {
  // The new HTML replaces the marked cells; start from a clean slate.
  tableHighlight.clear();
  const next = document.createElement('article');
  next.className = 'markdown-body';
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
    const done = () => {
      if (--left <= 0) {
        resolve();
      }
    };
    setTimeout(resolve, 5000);
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
    render(message.html, message.toc);
  } else if (message.type === 'scrollTo') {
    scrollToLine(message.line);
  } else if (message.type === 'viewState') {
    view.set(message.split ? 'split' : 'preview');
  }
});

post({ type: 'ready' });
