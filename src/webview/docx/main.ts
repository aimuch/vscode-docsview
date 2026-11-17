import { renderAsync } from 'docx-preview';
import '../shared/base.css';
import '../shared/office-fonts.css';
import './docx.css';
import type { DocComment } from '../../common/protocol';
import { app, el, errorText, onMessage, post, showStatus, t, toArrayBuffer } from '../shared/api';
import { closeFloatingEditors, CommentsPanel, openCommentComposer, openInlineTextEditor } from '../shared/comments';
import { getFileState } from '../shared/fileState';
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
import { createZoom } from '../shared/zoom';

const notice = noticeBanner();
const stage = el('div', { class: 'dv-stage' });
const pages = el('div', { class: 'docx-host dv-page-invert' });
const styles = el('div');
styles.hidden = true;
stage.append(pages);

const sidebar = new Sidebar(t('nav'), [
  { id: 'outline', label: t('toc') },
  { id: 'comments', label: t('comments') },
]);
const outline = new Outline((key) => {
  headings[Number(key)]?.scrollIntoView({ block: 'start' });
});
sidebar.panel('outline').append(outline.node);

let editable = false;
let editMode = false;
let annotateMode = false;
let comments: DocComment[] = [];
let docxParagraphs: string[] = [];
let paragraphMap = new Map<number, HTMLElement>();

const editToggle = toggleButton('pencil', t('docxEditMode'), (on) => {
  editMode = on;
  if (on && annotateMode) {
    annotateMode = false;
    annotateToggle.set(false);
    pages.classList.remove('docx-annotating');
  }
  pages.classList.toggle('docx-editing', on);
  closeFloatingEditors();
  if (on) {
    notice.flash(t('docxEditMode'), 2800);
  }
});

const annotateToggle = toggleButton('commentPlus', t('addComment'), (on) => {
  annotateMode = on;
  if (on && editMode) {
    editMode = false;
    editToggle.set(false);
    pages.classList.remove('docx-editing');
  }
  pages.classList.toggle('docx-annotating', on);
  closeFloatingEditors();
  if (on) {
    sidebar.setOpen(true);
    sidebar.setTab('comments');
    notice.flash(t('annotateDocxHint'), 2800);
  }
});

const commentsPanel = new CommentsPanel({
  targetLabel: (c) => {
    const pLabel = c.pIndex !== undefined ? `¶${c.pIndex + 1}` : '';
    const quote = c.quote ? ` “${c.quote}”` : '';
    return `${pLabel}${quote}`.trim();
  },
  onSelect: (c) => {
    syncParagraphBadges();
    if (c.pIndex !== undefined) {
      const target = paragraphMap.get(c.pIndex);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.remove('docx-para-flash');
        void target.offsetWidth;
        target.classList.add('docx-para-flash');
      }
    }
  },
  onUpdate: (id, text) => post({ type: 'docMutate', mutation: { kind: 'updateComment', id, text } }),
  onDelete: (id) => post({ type: 'docMutate', mutation: { kind: 'deleteComment', id } }),
  onToggleAddMode: () => {
    annotateMode = !annotateMode;
    annotateToggle.set(annotateMode);
    if (annotateMode && editMode) {
      editMode = false;
      editToggle.set(false);
      pages.classList.remove('docx-editing');
    }
    pages.classList.toggle('docx-annotating', annotateMode);
    if (annotateMode) {
      notice.flash(t('annotateDocxHint'), 2800);
    }
  },
});
sidebar.panel('comments').append(commentsPanel.node);

let flow = readState().docxFlow === true;
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
  pages.style.setProperty('zoom', String(value));
}, stage);

const historyBtn = iconButton('history', t('history'), () => post({ type: 'history' }));

