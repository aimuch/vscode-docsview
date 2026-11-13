import { renderAsync } from 'docx-preview';
import '../shared/base.css';
import './docx.css';
import { app, el, errorText, onMessage, post, showStatus, t, toArrayBuffer } from '../shared/api';
import { Outline, readState, Sidebar, writeState, type OutlineItem } from '../shared/sidebar';
import { segmented, toolbar } from '../shared/ui';
import { createZoom } from '../shared/zoom';

const stage = el('div', { class: 'dv-stage' });
const pages = el('div', { class: 'docx-host dv-page-invert' });
const styles = el('div');
styles.hidden = true;
stage.append(pages);

const sidebar = new Sidebar(t('toc'));
const outline = new Outline((key) => {
  headings[Number(key)]?.scrollIntoView({ block: 'start' });
});
sidebar.panel().append(outline.node);

let flow = readState().docxFlow === true;
// Pages: the paginated print layout. Continuous: one long page, easier to read on screen.
const view = segmented<'pages' | 'flow'>(
  t('view'),
  [
    ['pages', t('viewPages')],
    ['flow', t('viewFlow')],
  ],
  flow ? 'flow' : 'pages',
  (mode) => {
    flow = mode === 'flow';
    writeState({ docxFlow: flow });
    if (lastBytes) {
      void load(lastBytes);
    }
  },
);

const zoom = createZoom((value) => {
  // `zoom` (unlike transform) keeps the scroll extent in step with the visual size.
  pages.style.setProperty('zoom', String(value));
}, stage);

app.append(
  toolbar(sidebar.toggle, view.node, '|', ...zoom.nodes),
  el('div', { class: 'dv-body' }, [sidebar.node, el('div', { class: 'dv-main' }, [stage])]),
  styles,
);
showStatus(pages, t('loading'));

let generation = 0;
let lastBytes: Uint8Array | undefined;
let headings: HTMLElement[] = [];

/** Heading level of a rendered paragraph, from its Word style ("Heading 2", "Title", …). */
function headingLevel(node: Element): number | undefined {
  if (/^H[1-6]$/.test(node.tagName)) {
    return Number(node.tagName[1]);
  }
  for (const cls of node.classList) {
    const match = /^docx_(?:heading|标题)(\d)$/i.exec(cls);
    if (match) {
      return Number(match[1]);
    }
    if (/^docx_title$/i.test(cls)) {
      return 1;
    }
  }
  return undefined;
}

function buildOutline() {
  headings = [];
  const items: OutlineItem[] = [];
  for (const node of pages.querySelectorAll<HTMLElement>('section.docx article p, section.docx article h1, section.docx article h2, section.docx article h3, section.docx article h4, section.docx article h5, section.docx article h6')) {
    const level = headingLevel(node);
    const text = node.textContent?.trim();
    if (level && text) {
      items.push({ level, text, key: String(headings.length) });
      headings.push(node);
    }
  }
  outline.setItems(items);
  updateActive();
}

function updateActive() {
  const top = stage.getBoundingClientRect().top + 16;
  let active: string | undefined;
  headings.forEach((h, i) => {
    if (h.getBoundingClientRect().top <= top) {
      active = String(i);
    }
  });
  outline.setActive(active ?? (headings.length ? '0' : undefined));
}

let frame = 0;
stage.addEventListener('scroll', () => {
  if (!frame) {
    frame = requestAnimationFrame(() => {
      frame = 0;
      updateActive();
    });
  }
});

async function load(bytes: Uint8Array) {
  const current = ++generation;
  lastBytes = bytes;
  const scrollTop = stage.scrollTop;
  const target = el('div');
  try {
    await renderAsync(toArrayBuffer(bytes), target, styles, {
      className: 'docx',
      inWrapper: true,
      breakPages: !flow,
      ignoreLastRenderedPageBreak: false,
      experimental: true,
      renderHeaders: !flow,
      renderFooters: !flow,
      renderFootnotes: true,
      renderEndnotes: true,
      // data: URLs survive in the webview without needing extra CSP origins.
      useBase64URL: true,
    });
    if (current !== generation) {
      return;
    }
    pages.classList.toggle('docx-flow', flow);
    pages.replaceChildren(...target.childNodes);
    stage.scrollTop = scrollTop;
    buildOutline();
    post({ type: 'status', ok: true, detail: `${pages.querySelectorAll('section.docx').length} pages, ${headings.length} headings` });
  } catch (err) {
    if (current === generation) {
      showStatus(pages, t('loadFailed', errorText(err)), true);
      post({ type: 'status', ok: false, detail: errorText(err) });
    }
  }
}

onMessage((message) => {
  if (message.type === 'load') {
    void load(message.bytes);
  } else if (message.type === 'error') {
    showStatus(pages, message.message, true);
  }
});

post({ type: 'ready' });
