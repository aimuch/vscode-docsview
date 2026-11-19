import type {
  Cell,
  CellChange,
  CellFormatPatch,
  CellObject,
  CellStyle,
  HostMessage,
  MergeRange,
  SheetModel,
  StructureOp,
  WorkbookInfo,
} from '../../common/protocol';
import { parseCellInput } from './cellInput';
import {
  evaluateFormula,
  FormulaError,
  renameSheetInFormula,
  shiftFormulaReferences,
  type FormulaContext,
  type ScalarValue,
} from './formula';
import { formatNumber, loadWorkbook, type LoadedSheet, type LoadedWorkbook } from './reader';
import { applyWorkbookOps, type CellEdit, type WorkbookOp } from './xlsxPatcher';

export interface EditResult {
  /** Primary message that applies the edit in the webview. */
  message: HostMessage;
  /** Full list of messages to post when an operation updates both workbook tabs and sheet data. */
  messages: HostMessage[];
  undo(): HostMessage[];
  redo(): HostMessage[];
}

const rawOf = (cell: Cell | undefined): string =>
  cell == null ? '' : typeof cell === 'string' ? cell : (cell.raw ?? cell.v);

const textOf = (cell: Cell | undefined): string =>
  cell == null ? '' : typeof cell === 'string' ? cell : cell.v;

interface SheetSnapshot {
  name: string;
  date1904?: boolean;
  model: SheetModel;
  numFmts: Map<string, string>;
  scalars: Map<string, number | string | boolean>;
  userEditedFormulas: Set<string>;
}

interface WorkbookSnapshot {
  sheets: SheetSnapshot[];
  active: number;
}

interface HistoryStep {
  op: WorkbookOp;
  before?: WorkbookSnapshot;
  after?: WorkbookSnapshot;
  /** Fast path for cell-only edits (avoids cloning whole sheets). */
  cellUndo?: () => HostMessage[];
  cellRedo?: () => HostMessage[];
}

function cloneCell(c: Cell): Cell {
  return c && typeof c === 'object' ? { ...c } : c;
}

function cloneModel(m: SheetModel): SheetModel {
  return {
    name: m.name,
    rowCount: m.rowCount,
    colCount: m.colCount,
    rows: m.rows.map((row) => (row ? row.map(cloneCell) : [])),
    colWidths: m.colWidths ? [...m.colWidths] : undefined,
    rowHeights: m.rowHeights ? { ...m.rowHeights } : undefined,
    merges: m.merges ? m.merges.map((x) => ({ ...x })) : undefined,
    frozenRows: m.frozenRows,
    frozenCols: m.frozenCols,
    styles: m.styles ? m.styles.map((s) => ({ ...s })) : undefined,
  };
}

function shiftCoordKey(
  key: string,
  op: StructureOp,
  at: number,
  count: number,
): string | undefined {
  const [r, c] = key.split(',').map(Number);
  if (op === 'insertRow') {
    return `${r >= at ? r + count : r},${c}`;
  }
  if (op === 'deleteRows') {
    if (r >= at && r < at + count) {
      return undefined;
    }
    return `${r >= at + count ? r - count : r},${c}`;
  }
  if (op === 'insertCol') {
    return `${r},${c >= at ? c + count : c}`;
  }
  if (c >= at && c < at + count) {
    return undefined;
  }
  return `${r},${c >= at + count ? c - count : c}`;
}

function shiftMerges(merges: MergeRange[] | undefined, op: StructureOp, at: number, count: number): MergeRange[] | undefined {
  if (!merges?.length) {
    return undefined;
  }
  const isRow = op === 'insertRow' || op === 'deleteRows';
  const isInsert = op.startsWith('insert');
  const out: MergeRange[] = [];
  for (const m of merges) {
    let r0 = m.r;
    let r1 = m.r + m.rs - 1;
    let c0 = m.c;
    let c1 = m.c + m.cs - 1;
    if (isRow) {
      if (isInsert) {
        if (r0 >= at) {
          r0 += count;
          r1 += count;
        } else if (r1 >= at) {
          r1 += count;
        }
      } else {
        const delEnd = at + count - 1;
        if (r0 >= at && r1 <= delEnd) {
          continue;
        }
        if (r1 >= at) {
          if (r0 > delEnd) {
            r0 -= count;
            r1 -= count;
          } else {
            r0 = r0 < at ? r0 : at;
            r1 = r1 > delEnd ? r1 - count : at - 1;
          }
        }
      }
    } else if (isInsert) {
      if (c0 >= at) {
        c0 += count;
        c1 += count;
      } else if (c1 >= at) {
        c1 += count;
      }
    } else {
      const delEnd = at + count - 1;
      if (c0 >= at && c1 <= delEnd) {
        continue;
      }
      if (c1 >= at) {
        if (c0 > delEnd) {
          c0 -= count;
          c1 -= count;
        } else {
          c0 = c0 < at ? c0 : at;
          c1 = c1 > delEnd ? c1 - count : at - 1;
        }
      }
    }
    const rs = r1 - r0 + 1;
    const cs = c1 - c0 + 1;
    if (rs >= 1 && cs >= 1 && (rs > 1 || cs > 1)) {
      out.push({ r: r0, c: c0, rs, cs });
    }
  }
  return out.length ? out : undefined;
}

