import { renderAsync } from 'docx-preview';
import '../shared/base.css';
import '../shared/office-fonts.css';
import './docx.css';
import type { DocComment } from '../../common/protocol';
import { InteractionModeMachine } from '../../common/stateMachine';
import { countDocumentWords } from '../../common/textStats';
import { createAiAssistant } from '../shared/aiAssistant';
import { app, el, errorText, onMessage, post, showStatus, t, toArrayBuffer } from '../shared/api';
import { closeFloatingEditors, CommentsPanel, openCommentComposer, openInlineTextEditor } from '../shared/comments';
import { openDiffModal } from '../shared/diffModal';
import { getFileState } from '../shared/fileState';
import { createFindWidget, PreviewFind } from '../shared/find';
import { bindLiveViewerStatus, overlayStack } from '../shared/overlayStack';
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

let docFileName = 'Document.docx';
const modeMachine = new InteractionModeMachine();
let comments: DocComment[] = [];
let docxParagraphs: string[] = [];
let paragraphMap = new Map<number, HTMLElement>();

const editToggle = toggleButton('pencil', t('docxEditMode'), (on) => {
  modeMachine.setMode(on ? 'edit' : 'read');
});

const annotateToggle = toggleButton('commentPlus', t('addComment'), (on) => {
  modeMachine.setMode(on ? 'annotate' : 'read');
});

modeMachine.onChange((mode) => {
  editToggle.set(mode === 'edit');
  annotateToggle.set(mode === 'annotate');
  pages.classList.toggle('docx-editing', mode === 'edit');
  pages.classList.toggle('docx-annotating', mode === 'annotate');
  closeFloatingEditors();
  if (mode === 'edit') {
    notice.flash(t('docxEditMode'), 2800);
  } else if (mode === 'annotate') {
    sidebar.setOpen(true);
    sidebar.setTab('comments');
    notice.flash(t('annotateDocxHint'), 2800);
  }
});

