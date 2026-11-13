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
    return { sheets: [{ name: this.name }], editable: true, canStructure: true };
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
    this.eol = eol;
    this.text = text;
    // Detect once: re-detecting after every edit could flip the delimiter mid-session.
    if (!this.parsed || !previous?.length) {
      this.delimiter =
        this.delimiterSetting && this.delimiterSetting !== 'auto'
          ? this.delimiterSetting
          : detectDelimiter(text, this.name);
    }
    this.records = parseCsv(text, this.delimiter);
    this.colCount = this.records.reduce((max, r) => Math.max(max, r.cells.length), 0);
    this.parsed = true;

    if (previous && previous.length === this.records.length && previousCols === this.colCount) {
      const rows: { r: number; cells: string[] }[] = [];
      for (let r = 0; r < previous.length && rows.length <= MAX_PATCH_ROWS; r++) {
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
