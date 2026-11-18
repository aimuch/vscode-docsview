import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { init } from 'pptx-preview';
import '../shared/base.css';
import '../shared/office-fonts.css';
import './pptx.css';
import type { DocComment } from '../../common/protocol';
import { InteractionModeMachine } from '../../common/stateMachine';
import { createAiAssistant } from '../shared/aiAssistant';
import { app, el, errorText, onMessage, post, showStatus, t, toArrayBuffer } from '../shared/api';
import {
  attachSurfaceAnnotator,
  closeFloatingEditors,
  CommentsPanel,
  openInlineTextEditor,
  renderSurfaceAnnotations,
} from '../shared/comments';
import { getFileState } from '../shared/fileState';
import { createFindWidget, PreviewFind } from '../shared/find';
import { bindLiveViewerStatus, overlayStack } from '../shared/overlayStack';
import { Outline, readState, Sidebar, writeState } from '../shared/sidebar';
import {
  customToolbar,
  iconButton,
  noticeBanner,
  openExternalButton,
  openExternalMenuItem,
  segmented,
  toggleButton,
} from '../shared/ui';
import { createPager, createZoom } from '../shared/zoom';

const notice = noticeBanner(t('pptxNotice'));
const stage = el('div', { class: 'dv-stage' });
const host = el('div', { class: 'pptx-host' });
stage.append(host);

const sidebar = new Sidebar(t('nav'), [
  { id: 'slides', label: t('navSlides') },
  { id: 'comments', label: t('comments') },
]);
const slideList = new Outline((key) => goTo(Number(key)), {
  showFilter: false,
  emptyText: t('pptxEmpty'),
  countText: (n) => t('slides', n),
});
sidebar.panel('slides').append(slideList.node);

let docFileName = 'Presentation.pptx';
const modeMachine = new InteractionModeMachine();
let comments: DocComment[] = [];
let pptxShapes: string[][] = [];
let pptxNotes: string[] = [];
let lastSlideAspect: number | undefined;

const editToggle = toggleButton('pencil', t('pptxEditMode'), (on) => {
  modeMachine.setMode(on ? 'edit' : 'read');
});

const annotateToggle = toggleButton('commentPlus', t('addComment'), (on) => {
  modeMachine.setMode(on ? 'annotate' : 'read');
});

modeMachine.onChange((mode) => {
  editToggle.set(mode === 'edit');
  annotateToggle.set(mode === 'annotate');
  host.classList.toggle('pptx-editing', mode === 'edit');
  host.classList.toggle('pptx-annotating', mode === 'annotate');
  closeFloatingEditors();
  if (mode === 'edit') {
    notice.flash(t('pptxEditMode'), 2800);
  } else if (mode === 'annotate') {
    sidebar.setOpen(true);
    sidebar.setTab('comments');
    notice.flash(t('annotatePptxHint'), 2800);
  }
});

const commentsPanel = new CommentsPanel({
  docName: () => docFileName,
  editable: () => modeMachine.isEditable,
  targetLabel: (c) => (c.page ? t('slideN', c.page) : ''),
  onSelect: (c) => {
    if (c.page) {
      goTo(c.page - 1);
    }
    syncSlideAnnotations();
  },
  onUpdate: (id, text) => post({ type: 'docMutate', mutation: { kind: 'updateComment', id, text } }),
  onDelete: (id) => post({ type: 'docMutate', mutation: { kind: 'deleteComment', id } }),
  onToggleAddMode: () => {
    modeMachine.toggle('annotate');
  },
});
sidebar.panel('comments').append(commentsPanel.node);

let single = readState().pptxSingle === true;
const view = segmented<'list' | 'single'>(
  t('view'),
  [
    ['list', t('viewList')],
    ['single', t('viewSlide')],
  ],
  single ? 'single' : 'list',
  (mode) => {
    single = mode === 'single';
    writeState({ pptxSingle: single });
    applyView();
  },
);

