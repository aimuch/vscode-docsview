// Sort, multi-value/numeric filters, conditional formatting, JSON export and series autofill
// for the table view. Pure module (zero DOM dependencies).
import type { Cell, CellChange } from '../../common/protocol';

export type NumFilterOp = '>' | '>=' | '<' | '<=' | '=' | 'between' | 'topN';

export interface NumFilter {
  op: NumFilterOp;
  a: number;
  b?: number;
}

export type CondFormatKind = 'none' | 'bar' | 'heat';

export interface SheetView {
  sortCol?: number;
  /** 1 ascending, -1 descending. */
  sortDir?: 1 | -1;
  /** Column → text the cell must contain (case-insensitive). */
  filters: Record<number, string>;
  /** Column → exact trimmed cell values allowed (`''` = blanks). `undefined` = all values allowed. */
  valueFilters?: Record<number, string[] | undefined>;
  /** Column → exact trimmed cell values excluded (used when unchecking from a >200-unique list). */
  excludedValues?: Record<number, string[] | undefined>;
  /** Column → numeric comparison filter. */
  numFilters?: Record<number, NumFilter | undefined>;
  /** Keep the first row in place (a header). Ignored when the sheet has frozen rows. */
  headerRow: boolean;
}

export function emptyView(): SheetView {
  return { filters: {}, valueFilters: {}, excludedValues: {}, numFilters: {}, headerRow: true };
}

export function hasColumnFilter(view: SheetView, col: number): boolean {
  if (view.filters[col]?.trim()) {
    return true;
  }
  if (view.valueFilters?.[col] !== undefined) {
    return true;
  }
  if (view.excludedValues?.[col]?.length) {
    return true;
  }
  if (view.numFilters?.[col] !== undefined) {
    return true;
  }
  return false;
}

export function hasAnyFilter(view: SheetView): boolean {
  if (Object.values(view.filters).some((q) => q.trim() !== '')) {
    return true;
  }
  if (view.valueFilters && Object.values(view.valueFilters).some((v) => v !== undefined)) {
    return true;
  }
  if (view.excludedValues && Object.values(view.excludedValues).some((v) => Boolean(v?.length))) {
    return true;
  }
  if (view.numFilters && Object.values(view.numFilters).some((v) => v !== undefined)) {
    return true;
  }
  return false;
}

