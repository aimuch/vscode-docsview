import type { Cell, CellChange, CellObject, HostMessage, SheetModel, WorkbookInfo } from '../../common/protocol';
import { parseCellInput } from './cellInput';
import { formatNumber, loadWorkbook, type LoadedWorkbook } from './reader';
import { patchXlsx, type CellEdit } from './xlsxPatcher';

export interface EditResult {
  /** Message that applies the edit in the webview. */
  message: HostMessage;
  undo(): HostMessage;
  redo(): HostMessage;
}

interface AppliedChange {
  r: number;
  c: number;
  before: Cell;
  after: Cell;
  beforeText: string;
  afterText: string;
  /** Pending-edit state of the cell before this change (undefined: untouched since last save). */
  beforePending: string | undefined;
}

const rawOf = (cell: Cell | undefined): string =>
  cell == null ? '' : typeof cell === 'string' ? cell : (cell.raw ?? cell.v);

/**
 * One open workbook: the bytes as last saved, the display model, and the cell edits
 * made since then. Pure (no vscode imports) so the dev harness can drive it too.
 */
export class ExcelSession {
  private workbook!: LoadedWorkbook;
  private baseBytes!: Uint8Array;
  /** Per sheet: "r,c" -> text typed by the user, relative to `baseBytes`. */
  private pending: Map<string, string>[] = [];
  /** Bumped on every save; undo records from an earlier generation cannot simply drop their edit. */
  private generation = 0;

  private constructor(private readonly fileName: string) {}

  static async open(bytes: Uint8Array, fileName: string): Promise<ExcelSession> {
    const session = new ExcelSession(fileName);
    await session.load(bytes);
    return session;
  }

  /** (Re)loads from bytes, discarding pending edits. */
  async load(bytes: Uint8Array): Promise<void> {
    this.workbook = await loadWorkbook(bytes, this.fileName);
    this.baseBytes = bytes;
    this.pending = this.workbook.sheets.map(() => new Map());
    this.generation++;
  }

  get editable(): boolean {
    return this.workbook.editable;
  }

  get info(): WorkbookInfo {
    return {
      sheets: this.workbook.sheets.map((s) => ({ name: s.name })),
      editable: this.workbook.editable,
      canStructure: false,
      noticeKey: this.workbook.editable ? 'xlsxNotice' : 'xlsReadonly',
    };
  }

  get dirty(): boolean {
    return this.pending.some((m) => m.size > 0);
  }

  sheet(index: number): SheetModel | undefined {
    return this.workbook.sheets[index]?.model;
  }

  private displayCell(index: number, r: number, c: number, text: string, previous: Cell | undefined): Cell {
    const style = typeof previous === 'object' && previous ? previous.s : undefined;
    const input = parseCellInput(text);
    const out: CellObject = { v: '' };
    const loaded = this.workbook.sheets[index];
    switch (input.kind) {
      case 'empty':
        break;
      case 'number': {
        out.v = formatNumber(input.value, loaded.numFmts.get(`${r},${c}`), loaded.date1904);
        out.n = true;
        if (out.v !== text) {
          out.raw = text;
        }
        break;
      }
      case 'boolean':
        out.v = input.value ? 'TRUE' : 'FALSE';
        break;
      case 'formula':
        // Not evaluated here: show the formula itself until Excel recalculates.
        out.v = text;
        break;
      case 'string':
        out.v = input.value;
        if (input.value !== text) {
          out.raw = text;
        }
        break;
    }
    if (style !== undefined) {
      out.s = style;
    }
    if (out.s === undefined && out.raw === undefined && !out.n) {
      return out.v === '' ? null : out.v;
    }
    return out;
  }

  private write(index: number, r: number, c: number, cell: Cell): void {
    const model = this.workbook.sheets[index].model;
    while (model.rows.length <= r) {
      model.rows.push([]);
    }
    const row = model.rows[r];
    while (row.length <= c) {
      row.push(null);
    }
    row[c] = cell;
  }

  edit(index: number, changes: CellChange[]): EditResult | undefined {
    const sheet = this.workbook.sheets[index];
    if (!sheet || !this.workbook.editable) {
      return undefined;
    }
    const pending = this.pending[index];
    const applied: AppliedChange[] = [];
    for (const { r, c, text } of changes) {
      if (r < 0 || c < 0 || r >= sheet.model.rowCount || c >= sheet.model.colCount) {
        continue;
      }
      const before = sheet.model.rows[r]?.[c] ?? null;
      if ((typeof before === 'object' && before?.ro) || rawOf(before) === text) {
        continue;
      }
      applied.push({
        r,
        c,
        before,
        after: this.displayCell(index, r, c, text, before),
        beforeText: rawOf(before),
        afterText: text,
        beforePending: pending.get(`${r},${c}`),
      });
    }
    if (!applied.length) {
      return undefined;
    }

    const generation = this.generation;
    const apply = (forward: boolean): HostMessage => {
      const cells = applied.map((change) => {
        const key = `${change.r},${change.c}`;
        const cell = forward ? change.after : change.before;
        this.write(index, change.r, change.c, cell);
        if (forward) {
          pending.set(key, change.afterText);
        } else if (generation === this.generation && change.beforePending === undefined) {
          // Nothing was saved in between: the cell is back to what is on disk.
          pending.delete(key);
        } else {
          pending.set(key, change.beforePending ?? change.beforeText);
        }
        return { r: change.r, c: change.c, cell };
      });
      return { type: 'cells', index, cells };
    };

    return { message: apply(true), undo: () => apply(false), redo: () => apply(true) };
  }

  /** The workbook with all pending edits applied. Does not change session state. */
  export(): Uint8Array {
    if (!this.dirty) {
      return this.baseBytes;
    }
    const edits = new Map<string, CellEdit[]>();
    this.pending.forEach((cells, index) => {
      if (!cells.size) {
        return;
      }
      const list: CellEdit[] = [];
      for (const [key, text] of cells) {
        const [r, c] = key.split(',').map(Number);
        list.push({ r, c, text });
      }
      edits.set(this.workbook.sheets[index].name, list);
    });
    return patchXlsx(this.baseBytes, edits);
  }

  /** Call after `export()`'s result was written to the document's own file. */
  markSaved(bytes: Uint8Array): void {
    this.baseBytes = bytes;
    this.pending.forEach((m) => m.clear());
    this.generation++;
  }

  /** Serialises pending edits for hot exit. */
  backup(): string {
    return JSON.stringify(this.pending.map((m) => [...m]));
  }

  /** Re-applies edits from `backup()` on top of a freshly loaded workbook. */
  restore(json: string): void {
    const data = JSON.parse(json) as [string, string][][];
    data.forEach((entries, index) => {
      const changes = entries.map(([key, text]) => {
        const [r, c] = key.split(',').map(Number);
        return { r, c, text };
      });
      this.edit(index, changes);
    });
  }
}