const pager = createPager((n) => goTo(n - 1), t('slide'));
const zoom = createZoom((value) => host.style.setProperty('zoom', String(value)), stage);
stage.tabIndex = -1;
const pptFind = new PreviewFind(host, stage, {
  includeHidden: true,
  onReveal: (range) => {
    const parentEl = range.startContainer.parentElement;
    const slideEl = parentEl?.closest<HTMLElement>('.pptx-preview-slide-wrapper');
    if (slideEl) {
      const idx = slides.indexOf(slideEl);
      if (idx >= 0 && idx !== current) {
        goTo(idx);
      }
    }
  },
});
const findWidget = createFindWidget(pptFind, stage);
// ---------------------------------------------------------------- Speaker Notes & Fullscreen Presentation

let notesOpen = readState().pptxNotesOpen === true;
const notesTitleEl = el('span', { class: 'pptx-notes-title', text: t('speakerNotes') });
const notesAiBtn = iconButton('sparkle', `${t('aiAssistant')} · ${t('speakerNotes')}`, () => {
  ai.open({
    presetAction: 'generate',
    initialPrompt: 'Write concise, natural speaker notes for this slide.',
    autoRun: true,
  });
});
notesAiBtn.classList.add('dv-cm-mini');
const notesEditBtn = iconButton('pencil', t('editSpeakerNotes'), () => startNoteEdit());
notesEditBtn.classList.add('dv-cm-mini');
const notesCloseBtn = iconButton('close', t('cancel'), () => setNotesOpen(false));
notesCloseBtn.classList.add('dv-cm-mini');
const notesBody = el('div', { class: 'pptx-notes-body' });
const notesPanel = el('div', { class: 'pptx-notes-panel' }, [
  el('div', { class: 'pptx-notes-head' }, [
    notesTitleEl,
    el('div', { class: 'dv-spacer' }),
    notesAiBtn,
    notesEditBtn,
    notesCloseBtn,
  ]),
  notesBody,
]);
notesPanel.hidden = !notesOpen;

const notesToggle = toggleButton('notes', t('speakerNotes'), (on) => setNotesOpen(on));
notesToggle.set(notesOpen);

function setNotesOpen(on: boolean) {
  notesOpen = on;
  notesToggle.set(on);
  notesPanel.hidden = !on;
  writeState({ pptxNotesOpen: on });
  if (on) {
    syncNotesUi();
  }
}

function syncNotesUi() {
  notesEditBtn.hidden = !modeMachine.isEditable;
  notesAiBtn.hidden = !modeMachine.isEditable;
  if (!slides.length) {
    notesTitleEl.textContent = t('speakerNotes');
    notesBody.textContent = '';
    return;
  }
  notesTitleEl.textContent = `${t('speakerNotes')} · ${t('slideN', current + 1)}`;
  const note = (pptxNotes[current] ?? '').trim();
  notesBody.classList.toggle('pptx-notes-empty', !note);
  notesBody.textContent = note || t('noSpeakerNotes');
}

function startNoteEdit() {
  if (!modeMachine.isEditable || !slides.length) {
    return;
  }
  const slideIndex = current;
  const initial = pptxNotes[slideIndex] ?? '';
  const rect = notesPanel.getBoundingClientRect();
  openInlineTextEditor({
    anchor: { x: Math.max(16, rect.left + 24), y: Math.max(48, rect.top - 180) },
    title: `${t('editSpeakerNotes')} · ${t('slideN', slideIndex + 1)}`,
    initialText: initial,
    onCommit: (nextText) => {
      post({ type: 'docMutate', mutation: { kind: 'editPptxNote', slideIndex, text: nextText } });
    },
  });
}

notesBody.addEventListener('dblclick', () => {
  if (modeMachine.isEditable) {
    startNoteEdit();
  }
});

// Fullscreen Presentation Mode (F5) + Virtual Laser Pointer + Speaker Notes Caption
let presenting = false;
let enteredOsFullscreen = false;
let laserOn = false;
let presentNotesOn = false;
const presentStageWrap = el('div', { class: 'pptx-present-stage' });
const presentCounter = el('span', { class: 'dv-label' });
const presentNotesBubble = el('div', { class: 'pptx-present-notes' });
presentNotesBubble.hidden = true;
const laserDot = el('div', { class: 'dv-laser-dot' });
laserDot.hidden = true;

