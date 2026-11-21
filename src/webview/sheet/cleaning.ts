// Pure spreadsheet data-cleaning helpers: deduplicate rows, split column by delimiter,
// batch trim whitespace, and UPPERCASE / lowercase / Title Case text transforms.
import type { Cell, CellChange } from '../../common/protocol';

const cellStr = (c: Cell | undefined): string => (c == null ? '' : typeof c === 'string' ? c : c.v);

/** Returns 0-based row indices (in descending order) that are duplicates of an earlier row on `keyCols`. */
export function findDuplicateRowIndices(
  rows: readonly Cell[][],
  fixedRows: number,
  keyCols: readonly number[],
): number[] {
  if (!keyCols.length) {
    return [];
  }
  const seen = new Set<string>();
  const duplicates: number[] = [];
  for (let r = Math.max(0, fixedRows); r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => cellStr(c).trim() === '')) {
      continue;
    }
    const key = keyCols.map((c) => cellStr(row[c]).trim()).join('\u0001');
    if (seen.has(key)) {
      duplicates.push(r);
    } else {
      seen.add(key);
    }
  }
  return duplicates.reverse();
}

/** Splits values in column `col` by `delimiter`, returning max extra columns needed and cell edits. */
export function computeSplitColumn(
  rows: readonly Cell[][],
  fixedRows: number,
  col: number,
  delimiter: string,
): { extraCols: number; changes: CellChange[] } {
  if (!delimiter) {
    return { extraCols: 0, changes: [] };
  }
  const MAX_EXTRA = 20;
  let maxParts = 1;
  const splitRows: { r: number; parts: string[] }[] = [];
  for (let r = Math.max(0, fixedRows); r < rows.length; r++) {
    const cell = rows[r]?.[col];
    // Never overwrite formula cells or read-only cells
    if (cell && typeof cell === 'object' && (cell.ro || cell.raw?.startsWith('='))) {
      continue;
    }
    const raw = cellStr(cell);
    if (!raw || !raw.includes(delimiter)) {
      continue;
    }
    const parts = raw.split(delimiter).map((p) => p.trim());
    if (parts.length > maxParts) {
      maxParts = parts.length;
    }
    splitRows.push({ r, parts });
  }
  const extraCols = Math.max(0, Math.min(MAX_EXTRA, maxParts - 1));
  if (extraCols === 0) {
    return { extraCols: 0, changes: [] };
  }
  const changes: CellChange[] = [];
  const maxCols = extraCols + 1;
  for (const { r, parts } of splitRows) {
    for (let i = 0; i < Math.min(parts.length, maxCols); i++) {
      // Keep any overflow segments joined in the last column instead of silently dropping data
      const text = i === maxCols - 1 && parts.length > maxCols ? parts.slice(i).join(delimiter) : parts[i];
      changes.push({ r, c: col + i, text });
    }
  }
  return { extraCols, changes };
}

export type TextCleanMode = 'trim' | 'upper' | 'lower' | 'title';

function toTitleCase(s: string): string {
  return s.replace(/\b([A-Za-z])([A-Za-z]*)/g, (_, first: string, rest: string) => first.toUpperCase() + rest.toLowerCase());
}

/** Computes cell edits for trimming or changing case across selection `[r0..r1] x [c0..c1]`, preserving formulas. */
export function computeSelectionTextClean(
  cellRawAt: (r: number, c: number) => string,
  r0: number,
  c0: number,
  r1: number,
  c1: number,
  mode: TextCleanMode,
): CellChange[] {
  const changes: CellChange[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const raw = cellRawAt(r, c);
      if (!raw || raw.startsWith('=')) {
        continue;
      }
      const next =
        mode === 'trim'
          ? raw.trim().replace(/\s{2,}/g, ' ')
          : mode === 'upper'
            ? raw.toUpperCase()
            : mode === 'lower'
              ? raw.toLowerCase()
              : toTitleCase(raw);
      if (next !== raw) {
        changes.push({ r, c, text: next });
      }
    }
  }
  return changes;
}
