import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { init } from 'pptx-preview';
import '../shared/base.css';
import './pptx.css';
import { app, el, errorText, onMessage, post, showStatus, t, toArrayBuffer } from '../shared/api';
import { Outline, readState, Sidebar, writeState } from '../shared/sidebar';
import { customToolbar, noticeBanner, segmented } from '../shared/ui';
import { createPager, createZoom } from '../shared/zoom';

const notice = noticeBanner(t('pptxNotice'));
const stage = el('div', { class: 'dv-stage' });
const host = el('div', { class: 'pptx-host' });
stage.append(host);

const sidebar = new Sidebar(t('navSlides'));
const slideList = new Outline((key) => goTo(Number(key)), {
  showFilter: false,
  emptyText: t('pptxEmpty'),
  countText: (n) => t('slides', n),
});
sidebar.panel().append(slideList.node);

let single = readState().pptxSingle === true;
// List: every slide in one scroll. Single: one slide at a time, paged with the arrows.
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

app.append(
  customToolbar({
    subtitle: 'PPTX',
    slots: [
      { id: 'nav', nodes: [sidebar.toggle] },
      { id: 'view', nodes: [view.node] },
      { id: 'pager', nodes: [pager.node] },
      { id: 'zoom', nodes: zoom.nodes },
    ],
  }).node,
  notice.node,
  el('div', { class: 'dv-body' }, [sidebar.node, el('div', { class: 'dv-main' }, [sidebar.expandBtn, stage])]),
);
showStatus(host, t('loading'));

/**
 * Some generators (pptxgenjs among them) list parts in [Content_Types].xml that are not
 * in the package. PowerPoint ignores those entries, but the preview library aborts on
 * the first missing part and then reports zero slides, so drop them up front.
 */
function dropDanglingParts(buffer: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(buffer);
  const names = new Set<string>();
  const extracted = unzipSync(bytes, {
    filter(file) {
      names.add(file.name);
      return file.name === '[Content_Types].xml';
    },
  });
  const types = extracted['[Content_Types].xml'];
  if (!types) {
    return buffer;
  }
  const xml = strFromU8(types);
  const fixed = xml.replace(/<Override\b[^>]*\bPartName="([^"]+)"[^>]*\/>/g, (entry, part: string) =>
    names.has(part.replace(/^\/+/, '')) ? entry : '',
  );
  if (fixed === xml) {
    return buffer;
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
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
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

/** Short label for a slide: its first line of text. */
function slideTitle(slide: HTMLElement): string {
  const text = (slide.innerText || slide.textContent || '').split('\n').map((s) => s.trim()).find(Boolean);
  return text ? text.slice(0, 60) : '';
}

async function load(bytes: Uint8Array) {
  const run = ++generation;
  const keep = current;
  try {
    previewer?.destroy();
    host.replaceChildren();
    // Slides are laid out at a fixed pixel width; pick one that fits the pane, zoom does the rest.
    const width = Math.max(480, Math.min(1280, stage.clientWidth - 48));
    previewer = init(host, { width, height: Math.round((width * 9) / 16), mode: 'list' });
    await previewer.preview(dropDanglingParts(toArrayBuffer(bytes)));
    if (run !== generation) {
      return;
    }
    if (!previewer.slideCount) {
      // The library swallows parse errors and just yields no slides.
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
    void load(message.bytes);
  } else if (message.type === 'error') {
    showStatus(host, message.message, true);
  }
});

post({ type: 'ready' });