const laserToggle = toggleButton('laser', `${t('laserPointer')} (L)`, (on) => {
  laserOn = on;
  presentOverlay.classList.toggle('dv-laser-on', on);
  if (!on) {
    laserDot.hidden = true;
  }
});

const presentNotesToggle = toggleButton('notes', `${t('speakerNotes')} (N)`, (on) => {
  presentNotesOn = on;
  syncPresentNotes();
});

function syncPresentNotes() {
  if (!presenting || !presentNotesOn || !slides.length) {
    presentNotesBubble.hidden = true;
    return;
  }
  const note = (pptxNotes[current] ?? '').trim();
  presentNotesBubble.textContent = note || t('noSpeakerNotes');
  presentNotesBubble.classList.toggle('pptx-notes-empty', !note);
  presentNotesBubble.hidden = false;
}

const presentHud = el('div', { class: 'dv-present-hud' }, [
  iconButton('left', t('prevPage'), () => stepPresentation(-1)),
  presentCounter,
  iconButton('right', t('nextPage'), () => stepPresentation(1)),
  presentNotesToggle.node,
  laserToggle.node,
  iconButton('close', t('exitPresentation'), () => exitPresentation()),
]);
presentHud.addEventListener('click', (e) => e.stopPropagation());
presentNotesBubble.addEventListener('click', (e) => e.stopPropagation());

const presentOverlay = el('div', { class: 'dv-present-overlay' }, [
  presentStageWrap,
  presentNotesBubble,
  presentHud,
  laserDot,
]);
presentOverlay.hidden = true;
document.body.append(presentOverlay);

document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) {
    enteredOsFullscreen = true;
  } else if (enteredOsFullscreen) {
    enteredOsFullscreen = false;
    if (presenting) {
      exitPresentation();
    }
  }
});

presentOverlay.addEventListener('mousemove', (e) => {
  if (presenting && laserOn) {
    laserDot.hidden = false;
    laserDot.style.left = `${e.clientX}px`;
    laserDot.style.top = `${e.clientY}px`;
  }
});
presentOverlay.addEventListener('mouseleave', () => {
  laserDot.hidden = true;
});
presentOverlay.addEventListener('click', (e) => {
  if ((e.target as HTMLElement | null)?.closest('.dv-present-hud, .pptx-present-notes')) {
    return;
  }
  stepPresentation(1);
});

function renderPresentSlide() {
  if (!presenting || !slides.length) {
    return;
  }
  const srcSlide = slides[current];
  const clone = srcSlide.cloneNode(true) as HTMLElement;
  clone.hidden = false;
  clone.querySelectorAll('.dv-annot-layer').forEach((n) => n.remove());
  const sw = srcSlide.offsetWidth || 960;
  const sh = srcSlide.offsetHeight || 540;
  const scale = Math.min((window.innerWidth - 32) / sw, (window.innerHeight - 64) / sh);
  clone.style.transformOrigin = 'center center';
  clone.style.transform = `scale(${Math.max(0.2, scale)})`;
  presentStageWrap.replaceChildren(clone);
  presentCounter.textContent = `${current + 1} / ${slides.length}`;
  syncPresentNotes();
}

function stepPresentation(delta: -1 | 1) {
  if (!slides.length) {
    return;
  }
  goTo(Math.max(0, Math.min(slides.length - 1, current + delta)));
  renderPresentSlide();
}

function enterPresentation() {
  if (!slides.length) {
    return;
  }
  presenting = true;
  modeMachine.setMode('present');
  presentOverlay.hidden = false;
  renderPresentSlide();
  overlayStack.push({
    id: 'pptxPresentation',
    isOpen: () => presenting,
    close: exitPresentation,
    restoreFocus: () => stage,
  });
  try {
    void document.documentElement.requestFullscreen?.()?.catch(() => undefined);
  } catch {
    // Webview sandbox may disallow OS fullscreen; fixed overlay still fills viewport.
  }
}