export function isActive(view: SheetView): boolean {
  return view.sortCol !== undefined || hasAnyFilter(view);
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
  const textFilters = Object.entries(view.filters)
    .filter(([, q]) => q.trim() !== '')
    .map(([c, q]) => [Number(c), q.trim().toLowerCase()] as const);
  if (textFilters.length) {
    body = body.filter((r) => textFilters.every(([c, q]) => text(rows[r]?.[c]).toLowerCase().includes(q)));
  }
  if (view.valueFilters) {
    const valSets = Object.entries(view.valueFilters)
      .filter(([, arr]) => arr !== undefined)
      .map(([c, arr]) => [Number(c), new Set(arr!)] as const);
    if (valSets.length) {
      body = body.filter((r) => valSets.every(([c, set]) => set.has(text(rows[r]?.[c]).trim())));
    }
  }
  if (view.excludedValues) {
    const exSets = Object.entries(view.excludedValues)
      .filter(([, arr]) => Boolean(arr?.length))
      .map(([c, arr]) => [Number(c), new Set(arr!)] as const);
    if (exSets.length) {
      body = body.filter((r) => exSets.every(([c, set]) => !set.has(text(rows[r]?.[c]).trim())));
    }
  }
  if (view.numFilters) {
    const numEntries = Object.entries(view.numFilters)
      .filter(([, nf]) => nf !== undefined)
      .map(([c, nf]) => [Number(c), nf!] as const);
    for (const [c, nf] of numEntries) {
      if (nf.op === 'topN') {
        const limit = Math.max(1, Math.floor(nf.a));
        const ranked = body
          .map((r) => ({ r, n: numericValue(rows[r]?.[c]) }))
          .filter((x): x is { r: number; n: number } => x.n !== undefined && Number.isFinite(x.n))
          .sort((x, y) => y.n - x.n || x.r - y.r)
          .slice(0, limit);
        const keep = new Set(ranked.map((x) => x.r));
        body = body.filter((r) => keep.has(r));
      } else {
        body = body.filter((r) => {
          const n = numericValue(rows[r]?.[c]);
          if (n === undefined || !Number.isFinite(n)) {
            return false;
          }
          switch (nf.op) {
            case '>':
              return n > nf.a;
            case '>=':
              return n >= nf.a;
            case '<':
              return n < nf.a;
            case '<=':
              return n <= nf.a;
            case '=':
              return Math.abs(n - nf.a) < 1e-9;
            case 'between': {
              const lo = Math.min(nf.a, nf.b ?? nf.a);
              const hi = Math.max(nf.a, nf.b ?? nf.a);
              return n >= lo && n <= hi;
            }
          }
        });
      }
    }
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

/** Collects distinct trimmed cell values and occurrence counts in column `col` across data rows. */
export function collectColumnUniqueValues(
  rows: Cell[][],
  dataRows: number,
  fixed: number,
  col: number,
  maxUnique = 400,
): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (let r = Math.min(fixed, dataRows); r < dataRows; r++) {
    const v = text(rows[r]?.[col]).trim();
    if (!counts.has(v) && counts.size >= maxUnique) {
      continue;
    }
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const items = Array.from(counts.entries()).map(([value, count]) => ({ value, count }));
  items.sort((a, b) => {
    if (a.value === '' || b.value === '') {
      return a.value === b.value ? 0 : a.value === '' ? -1 : 1;
    }
    return compareCells(a.value, b.value, 1);
  });
  return items;
}

export interface SelectionStats {
  count: number;
  numCount: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
}

/**
 * Aggregates non-empty cell count and numeric SUM / AVG / MIN / MAX across a rectangular
 * selection `[r0..r1] x [c0..c1]` (capped to `maxCells` so full-sheet Ctrl+A stays O(1) instant).
 */
export function computeSelectionStats(
  cellAt: (r: number, c: number) => Cell | undefined,
  r0: number,
  c0: number,
  r1: number,
  c1: number,
  maxCells = 200_000,
  populatedRowBound?: number,
  rowLengthAt?: (r: number) => number,
): SelectionStats | undefined {
  const totalSelected = (r1 - r0 + 1) * (c1 - c0 + 1);
  if (totalSelected < 2) {
    return undefined;
  }
  const effectiveR1 = populatedRowBound !== undefined ? Math.min(r1, populatedRowBound - 1) : r1;
  if (effectiveR1 < r0) {
    return undefined;
  }
  let count = 0;
  let numCount = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let visited = 0;
  outer: for (let r = r0; r <= effectiveR1; r++) {
    const rowEndC = rowLengthAt ? Math.min(c1, rowLengthAt(r) - 1) : c1;
    for (let c = c0; c <= rowEndC; c++) {
      if (++visited > maxCells) {
        break outer;
      }
      const cell = cellAt(r, c);
      const t = text(cell).trim();
      if (!t) {
        continue;
      }
      count++;
      const n = numericValue(cell);
      if (n !== undefined && Number.isFinite(n)) {
        numCount++;
        sum += n;
        if (n < min) min = n;
        if (n > max) max = n;
      }
    }
  }
  if (count === 0) {
    return undefined;
  }
  return {
    count,
    numCount,
    sum,
    avg: numCount > 0 ? sum / numCount : 0,
    min: numCount > 0 ? min : 0,
    max: numCount > 0 ? max : 0,
  };
}

function escapeMdCell(rawVal: string): string {
  return rawVal.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
}

/**
 * Formats a rectangular sheet selection `[r0..r1] x [c0..c1]` as a GitHub-Flavored Markdown table,
 * automatically right-aligning (`---:`) columns whose body cells are numeric.
 */
export function selectionToMarkdownTable(
  cellAt: (r: number, c: number) => Cell | undefined,
  r0: number,
  c0: number,
  r1: number,
  c1: number,
  maxRows = 5_000,
): string {
  const endR = Math.min(r1, r0 + maxRows - 1);
  const cols = c1 - c0 + 1;
  if (cols <= 0 || endR < r0) {
    return '';
  }
  const headCells: string[] = [];
  for (let c = c0; c <= c1; c++) {
    headCells.push(escapeMdCell(text(cellAt(r0, c))));
  }

  const sepCells: string[] = [];
  for (let c = c0; c <= c1; c++) {
    let nonEmpty = 0;
    let allNum = true;
    for (let r = r0 + 1; r <= endR; r++) {
      const cell = cellAt(r, c);
      if (!text(cell).trim()) {
        continue;
      }
      nonEmpty++;
      if (numericValue(cell) === undefined) {
        allNum = false;
        break;
      }
    }
    sepCells.push(nonEmpty > 0 && allNum ? '---:' : '---');
  }

  const lines: string[] = [
    `| ${headCells.join(' | ')} |`,
    `| ${sepCells.join(' | ')} |`,
  ];

  for (let r = r0 + 1; r <= endR; r++) {
    const rowCells: string[] = [];
    for (let c = c0; c <= c1; c++) {
      rowCells.push(escapeMdCell(text(cellAt(r, c))));
    }
    lines.push(`| ${rowCells.join(' | ')} |`);
  }
  return lines.join('\n');
}

function parseJsonScalar(cell: Cell | undefined): unknown {
  const s = text(cell).trim();
  if (!s) {
    return null;
  }
  if (s === 'true') {
    return true;
  }
  if (s === 'false') {
    return false;
  }
  if (/^[+-]?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try {
      return JSON.parse(s);
    } catch {
      // keep as string
    }
  }
  return text(cell);
}

/**
 * Formats a rectangular sheet selection as JSON:
 * - Multi-row selection (`r1 > r0`): array of objects keyed by `r0` header names.
 * - Single-row selection (`r1 === r0`): array of typed scalar values.
 */
export function selectionToJson(
  cellAt: (r: number, c: number) => Cell | undefined,
  r0: number,
  c0: number,
  r1: number,
  c1: number,
  maxRows = 5_000,
): string {
  const endR = Math.min(r1, r0 + maxRows - 1);
  if (c1 < c0 || endR < r0) {
    return '';
  }
  if (endR === r0) {
    const values: unknown[] = [];
    for (let c = c0; c <= c1; c++) {
      values.push(parseJsonScalar(cellAt(r0, c)));
    }
    return JSON.stringify(values, null, 2);
  }
  const keys: string[] = [];
  const used = new Set<string>();
  for (let c = c0; c <= c1; c++) {
    const base = text(cellAt(r0, c)).trim() || `col_${c - c0 + 1}`;
    let key = base;
    let suffix = 2;
    while (used.has(key)) {
      key = `${base}_${suffix++}`;
    }
    used.add(key);
    keys.push(key);
  }
  const records: Record<string, unknown>[] = [];
  for (let r = r0 + 1; r <= endR; r++) {
    const obj: Record<string, unknown> = {};
    for (let c = c0; c <= c1; c++) {
      obj[keys[c - c0]] = parseJsonScalar(cellAt(r, c));
    }
    records.push(obj);
  }
  return JSON.stringify(records, null, 2);
}

function colLettersToIndex(letters: string): number {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.toUpperCase().charCodeAt(i) - 64);
  }
  return idx - 1;
}

