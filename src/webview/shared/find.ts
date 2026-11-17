// Reusable in-document text search using the CSS Custom Highlight API, so DOM nodes in
// Markdown, Word (.docx) and PowerPoint (.pptx) are never mutated during highlighting.
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

/** Creates a standard toolbar Find widget (`Ctrl/Cmd+F`, input, match count, prev/next arrows). */
export function createFindWidget(find: PreviewFind, focusReturnTarget: HTMLElement): {
  nodes: HTMLElement[];
  refreshCount(): void;
} {
  const input = el('input');
  input.type = 'search';
  input.placeholder = t('find');
  input.setAttribute('aria-label', t('findInPreview'));
  const icon = el('span', { class: 'dv-find-icon' });
  icon.innerHTML = icons.search;
  const box = el('label', { class: 'dv-search dv-find-box' }, [icon, input]);
  const count = el('span', { class: 'dv-label dv-find-count' });

  const refreshCount = () => {
    count.textContent = input.value ? (find.total ? `${find.current}/${find.total}` : t('noMatch')) : '';
  };

  input.addEventListener('input', () => {
    find.search(input.value);
    refreshCount();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      find.next(e.shiftKey);
      refreshCount();
    } else if (e.key === 'Escape') {
      input.value = '';
      find.clear();
      refreshCount();
      focusReturnTarget.focus();
    }
  });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
  const prevBtn = iconButton('up', t('findPrev'), () => {
    find.next(true);
    refreshCount();
  });
  const nextBtn = iconButton('down', t('findNext'), () => {
    find.next();
    refreshCount();
  });

  return {
    nodes: [box, count, prevBtn, nextBtn],
    refreshCount,
  };
}