/**
 * One open workbook: initial & last-saved bytes, live formula evaluator, row/column structural
 * editing, and worksheet add/rename/delete with full undo/redo. Pure (no vscode imports).
 */
export class ExcelSession {
  private workbook!: LoadedWorkbook;
  private initialBytes!: Uint8Array;
  private savedBytes!: Uint8Array;
  private savedCursor = 0;
  private history: HistoryStep[] = [];
  private cursor = 0;
  /** Per sheet: coordinates ("r,c") of formulas typed/edited during this session. */
  private userFormulas: Set<string>[] = [];
  /** Tracks which sheets have already been forced out of lazy mode. */
  private materializedSheets = new WeakSet<LoadedSheet>();

  private constructor(private readonly fileName: string) {}

  static async open(bytes: Uint8Array, fileName: string): Promise<ExcelSession> {
    const session = new ExcelSession(fileName);
    await session.load(bytes);
    return session;
  }

  /** (Re)loads from bytes, discarding pending edits. */
  async load(bytes: Uint8Array): Promise<void> {
    this.workbook = await loadWorkbook(bytes, this.fileName);
    this.initialBytes = bytes;
    this.savedBytes = bytes;
    this.savedCursor = 0;
    this.history = [];
    this.cursor = 0;
    this.userFormulas = this.workbook.sheets.map(() => new Set());
    this.materializedSheets = new WeakSet();
  }

  get editable(): boolean {
    return this.workbook.editable;
  }

  get info(): WorkbookInfo {
    return {
      sheets: this.workbook.sheets.map((s) => ({ name: s.name })),
      editable: this.workbook.editable,
      canStructure: this.workbook.editable,
      canManageSheets: this.workbook.editable,
      noticeKey: this.workbook.editable ? undefined : 'xlsReadonly',
    };
  }

  get dirty(): boolean {
    return this.cursor !== this.savedCursor;
  }

  sheet(index: number): SheetModel | undefined {
    const s = this.workbook.sheets[index];
    if (!s) {
      return undefined;
    }
    const firstVisit = !this.materializedSheets.has(s);
    this.materializedSheets.add(s);
    if (firstVisit && this.history.length > 0) {
      this.recalculate(index);
    }
    return s.model;
  }

  private pushStep(step: HistoryStep): void {
    if (this.cursor < this.history.length) {
      // Branching after undo invalidates a saved point that lay on the discarded branch.
      if (this.savedCursor > this.cursor) {
        this.savedCursor = -1;
      }
      this.history.length = this.cursor;
    }
    this.history.push(step);
    this.cursor = this.history.length;
  }

  private takeSnapshot(active: number): WorkbookSnapshot {
    return {
      active,
      sheets: this.workbook.sheets.map((s, i) => {
        this.materializedSheets.add(s);
        return {
          name: s.name,
          date1904: s.date1904,
          model: cloneModel(s.model),
          numFmts: new Map(s.numFmts),
          scalars: new Map(s.scalars),
          userEditedFormulas: new Set(this.userFormulas[i] ?? []),
        };
      }),
    };
  }

  private restoreSnapshot(snap: WorkbookSnapshot): HostMessage[] {
    this.workbook.sheets = snap.sheets.map((s) => {
      const model = cloneModel(s.model);
      const numFmts = new Map(s.numFmts);
      const scalars = new Map(s.scalars);
      const loaded: LoadedSheet = {
        name: s.name,
        date1904: s.date1904,
        model,
        numFmts,
        scalars,
      };
      this.materializedSheets.add(loaded);
      return loaded;
    });
    this.userFormulas = snap.sheets.map((s) => new Set(s.userEditedFormulas));
    const active = Math.max(0, Math.min(this.workbook.sheets.length - 1, snap.active));
    return [
      { type: 'workbook', info: this.info, active },
      { type: 'sheet', index: active, model: this.workbook.sheets[active].model },
    ];
  }

  // ---------------------------------------------------------------- formula evaluation

