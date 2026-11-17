// Virtualised spreadsheet grid shared by the CSV and Excel views.
//
// Layout: one scroll container. Cells are absolutely positioned inside four layers:
//   body   - scrolls both ways
//   top    - position:sticky top    -> column headers + frozen rows
//   left   - position:sticky left   -> row headers + frozen columns
//   corner - sticky top and left    -> corner box + cells frozen in both directions
// Only cells intersecting the viewport exist in the DOM.
import type { Cell, CellChange, CellStyle, MergeRange } from '../../common/protocol';
import './grid.css';

export interface GridSource {
  rowCount: number;
  colCount: number;
  cell(r: number, c: number): Cell | undefined;
  styles?: CellStyle[];
  /** Width in px for every column. */
  colWidths: number[];
  rowHeights?: Record<number, number>;
  merges?: MergeRange[];
  frozenRows?: number;
  frozenCols?: number;
  /** 'light' renders a white sheet regardless of theme (for workbooks with authored colours). */
  palette?: 'theme' | 'light';
  /** Row header text; defaults to the 1-based row index (a sorted view shows the original numbers). */
  rowLabel?(r: number): string;
  /** Marker appended to a column header, e.g. a sort arrow. */
  colBadge?(c: number): string;
}

export interface Selection {
  /** Active cell. */
  r: number;
  c: number;
  /** Normalised range. */
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface GridOptions {
  editable: boolean;
  /** Paste may extend past the last row (the host appends rows). */
  canGrowRows?: boolean;
  onEdit(changes: CellChange[]): void;
  onSelection?(selection: Selection): void;
  onReadonlyCell?(): void;
  /** The user tried to edit while editing is switched off (see setEditable). */
  onBlockedEdit?(): void;
  /** Paste had to truncate rows because growing rows is temporarily blocked (e.g. sorted/filtered view). */
  onPasteTruncated?(): void;
  onColumnResize?(col: number, width: number): void;
  /** Double-click on a column header right border to auto-fit that column's width. */
  onColumnAutoFit?(col: number): void;
  /** Adds a menu button to column headers (sort / filter). */
  onColumnMenu?(col: number, anchor: DOMRect): void;
  /** Right-click context menu on a cell, row header, or column header. */
  onContextMenu?(area: 'cell' | 'row' | 'col', r: number, c: number, clientX: number, clientY: number): void;
  /** Live mirror of the in-cell editor text (for syncing the formula bar). */
  onEditorInput?(value: string): void;
}

const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 24;
const MIN_COL_WIDTH = 24;
const OVERSCAN_ROWS = 6;
const OVERSCAN_COLS = 2;

type LayerName = 'body' | 'top' | 'left' | 'corner';

interface CellEl extends HTMLDivElement {
  _r: number;
  _c: number;
  /** Rows / columns covered (merged cells span more than one). */
  _rs?: number;
  _cs?: number;
  _kind: 'cell' | 'col' | 'row';
}

export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

export function cellText(cell: Cell | undefined): string {
  return cell == null ? '' : typeof cell === 'string' ? cell : cell.v;
}

export function cellRaw(cell: Cell | undefined): string {
  return cell == null ? '' : typeof cell === 'string' ? cell : (cell.raw ?? cell.v);
}

/** Largest index i in [0, n-1] with prefix[i] <= value. */
function locate(prefix: Float64Array, n: number, value: number): number {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (prefix[mid] <= value) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return Math.max(0, lo);
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export class Grid {
  readonly root: HTMLDivElement;
  private readonly viewport: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly layers: Record<LayerName, HTMLDivElement>;
  private readonly cornerBox: HTMLDivElement;

  private source: GridSource = { rowCount: 0, colCount: 0, cell: () => null, colWidths: [] };
  private colX = new Float64Array(1);
  private rowY = new Float64Array(1);
  private headerW = 44;
  private headerH = HEADER_HEIGHT;
  private zoom = 1;
  private frozenRows = 0;
  private frozenCols = 0;
  /** Merge lookup by anchor "r,c" and sorted by top row for fast viewport/hit queries. */
  private mergeAnchors = new Map<string, MergeRange>();
  private sortedMerges: MergeRange[] = [];
  private maxMergeRows = 1;

  private pool = new Map<string, CellEl>();
  private frame = 0;
  private frameTimer: ReturnType<typeof setTimeout> | undefined;

  private active = { r: 0, c: 0 };
  private anchor = { r: 0, c: 0 };
  private dragging = false;

  private editor: HTMLTextAreaElement | undefined;
  private editing: { r: number; c: number } | undefined;

  constructor(
    parent: HTMLElement,
    private readonly opts: GridOptions,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'grid';
    this.viewport = document.createElement('div');
    this.viewport.className = 'grid-viewport';
    this.viewport.tabIndex = 0;
    this.content = document.createElement('div');
    this.content.className = 'grid-content';

    const layer = (name: LayerName) => {
      const node = document.createElement('div');
      node.className = `grid-layer grid-${name}`;
      return node;
    };
    this.layers = { corner: layer('corner'), top: layer('top'), left: layer('left'), body: layer('body') };
    this.cornerBox = document.createElement('div');
    this.cornerBox.className = 'grid-header grid-corner-box';
    this.layers.corner.append(this.cornerBox);
    this.content.append(this.layers.corner, this.layers.top, this.layers.left, this.layers.body);
    this.viewport.append(this.content);
    this.root.append(this.viewport);
    parent.append(this.root);

    this.viewport.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(this.viewport);
    this.viewport.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.viewport.addEventListener('mousemove', (e) => {
      let overEdge = false;
      if (this.source.colCount > 0) {
        const rect = this.viewport.getBoundingClientRect();
        const vx = e.clientX - rect.left;
        const vy = e.clientY - rect.top;
        if (vy >= 0 && vy < this.headerH && vx >= this.headerW && vx < this.viewport.clientWidth) {
          overEdge = this.resizeTargetFromVx(vx) !== undefined;
        }
      }
      if (this.root.classList.contains('grid-edge') !== overEdge) {
        this.root.classList.toggle('grid-edge', overEdge);
      }
    });
    this.viewport.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    this.viewport.addEventListener('contextmenu', (e) => this.onContextMenuEvent(e));
    this.viewport.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.viewport.addEventListener('copy', (e) => this.onCopy(e));
    this.viewport.addEventListener('cut', (e) => this.onCopy(e, true));
    this.viewport.addEventListener('paste', (e) => this.onPaste(e));
  }

  // ------------------------------------------------------------------ data

  setData(source: GridSource, keepView = false): void {
    this.commitEdit();
    this.source = source;
    this.frozenRows = clamp(source.frozenRows ?? 0, 0, Math.max(0, source.rowCount - 1));
    this.frozenCols = clamp(source.frozenCols ?? 0, 0, Math.max(0, source.colCount - 1));
    this.root.classList.toggle('grid-light', source.palette === 'light');
    this.buildMergeIndex(source.merges);
    this.measure();
    if (!keepView) {
      this.active = { r: 0, c: 0 };
      this.anchor = { r: 0, c: 0 };
      this.viewport.scrollTop = 0;
      this.viewport.scrollLeft = 0;
    } else {
      this.active = this.clampCell(this.active);
      this.anchor = this.clampCell(this.anchor);
    }
    this.invalidate();
    this.emitSelection();
  }

  /** Cell contents changed in place: rebuild the visible cells. */
  invalidate(): void {
    for (const node of this.pool.values()) {
      node.remove();
    }
    this.pool.clear();
    this.schedule();
  }

  get selection(): Selection {
    return {
      r: this.active.r,
      c: this.active.c,
      r0: Math.min(this.active.r, this.anchor.r),
      r1: Math.max(this.active.r, this.anchor.r),
      c0: Math.min(this.active.c, this.anchor.c),
      c1: Math.max(this.active.c, this.anchor.c),
    };
  }

  /** Switches cell editing on or off (e.g. a "lock editing" toggle). */
  setEditable(on: boolean): void {
    if (!on) {
      this.cancelEdit();
    }
    this.opts.editable = on;
  }

  get editable(): boolean {
    return this.opts.editable;
  }

  /** Enables or disables growing rows on paste (disabled while a sort/filter view is active). */
  setCanGrowRows(on: boolean): void {
    this.opts.canGrowRows = on;
  }

  private buildMergeIndex(merges: MergeRange[] | undefined): void {
    this.mergeAnchors.clear();
    if (!merges?.length) {
      this.sortedMerges = [];
      this.maxMergeRows = 1;
      return;
    }
    let maxRs = 1;
    for (const m of merges) {
      this.mergeAnchors.set(`${m.r},${m.c}`, m);
      if (m.rs > maxRs) {
        maxRs = m.rs;
      }
    }
    this.sortedMerges = [...merges].sort((a, b) => a.r - b.r || a.c - b.c);
    this.maxMergeRows = maxRs;
  }

  /** First index in `sortedMerges` whose top row `m.r >= minRow`. */
  private lowerBoundMerge(minRow: number): number {
    let lo = 0;
    let hi = this.sortedMerges.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sortedMerges[mid].r < minRow) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /** Right-to-left cell text. */
  setRtl(on: boolean): void {
    this.root.classList.toggle('grid-rtl', on);
  }

  /** Scales row heights, column widths and typography crisply without CSS transform blur. */
  setZoom(scale: number): void {
    const next = clamp(scale, 0.25, 4);
    if (next === this.zoom) {
      return;
    }
    this.commitEdit();
    this.zoom = next;
    this.root.style.fontSize = `${Math.max(8, Math.round(13 * next))}px`;
    if (this.source.rowCount > 0 && this.source.colCount > 0) {
      this.measure();
      this.invalidate();
    }
  }

  /** Selects a cell and scrolls it into view. */
  goTo(r: number, c: number): void {
    this.commitEdit();
    this.select(r, c);
  }

  focus(): void {
    this.viewport.focus({ preventScroll: true });
  }

  private measure(): void {
    const { rowCount, colCount, colWidths, rowHeights } = this.source;
    const z = this.zoom;
    const rowH = Math.max(10, Math.round(ROW_HEIGHT * z));
    this.headerH = Math.max(14, Math.round(HEADER_HEIGHT * z));
    this.colX = new Float64Array(colCount + 1);
    for (let c = 0; c < colCount; c++) {
      this.colX[c + 1] = this.colX[c] + Math.max(0, Math.round((colWidths[c] ?? 80) * z));
    }
    this.rowY = new Float64Array(rowCount + 1);
    if (rowHeights && Object.keys(rowHeights).length) {
      for (let r = 0; r < rowCount; r++) {
        const h = rowHeights[r];
        this.rowY[r + 1] = this.rowY[r] + (h !== undefined ? Math.max(8, Math.round(h * z)) : rowH);
      }
    } else {
      for (let r = 0; r <= rowCount; r++) {
        this.rowY[r] = r * rowH;
      }
    }
    this.headerW = Math.max(Math.round(36 * z), Math.round((18 + String(rowCount).length * 8) * z));
    this.content.style.width = `${this.headerW + this.colX[colCount]}px`;
    this.content.style.height = `${this.headerH + this.rowY[rowCount]}px`;
    this.cornerBox.style.width = `${this.headerW}px`;
    this.cornerBox.style.height = `${this.headerH}px`;
  }

  private clampCell(cell: { r: number; c: number }): { r: number; c: number } {
    return {
      r: clamp(cell.r, 0, Math.max(0, this.source.rowCount - 1)),
      c: clamp(cell.c, 0, Math.max(0, this.source.colCount - 1)),
    };
  }

  // ------------------------------------------------------------------ rendering

  private schedule(): void {
    if (this.frame) {
      return;
    }
    const run = () => {
      cancelAnimationFrame(this.frame);
      clearTimeout(this.frameTimer);
      this.frame = 0;
      this.render();
    };
    this.frame = requestAnimationFrame(run);
    // Animation frames are paused while the webview is hidden; the timer keeps the
    // grid from going stale when data arrives in the background.
    this.frameTimer = setTimeout(run, 150);
  }

  private render(): void {
    const { rowCount, colCount } = this.source;
    const used = new Set<string>();
    if (rowCount > 0 && colCount > 0) {
      const { scrollLeft, scrollTop, clientWidth, clientHeight } = this.viewport;
      const fr = this.frozenRows;
      const fc = this.frozenCols;
      const frozenW = this.colX[fc];
      const frozenH = this.rowY[fr];

      const c0 = Math.max(fc, locate(this.colX, colCount, scrollLeft + frozenW) - OVERSCAN_COLS);
      const c1 = Math.min(
        colCount - 1,
        locate(this.colX, colCount, scrollLeft + clientWidth - this.headerW) + OVERSCAN_COLS,
      );
      const r0 = Math.max(fr, locate(this.rowY, rowCount, scrollTop + frozenH) - OVERSCAN_ROWS);
      const r1 = Math.min(
        rowCount - 1,
        locate(this.rowY, rowCount, scrollTop + clientHeight - this.headerH) + OVERSCAN_ROWS,
      );

      // Each region: [layer, row range, col range].
      const regions: [LayerName, number, number, number, number][] = [
        ['body', r0, r1, c0, c1],
        ['top', 0, fr - 1, c0, c1],
        ['left', r0, r1, 0, fc - 1],
        ['corner', 0, fr - 1, 0, fc - 1],
      ];
      for (const [layer, ra, rb, ca, cb] of regions) {
        if (ra > rb || ca > cb) {
          continue;
        }
        this.renderRegion(layer, ra, rb, ca, cb, used);
      }

      for (let c = c0; c <= c1; c++) {
        this.header('top', 'col', c, used);
      }
      for (let c = 0; c < fc; c++) {
        this.header('corner', 'col', c, used);
      }
      for (let r = r0; r <= r1; r++) {
        this.header('left', 'row', r, used);
      }
      for (let r = 0; r < fr; r++) {
        this.header('corner', 'row', r, used);
      }
    }

    for (const [key, node] of this.pool) {
      if (!used.has(key)) {
        node.remove();
        this.pool.delete(key);
      }
    }
    this.paintSelection();
  }

  private renderRegion(layer: LayerName, r0: number, r1: number, c0: number, c1: number, used: Set<string>): void {
    // Cells hidden under a merge, and the merge anchors that must be drawn for this region.
    const covered = new Set<number>();
    const colCount = this.source.colCount;
    const merges = this.sortedMerges;
    if (merges.length) {
      for (let idx = this.lowerBoundMerge(r0 - this.maxMergeRows + 1); idx < merges.length; idx++) {
        const m = merges[idx];
        if (m.r > r1) {
          break;
        }
        const mr1 = m.r + m.rs - 1;
        const mc1 = m.c + m.cs - 1;
        if (mr1 < r0 || mc1 < c0 || m.c > c1) {
          continue;
        }
        for (let r = Math.max(m.r, r0); r <= Math.min(mr1, r1); r++) {
          for (let c = Math.max(m.c, c0); c <= Math.min(mc1, c1); c++) {
            covered.add(r * colCount + c);
          }
        }
        this.cell(layer, m.r, m.c, m, used);
      }
    }
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (!covered.has(r * colCount + c)) {
          this.cell(layer, r, c, undefined, used);
        }
      }
    }
  }

