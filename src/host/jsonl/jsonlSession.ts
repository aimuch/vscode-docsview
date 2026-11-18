// Pure JSON Lines (`.jsonl` / `.ndjson`) table session: maps each JSON line to a row,
// freezes discovered field names in row 0, and emits exact line-level TextEdits on cell edits.
import type { Cell, CellChange, HostMessage, SheetModel, StructureOp, WorkbookInfo } from '../../common/protocol';
import type { TextEdit } from '../csv/csvParser';

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

function parseEditedField(text: string, prevValue: unknown): unknown {
  const trimmed = text.trim();
  if (trimmed === '') {
    return typeof prevValue === 'string' ? '' : null;
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num) && (typeof prevValue === 'number' || !/^0\d+/.test(trimmed))) {
      return num;
    }
  }
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Keep as plain string when not valid JSON.
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

  get info(): WorkbookInfo {
    return {
      sheets: [{ name: this.fileName }],
      editable: true,
      canStructure: true,
      hasSource: true,
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
    const headerRow: Cell[] = this.columns.map((col) => ({ v: col, s: 0, ro: true }));
    const bodyRows: Cell[][] = this.records.map((rec) =>
      this.columns.map((col) => formatJsonField(rec.obj[col])),
    );
    const rows = [headerRow, ...bodyRows];
    return {
      name: this.fileName,
      rowCount: Math.max(rows.length, 2),
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

  editCells(changes: readonly CellChange[]): TextEdit[] {
    const byRecord = new Map<number, CellChange[]>();
    let appendObjects: Record<string, unknown>[] | undefined;

    for (const ch of changes) {
      if (ch.r === 0 || ch.c < 0 || ch.c >= this.columns.length) {
        continue; // Row 0 is the frozen schema header.
      }
      const recIdx = ch.r - 1;
      if (recIdx >= 0 && recIdx < this.records.length) {
        let list = byRecord.get(recIdx);
        if (!list) {
          byRecord.set(recIdx, (list = []));
        }
        list.push(ch);
      } else if (recIdx >= this.records.length && ch.text.trim() !== '') {
        appendObjects ??= [];
        const relIdx = recIdx - this.records.length;
        while (appendObjects.length <= relIdx) {
          appendObjects.push({});
        }
        appendObjects[relIdx][this.columns[ch.c]] = parseEditedField(ch.text, undefined);
      }
    }

    const edits: TextEdit[] = [];
    for (const [recIdx, recChanges] of [...byRecord.entries()].sort((a, b) => b[0] - a[0])) {
      const rec = this.records[recIdx];
      if (rec.invalid && recChanges.some((c) => this.columns[c.c] === '_raw')) {
        const rawEdit = recChanges.find((c) => this.columns[c.c] === '_raw')!;
        edits.push({ start: rec.start, end: rec.end, text: rawEdit.text.replace(/\r?\n/g, ' ') });
        continue;
      }
      if (rec.isPrimitive && this.columns.length === 1 && this.columns[0] === '_value') {
        const val = parseEditedField(recChanges[recChanges.length - 1].text, rec.obj._value);
        edits.push({ start: rec.start, end: rec.end, text: JSON.stringify(val) });
        continue;
      }
      const clone: Record<string, unknown> = { ...rec.obj };
      delete clone._raw;
      for (const ch of recChanges) {
        const key = this.columns[ch.c];
        clone[key] = parseEditedField(ch.text, clone[key]);
      }
      edits.push({ start: rec.start, end: rec.end, text: JSON.stringify(clone) });
    }

    if (appendObjects?.length) {
      const nonEmpty = appendObjects.filter((o) => Object.keys(o).length > 0);
      if (nonEmpty.length) {
        const needsLeadingNewline = this.source.length > 0 && !this.source.endsWith('\n');
        const payload = (needsLeadingNewline ? this.eol : '') + nonEmpty.map((o) => JSON.stringify(o)).join(this.eol) + this.eol;
        edits.unshift({ start: this.source.length, end: this.source.length, text: payload });
      }
    }

    return edits;
  }

  structure(op: StructureOp, at: number, count: number): TextEdit[] {
    if (op === 'insertRow') {
      const template: Record<string, unknown> = {};
      for (const col of this.columns) {
        if (col !== '_raw' && col !== '_value') {
          template[col] = '';
        }
      }
      const newLine = JSON.stringify(template);
      const recIdx = Math.max(0, at - 1);
      if (recIdx < this.records.length) {
        const pos = this.records[recIdx].start;
        return [{ start: pos, end: pos, text: newLine + this.eol }];
      }
      const needsNl = this.source.length > 0 && !this.source.endsWith('\n');
      return [{ start: this.source.length, end: this.source.length, text: (needsNl ? this.eol : '') + newLine + this.eol }];
    }

    if (op === 'deleteRows') {
      const r0 = Math.max(0, at - 1);
      const r1 = Math.min(this.records.length - 1, at + count - 2);
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

    return [];
  }
}