function colIndexToLetters(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

/**
 * Shifts unanchored (`$`) A1 cell references in a formula by `(dr, dc)`, skipping string
 * literals (`"..."`) and sheet prefixes (`Sheet1!` or `'Sales Q1'!`) so cross-sheet names
 * like `=Q1!A2` never mutate into `=Q2!A3`.
 */
export function shiftFormulaRefs(formula: string, dr: number, dc: number): string {
  if (!formula.startsWith('=') || (dr === 0 && dc === 0)) {
    return formula;
  }
  let out = '=';
  let i = 1;
  const len = formula.length;
  while (i < len) {
    const ch = formula[i];
    if (ch === '"') {
      let end = i + 1;
      while (end < len) {
        if (formula[end] === '"') {
          if (formula[end + 1] === '"') {
            end += 2;
            continue;
          }
          end++;
          break;
        }
        end++;
      }
      out += formula.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "'") {
      let end = i + 1;
      while (end < len) {
        if (formula[end] === "'") {
          if (formula[end + 1] === "'") {
            end += 2;
            continue;
          }
          end++;
          break;
        }
        end++;
      }
      out += formula.slice(i, end);
      i = end;
      continue;
    }
    const prev = i > 1 ? formula[i - 1] : '';
    if (!/[A-Za-z0-9_.]/.test(prev)) {
      const m = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d*)/.exec(formula.slice(i));
      if (m) {
        const afterIdx = i + m[0].length;
        const nextCh = afterIdx < len ? formula[afterIdx] : '';
        if (!/[A-Za-z0-9_(!]/.test(nextCh)) {
          const [, absC, col, absR, row] = m;
          const nextC = absC ? colLettersToIndex(col) : Math.max(0, colLettersToIndex(col) + dc);
          const nextR = absR ? Number(row) : Math.max(1, Number(row) + dr);
          out += `${absC}${colIndexToLetters(nextC)}${absR}${nextR}`;
          i = afterIdx;
          continue;
        }
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function parseIsoDateUtc(rawStr: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rawStr.trim());
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return undefined;
  }
  return dt.getTime();
}

function formatIsoDateUtc(ms: number): string {
  const dt = new Date(ms);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function extrapolateSeries(values: string[], stepOffset: number, drPerStep: number, dcPerStep: number): string {
  const n = values.length;
  if (n === 0) {
    return '';
  }
  const baseIdx = ((stepOffset % n) + n) % n;
  const baseVal = values[baseIdx];
  const cycles = Math.floor(stepOffset / n);

  // 1. Formulas: shift relative A1 references from the corresponding source cell.
  if (baseVal.startsWith('=')) {
    const deltaSteps = stepOffset - baseIdx;
    return shiftFormulaRefs(baseVal, deltaSteps * drPerStep, deltaSteps * dcPerStep);
  }

  // 2. ISO calendar dates (YYYY-MM-DD): advance real calendar days ("2026-01-30" -> "2026-01-31", "2026-02-01").
  const baseDateMs = parseIsoDateUtc(baseVal);
  if (baseDateMs !== undefined) {
    const DAY = 86_400_000;
    if (n >= 2) {
      const parsedAll = values.map(parseIsoDateUtc);
      if (parsedAll.every((v): v is number => v !== undefined)) {
        const dayStep = Math.round((parsedAll[n - 1] - parsedAll[0]) / DAY / (n - 1));
        return formatIsoDateUtc(parsedAll[0] + stepOffset * dayStep * DAY);
      }
    }
    return formatIsoDateUtc(baseDateMs + cycles * DAY);
  }

  // 3. Multi-cell numeric progression (e.g. [1, 2] -> 3, 4 or [10, 20] -> 30).
  if (n >= 2 && values.every((v) => v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v.trim()))) {
    const nums = values.map((v) => Number(v.trim()));
    const diff = (nums[n - 1] - nums[0]) / (n - 1);
    const val = nums[0] + diff * stepOffset;
    const rounded = Math.abs(val - Math.round(val)) < 1e-9 ? Math.round(val) : Number(val.toFixed(8));
    return String(rounded);
  }

  // 3. Strings ending in an integer (e.g. "Item 1" -> "Item 2", "ID-001" -> "ID-002", "2026-01-01" -> "2026-01-02").
  const suffixMatch = /^(.*?)(\d+)$/.exec(baseVal);
  if (suffixMatch && suffixMatch[1].trim() !== '-' && !/^\d+$/.test(baseVal.trim())) {
    const [, prefix, digits] = suffixMatch;
    let step = 1;
    if (n >= 2) {
      const m0 = /^(.*?)(\d+)$/.exec(values[0]);
      const mLast = /^(.*?)(\d+)$/.exec(values[n - 1]);
      if (m0 && mLast && m0[1] === mLast[1]) {
        step = (Number(mLast[2]) - Number(m0[2])) / (n - 1);
        const target = Math.round(Number(m0[2]) + step * stepOffset);
        const formatted = target >= 0 ? String(target).padStart(m0[2].length, '0') : String(target);
        return `${m0[1]}${formatted}`;
      }
    }
    const target = Number(digits) + cycles * step;
    const formatted = target >= 0 ? String(target).padStart(digits.length, '0') : String(target);
    return `${prefix}${formatted}`;
  }

  // 4. Default: cyclic repetition.
  return baseVal;
}

/**
 * Computes `CellChange[]` when dragging the fill handle from `src` to expanded `dst`
 * (either vertically or horizontally).
 */
export function computeAutoFillChanges(
  cellRawAt: (r: number, c: number) => string,
  src: { r0: number; c0: number; r1: number; c1: number },
  dst: { r0: number; c0: number; r1: number; c1: number },
): CellChange[] {
  const changes: CellChange[] = [];
  const srcH = src.r1 - src.r0 + 1;
  const srcW = src.c1 - src.c0 + 1;
  if (dst.r0 < src.r0 || dst.r1 > src.r1) {
    // Vertical autofill per column
    for (let c = src.c0; c <= src.c1; c++) {
      const colVals: string[] = [];
      for (let r = src.r0; r <= src.r1; r++) {
        colVals.push(cellRawAt(r, c));
      }
      for (let r = dst.r0; r <= dst.r1; r++) {
        if (r >= src.r0 && r <= src.r1) {
          continue;
        }
        const offset = r - src.r0;
        changes.push({ r, c, text: extrapolateSeries(colVals, offset, 1, 0) });
      }
    }
  } else if (dst.c0 < src.c0 || dst.c1 > src.c1) {
    // Horizontal autofill per row
    for (let r = src.r0; r <= src.r1; r++) {
      const rowVals: string[] = [];
      for (let c = src.c0; c <= src.c1; c++) {
        rowVals.push(cellRawAt(r, c));
      }
      for (let c = dst.c0; c <= dst.c1; c++) {
        if (c >= src.c0 && c <= src.c1) {
          continue;
        }
        const offset = c - src.c0;
        changes.push({ r, c, text: extrapolateSeries(rowVals, offset, 0, 1) });
      }
    }
  }
  void srcH;
  void srcW;
  return changes;
}

/** Precomputes `[min, max]` numeric bounds for a column across displayed body rows. */
export function computeColumnNumericBounds(
  rows: Cell[][],
  rowMap: number[] | undefined,
  fixed: number,
  col: number,
): { min: number; max: number } | undefined {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  const total = rowMap ? rowMap.length : rows.length;
  for (let r = fixed; r < total; r++) {
    const srcR = rowMap ? rowMap[r] : r;
    const n = numericValue(rows[srcR]?.[col]);
    if (n !== undefined && Number.isFinite(n)) {
      if (n < min) min = n;
      if (n > max) max = n;
      count++;
    }
  }
  return count > 0 ? { min, max } : undefined;
}

/** Builds a CSS `background-image` gradient for Data Bars or 3-colour Red-Yellow-Green Color Scales. */
export function condFormatGradient(
  kind: CondFormatKind,
  val: number | undefined,
  bounds: { min: number; max: number } | undefined,
): string | undefined {
  if (kind === 'none' || val === undefined || !Number.isFinite(val) || !bounds) {
    return undefined;
  }
  if (kind === 'bar') {
    const base = Math.min(0, bounds.min);
    const span = bounds.max - base;
    const pct = span > 0 ? Math.max(0, Math.min(100, ((val - base) / span) * 100)) : val > 0 ? 100 : 0;
    if (pct <= 0) {
      return undefined;
    }
    return `linear-gradient(90deg, rgba(59, 130, 246, 0.28) 0%, rgba(59, 130, 246, 0.28) ${pct.toFixed(1)}%, transparent ${pct.toFixed(1)}%)`;
  }
  // 'heat': Red (239,68,68) -> Yellow (234,179,8) -> Green (34,197,94)
  const span = bounds.max - bounds.min;
  const ratio = span > 0 ? Math.max(0, Math.min(1, (val - bounds.min) / span)) : 0.5;
  let r: number;
  let g: number;
  let b: number;
  if (ratio < 0.5) {
    const k = ratio * 2;
    r = Math.round(239 + (234 - 239) * k);
    g = Math.round(68 + (179 - 68) * k);
    b = Math.round(68 + (8 - 68) * k);
  } else {
    const k = (ratio - 0.5) * 2;
    r = Math.round(234 + (34 - 234) * k);
    g = Math.round(179 + (197 - 179) * k);
    b = Math.round(8 + (94 - 8) * k);
  }
  return `linear-gradient(rgba(${r}, ${g}, ${b}, 0.25), rgba(${r}, ${g}, ${b}, 0.25))`;
}