  private cell(layer: LayerName, r: number, c: number, merge: MergeRange | undefined, used: Set<string>): void {
    const key = `c:${r}:${c}`;
    used.add(key);
    if (this.pool.has(key)) {
      return;
    }
    const node = document.createElement('div') as CellEl;
    node._r = r;
    node._c = c;
    node._rs = merge?.rs ?? 1;
    node._cs = merge?.cs ?? 1;
    node._kind = 'cell';
    node.className = 'grid-cell';
    const rs = merge?.rs ?? 1;
    const cs = merge?.cs ?? 1;
    const s = node.style;
    s.left = `${this.headerW + this.colX[c]}px`;
    s.top = `${this.headerH + this.rowY[r]}px`;
    s.width = `${this.colX[Math.min(this.source.colCount, c + cs)] - this.colX[c]}px`;
    s.height = `${this.rowY[Math.min(this.source.rowCount, r + rs)] - this.rowY[r]}px`;
    if (merge) {
      node.classList.add('grid-merged');
    }

    const data = this.source.cell(r, c);
    if (data != null) {
      const text = cellText(data);
      const style = typeof data !== 'string' && data.s !== undefined ? this.source.styles?.[data.s] : undefined;
      // Rows have a fixed height: unless the cell wraps, show line breaks inline.
      node.textContent = style?.wrap || !text.includes('\n') ? text : text.replace(/\r?\n/g, ' \u21b5 ');
      if (typeof data !== 'string') {
        if (data.n) {
          s.justifyContent = 'flex-end';
        }
        if (style) {
          this.applyStyle(node, style);
        }
      }
    }
    this.layers[layer].append(node);
    this.pool.set(key, node);
  }