const topBar = customToolbar({
  subtitle: 'DOCX',
  slots: [
    { id: 'nav', nodes: [sidebar.toggle] },
    { id: 'view', nodes: [view.node] },
    { id: 'zoom', nodes: zoom.nodes },
    { id: 'edit', label: t('docxEditMode'), nodes: [editToggle.node], visible: () => editable },
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
  styles,
);
showStatus(pages, t('loading'));

let generation = 0;
let lastBytes: Uint8Array | undefined;
let headings: HTMLElement[] = [];

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

const PARA_SELECTOR =
  'section.docx article p, section.docx article h1, section.docx article h2, section.docx article h3, section.docx article h4, section.docx article h5, section.docx article h6';

function normText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function indexRenderedParagraphs(): void {
  paragraphMap = new Map();
  const nodes = [...pages.querySelectorAll<HTMLElement>(PARA_SELECTOR)];
  if (!docxParagraphs.length) {
    nodes.forEach((n, i) => {
      n.dataset.pIndex = String(i);
      paragraphMap.set(i, n);
    });
    return;
  }
  let cursor = 0;
  for (const node of nodes) {
    const rendered = normText(node.textContent ?? '');
    let matched = -1;
    for (let look = cursor; look < Math.min(docxParagraphs.length, cursor + 6); look++) {
      if (normText(docxParagraphs[look]) === rendered) {
        matched = look;
        break;
      }
    }
    if (matched < 0 && cursor < docxParagraphs.length) {
      matched = cursor;
    }
    if (matched >= 0) {
      node.dataset.pIndex = String(matched);
      if (!paragraphMap.has(matched)) {
        paragraphMap.set(matched, node);
      }
      cursor = matched + 1;
    }
  }
}

function syncCommentsUi(): void {
  commentsPanel.setComments(comments);
  sidebar.setTabLabel('comments', comments.length ? t('commentsCount', comments.length) : t('comments'));
  syncParagraphBadges();
}

function syncParagraphBadges(): void {
  for (const old of pages.querySelectorAll('.docx-cm-pill')) {
    old.remove();
  }
  for (const old of pages.querySelectorAll('.docx-has-comment')) {
    old.classList.remove('docx-has-comment');
  }
  comments.forEach((c, idx) => {
    if (c.pIndex === undefined) {
      return;
    }
    const pEl = paragraphMap.get(c.pIndex);
    if (!pEl) {
      return;
    }
    pEl.classList.add('docx-has-comment');
    const pill = el('button', {
      class: 'docx-cm-pill',
      title: `${c.author}: ${c.text}`,
      text: `#${idx + 1}`,
    });
    pill.type = 'button';
    if (commentsPanel.active === c.id) {
      pill.classList.add('docx-cm-pill-active');
    }
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      sidebar.setOpen(true);
      sidebar.setTab('comments');
      commentsPanel.setActive(c.id, true);
      syncParagraphBadges();
    });
    pEl.append(pill);
  });
}

function resolveClickedParagraph(target: EventTarget | null): { node: HTMLElement; pIndex: number } | undefined {
  const elTarget = target instanceof HTMLElement ? target : undefined;
  if (!elTarget || elTarget.closest('.docx-cm-pill')) {
    return undefined;
  }
  const p = elTarget.closest<HTMLElement>('[data-p-index]');
  if (!p) {
    return undefined;
  }
  const idx = Number(p.dataset.pIndex);
  return Number.isFinite(idx) ? { node: p, pIndex: idx } : undefined;
}

pages.addEventListener('click', (e) => {
  if (!editable || !annotateMode) {
    return;
  }
  const hit = resolveClickedParagraph(e.target);
  if (!hit) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  const quote = (docxParagraphs[hit.pIndex] ?? hit.node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  openCommentComposer({
    anchor: { x: e.clientX + 8, y: e.clientY + 8 },
    title: `${t('addComment')} · ¶${hit.pIndex + 1}`,
    onSubmit: (text) => {
      post({
        type: 'docMutate',
        mutation: { kind: 'addComment', pIndex: hit.pIndex, quote, text },
      });
    },
  });
});

pages.addEventListener('dblclick', (e) => {
  if (!editable || !editMode) {
    return;
  }
  const hit = resolveClickedParagraph(e.target);
  if (!hit) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  const expected = docxParagraphs[hit.pIndex] ?? (hit.node.textContent ?? '');
  openInlineTextEditor({
    anchor: { x: e.clientX, y: e.clientY + 10 },
    title: t('editParagraphTitle', hit.pIndex + 1),
    initialText: expected,
    onCommit: (nextText) => {
      post({
        type: 'docMutate',
        mutation: { kind: 'editDocxParagraph', pIndex: hit.pIndex, text: nextText, expected },
      });
    },
  });
});

function buildOutline() {
  headings = [];
  const items: OutlineItem[] = [];
  for (const node of pages.querySelectorAll<HTMLElement>(PARA_SELECTOR)) {
    const level = headingLevel(node);
    const clone = node.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.docx-cm-pill').forEach((n) => n.remove());
    const text = clone.textContent?.trim();
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
      renderChanges: true,
      renderComments: true,
      renderAltChunks: true,
      useBase64URL: true,
    });
    if (current !== generation) {
      return;
    }
    pages.classList.toggle('docx-flow', flow);
    pages.replaceChildren(...target.childNodes);
    stage.scrollTop = scrollTop;
    indexRenderedParagraphs();
    buildOutline();
    syncCommentsUi();
    post({
      type: 'status',
      ok: true,
      detail: `${pages.querySelectorAll('section.docx').length} pages, ${headings.length} headings`,
    });
  } catch (err) {
    if (current === generation) {
      showStatus(pages, t('loadFailed', errorText(err)), true);
      post({ type: 'status', ok: false, detail: errorText(err) });
    }
  }
}

onMessage((message) => {
  if (message.type === 'load') {
    editable = message.editable === true;
    comments = message.comments ?? [];
    docxParagraphs = message.docxParagraphs ?? [];
    topBar.refresh();
    void load(message.bytes);
  } else if (message.type === 'comments') {
    comments = message.comments;
    syncCommentsUi();
  } else if (message.type === 'error') {
    showStatus(pages, message.message, true);
  }
});

post({ type: 'ready' });
