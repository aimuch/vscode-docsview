// Pure JSON Lines (`.jsonl` / `.ndjson`) table session: maps each JSON line to a row,
// freezes discovered field names in row 0, supports key renaming + column/row CRUD +
// whole-record JSON editing, and emits exact line-level TextEdits without corrupting types.
import type { Cell, CellChange, HostMessage, SheetModel, StructureOp, WorkbookInfo } from '../../common/protocol';
import type { TextEdit } from '../csv/csvParser';

const EXTRA_JSONL_ROWS = 10;
const INVALID_JSON_FIELD = Symbol('INVALID_JSON_FIELD');

interface RecordSpan {
  start: number;
  end: number;
  raw: string;
  obj: Record<string, unknown>;
  isPrimitive?: boolean;
  invalid?: boolean;
}

function formatJsonField(val: unknown): Cell {
  if (val === undefined || val === null) {
    return '';
  }
  if (typeof val === 'number') {
    return { v: String(val), n: true };
  }
  if (typeof val === 'boolean') {
    return String(val);
  }
  if (typeof val === 'string') {
    return val;
  }
  const json = JSON.stringify(val);
  return { v: json, raw: json };
}

function parseEditedField(text: string, prevValue: unknown): unknown | typeof INVALID_JSON_FIELD {
  if (text.startsWith("'")) {
    return text.slice(1);
  }
  const trimmed = text.trim();

  // Existing nested object/array: require valid JSON (or empty/'null' to clear) rather than corrupting to string.
  if (prevValue !== null && typeof prevValue === 'object') {
    if (trimmed === '' || trimmed === 'null') {
      return null;
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      return INVALID_JSON_FIELD;
    }
  }

  // Existing string field: preserve string type (so string IDs like "0042" or "1001" stay strings).
  if (typeof prevValue === 'string') {
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return text;
      }
    }
    return text;
  }

  if (trimmed === '' || trimmed === 'null') {
    return null;
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Keep as plain string when previous value was empty/undefined.
    }
  }
  return text;
}

export class JsonlSession {
  private source = '';
  private eol = '\n';
  private columns: string[] = [];
  private records: RecordSpan[] = [];

  constructor(
    private readonly fileName: string,
    initialEol = '\n',
  ) {
    this.eol = initialEol;
  }

  get currentText(): string {
    return this.source;
  }

  get recordCount(): number {
    return this.records.length;
  }

  get info(): WorkbookInfo {
    return {
      sheets: [{ name: this.fileName }],
      editable: true,
      canStructure: true,
      hasSource: true,
      supportsFormulas: false,
      isJsonl: true,
    };
  }

  setText(text: string, eol = this.eol): HostMessage {
    this.source = text;
    this.eol = eol;
    this.records = [];
    const colSet = new Set<string>();

    let pos = 0;
    const len = text.length;
    while (pos < len) {
      let lineEnd = text.indexOf('\n', pos);
      if (lineEnd < 0) {
        lineEnd = len;
      }
      const contentEnd = lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
      const line = text.slice(pos, contentEnd);
      if (line.trim().length > 0) {
        try {
          const parsed = JSON.parse(line) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const obj = parsed as Record<string, unknown>;
            for (const k of Object.keys(obj)) {
              colSet.add(k);
            }
            this.records.push({ start: pos, end: contentEnd, raw: line, obj });
          } else {
            colSet.add('_value');
            this.records.push({ start: pos, end: contentEnd, raw: line, obj: { _value: parsed }, isPrimitive: true });
          }
        } catch {
          colSet.add('_raw');
          this.records.push({ start: pos, end: contentEnd, raw: line, obj: { _raw: line }, invalid: true });
        }
      }
      pos = lineEnd + 1;
    }