function exitPresentation() {
  if (!presenting) {
    return;
  }
  presenting = false;
  overlayStack.remove('pptxPresentation');
  if (modeMachine.mode === 'present') {
    modeMachine.setMode('read');
  }
  presentOverlay.hidden = true;
  presentNotesBubble.hidden = true;
  laserDot.hidden = true;
  if (document.fullscreenElement) {
    enteredOsFullscreen = false;
    void document.exitFullscreen?.().catch(() => undefined);
  }
}

window.addEventListener('resize', () => {
  if (presenting) {
    renderPresentSlide();
  }
});

const presentBtn = iconButton('play', t('presentSlides'), () => enterPresentation());
const exportMdBtn = iconButton('export', t('exportMarkdown'), () => post({ type: 'exportDocMarkdown' }));
const historyBtn = iconButton('history', t('history'), () => post({ type: 'history' }));

interface PptxAiMeta {
  slideIndex: number;
  shapeIndex?: number;
  expected?: string;
}

function matchSlideShapeFromElement(elNode: Element): { slideIdx: number; shapeIdx: number; expected: string } | undefined {
  const slideEl = elNode.closest<HTMLElement>('.pptx-preview-slide-wrapper');
  if (!slideEl) return undefined;
  const slideIdx = slides.indexOf(slideEl);
  const shapesOnSlide = pptxShapes[slideIdx] ?? [];
  if (slideIdx < 0 || !shapesOnSlide.length) return undefined;
  const normedShapes = shapesOnSlide.map(normShapeText);
  let cur: HTMLElement | null = elNode instanceof HTMLElement ? elNode : elNode.parentElement;
  let matched = -1;
  while (cur && cur !== slideEl) {
    const txt = normShapeText(cur.textContent ?? '');
    if (txt) {
      const exact = normedShapes.indexOf(txt);
      if (exact >= 0) {
        matched = exact;
        break;
      }
      const containing = normedShapes.findIndex((s) => s.includes(txt));
      if (containing >= 0) {
        matched = containing;
      }
    }
    cur = cur.parentElement;
  }
  return matched >= 0 ? { slideIdx, shapeIdx: matched, expected: shapesOnSlide[matched] } : undefined;
}

function capturePptxAiContext() {
  const slideIdx = Math.max(0, current);
  const slideSummary = pptxShapes
    .map((shapes, idx) => `Slide ${idx + 1}: ${shapes.join(' | ')}${pptxNotes[idx] ? ` (Notes: ${pptxNotes[idx]})` : ''}`)
    .join('\n')
    .slice(0, 10_000);

  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    const startEl =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
    if (startEl && host.contains(startEl)) {
      const shapeHit = matchSlideShapeFromElement(startEl);
      if (shapeHit) {
        return {
          selection: shapeHit.expected,
          surrounding: slideSummary,
          badge: `${t('slideN', shapeHit.slideIdx + 1)} · #${shapeHit.shapeIdx + 1}`,
          meta: {
            slideIndex: shapeHit.slideIdx,
            shapeIndex: shapeHit.shapeIdx,
            expected: shapeHit.expected,
          } satisfies PptxAiMeta,
        };
      }
      const selStr = sel.toString().trim();
      return {
        selection: selStr,
        surrounding: slideSummary,
        badge: t('slideN', slideIdx + 1),
        meta: { slideIndex: slideIdx } satisfies PptxAiMeta,
      };
    }
  }

  const curShapes = (pptxShapes[slideIdx] ?? []).join('\n');
  const curNotes = (pptxNotes[slideIdx] ?? '').trim();
  const curSlideContext = [curShapes, curNotes ? `Speaker notes:\n${curNotes}` : ''].filter(Boolean).join('\n\n');
  return {
    selection: curSlideContext || undefined,
    surrounding: slideSummary,
    badge: t('slideN', slideIdx + 1),
    meta: { slideIndex: slideIdx } satisfies PptxAiMeta,
  };
}

