// Reusable in-document text search (CSS Custom Highlight API) + unified collapsible Find capsule
// shared across Markdown, Word (.docx), PowerPoint (.pptx), PDF (.pdf), Spreadsheets, and .doc.
import { el, t } from './api';
import { icons } from './icons';
import { iconButton } from './ui';

interface HighlightRegistryLike {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

const registry = (): HighlightRegistryLike | undefined =>
  (globalThis.CSS as unknown as { highlights?: HighlightRegistryLike } | undefined)?.highlights;

const HighlightCtor = (): (new (...ranges: Range[]) => unknown) | undefined =>
  (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

/** UI elements inside preview containers whose text is not part of the authored document. */
const SKIP = '.md-copy, .md-edit, .docx-cm-pill, .dv-annot-layer, script, style, svg, textarea';

export interface PreviewFindOptions {
  /** Search inside `[hidden]` containers too (e.g. non-active slides in PPT single-slide mode). */
  includeHidden?: boolean;
  /** Called before scrolling a match into view (e.g. to switch PPT to the matching slide). */
  onReveal?: (range: Range) => void;
}

export class PreviewFind {
  private ranges: Range[] = [];
  private index = -1;
  private query = '';

  constructor(
    private readonly root: HTMLElement,
    private readonly scroller: HTMLElement,
    private readonly opts: PreviewFindOptions = {},
  ) {}

  get total(): number {
    return this.ranges.length;
  }

  /** 1-based position of the current match, 0 when there is none. */
  get current(): number {
    return this.index + 1;
  }

  search(query: string): void {
    this.query = query;
    this.collect();
    this.index = this.ranges.length ? this.firstVisible() : -1;
    this.paint();
    this.reveal();
  }

  next(backwards = false): void {
    if (!this.ranges.length) {
      return;
    }
    const n = this.ranges.length;
    this.index = (this.index + (backwards ? -1 : 1) + n) % n;
    this.paint();
    this.reveal();
  }

  /** Re-runs the search after the document was re-rendered, keeping the position if possible. */
  refresh(): void {
    if (!this.query) {
      return;
    }
    const keep = this.index;
    this.collect();
    this.index = this.ranges.length ? Math.min(Math.max(keep, 0), this.ranges.length - 1) : -1;
    this.paint();
  }

  clear(): void {
    this.query = '';
    this.ranges = [];
    this.index = -1;
    this.paint();
  }

  private collect(): void {
    this.ranges = [];
    const needle = this.query.toLowerCase();
    if (!needle) {
      return;
    }
    const walker = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (node.parentElement?.closest(SKIP)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (!this.opts.includeHidden && node.parentElement?.closest('[hidden]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.nodeValue ?? '').toLowerCase();
      for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        this.ranges.push(range);
      }
    }
  }

  private firstVisible(): number {
    const top = this.scroller.getBoundingClientRect().top;
    const i = this.ranges.findIndex(
      (r) => typeof r.getBoundingClientRect === 'function' && r.getBoundingClientRect().bottom >= top,
    );
    return i >= 0 ? i : 0;
  }

  private paint(): void {
    const highlights = registry();
    const Highlight = HighlightCtor();
    if (!highlights || !Highlight) {
      return;
    }
    if (!this.ranges.length) {
      highlights.delete('dv-find');
      highlights.delete('dv-find-current');
      return;
    }
    highlights.set('dv-find', new Highlight(...this.ranges));
    highlights.set('dv-find-current', new Highlight(this.ranges[this.index]));
  }

  private reveal(): void {
    const range = this.ranges[this.index];
    if (!range) {
      return;
    }
    this.opts.onReveal?.(range);
    if (typeof range.getBoundingClientRect !== 'function') {
      return;
    }
    const rect = range.getBoundingClientRect();
    const view = this.scroller.getBoundingClientRect();
    if (rect.top < view.top + 8 || rect.bottom > view.bottom - 8) {
      this.scroller.scrollTop += rect.top - view.top - this.scroller.clientHeight / 3;
    }
  }
}

export interface FindBackend {
  onInput(query: string): void;
  step(backwards: boolean): void;
  clear(): void;
  status(query: string): string;
}

export interface FindBar {
  nodes: HTMLElement[];
  input: HTMLInputElement;
  open(): void;
  close(): void;
  refreshCount(overrideStatus?: string): void;
}

/**
 * Collapsible toolbar Find capsule:
 * - Collapsed: compact 28px search icon button (`Ctrl/Cmd+F`), freeing ~240px of toolbar width!
 * - Expanded: `[search input | match count | prev ↑ | next ↓ | close ×]`, overflow-aware (`dv:slot-change`)
 *   so pressing `Ctrl/Cmd+F` even in a narrow split pane reveals and focuses the input reliably.
 */
export function createFindBar(
  backend: FindBackend,
  focusReturnTarget: HTMLElement,
  opts: { ariaLabel?: string } = {},
): FindBar {
  const toggleBtn = iconButton('search', `${t('find')} (Ctrl/Cmd+F)`, () => open());
  toggleBtn.setAttribute('aria-expanded', 'false');

  const input = el('input');
  input.type = 'search';
  input.placeholder = t('find');
  input.setAttribute('aria-label', opts.ariaLabel ?? t('findInPreview'));

  const searchIcon = el('span', { class: 'dv-find-icon' });
  searchIcon.innerHTML = icons.search;
  const count = el('span', { class: 'dv-label dv-find-count' });
  const box = el('label', { class: 'dv-search dv-find-box' }, [searchIcon, input]);

  const prevBtn = iconButton('up', t('findPrev'), () => {
    backend.step(true);
    refreshCount();
  });
  const nextBtn = iconButton('down', t('findNext'), () => {
    backend.step(false);
    refreshCount();
  });
  const closeBtn = iconButton('close', t('close'), () => close());
  closeBtn.classList.add('dv-find-close');

  const barWrap = el('div', { class: 'dv-find-bar' }, [box, count, prevBtn, nextBtn, closeBtn]);
  barWrap.hidden = true;

  const refreshCount = (overrideStatus?: string) => {
    count.textContent = overrideStatus !== undefined ? overrideStatus : backend.status(input.value);
  };

  const notifyToolbar = (ensureVisible: boolean) => {
    (barWrap.hidden ? toggleBtn : barWrap).dispatchEvent(
      new CustomEvent('dv:slot-change', { bubbles: true, detail: { ensureVisible } }),
    );
  };

  const open = () => {
    toggleBtn.hidden = true;
    toggleBtn.setAttribute('aria-expanded', 'true');
    barWrap.hidden = false;
    notifyToolbar(true);
    input.focus();
    input.select();
  };

  const close = () => {
    input.value = '';
    backend.clear();
    refreshCount('');
    barWrap.hidden = true;
    toggleBtn.hidden = false;
    toggleBtn.setAttribute('aria-expanded', 'false');
    notifyToolbar(false);
    focusReturnTarget.focus();
  };

  input.addEventListener('input', () => {
    backend.onInput(input.value);
    refreshCount();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      backend.step(e.shiftKey);
      refreshCount();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      open();
    }
  });

  return {
    nodes: [toggleBtn, barWrap],
    input,
    open,
    close,
    refreshCount,
  };
}

/** Creates a standard toolbar Find widget backed by `PreviewFind`. */
export function createFindWidget(find: PreviewFind, focusReturnTarget: HTMLElement): FindBar {
  return createFindBar(
    {
      onInput: (q) => find.search(q),
      step: (backwards) => find.next(backwards),
      clear: () => find.clear(),
      status: (q) => (q ? (find.total ? `${find.current}/${find.total}` : t('noMatch')) : ''),
    },
    focusReturnTarget,
  );
}
