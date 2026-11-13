// Find in the Markdown preview. Matches are painted with the CSS Custom Highlight API, so
// the document's DOM is never modified (incremental re-rendering and scroll sync keep working).

interface HighlightRegistryLike {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

const registry = (): HighlightRegistryLike | undefined =>
  (globalThis.CSS as unknown as { highlights?: HighlightRegistryLike } | undefined)?.highlights;

const HighlightCtor = (): (new (...ranges: Range[]) => unknown) | undefined =>
  (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

/** Text that is not part of the document (copy buttons, the block editor, diagram internals). */
const SKIP = '.md-copy, .md-edit, script, style, svg, textarea';

export class PreviewFind {
  private ranges: Range[] = [];
  private index = -1;
  private query = '';

  constructor(
    private readonly root: HTMLElement,
    private readonly scroller: HTMLElement,
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
      acceptNode: (node) =>
        node.parentElement?.closest(SKIP) || node.parentElement?.closest('[hidden]')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
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

  /** The first match at or below the top of the visible area, so a search starts where you are. */
  private firstVisible(): number {
    const top = this.scroller.getBoundingClientRect().top;
    const i = this.ranges.findIndex((r) => typeof r.getBoundingClientRect === 'function' && r.getBoundingClientRect().bottom >= top);
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
    if (!range || typeof range.getBoundingClientRect !== 'function') {
      return;
    }
    const rect = range.getBoundingClientRect();
    const view = this.scroller.getBoundingClientRect();
    if (rect.top < view.top + 8 || rect.bottom > view.bottom - 8) {
      this.scroller.scrollTop += rect.top - view.top - this.scroller.clientHeight / 3;
    }
  }
}