let openPptxDrawerFn: (() => void) | undefined;

const ai = createAiAssistant({
  viewerKind: 'pptx',
  getFileName: () => docFileName,
  captureContext: capturePptxAiContext,
  selectionRoot: host,
  onOpenSettings: () => openPptxDrawerFn?.(),
  focusReturnTarget: () => stage,
  applyActions: [
    {
      id: 'replace-shape',
      label: () => t('aiApplyReplace'),
      primary: true,
      visible: ({ captured }) => {
        const m = captured.meta as PptxAiMeta | undefined;
        return modeMachine.isEditable && m?.shapeIndex !== undefined && m.expected !== undefined;
      },
      onApply: ({ text, captured }) => {
        const m = captured.meta as PptxAiMeta;
        post({
          type: 'docMutate',
          mutation: {
            kind: 'editPptxText',
            slideIndex: m.slideIndex,
            shapeIndex: m.shapeIndex!,
            text: text.trim(),
            expected: m.expected!,
          },
        });
      },
    },
    {
      id: 'save-notes',
      label: () => t('aiApplyNotes'),
      primary: true,
      visible: () => modeMachine.isEditable && slides.length > 0,
      onApply: ({ text, captured }) => {
        const m = captured.meta as PptxAiMeta | undefined;
        const slideIndex = m?.slideIndex ?? current;
        setNotesOpen(true);
        post({
          type: 'docMutate',
          mutation: { kind: 'editPptxNote', slideIndex, text: text.trim() },
        });
      },
    },
    {
      id: 'save-comment',
      label: () => t('aiApplyComment'),
      visible: () => modeMachine.isEditable && slides.length > 0,
      onApply: ({ text, captured }) => {
        const m = captured.meta as PptxAiMeta | undefined;
        const page = (m?.slideIndex ?? current) + 1;
        sidebar.setOpen(true);
        sidebar.setTab('comments');
        post({
          type: 'docMutate',
          mutation: { kind: 'addComment', page, rect: { x: 0.9, y: 0.08, w: 0, h: 0 }, text: text.trim() },
        });
      },
    },
  ],
});

const topBar = customToolbar({
  subtitle: 'PPTX',
  slots: [
    { id: 'nav', nodes: [sidebar.toggle] },
    { id: 'view', nodes: [view.node, presentBtn, notesToggle.node] },
    { id: 'pager', nodes: [pager.node] },
    { id: 'zoom', nodes: zoom.nodes },
    { id: 'find', nodes: findWidget.nodes },
    { id: 'edit', label: t('pptxEditMode'), nodes: [editToggle.node], visible: () => modeMachine.isEditable },
    { id: 'comments', nodes: [annotateToggle.node], visible: () => modeMachine.isEditable },
    { id: 'ai', nodes: [ai.button] },
    { id: 'actions', nodes: [exportMdBtn] },
    { id: 'history', nodes: [historyBtn], visible: () => getFileState().history },
    { id: 'openApp', nodes: [openExternalButton()] },
  ],
  documentActions: [
    { label: t('aiAssistant'), icon: 'sparkle', onClick: () => ai.open() },
    openExternalMenuItem(),
    { label: t('presentSlides'), icon: 'play', onClick: () => enterPresentation() },
    { label: t('exportMarkdown'), icon: 'export', onClick: () => post({ type: 'exportDocMarkdown' }) },
    {
      label: t('exportCommentsMd'),
      icon: 'export',
      visible: () => comments.length > 0,
      onClick: () => commentsPanel.exportMarkdown(),
    },
    { label: t('history'), icon: 'history', visible: () => getFileState().history, onClick: () => post({ type: 'history' }) },
  ],
});