  private applyStyle(node: HTMLElement, style: CellStyle): void {
    const s = node.style;
    if (style.bold) {
      s.fontWeight = '600';
    }
    if (style.italic) {
      s.fontStyle = 'italic';
    }
    if (style.underline || style.strike) {
      s.textDecoration = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].join(' ').trim();
    }
    if (style.color) {
      s.color = style.color;
    }
    if (style.bg) {
      s.backgroundColor = style.bg;
    }
    if (style.fontSize) {
      s.fontSize = `${Math.max(8, Math.round(style.fontSize * this.zoom))}px`;
    }
    if (style.align) {
      s.justifyContent = style.align === 'center' ? 'center' : style.align === 'right' ? 'flex-end' : 'flex-start';
      s.textAlign = style.align;
    }
    if (style.valign) {
      s.alignItems = style.valign === 'top' ? 'flex-start' : style.valign === 'bottom' ? 'flex-end' : 'center';
    }
    if (style.wrap) {
      s.whiteSpace = 'pre-wrap';
      s.overflowWrap = 'anywhere';
      s.lineHeight = '1.25';
    }
    if (style.bt) {
      s.borderTop = style.bt;
    }
    if (style.br) {
      s.borderRight = style.br;
    }
    if (style.bb) {
      s.borderBottom = style.bb;
    }
    if (style.bl) {
      s.borderLeft = style.bl;
    }
  }

  private header(layer: LayerName, kind: 'col' | 'row', index: number, used: Set<string>): void {
    const key = `${kind}:${index}`;
    used.add(key);
    if (this.pool.has(key)) {
      return;
    }
    const node = document.createElement('div') as CellEl;
    node._kind = kind;
    node._r = kind === 'row' ? index : -1;
    node._c = kind === 'col' ? index : -1;
    node.className = `grid-header grid-${kind}-header`;
    const s = node.style;
    if (kind === 'col') {
      node.textContent = columnName(index) + (this.source.colBadge?.(index) ?? '');
      const onMenu = this.opts.onColumnMenu;
      if (onMenu) {
        const menu = document.createElement('button');
        menu.type = 'button';
        menu.className = 'grid-col-menu';
        menu.title = columnName(index);
        menu.setAttribute('aria-haspopup', 'menu');
        menu.innerHTML =
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';
        if (this.source.colBadge?.(index)) {
          menu.classList.add('grid-col-menu-on');
        }
        // Keep the header's own mousedown (column selection) from firing.
        menu.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          e.preventDefault();
        });
        menu.addEventListener('click', (e) => {
          e.stopPropagation();
          onMenu(index, node.getBoundingClientRect());
        });
        node.append(menu);
      }
      s.left = `${this.headerW + this.colX[index]}px`;
      s.top = '0px';
      s.width = `${this.colX[index + 1] - this.colX[index]}px`;
      s.height = `${this.headerH}px`;
    } else {
      node.textContent = this.source.rowLabel?.(index) ?? String(index + 1);
      s.left = '0px';
      s.top = `${this.headerH + this.rowY[index]}px`;
      s.width = `${this.headerW}px`;
      s.height = `${this.rowY[index + 1] - this.rowY[index]}px`;
    }
    this.layers[layer].append(node);
    this.pool.set(key, node);
  }

  private paintSelection(): void {
    const sel = this.selection;
    const single = sel.r0 === sel.r1 && sel.c0 === sel.c1;
    for (const node of this.pool.values()) {
      if (node._kind === 'cell') {
        const inside = node._r >= sel.r0 && node._r <= sel.r1 && node._c >= sel.c0 && node._c <= sel.c1;
        node.classList.toggle('grid-sel', inside && !single);
        node.classList.toggle('grid-active', node._r === sel.r && node._c === sel.c);
        // Row/column highlight ("reading mode"): shown only while the body has dv-highlight.
        const lastRow = node._r + (node._rs ?? 1) - 1;
        const lastCol = node._c + (node._cs ?? 1) - 1;
        const inRows = node._r <= sel.r1 && lastRow >= sel.r0;
        const inCols = node._c <= sel.c1 && lastCol >= sel.c0;
        node.classList.toggle('grid-cross', inRows || inCols);
      } else if (node._kind === 'col') {
        node.classList.toggle('grid-hl', node._c >= sel.c0 && node._c <= sel.c1);
      } else {
        node.classList.toggle('grid-hl', node._r >= sel.r0 && node._r <= sel.r1);
      }
    }
  }

  // ------------------------------------------------------------------ selection

  private emitSelection(): void {
    this.opts.onSelection?.(this.selection);
  }

  /** If the cell lies under a merge, returns the merge's anchor cell. */
  private anchorOf(r: number, c: number): { r: number; c: number } {
    const merges = this.sortedMerges;
    if (merges.length) {
      for (let idx = this.lowerBoundMerge(r - this.maxMergeRows + 1); idx < merges.length; idx++) {
        const m = merges[idx];
        if (m.r > r) {
          break;
        }
        if (r < m.r + m.rs && c >= m.c && c < m.c + m.cs) {
          return { r: m.r, c: m.c };
        }
      }
    }
    return { r, c };
  }

  private select(r: number, c: number, extend = false, reveal = true): void {
    if (!this.source.rowCount || !this.source.colCount) {
      return;
    }
    const target = this.clampCell({ r, c });
    this.active = extend ? target : this.anchorOf(target.r, target.c);
    if (!extend) {
      this.anchor = { ...this.active };
    }
    if (reveal) {
      this.reveal(this.active.r, this.active.c);
    }
    this.paintSelection();
    this.emitSelection();
  }

  private reveal(r: number, c: number): void {
    const v = this.viewport;
    if (c >= this.frozenCols) {
      const min = v.scrollLeft + this.colX[this.frozenCols];
      const max = v.scrollLeft + v.clientWidth - this.headerW;
      if (this.colX[c] < min) {
        v.scrollLeft = this.colX[c] - this.colX[this.frozenCols];
      } else if (this.colX[c + 1] > max) {
        v.scrollLeft = Math.min(this.colX[c] - this.colX[this.frozenCols], this.colX[c + 1] - (v.clientWidth - this.headerW));
      }
    }
    if (r >= this.frozenRows) {
      const min = v.scrollTop + this.rowY[this.frozenRows];
      const max = v.scrollTop + v.clientHeight - this.headerH;
      if (this.rowY[r] < min) {
        v.scrollTop = this.rowY[r] - this.rowY[this.frozenRows];
      } else if (this.rowY[r + 1] > max) {
        v.scrollTop = Math.min(this.rowY[r] - this.rowY[this.frozenRows], this.rowY[r + 1] - (v.clientHeight - this.headerH));
      }
    }
  }

  private hitTest(clientX: number, clientY: number): { r: number; c: number; area: 'cell' | 'col' | 'row' | 'corner' } {
    const rect = this.viewport.getBoundingClientRect();
    const vx = clientX - rect.left;
    const vy = clientY - rect.top;
    const x = vx - this.headerW;
    const y = vy - this.headerH;
    // Frozen panes do not scroll, everything else is offset by the scroll position.
    const cx = x < this.colX[this.frozenCols] ? x : x + this.viewport.scrollLeft;
    const cy = y < this.rowY[this.frozenRows] ? y : y + this.viewport.scrollTop;
    const c = locate(this.colX, this.source.colCount, Math.max(0, cx));
    const r = locate(this.rowY, this.source.rowCount, Math.max(0, cy));
    const area = vy < this.headerH ? (vx < this.headerW ? 'corner' : 'col') : vx < this.headerW ? 'row' : 'cell';
    return { r, c, area };
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button !== 0 || e.target === this.editor) {
      return;
    }
    // Clicks on the scrollbars land on the viewport itself, outside the client box.
    const rect = this.viewport.getBoundingClientRect();
    if (e.clientX - rect.left >= this.viewport.clientWidth || e.clientY - rect.top >= this.viewport.clientHeight) {
      return;
    }
    if (!this.source.rowCount || !this.source.colCount) {
      return;
    }
    this.commitEdit();
    const hit = this.hitTest(e.clientX, e.clientY);
    const lastRow = this.source.rowCount - 1;
    const lastCol = this.source.colCount - 1;

    if (hit.area === 'col') {
      const edge = this.resizeTarget(e.clientX);
      if (edge !== undefined) {
        e.preventDefault();
        this.startResize(edge, e.clientX);
        return;
      }
      this.anchor = { r: 0, c: e.shiftKey ? this.anchor.c : hit.c };
      this.active = { r: lastRow, c: hit.c };
    } else if (hit.area === 'row') {
      this.anchor = { r: e.shiftKey ? this.anchor.r : hit.r, c: 0 };
      this.active = { r: hit.r, c: lastCol };
    } else if (hit.area === 'corner') {
      this.anchor = { r: 0, c: 0 };
      this.active = { r: lastRow, c: lastCol };
    } else {
      this.select(hit.r, hit.c, e.shiftKey, false);
      this.dragging = true;
      const move = (ev: MouseEvent) => {
        if (!this.dragging) {
          return;
        }
        const next = this.hitTest(ev.clientX, ev.clientY);
        if (next.r !== this.active.r || next.c !== this.active.c) {
          this.select(next.r, next.c, true, true);
        }
      };
      const up = () => {
        this.dragging = false;
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }
    this.paintSelection();
    this.emitSelection();
    this.focus();
    e.preventDefault();
  }

  private onContextMenuEvent(e: MouseEvent): void {
    if (!this.opts.onContextMenu || !this.source.rowCount || !this.source.colCount || e.target === this.editor) {
      return;
    }
    e.preventDefault();
    this.commitEdit();
    const hit = this.hitTest(e.clientX, e.clientY);
    if (hit.area === 'corner') {
      return;
    }
    const sel = this.selection;
    const lastRow = this.source.rowCount - 1;
    const lastCol = this.source.colCount - 1;
    if (hit.area === 'row') {
      if (hit.r < sel.r0 || hit.r > sel.r1) {
        this.anchor = { r: hit.r, c: 0 };
        this.active = { r: hit.r, c: lastCol };
        this.paintSelection();
        this.emitSelection();
      }
    } else if (hit.area === 'col') {
      if (hit.c < sel.c0 || hit.c > sel.c1) {
        this.anchor = { r: 0, c: hit.c };
        this.active = { r: lastRow, c: hit.c };
        this.paintSelection();
        this.emitSelection();
      }
    } else if (hit.r < sel.r0 || hit.r > sel.r1 || hit.c < sel.c0 || hit.c > sel.c1) {
      this.select(hit.r, hit.c, false, false);
    }
    this.opts.onContextMenu(hit.area, hit.r, hit.c, e.clientX, e.clientY);
  }

  // ------------------------------------------------------------------ column resize

  private resizeTargetFromVx(vx: number): number | undefined {
    const x = vx - this.headerW;
    const frozenW = this.colX[this.frozenCols];
    const cx = x < frozenW ? x : x + this.viewport.scrollLeft;
    const c = locate(this.colX, this.source.colCount, Math.max(0, cx));
    if (this.colX[c + 1] - cx <= 4) {
      return c;
    }
    if (cx - this.colX[c] <= 4 && c > 0) {
      return c - 1;
    }
    return undefined;
  }

  /** Column whose right edge is under the pointer, if any. */
  private resizeTarget(clientX: number): number | undefined {
    const rect = this.viewport.getBoundingClientRect();
    return this.resizeTargetFromVx(clientX - rect.left);
  }

  /** Updates horizontal positions/widths of already mounted cells without destroying DOM nodes. */
  private repositionPool(): void {
    const colCount = this.source.colCount;
    for (const node of this.pool.values()) {
      if (node._kind === 'cell') {
        const cs = node._cs ?? 1;
        node.style.left = `${this.headerW + this.colX[node._c]}px`;
        node.style.width = `${this.colX[Math.min(colCount, node._c + cs)] - this.colX[node._c]}px`;
      } else if (node._kind === 'col') {
        node.style.left = `${this.headerW + this.colX[node._c]}px`;
        node.style.width = `${this.colX[node._c + 1] - this.colX[node._c]}px`;
      }
    }
    if (this.editor && this.editing) {
      const { r, c } = this.editing;
      const merge = this.mergeAnchors.get(`${r},${c}`);
      this.editor.style.left = `${this.headerW + this.colX[c]}px`;
      this.editor.style.width = `${Math.max(60, this.colX[Math.min(colCount, c + (merge?.cs ?? 1))] - this.colX[c])}px`;
    }
  }

  private startResize(col: number, startX: number): void {
    const startWidth = this.source.colWidths[col] ?? 80;
    let resizeFrame = 0;
    this.root.classList.add('grid-resizing');
    const flush = () => {
      resizeFrame = 0;
      this.measure();
      this.repositionPool();
      this.render();
    };
    const move = (ev: MouseEvent) => {
      const nextWidth = Math.max(MIN_COL_WIDTH, Math.round(startWidth + (ev.clientX - startX) / this.zoom));
      if (this.source.colWidths[col] === nextWidth) {
        return;
      }
      this.source.colWidths[col] = nextWidth;
      if (!resizeFrame) {
        resizeFrame = requestAnimationFrame(flush);
      }
    };
    const up = () => {
      if (resizeFrame) {
        cancelAnimationFrame(resizeFrame);
        flush();
      }
      this.root.classList.remove('grid-resizing');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.opts.onColumnResize?.(col, this.source.colWidths[col]);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  // ------------------------------------------------------------------ keyboard

  private onKeyDown(e: KeyboardEvent): void {
    if (this.editing || !this.source.rowCount) {
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const { r, c } = this.active;
    const lastRow = this.source.rowCount - 1;
    const lastCol = this.source.colCount - 1;
    const page = Math.max(1, Math.floor(this.viewport.clientHeight / ROW_HEIGHT) - 2);
    let handled = true;

    switch (e.key) {
      case 'ArrowUp':
        this.select(mod ? 0 : r - 1, c, e.shiftKey);
        break;
      case 'ArrowDown':
        this.select(mod ? lastRow : this.below(r, c), c, e.shiftKey);
        break;
      case 'ArrowLeft':
        this.select(r, mod ? 0 : c - 1, e.shiftKey);
        break;
      case 'ArrowRight':
        this.select(r, mod ? lastCol : this.rightOf(r, c), e.shiftKey);
        break;
      case 'PageUp':
        this.select(r - page, c, e.shiftKey);
        break;
      case 'PageDown':
        this.select(r + page, c, e.shiftKey);
        break;
      case 'Home':
        this.select(mod ? 0 : r, 0, e.shiftKey);
        break;
      case 'End':
        this.select(mod ? lastRow : r, lastCol, e.shiftKey);
        break;
      case 'Tab':
        this.select(r, e.shiftKey ? c - 1 : this.rightOf(r, c));
        break;
      case 'Enter':
      case 'F2':
        if (this.opts.editable) {
          this.startEdit();
        } else {
          this.select(this.below(r, c), c);
        }
        break;
      case 'Delete':
      case 'Backspace':
        this.clearSelection();
        break;
      default:
        handled = false;
        if (mod && e.key.toLowerCase() === 'a') {
          this.anchor = { r: 0, c: 0 };
          this.active = { r: lastRow, c: lastCol };
          this.paintSelection();
          this.emitSelection();
          handled = true;
        } else if (!mod && !e.altKey && !this.opts.editable && e.key.length === 1) {
          this.opts.onBlockedEdit?.();
        } else if (!mod && !e.altKey && this.opts.editable && (e.key.length === 1 || e.key === 'Process')) {
          // Typing replaces the cell content. Focus moves to the editor during keydown,
          // so the keystroke itself lands in the input.
          this.startEdit('');
          return;
        }
    }
    if (handled) {
      e.preventDefault();
    }
  }

  /** Next row below, skipping the rest of a merged cell. */
  private below(r: number, c: number): number {
    return r + (this.mergeAnchors.get(`${r},${c}`)?.rs ?? 1);
  }

  private rightOf(r: number, c: number): number {
    return c + (this.mergeAnchors.get(`${r},${c}`)?.cs ?? 1);
  }

  private clearSelection(): void {
    if (!this.opts.editable) {
      return;
    }
    const sel = this.selection;
    const changes: CellChange[] = [];
    for (let r = sel.r0; r <= sel.r1; r++) {
      for (let c = sel.c0; c <= sel.c1; c++) {
        const cell = this.source.cell(r, c);
        if (cellRaw(cell) !== '' && !(typeof cell === 'object' && cell?.ro)) {
          changes.push({ r, c, text: '' });
        }
      }
    }
    if (changes.length) {
      this.opts.onEdit(changes);
    }
  }

  // ------------------------------------------------------------------ clipboard

  private onCopy(e: ClipboardEvent, cut = false): void {
    if (this.editing || !e.clipboardData) {
      return;
    }
    const sel = this.selection;
    const lines: string[] = [];
    for (let r = sel.r0; r <= sel.r1; r++) {
      const cells: string[] = [];
      for (let c = sel.c0; c <= sel.c1; c++) {
        const text = cellText(this.source.cell(r, c));
        cells.push(/[\t\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
      }
      lines.push(cells.join('\t'));
    }
    e.clipboardData.setData('text/plain', lines.join('\n'));
    e.preventDefault();
    if (cut) {
      this.clearSelection();
    }
  }

  private onPaste(e: ClipboardEvent): void {
    if (this.editing || !this.opts.editable || !e.clipboardData) {
      return;
    }
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (!text) {
      return;
    }
    const rows = parseClipboard(text);
    const sel = this.selection;
    const changes: CellChange[] = [];
    let truncatedRows = false;
    rows.forEach((cells, i) => {
      const r = sel.r0 + i;
      if (r >= this.source.rowCount && !this.opts.canGrowRows) {
        truncatedRows = true;
        return;
      }
      cells.forEach((value, j) => {
        const c = sel.c0 + j;
        if (c >= this.source.colCount) {
          return;
        }
        const cell = this.source.cell(r, c);
        if (typeof cell === 'object' && cell?.ro) {
          return;
        }
        if (cellRaw(cell) !== value) {
          changes.push({ r, c, text: value });
        }
      });
    });
    if (changes.length) {
      this.opts.onEdit(changes);
    }
    if (truncatedRows) {
      this.opts.onPasteTruncated?.();
    }
  }

  // ------------------------------------------------------------------ editing

  /** Updates a single column's width in place without resetting scroll or selection. */
  setColumnWidth(col: number, width: number): void {
    if (col < 0 || col >= this.source.colCount) {
      return;
    }
    const clamped = Math.max(MIN_COL_WIDTH, Math.round(width));
    if (this.source.colWidths[col] === clamped) {
      return;
    }
    this.source.colWidths[col] = clamped;
    this.measure();
    this.repositionPool();
    this.render();
    this.opts.onColumnResize?.(col, clamped);
  }

  private onDoubleClick(e: MouseEvent): void {
    if (e.target === this.editor) {
      return;
    }
    if (this.source.colCount > 0) {
      const rect = this.viewport.getBoundingClientRect();
      const vx = e.clientX - rect.left;
      const vy = e.clientY - rect.top;
      if (vy >= 0 && vy < this.headerH && vx >= this.headerW) {
        const resizeCol = this.resizeTargetFromVx(vx);
        if (resizeCol !== undefined) {
          e.preventDefault();
          this.opts.onColumnAutoFit?.(resizeCol);
          return;
        }
      }
    }
    if (!this.opts.editable) {
      if (this.hitTest(e.clientX, e.clientY).area === 'cell') {
        this.opts.onBlockedEdit?.();
      }
      return;
    }
    const hit = this.hitTest(e.clientX, e.clientY);
    if (hit.area === 'cell') {
      this.startEdit();
    }
  }

  private layerOf(r: number, c: number): LayerName {
    const top = r < this.frozenRows;
    const left = c < this.frozenCols;
    return top && left ? 'corner' : top ? 'top' : left ? 'left' : 'body';
  }

  private startEdit(initial?: string): void {
    const { r, c } = this.active;
    const cell = this.source.cell(r, c);
    if (typeof cell === 'object' && cell?.ro) {
      this.opts.onReadonlyCell?.();
      return;
    }
    this.reveal(r, c);
    const merge = this.mergeAnchors.get(`${r},${c}`);
    // A textarea (not <input>) so multi-line values survive being edited.
    const input = document.createElement('textarea');
    input.className = 'grid-editor';
    input.rows = 1;
    input.wrap = 'off';
    input.spellcheck = false;
    input.value = initial ?? cellRaw(cell);
    const s = input.style;
    s.left = `${this.headerW + this.colX[c]}px`;
    s.top = `${this.headerH + this.rowY[r]}px`;
    s.width = `${Math.max(60, this.colX[Math.min(this.source.colCount, c + (merge?.cs ?? 1))] - this.colX[c])}px`;
    s.height = `${this.rowY[Math.min(this.source.rowCount, r + (merge?.rs ?? 1))] - this.rowY[r]}px`;
    this.layers[this.layerOf(r, c)].append(input);
    this.editor = input;
    this.editing = { r, c };

    input.addEventListener('keydown', (e) => {
      if (e.isComposing) {
        return;
      }
      if (e.key === 'Enter' && e.altKey) {
        // Alt+Enter: line break inside the cell, as in Excel.
        e.preventDefault();
        input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.commitEdit();
        this.select(e.shiftKey ? r - 1 : this.below(r, c), c);
        this.focus();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.commitEdit();
        this.select(r, e.shiftKey ? c - 1 : this.rightOf(r, c));
        this.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelEdit();
        this.focus();
      }
      e.stopPropagation();
    });
    input.addEventListener('input', () => this.opts.onEditorInput?.(input.value));
    input.addEventListener('blur', () => this.commitEdit());
    for (const type of ['copy', 'cut', 'paste', 'mousedown', 'dblclick'] as const) {
      input.addEventListener(type, (e) => e.stopPropagation());
    }
    input.focus({ preventScroll: true });
    if (initial === undefined) {
      input.select();
    }
  }

  private commitEdit(): void {
    const editing = this.editing;
    const input = this.editor;
    if (!editing || !input) {
      return;
    }
    this.editing = undefined;
    this.editor = undefined;
    const value = input.value;
    input.remove();
    if (value !== cellRaw(this.source.cell(editing.r, editing.c))) {
      this.opts.onEdit([{ r: editing.r, c: editing.c, text: value }]);
    }
  }

  private cancelEdit(): void {
    const input = this.editor;
    this.editing = undefined;
    this.editor = undefined;
    input?.remove();
  }
}

/** Tab-separated clipboard text (as produced by spreadsheets) into rows of cells. */
export function parseClipboard(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const n = text.length;
  for (;;) {
    let value = '';
    if (text[i] === '"') {
      i++;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q < 0) {
          value += text.slice(i);
          i = n;
          break;
        }
        value += text.slice(i, q);
        if (text[q + 1] === '"') {
          value += '"';
          i = q + 2;
          continue;
        }
        i = q + 1;
        break;
      }
    }
    let end = i;
    while (end < n && text[end] !== '\t' && text[end] !== '\n' && text[end] !== '\r') {
      end++;
    }
    value += text.slice(i, end);
    row.push(value);
    i = end;
    if (i >= n) {
      break;
    }
    if (text[i] === '\t') {
      i++;
      continue;
    }
    if (text[i] === '\r') {
      i++;
    }
    if (text[i] === '\n') {
      i++;
    }
    rows.push(row);
    row = [];
    if (i >= n) {
      // A trailing line break does not start another row.
      return rows;
    }
  }
  rows.push(row);
  return rows;
}