  private readRawScalar(sheetIndex: number, r: number, c: number): ScalarValue {
    const sheet = this.workbook.sheets[sheetIndex];
    if (!sheet) {
      return new FormulaError('#REF!');
    }
    this.materializedSheets.add(sheet);
    const cell = sheet.model.rows[r]?.[c];
    if (cell == null) {
      return null;
    }
    const key = `${r},${c}`;
    const raw = rawOf(cell);
    if (raw.startsWith('=') && raw.length > 1) {
      return null; // Handled by memoised evaluator
    }
    if (sheet.scalars.has(key)) {
      return sheet.scalars.get(key)!;
    }
    const parsed = parseCellInput(raw);
    switch (parsed.kind) {
      case 'empty':
        return null;
      case 'number':
        return parsed.value;
      case 'boolean':
        return parsed.value;
      case 'string':
        return parsed.value;
      default:
        return textOf(cell);
    }
  }

  /**
   * Re-evaluates all formula cells in materialised sheets, updating their display text and
   * returning any cells on `watchSheet` whose displayed state changed.
   */
  private recalculate(watchSheet: number): { r: number; c: number; cell: Cell }[] {
    const memo = new Map<string, ScalarValue>();
    const visiting = new Set<string>();

    const sheetIndexByName = (name: string): number => {
      const lower = name.toLowerCase();
      return this.workbook.sheets.findIndex((s) => s.name.toLowerCase() === lower);
    };

    const evalCell = (sIdx: number, r: number, c: number): ScalarValue => {
      const sheet = this.workbook.sheets[sIdx];
      if (!sheet) {
        return new FormulaError('#REF!');
      }
      this.materializedSheets.add(sheet);
      if (r < 0 || c < 0) {
        return new FormulaError('#REF!');
      }
      const id = `${sIdx}:${r},${c}`;
      if (memo.has(id)) {
        return memo.get(id)!;
      }
      const cell = sheet.model.rows[r]?.[c];
      if (cell == null) {
        return null;
      }
      const raw = rawOf(cell);
      if (!raw.startsWith('=') || raw.length <= 1) {
        const val = this.readRawScalar(sIdx, r, c);
        memo.set(id, val);
        return val;
      }
      if (visiting.has(id)) {
        return new FormulaError('#CYCLE!');
      }
      visiting.add(id);
      const ctx: FormulaContext = {
        currentSheet: sIdx,
        sheetIndexByName,
        getCellValue: (ts, tr, tc) => evalCell(ts, tr, tc),
        getRangeValues: (ts, r0, c0, r1, c1) => {
          const out: ScalarValue[][] = [];
          const target = this.workbook.sheets[ts];
          if (target) {
            this.materializedSheets.add(target);
          }
          const maxR = Math.min(r1, Math.max((target?.model.rows.length ?? 0) - 1, r0));
          for (let rr = r0; rr <= r1; rr++) {
            const rowVals: ScalarValue[] = [];
            if (rr > maxR) {
              for (let cc = c0; cc <= c1; cc++) {
                rowVals.push(null);
              }
            } else {
              for (let cc = c0; cc <= c1; cc++) {
                rowVals.push(evalCell(ts, rr, cc));
              }
            }
            out.push(rowVals);
          }
          return out;
        },
      };
      const value = evaluateFormula(raw.slice(1), ctx);
      visiting.delete(id);
      memo.set(id, value);
      return value;
    };

    const changedOnWatched: { r: number; c: number; cell: Cell }[] = [];

    this.workbook.sheets.forEach((sheet, sIdx) => {
      if (!this.materializedSheets.has(sheet)) {
        return;
      }
      const rows = sheet.model.rows;
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        if (!row?.length) {
          continue;
        }
        for (let c = 0; c < row.length; c++) {
          const cell = row[c];
          if (!cell || typeof cell !== 'object' || !cell.raw?.startsWith('=') || cell.raw.length <= 1) {
            continue;
          }
          const val = evalCell(sIdx, r, c);
          const key = `${r},${c}`;
          // Preserve Excel's cached value on untouched unknown UDFs so custom-macro sheets don't show #NAME?.
          if (
            val instanceof FormulaError &&
            val.code === '#NAME?' &&
            !this.userFormulas[sIdx]?.has(key) &&
            cell.v !== '' &&
            !cell.v.startsWith('=')
          ) {
            continue;
          }
          let nextV = '';
          let nextN: boolean | undefined;
          if (val instanceof FormulaError) {
            nextV = val.code;
            sheet.scalars.delete(key);
          } else if (typeof val === 'number') {
            nextV = formatNumber(val, sheet.numFmts.get(key), sheet.date1904);
            nextN = true;
            sheet.scalars.set(key, val);
          } else if (typeof val === 'boolean') {
            nextV = val ? 'TRUE' : 'FALSE';
            sheet.scalars.set(key, val);
          } else if (typeof val === 'string') {
            nextV = val;
            sheet.scalars.set(key, val);
          } else {
            nextV = '0';
            nextN = true;
            sheet.scalars.set(key, 0);
          }
          if (cell.v !== nextV || cell.n !== nextN) {
            const updated: CellObject = { ...cell, v: nextV };
            if (nextN) {
              updated.n = true;
            } else {
              delete updated.n;
            }
            row[c] = updated;
            if (sIdx === watchSheet) {
              changedOnWatched.push({ r, c, cell: updated });
            }
          }
        }
      }
    });

