import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { init } from 'pptx-preview';
import '../shared/base.css';
import '../shared/office-fonts.css';
import './pptx.css';
import type { DocComment } from '../../common/protocol';
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

let editable = false;
let editMode = false;
let annotateMode = false;
let comments: DocComment[] = [];
let pptxShapes: string[][] = [];
let lastSlideAspect: number | undefined;

const editToggle = toggleButton('pencil', t('pptxEditMode'), (on) => {
  editMode = on;
  if (on && annotateMode) {
    annotateMode = false;
    annotateToggle.set(false);
    host.classList.remove('pptx-annotating');
  }
  host.classList.toggle('pptx-editing', on);
  closeFloatingEditors();
  if (on) {
    notice.flash(t('pptxEditMode'), 2800);
  }
});

const annotateToggle = toggleButton('commentPlus', t('addComment'), (on) => {
  annotateMode = on;
  if (on && editMode) {
    editMode = false;
    editToggle.set(false);
    host.classList.remove('pptx-editing');
  }
  host.classList.toggle('pptx-annotating', on);
  closeFloatingEditors();
  if (on) {
    sidebar.setOpen(true);
    sidebar.setTab('comments');
    notice.flash(t('annotatePptxHint'), 2800);
  }
});

const commentsPanel = new CommentsPanel({
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
    annotateMode = !annotateMode;
    annotateToggle.set(annotateMode);
    if (annotateMode && editMode) {
      editMode = false;
      editToggle.set(false);
      host.classList.remove('pptx-editing');
    }
    host.classList.toggle('pptx-annotating', annotateMode);
    if (annotateMode) {
      notice.flash(t('annotatePptxHint'), 2800);
    }
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

const pager = createPager((n) => goTo(n - 1), t('slideN', ''));
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
const historyBtn = iconButton('history', t('history'), () => post({ type: 'history' }));

const topBar = customToolbar({
  subtitle: 'PPTX',
  slots: [
    { id: 'nav', nodes: [sidebar.toggle] },
    { id: 'view', nodes: [view.node] },
    { id: 'pager', nodes: [pager.node] },
    { id: 'zoom', nodes: zoom.nodes },
    { id: 'find', nodes: findWidget.nodes },
    { id: 'edit', label: t('pptxEditMode'), nodes: [editToggle.node], visible: () => editable },
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
  isActive: () => editable && annotateMode,
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

host.addEventListener('dblclick', (e) => {
  if (!editable || !editMode) {
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
  if (!single || target.closest('input, textarea')) {
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
    slides.forEach((slide) => slide.classList.add('dv-page-invert'));
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
    post({ type: 'status', ok: true, detail: `${previewer.slideCount} slides` });
  } catch (err) {
    if (run === generation) {
      showStatus(host, t('loadFailed', errorText(err)), true);
      post({ type: 'status', ok: false, detail: errorText(err) });
    }
  }
}

onMessage((message) => {
  if (message.type === 'load') {
    editable = message.editable === true;
    comments = message.comments ?? [];
    pptxShapes = message.pptxShapes ?? [];
    lastSlideAspect = message.slideAspect;
    topBar.refresh();
    void load(message.bytes);
  } else if (message.type === 'comments') {
    comments = message.comments;
    syncCommentsUi();
  } else if (message.type === 'error') {
    showStatus(host, message.message, true);
  }
});

post({ type: 'ready' });