let pptxInitialRendered = false;
modeMachine.onChange(() => {
  if (pptxInitialRendered) {
    post({ type: 'status', ok: true, mode: modeMachine.mode, overlays: overlayStack.getOpenIds() });
  }
});
bindLiveViewerStatus(
  (mode, overlays) => post({ type: 'status', ok: true, mode, overlays }),
  () => modeMachine.mode,
  () => pptxInitialRendered,
);
openPptxDrawerFn = () => topBar.openDrawer();
app.append(
  topBar.node,
  notice.node,
  el('div', { class: 'dv-body' }, [
    sidebar.node,
    el('div', { class: 'dv-main' }, [sidebar.expandBtn, stage, notesPanel]),
  ]),
);
showStatus(host, t('loading'));

/**
 * Strips missing [Content_Types].xml overrides (some generators like pptxgenjs emit them)
 * and reads the true slide aspect ratio from `<p:sldSz cx="..." cy="..."/>` in presentation.xml
 * so 4:3, 16:10, 16:9 and custom slides render at exact Office/WPS proportions.
 */
function preparePptx(buffer: ArrayBuffer, knownAspect?: number): { buffer: ArrayBuffer; aspect: number } {
  const bytes = new Uint8Array(buffer);
  const names = new Set<string>();
  const extracted = unzipSync(bytes, {
    filter(file) {
      names.add(file.name);
      return file.name === '[Content_Types].xml' || (!knownAspect && file.name === 'ppt/presentation.xml');
    },
  });

  let aspect = knownAspect ?? 16 / 9;
  const pres = extracted['ppt/presentation.xml'];
  if (!knownAspect && pres) {
    const pXml = strFromU8(pres);
    const m =
      /<(?:p:)?sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i.exec(pXml) ??
      /<(?:p:)?sldSz\b[^>]*\bcy="(\d+)"[^>]*\bcx="(\d+)"/i.exec(pXml);
    if (m) {
      const cxFirst = /cx="\d+"[^>]*cy="/i.test(m[0]);
      const cx = Number(cxFirst ? m[1] : m[2]);
      const cy = Number(cxFirst ? m[2] : m[1]);
      if (cx > 0 && cy > 0) {
        aspect = cx / cy;
      }
    }
  }

  const types = extracted['[Content_Types].xml'];
  if (!types) {
    return { buffer, aspect };
  }
  const xml = strFromU8(types);
  const fixed = xml.replace(/<Override\b[^>]*\bPartName="([^"]+)"[^>]*\/>/g, (entry, part: string) =>
    names.has(part.replace(/^\/+/, '')) ? entry : '',
  );
  if (fixed === xml) {
    return { buffer, aspect };
  }
  const all = unzipSync(bytes);
  all['[Content_Types].xml'] = strToU8(fixed);
  const archive: Zippable = {};
  for (const [name, data] of Object.entries(all)) {
    archive[name] = /\.(?:png|jpe?g|gif|webp|mp4|m4v|mov|mp3|wav|ogg)$/i.test(name)
      ? [data, { level: 0 }]
      : [data, { level: 1 }];
  }
  const zipped = zipSync(archive);
  return {
    buffer: zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer,
    aspect,
  };
}

let previewer: ReturnType<typeof init> | undefined;
let generation = 0;
let slides: HTMLElement[] = [];
let current = 0;

function setCurrent(index: number) {
  current = Math.max(0, Math.min(slides.length - 1, index));
  pager.update(current + 1, slides.length);
  slideList.setActive(String(current));
  syncNotesUi();
}

function applyView() {
  slides.forEach((slide, i) => {
    slide.hidden = single && i !== current;
  });
  if (!single) {
    slides[current]?.scrollIntoView({ block: 'start' });
  } else {
    stage.scrollTop = 0;
  }
}

function goTo(index: number) {
  if (!slides.length) {
    return;
  }
  setCurrent(index);
  if (single) {
    applyView();
  } else {
    slides[current].scrollIntoView({ block: 'start' });
  }
}

function syncCommentsUi(): void {
  commentsPanel.setComments(comments);
  sidebar.setTabLabel('comments', comments.length ? t('commentsCount', comments.length) : t('comments'));
  syncSlideAnnotations();
}