const commentsPanel = new CommentsPanel({
  docName: () => docFileName,
  editable: () => modeMachine.isEditable,
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
    modeMachine.toggle('annotate');
  },
  onAiDigest: (md) => {
    ai.open({
      presetAction: 'summarize',
      initialPrompt: `Summarize all review comments below into key themes and a prioritised action-item checklist:\n\n${md}`,
      autoRun: true,
    });
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

stage.tabIndex = -1;
const docFind = new PreviewFind(pages, stage);
const findWidget = createFindWidget(docFind, stage);

const exportMdBtn = iconButton('export', t('exportMarkdown'), () => post({ type: 'exportDocMarkdown' }));
const historyBtn = iconButton('history', t('history'), () => post({ type: 'history' }));

interface DocxAiMeta {
  pIndex?: number;
  expected?: string;
}

function captureDocxAiContext() {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    const startEl =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
    if (startEl && pages.contains(startEl)) {
      const pNode = startEl.closest<HTMLElement>('[data-p-index]');
      const pIndex = pNode ? Number(pNode.dataset.pIndex) : undefined;
      const validIdx = pIndex !== undefined && Number.isFinite(pIndex) ? pIndex : undefined;
      const expected = validIdx !== undefined ? docxParagraphs[validIdx] : undefined;
      const selStr = sel.toString().trim();
      return {
        selection: expected ?? selStr,
        surrounding: docxParagraphs.join('\n').slice(0, 10_000),
        badge: validIdx !== undefined ? `¶${validIdx + 1}` : t('aiContextSelection', selStr.length),
        meta: { pIndex: validIdx, expected } satisfies DocxAiMeta,
      };
    }
  }
  return {
    surrounding: docxParagraphs.length ? docxParagraphs.join('\n') : (pages.textContent ?? ''),
    badge: t('aiContextDocument'),
    meta: {} satisfies DocxAiMeta,
  };
}

let openDocxDrawerFn: (() => void) | undefined;

const ai = createAiAssistant({
  viewerKind: 'docx',
  getFileName: () => docFileName,
  captureContext: captureDocxAiContext,
  selectionRoot: pages,
  onOpenSettings: () => openDocxDrawerFn?.(),
  focusReturnTarget: () => stage,
  applyActions: [
    {
      id: 'replace-para',
      label: () => t('aiApplyReplace'),
      primary: true,
      visible: ({ captured }) => {
        const m = captured.meta as DocxAiMeta | undefined;
        return modeMachine.isEditable && m?.pIndex !== undefined && m.expected !== undefined;
      },
      onApply: ({ text, captured }) => {
        const m = captured.meta as DocxAiMeta;
        post({
          type: 'docMutate',
          mutation: {
            kind: 'editDocxParagraph',
            pIndex: m.pIndex!,
            text: text.replace(/\r?\n+/g, ' ').trim(),
            expected: m.expected!,
          },
        });
      },
    },
    {
      id: 'save-comment',
      label: () => t('aiApplyComment'),
      visible: () => modeMachine.isEditable,
      onApply: ({ text, captured }) => {
        const m = captured.meta as DocxAiMeta | undefined;
        const pIndex = m?.pIndex ?? 0;
        const quote = (captured.selection ?? docxParagraphs[pIndex] ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
        sidebar.setOpen(true);
        sidebar.setTab('comments');
        post({
          type: 'docMutate',
          mutation: { kind: 'addComment', pIndex, quote, text: text.trim() },
        });
      },
    },
  ],
});

const statusText = el('span', { class: 'dv-label' });
const statusBar = el('div', { class: 'dv-statusbar' }, [el('div', { class: 'dv-spacer' }), statusText]);

const topBar = customToolbar({
  subtitle: 'DOCX',
  slots: [
    { id: 'nav', nodes: [sidebar.toggle] },
    { id: 'view', nodes: [view.node] },
    { id: 'zoom', nodes: zoom.nodes },
    { id: 'find', nodes: findWidget.nodes },
    { id: 'edit', label: t('docxEditMode'), nodes: [editToggle.node], visible: () => modeMachine.isEditable },
    { id: 'comments', nodes: [annotateToggle.node], visible: () => modeMachine.isEditable },
    { id: 'ai', nodes: [ai.button] },
    { id: 'actions', nodes: [exportMdBtn] },
    { id: 'history', nodes: [historyBtn], visible: () => getFileState().history },
    { id: 'openApp', nodes: [openExternalButton()] },
  ],
  documentActions: [
    { label: t('aiAssistant'), icon: 'sparkle', onClick: () => ai.open() },
    openExternalMenuItem(),
    { label: t('exportMarkdown'), icon: 'export', onClick: () => post({ type: 'exportDocMarkdown' }) },
    {
      label: t('exportCommentsMd'),
      icon: 'export',
      visible: () => comments.length > 0,
      onClick: () => commentsPanel.exportMarkdown(),
    },
    { label: t('history'), icon: 'history', visible: () => getFileState().history, onClick: () => post({ type: 'history' }) },
    { label: t('diffCompareHistory'), icon: 'history', visible: () => getFileState().history, onClick: () => post({ type: 'compareDocument', fromHistory: true }) },
    { label: t('diffCompareFile'), icon: 'history', onClick: () => post({ type: 'compareDocument', fromHistory: false }) },
  ],
});

let docxInitialRendered = false;
const emitDocxLiveStatus = () => {
  if (docxInitialRendered) {
    post({ type: 'status', ok: true, mode: modeMachine.mode, overlays: overlayStack.getOpenIds() });
  }
};
modeMachine.onChange(emitDocxLiveStatus);
bindLiveViewerStatus(
  (mode, overlays) => post({ type: 'status', ok: true, mode, overlays }),
  () => modeMachine.mode,
  () => docxInitialRendered,
);
openDocxDrawerFn = () => topBar.openDrawer();
app.append(
  topBar.node,
  notice.node,
  el('div', { class: 'dv-body' }, [
    sidebar.node,
    el('div', { class: 'dv-main' }, [sidebar.expandBtn, stage, statusBar]),
  ]),
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
  const normedParas = docxParagraphs.map(normText);
  const freq = new Map<string, number>();
  for (const s of normedParas) {
    if (s) {
      freq.set(s, (freq.get(s) ?? 0) + 1);
    }
  }
  let cursor = 0;
  for (const node of nodes) {
    delete node.dataset.pIndex;
    const clone = node.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.docx-cm-pill').forEach((p) => p.remove());
    const rendered = normText(clone.textContent ?? '');

    if (!rendered) {
      if (cursor < normedParas.length && normedParas[cursor] === '') {
        node.dataset.pIndex = String(cursor);
        if (!paragraphMap.has(cursor)) {
          paragraphMap.set(cursor, node);
        }
        cursor++;
      }
      continue;
    }

    let matched = -1;
    // 1. Wide forward window (handles multi-line TOC fields, page-break gaps and table spans).
    for (let look = cursor; look < Math.min(normedParas.length, cursor + 40); look++) {
      if (normedParas[look] === rendered) {
        matched = look;
        break;
      }
    }
    // 2. Global unique-text anchor re-sync if drift exceeded 40 paragraphs.
    if (matched < 0 && freq.get(rendered) === 1) {
      matched = normedParas.indexOf(rendered);
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

function syncDocxStatusBar(): void {
  const pageCount = pages.querySelectorAll('section.docx').length;
  if (!pageCount) {
    statusText.textContent = '';
    return;
  }
  const paraNodes = [...pages.querySelectorAll<HTMLElement>(PARA_SELECTOR)];
  const nonEmptyParas = paraNodes.filter((n) => (n.textContent ?? '').trim().length > 0).length;
  const words = countDocumentWords(pages.textContent ?? '');
  const parts = [
    `${t('page')} ${pageCount}`,
    t('docParagraphs', nonEmptyParas),
    t('mdWords', words.toLocaleString()),
  ];
  if (comments.length > 0) {
    parts.push(t('commentsCount', comments.length));
  }
  statusText.textContent = parts.join(' · ');
}

function syncCommentsUi(): void {
  commentsPanel.setComments(comments);
  sidebar.setTabLabel('comments', comments.length ? t('commentsCount', comments.length) : t('comments'));
  syncParagraphBadges();
  syncDocxStatusBar();
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
  if (modeMachine.mode === 'read') {
    const anchor = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[href]');
    const href = anchor?.getAttribute('href')?.trim();
    if (anchor && href) {
      e.preventDefault();
      if (href.startsWith('#')) {
        const id = decodeURIComponent(href.slice(1));
        const dest = id
          ? pages.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"], a[name="${CSS.escape(id)}"]`)
          : null;
        dest?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (/^(?:https?:|mailto:)/i.test(href)) {
        post({ type: 'openLink', href });
      }
      return;
    }
  }
  if (!modeMachine.isEditable || modeMachine.mode !== 'annotate') {
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
  if (!modeMachine.isEditable || modeMachine.mode !== 'edit') {
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
    docFind.refresh();
    findWidget.refreshCount();
    docxInitialRendered = true;
    post({
      type: 'status',
      ok: true,
      detail: `${pages.querySelectorAll('section.docx').length} pages, ${headings.length} headings`,
      mode: modeMachine.mode,
      overlays: overlayStack.getOpenIds(),
    });
  } catch (err) {
    if (current === generation) {
      showStatus(pages, t('loadFailed', errorText(err)), true);
      post({ type: 'status', ok: false, detail: errorText(err), mode: modeMachine.mode });
    }
  }
}

onMessage((message) => {
  if (message.type === 'load') {
    docFileName = message.name || 'Document.docx';
    modeMachine.setEditable(message.editable === true);
    comments = message.comments ?? [];
    docxParagraphs = message.docxParagraphs ?? [];
    topBar.refresh();
    void load(message.bytes);
  } else if (message.type === 'comments') {
    comments = message.comments;
    if (message.docxParagraphs) {
      docxParagraphs = message.docxParagraphs;
    }
    syncCommentsUi();
  } else if (message.type === 'diffReport') {
    openDiffModal(message.report);
  } else if (message.type === 'error') {
    showStatus(pages, message.message, true);
  }
});

post({ type: 'ready' });