    this.columns = colSet.size > 0 ? [...colSet] : ['field'];
    return { type: 'sheet', index: 0, model: this.model() };
  }

  model(): SheetModel {
    const headerRow: Cell[] = this.columns.map((col) => ({
      v: col,
      s: 0,
      ro: col === '_raw' || col === '_value' ? true : undefined,
    }));
    const bodyRows: Cell[][] = this.records.map((rec) =>
      this.columns.map((col) => formatJsonField(rec.obj[col])),
    );
    const rows = [headerRow, ...bodyRows];
    return {
      name: this.fileName,
      rowCount: rows.length + EXTRA_JSONL_ROWS,
      colCount: Math.max(this.columns.length, 1),
      rows,
      frozenRows: 1,
      styles: [{ bold: true }],
    };
  }

  /** Plain string matrix (including header row) for CSV / TSV / XLSX export. */
  exportRows(): string[][] {
    const head = [...this.columns];
    const body = this.records.map((rec) =>
      this.columns.map((col) => {
        const v = rec.obj[col];
        if (v === undefined || v === null) return '';
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
      }),
    );
    return [head, ...body];
  }

  editCells(changes: readonly CellChange[]): { edits: TextEdit[]; hadInvalidJson?: boolean } {
    const renames = new Map<string, string>();
    const byRecord = new Map<number, CellChange[]>();
    let appendObjects: Record<string, unknown>[] | undefined;
    let hadInvalidJson = false;

    for (const ch of changes) {
      if (ch.c < 0 || ch.c >= this.columns.length) {
        continue;
      }
      if (ch.r === 0) {
        const oldKey = this.columns[ch.c];
        const nextKey = ch.text.trim();
        if (nextKey && nextKey !== oldKey && oldKey !== '_raw' && oldKey !== '_value' && !this.columns.includes(nextKey)) {
          renames.set(oldKey, nextKey);
        }
        continue;
      }
      const recIdx = ch.r - 1;
      if (recIdx >= 0 && recIdx < this.records.length) {
        let list = byRecord.get(recIdx);
        if (!list) {
          byRecord.set(recIdx, (list = []));
        }
        list.push(ch);
      } else if (recIdx >= this.records.length && ch.text.trim() !== '') {
        const parsed = parseEditedField(ch.text, undefined);
        if (parsed === INVALID_JSON_FIELD) {
          hadInvalidJson = true;
          continue;
        }
        appendObjects ??= [];
        const relIdx = recIdx - this.records.length;
        while (appendObjects.length <= relIdx) {
          appendObjects.push({});
        }
        appendObjects[relIdx][this.columns[ch.c]] = parsed;
      }
    }

    if (renames.size > 0) {
      for (let idx = 0; idx < this.records.length; idx++) {
        if (!byRecord.has(idx)) {
          byRecord.set(idx, []);
        }
      }
    }

    const edits: TextEdit[] = [];
    for (const [recIdx, recChanges] of [...byRecord.entries()].sort((a, b) => b[0] - a[0])) {
      const rec = this.records[recIdx];
      if (rec.invalid) {
        if (recChanges.some((c) => this.columns[c.c] === '_raw')) {
          const rawEdit = recChanges.find((c) => this.columns[c.c] === '_raw')!;
          edits.push({ start: rec.start, end: rec.end, text: rawEdit.text.replace(/\r?\n/g, ' ') });
        }
        continue;
      }
      if (rec.isPrimitive && this.columns.length === 1 && this.columns[0] === '_value') {
        if (recChanges.length) {
          const val = parseEditedField(recChanges[recChanges.length - 1].text, rec.obj._value);
          if (val === INVALID_JSON_FIELD) {
            hadInvalidJson = true;
            continue;
          }
          edits.push({ start: rec.start, end: rec.end, text: JSON.stringify(val) });
        }
        continue;
      }

      const nextObj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec.obj)) {
        if (k === '_raw') continue;
        nextObj[renames.get(k) ?? k] = v;
      }
      let skipRecord = false;
      for (const ch of recChanges) {
        const origKey = this.columns[ch.c];
        const targetKey = renames.get(origKey) ?? origKey;
        const parsed = parseEditedField(ch.text, nextObj[targetKey]);
        if (parsed === INVALID_JSON_FIELD) {
          hadInvalidJson = true;
          skipRecord = true;
          break;
        }
        nextObj[targetKey] = parsed;
      }
      if (!skipRecord) {
        edits.push({ start: rec.start, end: rec.end, text: JSON.stringify(nextObj) });
      }
    }

    if (appendObjects?.length) {
      const nonEmpty = appendObjects.filter((o) => Object.keys(o).length > 0);
      if (nonEmpty.length) {
        const needsLeadingNewline = this.source.length > 0 && !this.source.endsWith('\n');
        const payload =
          (needsLeadingNewline ? this.eol : '') + nonEmpty.map((o) => JSON.stringify(o)).join(this.eol) + this.eol;
        edits.unshift({ start: this.source.length, end: this.source.length, text: payload });
      }
    }

    return { edits, hadInvalidJson };
  }

  /** Replaces (or appends) the entire JSON record at 0-based `recordIndex` from the Record Inspector. */
  replaceRecordJson(recordIndex: number, jsonText: string): TextEdit[] | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return undefined;
    }
    const serialized = JSON.stringify(parsed);
    if (recordIndex >= 0 && recordIndex < this.records.length) {
      const rec = this.records[recordIndex];
      return [{ start: rec.start, end: rec.end, text: serialized }];
    }
    const needsNl = this.source.length > 0 && !this.source.endsWith('\n');
    return [{ start: this.source.length, end: this.source.length, text: (needsNl ? this.eol : '') + serialized + this.eol }];
  }

  private uniqueFieldName(base = 'field'): string {
    const used = new Set(this.columns);
    let idx = 1;
    while (used.has(`${base}_${idx}`)) {
      idx++;
    }
    return `${base}_${idx}`;
  }

  structure(op: StructureOp, at: number, count: number): TextEdit[] {
    const safeCount = Math.max(1, count);
    if (op === 'insertRow') {
      const template: Record<string, unknown> = {};
      if (!this.records.length) {
        for (const col of this.columns) {
          if (col !== '_raw' && col !== '_value') {
            template[col] = null;
          }
        }
      }
      const newLine = JSON.stringify(template);
      const block = Array.from({ length: safeCount }, () => newLine).join(this.eol);
      const recIdx = Math.max(0, at - 1);
      if (recIdx < this.records.length) {
        const pos = this.records[recIdx].start;
        return [{ start: pos, end: pos, text: block + this.eol }];
      }
      const needsNl = this.source.length > 0 && !this.source.endsWith('\n');
      return [{ start: this.source.length, end: this.source.length, text: (needsNl ? this.eol : '') + block + this.eol }];
    }

    if (op === 'deleteRows') {
      const r0 = Math.max(0, at - 1);
      const r1 = Math.min(this.records.length - 1, at + safeCount - 2);
      if (r0 > r1 || !this.records.length) {
        return [];
      }
      const start = this.records[r0].start;
      let end = this.records[r1].end;
      if (this.source.slice(end, end + 2) === '\r\n') {
        end += 2;
      } else if (this.source[end] === '\n') {
        end += 1;
      }
      return [{ start, end, text: '' }];
    }

    if (op === 'insertCol') {
      const newKeys: string[] = [];
      const used = new Set(this.columns);
      let idx = 1;
      for (let i = 0; i < safeCount; i++) {
        while (used.has(`field_${idx}`)) idx++;
        const k = `field_${idx++}`;
        used.add(k);
        newKeys.push(k);
      }
      if (!this.records.length) {
        const obj: Record<string, unknown> = {};
        const cols = [...this.columns];
        cols.splice(Math.max(0, Math.min(cols.length, at)), 0, ...newKeys);
        for (const c of cols) obj[c] = null;
        return [{ start: 0, end: this.source.length, text: JSON.stringify(obj) + this.eol }];
      }
      const insertAt = Math.max(0, Math.min(this.columns.length, at));
      const edits: TextEdit[] = [];
      for (let r = this.records.length - 1; r >= 0; r--) {
        const rec = this.records[r];
        if (rec.invalid || rec.isPrimitive) continue;
        const orderedCols = [...this.columns];
        orderedCols.splice(insertAt, 0, ...newKeys);
        const nextObj: Record<string, unknown> = {};
        for (const col of orderedCols) {
          if (newKeys.includes(col)) {
            nextObj[col] = null;
          } else if (col in rec.obj) {
            nextObj[col] = rec.obj[col];
          }
        }
        edits.push({ start: rec.start, end: rec.end, text: JSON.stringify(nextObj) });
      }
      return edits;
    }

    if (op === 'deleteCols') {
      const toRemove = new Set(this.columns.slice(at, at + safeCount));
      toRemove.delete('_raw');
      toRemove.delete('_value');
      if (!toRemove.size || !this.records.length) {
        return [];
      }
      const edits: TextEdit[] = [];
      for (let r = this.records.length - 1; r >= 0; r--) {
        const rec = this.records[r];
        if (rec.invalid || rec.isPrimitive) continue;
        const nextObj: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rec.obj)) {
          if (!toRemove.has(k)) {
            nextObj[k] = v;
          }
        }
        edits.push({ start: rec.start, end: rec.end, text: JSON.stringify(nextObj) });
      }
      return edits;
    }

    return [];
  }
}