function syncSlideAnnotations(): void {
  slides.forEach((slideEl, idx) => {
    const pageNum = idx + 1;
    const entries = comments
      .map((comment, i) => ({ comment, badgeIndex: i + 1 }))
      .filter((e) => e.comment.page === pageNum);
    renderSurfaceAnnotations(slideEl, entries, commentsPanel.active, (comment) => {
      sidebar.setOpen(true);
      sidebar.setTab('comments');
      commentsPanel.setActive(comment.id, true);
      syncSlideAnnotations();
    });
  });
}

attachSurfaceAnnotator({
  root: host,
  allowBox: false,
  isActive: () => modeMachine.isEditable && modeMachine.mode === 'annotate',
  resolveSurface: (target) => {
    const elTarget = target instanceof HTMLElement ? target : undefined;
    const slideEl = elTarget?.closest<HTMLElement>('.pptx-preview-slide-wrapper');
    if (!slideEl) {
      return undefined;
    }
    const idx = slides.indexOf(slideEl);
    return idx >= 0 ? { surface: slideEl, page: idx + 1 } : undefined;
  },
  titleForPage: (page) => t('slideN', page),
  onCreate: (page, rect, text) => {
    post({ type: 'docMutate', mutation: { kind: 'addComment', page, rect, text } });
  },
});

function normShapeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

host.addEventListener('click', (e) => {
  if (modeMachine.mode !== 'read') {
    return;
  }
  const anchor = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[href]');
  const href = anchor?.getAttribute('href')?.trim();
  if (anchor && href && /^(?:https?:|mailto:)/i.test(href)) {
    e.preventDefault();
    post({ type: 'openLink', href });
  }
});

host.addEventListener('dblclick', (e) => {
  if (!modeMachine.isEditable || modeMachine.mode !== 'edit') {
    return;
  }
  const elTarget = e.target instanceof HTMLElement ? e.target : undefined;
  if (!elTarget || elTarget.closest('.dv-annot-layer')) {
    return;
  }
  const slideEl = elTarget.closest<HTMLElement>('.pptx-preview-slide-wrapper');
  if (!slideEl) {
    return;
  }
  const slideIdx = slides.indexOf(slideEl);
  const shapesOnSlide = pptxShapes[slideIdx] ?? [];
  if (slideIdx < 0 || !shapesOnSlide.length) {
    return;
  }

  // Walk from clicked node up to slide wrapper to find the matching text shape.
  const normedShapes = shapesOnSlide.map(normShapeText);
  let matchedShape = -1;
  let cur: HTMLElement | null = elTarget;
  while (cur && cur !== slideEl) {
    const txt = normShapeText(cur.innerText || cur.textContent || '');
    if (txt) {
      const exact = normedShapes.indexOf(txt);
      if (exact >= 0) {
        matchedShape = exact;
        break;
      }
      const containing = normedShapes.findIndex((s) => s.includes(txt));
      if (containing >= 0) {
        matchedShape = containing;
      }
    }
    cur = cur.parentElement;
  }
  if (matchedShape < 0) {
    return;
  }

  e.preventDefault();
  e.stopPropagation();
  const expected = shapesOnSlide[matchedShape];
  openInlineTextEditor({
    anchor: { x: e.clientX, y: e.clientY + 10 },
    title: t('editShapeTitle', slideIdx + 1, matchedShape + 1),
    initialText: expected,
    onCommit: (nextText) => {
      post({
        type: 'docMutate',
        mutation: {
          kind: 'editPptxText',
          slideIndex: slideIdx,
          shapeIndex: matchedShape,
          text: nextText,
          expected,
        },
      });
    },
  });
});

