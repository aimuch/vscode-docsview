// Pure structural diff helpers for spreadsheets (XLSX/CSV/JSONL) and documents (DOCX/PPTX).
import { diffLineArrays, type LineDiffItem } from './textDiff';

export interface SheetCellDiff {
  sheet: string;
  r: number;
  c: number;
  addr: string;
  before: string;
  after: string;
}

export interface DocumentDiffReport {
  kind: 'paragraphs' | 'cells';
  baseLabel: string;
  currentLabel: string;
  addedCount: number;
  removedCount: number;
  changedCount: number;
  lines?: LineDiffItem[];
  cells?: SheetCellDiff[];
  truncated?: boolean;
}

function colLetters(c: number): string {
  let n = c + 1;
  let out = '';
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || 'A';
}

export function buildParagraphDiff(
  baseLabel: string,
  currentLabel: string,
  before: readonly string[],
  after: readonly string[],
): DocumentDiffReport {
  const all = diffLineArrays(before, after);
  let addedCount = 0;
  let removedCount = 0;
  for (const item of all) {
    if (item.kind === 'add') addedCount++;
    else if (item.kind === 'del') removedCount++;
  }
  return {
    kind: 'paragraphs',
    baseLabel,
    currentLabel,
    addedCount,
    removedCount,
    changedCount: addedCount + removedCount,
    lines: all,
  };
}

export function buildSheetsDiff(
  baseLabel: string,
  currentLabel: string,
  beforeSheets: readonly { name: string; rows: readonly (readonly string[])[] }[],
  afterSheets: readonly { name: string; rows: readonly (readonly string[])[] }[],
  maxDiffs = 2000,
): DocumentDiffReport {
  const beforeMap = new Map(beforeSheets.map((s) => [s.name, s.rows]));
  const afterMap = new Map(afterSheets.map((s) => [s.name, s.rows]));
  const names = [...new Set([...beforeSheets.map((s) => s.name), ...afterSheets.map((s) => s.name)])];

  const cells: SheetCellDiff[] = [];
  let addedCount = 0;
  let removedCount = 0;
  let changedCount = 0;
  let truncated = false;

  for (const name of names) {
    const bRows = beforeMap.get(name) ?? [];
    const aRows = afterMap.get(name) ?? [];
    const maxR = Math.max(bRows.length, aRows.length);
    for (let r = 0; r < maxR; r++) {
      const br = bRows[r] ?? [];
      const ar = aRows[r] ?? [];
      const maxC = Math.max(br.length, ar.length);
      for (let c = 0; c < maxC; c++) {
        const bv = br[c] ?? '';
        const av = ar[c] ?? '';
        if (bv === av) continue;
        if (!bv && av) addedCount++;
        else if (bv && !av) removedCount++;
        else changedCount++;
        if (cells.length < maxDiffs) {
          cells.push({
            sheet: name,
            r,
            c,
            addr: `${colLetters(c)}${r + 1}`,
            before: bv,
            after: av,
          });
        } else {
          truncated = true;
        }
      }
    }
  }

  return {
    kind: 'cells',
    baseLabel,
    currentLabel,
    addedCount,
    removedCount,
    changedCount,
    cells,
    truncated,
  };
}
