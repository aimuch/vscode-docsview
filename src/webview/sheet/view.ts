// Sort and filter for the table view. They only change which rows are shown and in what
// order; the file itself is never reordered. Pure module.
import type { Cell } from '../../common/protocol';

export interface SheetView {
  sortCol?: number;
  /** 1 ascending, -1 descending. */
  sortDir?: 1 | -1;
  /** Column → text the cell must contain (case-insensitive). */
  filters: Record<number, string>;
  /** Keep the first row in place (a header). Ignored when the sheet has frozen rows. */
  headerRow: boolean;
}

export function emptyView(): SheetView {
  return { filters: {}, headerRow: true };
}

export function isActive(view: SheetView): boolean {
  return view.sortCol !== undefined || Object.values(view.filters).some((q) => q.trim() !== '');
}

const text = (cell: Cell | undefined): string => (cell == null ? '' : typeof cell === 'string' ? cell : cell.v);
const raw = (cell: Cell | undefined): string =>
  cell == null ? '' : typeof cell === 'string' ? cell : (cell.raw ?? cell.v);

/** Numeric value of a cell for sorting ("1,299.50", "¥15,594.00", "87.65%"), or undefined. */
export function numericValue(cell: Cell | undefined): number | undefined {
  const source = raw(cell).trim();
  if (!source || source.startsWith('=')) {
    // A formula sorts by its displayed result.
    return source.startsWith('=') ? numericValue(text(cell)) : undefined;
  }
  const percent = source.endsWith('%');
  const cleaned = source.replace(/[,\s¥$€£%]/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(cleaned)) {
    return undefined;
  }
  const value = Number(cleaned);
  return percent ? value / 100 : value;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Order of two cells: numbers numerically, then text naturally; empty cells always last. */
export function compareCells(a: Cell | undefined, b: Cell | undefined, dir: 1 | -1): number {
  const ta = text(a).trim();
  const tb = text(b).trim();
  if (!ta || !tb) {
    return !ta && !tb ? 0 : !ta ? 1 : -1;
  }
  const na = numericValue(a);
  const nb = numericValue(b);
  if (na !== undefined && nb !== undefined) {
    return (na - nb) * dir;
  }
  if (na !== undefined || nb !== undefined) {
    // Numbers before text in ascending order.
    return (na !== undefined ? -1 : 1) * dir;
  }
  return collator.compare(ta, tb) * dir;
}

/**
 * Source row indices to show, in order. Rows before `fixed` (headers) keep their place;
 * only the `dataRows` rows that hold data are sorted and filtered (padding rows are dropped).
 */
export function viewRows(rows: Cell[][], dataRows: number, fixed: number, view: SheetView): number[] {
  const head: number[] = [];
  for (let r = 0; r < Math.min(fixed, dataRows); r++) {
    head.push(r);
  }
  let body: number[] = [];
  for (let r = head.length; r < dataRows; r++) {
    body.push(r);
  }
  const filters = Object.entries(view.filters)
    .filter(([, q]) => q.trim() !== '')
    .map(([c, q]) => [Number(c), q.trim().toLowerCase()] as const);
  if (filters.length) {
    body = body.filter((r) => filters.every(([c, q]) => text(rows[r]?.[c]).toLowerCase().includes(q)));
  }
  if (view.sortCol !== undefined) {
    const c = view.sortCol;
    const dir = view.sortDir ?? 1;
    // Precompute sort keys once per row (Schwartzian transform) instead of re-parsing in O(n log n) comparisons.
    const keyed = body.map((r, i) => {
      const cell = rows[r]?.[c];
      const t = text(cell).trim();
      return { r, i, empty: !t, num: t ? numericValue(cell) : undefined, str: t };
    });
    keyed.sort((x, y) => {
      if (x.empty || y.empty) {
        return x.empty && y.empty ? x.i - y.i : x.empty ? 1 : -1;
      }
      if (x.num !== undefined && y.num !== undefined) {
        return (x.num - y.num) * dir || x.i - y.i;
      }
      if (x.num !== undefined || y.num !== undefined) {
        return (x.num !== undefined ? -1 : 1) * dir;
      }
      return collator.compare(x.str, y.str) * dir || x.i - y.i;
    });
    body = keyed.map((x) => x.r);
  }
  return [...head, ...body];
}