// In the list view, the slide nearest the top of the pane is the current one.
let frame = 0;
stage.addEventListener('scroll', () => {
  if (single || frame) {
    return;
  }
  frame = requestAnimationFrame(() => {
    frame = 0;
    const top = stage.getBoundingClientRect().top + stage.clientHeight / 3;
    let index = 0;
    slides.forEach((slide, i) => {
      if (slide.getBoundingClientRect().top <= top) {
        index = i;
      }
    });
    if (index !== current) {
      setCurrent(index);
    }
  });
});

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target?.closest('input, textarea, select, button, [role="menu"], [role="dialog"], .dv-st-drawer')) {
    return;
  }
  if (e.key === 'F5') {
    e.preventDefault();
    enterPresentation();
    return;
  }
  if (presenting) {
    if (e.key === 'Escape') {
      e.preventDefault();
      exitPresentation();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault();
      stepPresentation(1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
      e.preventDefault();
      stepPresentation(-1);
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      laserOn = !laserOn;
      laserToggle.set(laserOn);
      presentOverlay.classList.toggle('dv-laser-on', laserOn);
      if (!laserOn) {
        laserDot.hidden = true;
      }
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      presentNotesOn = !presentNotesOn;
      presentNotesToggle.set(presentNotesOn);
      syncPresentNotes();
    }
    return;
  }
  if (!single) {
    return;
  }
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
    e.preventDefault();
    goTo(current + 1);
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    e.preventDefault();
    goTo(current - 1);
  }
});

function slideTitle(slide: HTMLElement): string {
  const clone = slide.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.dv-annot-layer').forEach((n) => n.remove());
  const text = (clone.innerText || clone.textContent || '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean);
  return text ? text.slice(0, 60) : '';
}

async function load(bytes: Uint8Array) {
  const run = ++generation;
  const keep = current;
  try {
    previewer?.destroy();
    host.replaceChildren();
    const { buffer, aspect } = preparePptx(toArrayBuffer(bytes), lastSlideAspect);
    const width = Math.max(480, Math.min(1280, (stage.clientWidth || 960) - 48));
    const height = Math.max(240, Math.round(width / aspect));
    previewer = init(host, { width, height, mode: 'list' });
    await previewer.preview(buffer);
    if (run !== generation) {
      return;
    }
    if (!previewer.slideCount) {
      showStatus(host, t('pptxEmpty'), true);
      slides = [];
      slideList.setItems([]);
      post({ type: 'status', ok: false, detail: 'no slides' });
      return;
    }
    slides = [...host.querySelectorAll<HTMLElement>('.pptx-preview-slide-wrapper')];
    slideList.setItems(
      slides.map((slide, i) => {
        const title = slideTitle(slide);
        return { level: 1, text: title ? `${i + 1}. ${title}` : t('slideN', i + 1), key: String(i) };
      }),
    );
    setCurrent(Math.min(keep, slides.length - 1));
    applyView();
    syncCommentsUi();
    pptFind.refresh();
    findWidget.refreshCount();
    pptxInitialRendered = true;
    post({
      type: 'status',
      ok: true,
      detail: `${previewer.slideCount} slides`,
      mode: modeMachine.mode,
      overlays: overlayStack.getOpenIds(),
    });
  } catch (err) {
    if (run === generation) {
      showStatus(host, t('loadFailed', errorText(err)), true);
      post({ type: 'status', ok: false, detail: errorText(err), mode: modeMachine.mode });
    }
  }
}

onMessage((message) => {
  if (message.type === 'load') {
    docFileName = message.name || 'Presentation.pptx';
    modeMachine.setEditable(message.editable === true);
    comments = message.comments ?? [];
    pptxShapes = message.pptxShapes ?? [];
    pptxNotes = message.pptxNotes ?? [];
    if (pptxNotes.some((n) => n.trim().length > 0) && readState().pptxNotesOpen === undefined) {
      setNotesOpen(true);
    }
    if (message.initialPage && message.initialPage >= 1) {
      current = message.initialPage - 1;
    }
    lastSlideAspect = message.slideAspect;
    topBar.refresh();
    void load(message.bytes);
  } else if (message.type === 'comments') {
    comments = message.comments;
    if (message.pptxNotes) {
      pptxNotes = message.pptxNotes;
    }
    syncCommentsUi();
    syncNotesUi();
  } else if (message.type === 'error') {
    showStatus(host, message.message, true);
  }
});

post({ type: 'ready' });