    return changedOnWatched;
  }

  // ---------------------------------------------------------------- cell editing

  private buildLiteralOrFormulaCell(index: number, r: number, c: number, text: string, previous: Cell | undefined): Cell {
    const style = typeof previous === 'object' && previous ? previous.s : undefined;
    const input = parseCellInput(text);
    const out: CellObject = { v: '' };
    const loaded = this.workbook.sheets[index];
    const key = `${r},${c}`;
    switch (input.kind) {
      case 'empty':
        loaded.scalars.delete(key);
        this.userFormulas[index]?.delete(key);
        break;
      case 'number': {
        out.v = formatNumber(input.value, loaded.numFmts.get(key), loaded.date1904);
        out.n = true;
        loaded.scalars.set(key, input.value);
        this.userFormulas[index]?.delete(key);
        if (out.v !== text) {
          out.raw = text;
        }
        break;
      }
      case 'boolean':
        out.v = input.value ? 'TRUE' : 'FALSE';
        loaded.scalars.set(key, input.value);
        this.userFormulas[index]?.delete(key);
        break;
      case 'formula':
        out.raw = text;
        out.v = text;
        this.userFormulas[index]?.add(key);
        break;
      case 'string':
        out.v = input.value;
        loaded.scalars.set(key, input.value);
        this.userFormulas[index]?.delete(key);
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

  private writeCellInModel(index: number, r: number, c: number, cell: Cell): void {
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

  private cachedResultFor(index: number, r: number, c: number): CellEdit['cached'] {
    const sheet = this.workbook.sheets[index];
    const cell = sheet?.model.rows[r]?.[c];
    if (!cell || typeof cell !== 'object' || !cell.raw?.startsWith('=')) {
      return undefined;
    }
    if (cell.v.startsWith('#')) {
      return { error: cell.v };
    }
    const scalar = sheet.scalars.get(`${r},${c}`);
    return scalar;
  }

  edit(index: number, changes: CellChange[]): EditResult | undefined {
    const sheet = this.workbook.sheets[index];
    if (!sheet || !this.workbook.editable) {
      return undefined;
    }
    this.materializedSheets.add(sheet);

    interface SavedBefore {
      r: number;
      c: number;
      cell: Cell;
      text: string;
      scalar: number | string | boolean | undefined;
      wasUserFormula: boolean;
      afterText: string;
    }
    const items: SavedBefore[] = [];
    for (const { r, c, text } of changes) {
      if (r < 0 || c < 0 || r >= sheet.model.rowCount || c >= sheet.model.colCount) {
        continue;
      }
      const before = sheet.model.rows[r]?.[c] ?? null;
      if ((typeof before === 'object' && before?.ro) || rawOf(before) === text) {
        continue;
      }
      const key = `${r},${c}`;
      items.push({
        r,
        c,
        cell: cloneCell(before),
        text: rawOf(before),
        scalar: sheet.scalars.get(key),
        wasUserFormula: this.userFormulas[index]?.has(key) ?? false,
        afterText: text,
      });
    }
    if (!items.length) {
      return undefined;
    }

    const applyForward = (): HostMessage[] => {
      const updatedMap = new Map<string, { r: number; c: number; cell: Cell }>();
      for (const item of items) {
        const prev = sheet.model.rows[item.r]?.[item.c] ?? null;
        const nextCell = this.buildLiteralOrFormulaCell(index, item.r, item.c, item.afterText, prev);
        this.writeCellInModel(index, item.r, item.c, nextCell);
        updatedMap.set(`${item.r},${item.c}`, { r: item.r, c: item.c, cell: nextCell });
      }
      for (const dep of this.recalculate(index)) {
        updatedMap.set(`${dep.r},${dep.c}`, dep);
      }
      // Refresh final cell references in case recalculate updated formula cells among `items`
      for (const item of items) {
        const finalCell = sheet.model.rows[item.r]?.[item.c] ?? null;
        updatedMap.set(`${item.r},${item.c}`, { r: item.r, c: item.c, cell: finalCell });
      }
      return [{ type: 'cells', index, cells: [...updatedMap.values()] }];
    };

    const applyBackward = (): HostMessage[] => {
      const updatedMap = new Map<string, { r: number; c: number; cell: Cell }>();
      for (const item of items) {
        const key = `${item.r},${item.c}`;
        this.writeCellInModel(index, item.r, item.c, cloneCell(item.cell));
        if (item.scalar !== undefined) {
          sheet.scalars.set(key, item.scalar);
        } else {
          sheet.scalars.delete(key);
        }
        if (item.wasUserFormula) {
          this.userFormulas[index]?.add(key);
        } else {
          this.userFormulas[index]?.delete(key);
        }
        updatedMap.set(key, { r: item.r, c: item.c, cell: sheet.model.rows[item.r]?.[item.c] ?? null });
      }
      for (const dep of this.recalculate(index)) {
        updatedMap.set(`${dep.r},${dep.c}`, dep);
      }
      return [{ type: 'cells', index, cells: [...updatedMap.values()] }];
    };

    const forwardMessages = applyForward();
    const cellEdits: CellEdit[] = items.map((item) => ({
      r: item.r,
      c: item.c,
      text: item.afterText,
      cached: this.cachedResultFor(index, item.r, item.c),
    }));

    const step: HistoryStep = {
      op: { kind: 'cells', sheet: sheet.name, edits: cellEdits },
      cellUndo: applyBackward,
      cellRedo: applyForward,
    };
    this.pushStep(step);

    return {
      message: forwardMessages[0],
      messages: forwardMessages,
      undo: () => {
        if (this.cursor > 0 && this.history[this.cursor - 1] === step) {
          this.cursor--;
        }
        return applyBackward();
      },
      redo: () => {
        if (this.history[this.cursor] === step) {
          this.cursor++;
        }
        return applyForward();
      },
    };
  }

  // ---------------------------------------------------------------- row / column structure ops

  structure(index: number, op: StructureOp, at: number, count = 1): EditResult | undefined {
    const sheet = this.workbook.sheets[index];
    if (!sheet || !this.workbook.editable || count < 1 || at < 0) {
      return undefined;
    }
    this.materializedSheets.add(sheet);
    const model = sheet.model;
    const isRow = op === 'insertRow' || op === 'deleteRows';
    if (!op.startsWith('insert')) {
      const total = isRow ? model.rowCount : model.colCount;
      if (at >= total) {
        return undefined;
      }
      count = Math.min(count, Math.max(0, total - 1));
      if (count < 1) {
        return undefined;
      }
    }

    const before = this.takeSnapshot(index);
    const targetName = sheet.name;

    // 1. Shift rows / columns in the target sheet model.
    if (op === 'insertRow') {
      const emptyRows: Cell[][] = Array.from({ length: count }, () => []);
      if (at <= model.rows.length) {
        model.rows.splice(at, 0, ...emptyRows);
      }
      model.rowCount += count;
      if (model.rowHeights) {
        const nextHeights: Record<number, number> = {};
        for (const [k, h] of Object.entries(model.rowHeights)) {
          const r = Number(k);
          nextHeights[r >= at ? r + count : r] = h;
        }
        model.rowHeights = nextHeights;
      }
    } else if (op === 'deleteRows') {
      if (at < model.rows.length) {
        model.rows.splice(at, count);
      }
      model.rowCount = Math.max(1, model.rowCount - count);
      if (model.rowHeights) {
        const nextHeights: Record<number, number> = {};
        for (const [k, h] of Object.entries(model.rowHeights)) {
          const r = Number(k);
          if (r < at) {
            nextHeights[r] = h;
          } else if (r >= at + count) {
            nextHeights[r - count] = h;
          }
        }
        model.rowHeights = Object.keys(nextHeights).length ? nextHeights : undefined;
      }
    } else if (op === 'insertCol') {
      const blanks: Cell[] = Array.from({ length: count }, () => null);
      for (const row of model.rows) {
        if (row && at < row.length) {
          row.splice(at, 0, ...blanks);
        }
      }
      model.colCount += count;
      if (model.colWidths) {
        model.colWidths.splice(at, 0, ...Array.from({ length: count }, () => null));
      }
    } else if (op === 'deleteCols') {
      for (const row of model.rows) {
        if (row && at < row.length) {
          row.splice(at, count);
        }
      }
      model.colCount = Math.max(1, model.colCount - count);
      if (model.colWidths && at < model.colWidths.length) {
        model.colWidths.splice(at, count);
      }
    }

    model.merges = shiftMerges(model.merges, op, at, count);

    // 2. Shift numFmts, scalars and userFormulas keys on the target sheet.
    const nextFmts = new Map<string, string>();
    for (const [k, v] of sheet.numFmts) {
      const nk = shiftCoordKey(k, op, at, count);
      if (nk) {
        nextFmts.set(nk, v);
      }
    }
    sheet.numFmts.clear();
    nextFmts.forEach((v, k) => sheet.numFmts.set(k, v));

    const nextScalars = new Map<string, number | string | boolean>();
    for (const [k, v] of sheet.scalars) {
      const nk = shiftCoordKey(k, op, at, count);
      if (nk) {
        nextScalars.set(nk, v);
      }
    }
    sheet.scalars.clear();
    nextScalars.forEach((v, k) => sheet.scalars.set(k, v));

    const nextUserFormulas = new Set<string>();
    for (const k of this.userFormulas[index] ?? []) {
      const nk = shiftCoordKey(k, op, at, count);
      if (nk) {
        nextUserFormulas.add(nk);
      }
    }
    this.userFormulas[index] = nextUserFormulas;

    // 3. Shift formula references across all sheets & recalculate.
    for (const s of this.workbook.sheets) {
      this.materializedSheets.add(s);
      for (const row of s.model.rows) {
        if (!row) {
          continue;
        }
        for (let c = 0; c < row.length; c++) {
          const cell = row[c];
          if (cell && typeof cell === 'object' && cell.raw?.startsWith('=') && cell.raw.length > 1) {
            const shifted = shiftFormulaReferences(cell.raw.slice(1), targetName, s.name, op, at, count);
            cell.raw = `=${shifted}`;
          }
        }
      }
    }
    this.recalculate(index);

    const after = this.takeSnapshot(index);
    const step: HistoryStep = {
      op: { kind: 'structure', sheet: targetName, op, at, count },
      before,
      after,
    };
    this.pushStep(step);

    const msg: HostMessage = { type: 'sheet', index, model: sheet.model };
    return {
      message: msg,
      messages: [msg],
      undo: () => {
        if (this.cursor > 0 && this.history[this.cursor - 1] === step) {
          this.cursor--;
        }
        return this.restoreSnapshot(before);
      },
      redo: () => {
        if (this.history[this.cursor] === step) {
          this.cursor++;
        }
        return this.restoreSnapshot(after);
      },
    };
  }

  // ---------------------------------------------------------------- sheet management

  addSheet(preferredName?: string): EditResult | undefined {
    if (!this.workbook.editable) {
      return undefined;
    }
    const existingLower = new Set(this.workbook.sheets.map((s) => s.name.toLowerCase()));
    let name = preferredName?.trim() || '';
    if (!name || existingLower.has(name.toLowerCase())) {
      let n = this.workbook.sheets.length + 1;
      while (existingLower.has(`sheet${n}`)) {
        n++;
      }
      name = `Sheet${n}`;
    }
    name = name.replace(/[:\\/?*[\]]/g, '_').slice(0, 31);

    const before = this.takeSnapshot(Math.max(0, this.workbook.sheets.length - 1));
    const date1904 = this.workbook.sheets[0]?.date1904 ?? false;
    const model: SheetModel = { name, rowCount: 40, colCount: 10, rows: [] };
    const newSheet: LoadedSheet = {
      name,
      date1904,
      model,
      numFmts: new Map(),
      scalars: new Map(),
    };
    this.materializedSheets.add(newSheet);
    this.workbook.sheets.push(newSheet);
    this.userFormulas.push(new Set());
    const newIndex = this.workbook.sheets.length - 1;
    this.recalculate(newIndex);

    const after = this.takeSnapshot(newIndex);
    const step: HistoryStep = { op: { kind: 'addSheet', name }, before, after };
    this.pushStep(step);

    const messages: HostMessage[] = [
      { type: 'workbook', info: this.info, active: newIndex },
      { type: 'sheet', index: newIndex, model },
    ];
    return {
      message: messages[0],
      messages,
      undo: () => {
        if (this.cursor > 0 && this.history[this.cursor - 1] === step) {
          this.cursor--;
        }
        return this.restoreSnapshot(before);
      },
      redo: () => {
        if (this.history[this.cursor] === step) {
          this.cursor++;
        }
        return this.restoreSnapshot(after);
      },
    };
  }

  renameSheet(index: number, rawName: string): EditResult | undefined {
    const sheet = this.workbook.sheets[index];
    if (!sheet || !this.workbook.editable) {
      return undefined;
    }
    const newName = rawName.trim().replace(/[:\\/?*[\]]/g, '').slice(0, 31);
    if (!newName || newName === sheet.name) {
      return undefined;
    }
    const conflict = this.workbook.sheets.some((s, i) => i !== index && s.name.toLowerCase() === newName.toLowerCase());
    if (conflict) {
      return undefined;
    }

    const oldName = sheet.name;
    const before = this.takeSnapshot(index);
    sheet.name = newName;
    for (const s of this.workbook.sheets) {
      this.materializedSheets.add(s);
      for (const row of s.model.rows) {
        if (!row) {
          continue;
        }
        for (const cell of row) {
          if (cell && typeof cell === 'object' && cell.raw?.startsWith('=') && cell.raw.length > 1) {
            cell.raw = `=${renameSheetInFormula(cell.raw.slice(1), oldName, newName)}`;
          }
        }
      }
    }
    this.recalculate(index);

    const after = this.takeSnapshot(index);
    const step: HistoryStep = { op: { kind: 'renameSheet', oldName, newName }, before, after };
    this.pushStep(step);

    const messages: HostMessage[] = [
      { type: 'workbook', info: this.info, active: index },
      { type: 'sheet', index, model: sheet.model },
    ];
    return {
      message: messages[0],
      messages,
      undo: () => {
        if (this.cursor > 0 && this.history[this.cursor - 1] === step) {
          this.cursor--;
        }
        return this.restoreSnapshot(before);
      },
      redo: () => {
        if (this.history[this.cursor] === step) {
          this.cursor++;
        }
        return this.restoreSnapshot(after);
      },
    };
  }

  deleteSheet(index: number): EditResult | undefined {
    const sheet = this.workbook.sheets[index];
    if (!sheet || !this.workbook.editable || this.workbook.sheets.length <= 1) {
      return undefined;
    }
    const before = this.takeSnapshot(index);
    const deletedName = sheet.name;
    this.workbook.sheets.splice(index, 1);
    this.userFormulas.splice(index, 1);
    const nextActive = Math.min(index, this.workbook.sheets.length - 1);
    for (const s of this.workbook.sheets) {
      this.materializedSheets.add(s);
    }
    this.recalculate(nextActive);

    const after = this.takeSnapshot(nextActive);
    const step: HistoryStep = { op: { kind: 'deleteSheet', name: deletedName }, before, after };
    this.pushStep(step);

    const messages: HostMessage[] = [
      { type: 'workbook', info: this.info, active: nextActive },
      { type: 'sheet', index: nextActive, model: this.workbook.sheets[nextActive].model },
    ];
    return {
      message: messages[0],
      messages,
      undo: () => {
        if (this.cursor > 0 && this.history[this.cursor - 1] === step) {
          this.cursor--;
        }
        return this.restoreSnapshot(before);
      },
      redo: () => {
        if (this.history[this.cursor] === step) {
          this.cursor++;
        }
        return this.restoreSnapshot(after);
      },
    };
  }

  /** Applies bold/italic/alignment/fill/text-color/number-format to a rectangular cell range. */
  formatCells(
    sheetIndex: number,
    r0: number,
    c0: number,
    r1: number,
    c1: number,
    patch: CellFormatPatch,
  ): EditResult | undefined {
    const loaded = this.workbook.sheets[sheetIndex];
    if (!this.workbook.editable || !loaded) {
      return undefined;
    }
    const before = this.takeSnapshot(sheetIndex);
    const model = loaded.model;
    model.styles ??= [];
    const sr0 = Math.max(0, Math.min(r0, r1));
    const sr1 = Math.min(Math.max(0, model.rowCount - 1), Math.max(r0, r1));
    const sc0 = Math.max(0, Math.min(c0, c1));
    const sc1 = Math.min(Math.max(0, model.colCount - 1), Math.max(c0, c1));

    for (let r = sr0; r <= sr1; r++) {
      while (model.rows.length <= r) model.rows.push([]);
      const row = model.rows[r];
      while (row.length <= sc1) row.push(null);
      for (let c = sc0; c <= sc1; c++) {
        const cur = row[c];
        const obj: CellObject =
          cur == null
            ? { v: '' }
            : typeof cur === 'string'
              ? { v: cur }
              : { ...cur };
        const baseStyle: CellStyle = obj.s !== undefined ? { ...(model.styles[obj.s] ?? {}) } : {};
        if (patch.bold !== undefined) baseStyle.bold = patch.bold;
        if (patch.italic !== undefined) baseStyle.italic = patch.italic;
        if (patch.align !== undefined) baseStyle.align = patch.align;
        if (patch.bg !== undefined) baseStyle.bg = patch.bg || undefined;
        if (patch.color !== undefined) baseStyle.color = patch.color || undefined;
        const newStyleIdx = model.styles.length;
        model.styles.push(baseStyle);
        obj.s = newStyleIdx;

        if (patch.numFmt !== undefined) {
          const coord = `${r},${c}`;
          if (patch.numFmt && patch.numFmt !== 'General') {
            loaded.numFmts.set(coord, patch.numFmt);
            const scalar = loaded.scalars.get(coord);
            if (typeof scalar === 'number') {
              obj.v = formatNumber(scalar, patch.numFmt, loaded.date1904);
              obj.raw = String(scalar);
              obj.n = true;
            }
          } else {
            loaded.numFmts.delete(coord);
            const scalar = loaded.scalars.get(coord);
            if (typeof scalar === 'number') {
              obj.v = String(scalar);
              delete obj.raw;
              obj.n = true;
            }
          }
        }
        row[c] = obj;
      }
    }

    const after = this.takeSnapshot(sheetIndex);
    const step: HistoryStep = {
      op: { kind: 'format', sheet: loaded.name, r0: sr0, c0: sc0, r1: sr1, c1: sc1, patch },
      before,
      after,
    };
    this.pushStep(step);
    const msg: HostMessage = { type: 'sheet', index: sheetIndex, model };
    return {
      message: msg,
      messages: [msg],
      undo: () => {
        if (this.history[this.cursor - 1] === step) this.cursor--;
        return this.restoreSnapshot(before);
      },
      redo: () => {
        if (this.history[this.cursor] === step) this.cursor++;
        return this.restoreSnapshot(after);
      },
    };
  }

  // ---------------------------------------------------------------- persistence

  /** The workbook with all applied operations up to `cursor`. Does not change session state. */
  export(): Uint8Array {
    if (this.cursor === this.savedCursor && this.savedCursor >= 0) {
      return this.savedBytes;
    }
    if (this.savedCursor >= 0 && this.cursor > this.savedCursor) {
      const ops = this.history.slice(this.savedCursor, this.cursor).map((h) => h.op);
      return applyWorkbookOps(this.savedBytes, ops);
    }
    const ops = this.history.slice(0, this.cursor).map((h) => h.op);
    return applyWorkbookOps(this.initialBytes, ops);
  }

  /** Call after `export()`'s result was written to the document's own file. */
  markSaved(bytes: Uint8Array): void {
    this.savedBytes = bytes;
    this.savedCursor = this.cursor;
  }

  /** Serialises pending operations for hot exit. */
  backup(): string {
    return JSON.stringify({
      v: 2,
      ops: this.history.slice(0, this.cursor).map((h) => h.op),
    });
  }

  /** Re-applies operations from `backup()` on top of a freshly loaded workbook. */
  restore(json: string): void {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) {
      // Legacy v1 backup format: [string, string][][]
      (parsed as [string, string][][]).forEach((entries, index) => {
        const changes = entries.map(([key, text]) => {
          const [r, c] = key.split(',').map(Number);
          return { r, c, text };
        });
        this.edit(index, changes);
      });
      return;
    }
    const v2 = parsed as { v?: number; ops?: WorkbookOp[] };
    if (!Array.isArray(v2?.ops)) {
      return;
    }
    for (const op of v2.ops) {
      switch (op.kind) {
        case 'cells': {
          const idx = this.workbook.sheets.findIndex((s) => s.name === op.sheet);
          if (idx >= 0) {
            this.edit(idx, op.edits);
          }
          break;
        }
        case 'format': {
          const idx = this.workbook.sheets.findIndex((s) => s.name === op.sheet);
          if (idx >= 0) {
            this.formatCells(idx, op.r0, op.c0, op.r1, op.c1, op.patch);
          }
          break;
        }
        case 'structure': {
          const idx = this.workbook.sheets.findIndex((s) => s.name === op.sheet);
          if (idx >= 0) {
            this.structure(idx, op.op, op.at, op.count);
          }
          break;
        }
        case 'addSheet':
          this.addSheet(op.name);
          break;
        case 'renameSheet': {
          const idx = this.workbook.sheets.findIndex((s) => s.name === op.oldName);
          if (idx >= 0) {
            this.renameSheet(idx, op.newName);
          }
          break;
        }
        case 'deleteSheet': {
          const idx = this.workbook.sheets.findIndex((s) => s.name === op.name);
          if (idx >= 0) {
            this.deleteSheet(idx);
          }
          break;
        }
      }
    }
  }
}
