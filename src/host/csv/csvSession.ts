import type { CellChange, HostMessage, SheetModel, StructureOp, WorkbookInfo } from '../../common/protocol';
import {
  deleteCols,
  deleteRows,
  detectDelimiter,
  editCells,
  insertCols,
  insertRows,
  parseCsv,
  type CsvRecord,
  type TextEdit,
} from './csvParser';

/** At most this many changed rows are sent as a patch; beyond that the sheet is resent. */
const MAX_PATCH_ROWS = 2000;

function sameCells(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function findRecordAtOrBefore(records: CsvRecord[], offset: number): number {
  let lo = 0;
  let hi = records.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (records[mid].start <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

function findRecordAfter(records: CsvRecord[], offset: number, from: number): number {
  let lo = from;
  let hi = records.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (records[mid].start <= offset) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Holds the parsed state of one CSV text and converts table operations into text edits.
 * The owner applies those edits to the real document and feeds the new text back via
 * `setText`, which answers with the smallest message that brings the webview up to date.
 */
export class CsvSession {
  private text = '';
  private records: CsvRecord[] = [];
  private delimiter = ',';
  private colCount = 0;
  private parsed = false;

  constructor(
    private readonly name: string,
    /** A single character, or "auto". */
    private readonly delimiterSetting: string,
    private eol: string = '\n',
  ) {}

  get info(): WorkbookInfo {
    return { sheets: [{ name: this.name }], editable: true, canStructure: true, hasSource: true };
  }

  get currentText(): string {
    return this.text;
  }

  get currentDelimiter(): string {
    return this.delimiter;
  }

  setText(text: string, eol = this.eol): HostMessage {
    const previous = this.parsed ? this.records : undefined;
    const previousCols = this.colCount;
    const oldText = this.text;
    this.eol = eol;
    if (previous && text === oldText) {
      return { type: 'rows', index: 0, rowCount: this.records.length, colCount: this.colCount, rows: [] };
    }
    this.text = text;
    // Detect once: re-detecting after every edit could flip the delimiter mid-session.
    if (!this.parsed || !previous?.length) {
      this.delimiter =
        this.delimiterSetting && this.delimiterSetting !== 'auto'
          ? this.delimiterSetting
          : detectDelimiter(text, this.name);
    }

    let diffRowStart = 0;
    let diffRowEnd = 0;
    let usedIncremental = false;

    if (previous && previous.length >= 4 && text.length > 0) {
      const minLen = Math.min(oldText.length, text.length);
      let diffStart = 0;
      while (diffStart < minLen && oldText.charCodeAt(diffStart) === text.charCodeAt(diffStart)) {
        diffStart++;
      }
      let oldEnd = oldText.length;
      let newEnd = text.length;
      while (oldEnd > diffStart && newEnd > diffStart && oldText.charCodeAt(oldEnd - 1) === text.charCodeAt(newEnd - 1)) {
        oldEnd--;
        newEnd--;
      }
      const r0 = Math.max(0, findRecordAtOrBefore(previous, diffStart) - 1);
      const r1 = Math.min(previous.length, findRecordAfter(previous, oldEnd, r0 + 1) + 1);
      const sliceStart = previous[r0].start;
      const delta = text.length - oldText.length;
      const newSliceEnd = r1 < previous.length ? previous[r1].start + delta : text.length;
      const sub = text.slice(sliceStart, newSliceEnd);
      const mid = parseCsv(sub, this.delimiter);
      // If r1 < previous.length, the window ends with the untouched terminator before previous[r1].
      // An unclosed quote inside `sub` would swallow that terminator (`end === sub.length`); fall back then.
      if (r1 === previous.length || (mid.length > 0 && mid[mid.length - 1].end < sub.length)) {
        for (const rec of mid) {
          rec.start += sliceStart;
          rec.end += sliceStart;
        }
        const tail: CsvRecord[] = new Array(previous.length - r1);
        for (let i = r1; i < previous.length; i++) {
          const rec = previous[i];
          tail[i - r1] = { start: rec.start + delta, end: rec.end + delta, cells: rec.cells };
        }
        this.records = [...previous.slice(0, r0), ...mid, ...tail];
        let removedMax = 0;
        for (let i = r0; i < r1; i++) {
          removedMax = Math.max(removedMax, previous[i].cells.length);
        }
        const midMax = mid.reduce((max, r) => Math.max(max, r.cells.length), 0);
        if (removedMax < previousCols || midMax >= previousCols) {
          this.colCount = Math.max(previousCols, midMax);
        } else {
          this.colCount = this.records.reduce((max, r) => Math.max(max, r.cells.length), 0);
        }
        diffRowStart = r0;
        diffRowEnd = r0 + mid.length;
        usedIncremental = true;
      }
    }

    if (!usedIncremental) {
      this.records = parseCsv(text, this.delimiter);
      this.colCount = this.records.reduce((max, r) => Math.max(max, r.cells.length), 0);
      diffRowStart = 0;
      diffRowEnd = this.records.length;
    }
    this.parsed = true;

    if (previous && previous.length === this.records.length && previousCols === this.colCount) {
      const rows: { r: number; cells: string[] }[] = [];
      for (let r = diffRowStart; r < diffRowEnd && rows.length <= MAX_PATCH_ROWS; r++) {
        if (!sameCells(previous[r].cells, this.records[r].cells)) {
          rows.push({ r, cells: this.records[r].cells });
        }
      }
      if (rows.length <= MAX_PATCH_ROWS) {
        return { type: 'rows', index: 0, rowCount: this.records.length, colCount: this.colCount, rows };
      }
    }
    return { type: 'sheet', index: 0, model: this.model() };
  }

  model(): SheetModel {
    return {
      name: this.name,
      rowCount: this.records.length,
      colCount: this.colCount,
      rows: this.records.map((r) => r.cells),
    };
  }

  private get ctx() {
    return { text: this.text, records: this.records, delimiter: this.delimiter, eol: this.eol };
  }

  editCells(changes: CellChange[]): TextEdit[] {
    return editCells(this.ctx, changes);
  }

  structure(op: StructureOp, at: number, count: number): TextEdit[] {
    switch (op) {
      case 'insertRow':
        return insertRows(this.ctx, at, count, this.colCount);
      case 'deleteRows':
        return deleteRows(this.ctx, at, count);
      case 'insertCol':
        return insertCols(this.ctx, at, count);
      case 'deleteCols':
        return deleteCols(this.ctx, at, count);
    }
  }
}
