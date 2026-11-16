// RFC 4180 style CSV parsing that keeps the character range of every record, so a cell
// edit can be turned into a minimal text edit instead of rewriting the whole file.
// Pure module: used by the VS Code provider, the dev harness and unit tests.
import type { CellChange } from '../../common/protocol';

export interface CsvRecord {
  /** Offset of the first character of the record. */
  start: number;
  /** Offset just past the last character, excluding the line terminator. */
  end: number;
  cells: string[];
}

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

const CANDIDATES = [',', ';', '\t', '|'];

/** Picks the delimiter that splits the first lines most consistently. */
export function detectDelimiter(text: string, fileName = ''): string {
  if (/\.tsv$/i.test(fileName)) {
    return '\t';
  }
  const counts = CANDIDATES.map(() => [] as number[]);
  let inQuotes = false;
  let line = CANDIDATES.map(() => 0);
  let lines = 0;
  const flush = () => {
    line.forEach((n, i) => counts[i].push(n));
    line = CANDIDATES.map(() => 0);
    lines++;
  };
  const limit = Math.min(text.length, 64 * 1024);
  let sawContent = false;
  let atFieldStart = true;
  for (let i = 0; i < limit && lines < 20; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < limit && text[i + 1] === '"') {
          i++;
        } else {
          inQuotes = false;
        }
      }
    } else if (ch === '"' && atFieldStart) {
      inQuotes = true;
      sawContent = true;
      atFieldStart = false;
    } else if (ch === '\n' || ch === '\r') {
      if (sawContent) {
        flush();
      }
      sawContent = false;
      atFieldStart = true;
    } else {
      sawContent = true;
      const idx = CANDIDATES.indexOf(ch);
      if (idx >= 0) {
        line[idx]++;
        atFieldStart = true;
      } else {
        atFieldStart = false;
      }
    }
  }
  if (sawContent) {
    flush();
  }

  let best = ',';
  let bestScore = 0;
  CANDIDATES.forEach((candidate, i) => {
    const perLine = counts[i];
    if (!perLine.length) {
      return;
    }
    const min = Math.min(...perLine);
    const total = perLine.reduce((a, b) => a + b, 0);
    // A delimiter that appears the same number of times on every line beats one that merely appears a lot.
    const consistent = min > 0 && perLine.every((n) => n === perLine[0]);
    const score = consistent ? 1_000_000 + total : min > 0 ? 1000 + total : total / 1000;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  });
  return best;
}

/** Scans one field starting at `pos`; returns its value and the offset just past it. */
function scanField(text: string, pos: number, delimiter: string): { value: string; end: number } {
  const n = text.length;
  let value = '';
  if (text.charCodeAt(pos) === 34 /* " */) {
    pos++;
    for (;;) {
      const quote = text.indexOf('"', pos);
      if (quote < 0) {
        value += text.slice(pos);
        pos = n;
        break;
      }
      value += text.slice(pos, quote);
      if (text.charCodeAt(quote + 1) === 34) {
        value += '"';
        pos = quote + 2;
        continue;
      }
      pos = quote + 1;
      break;
    }
  }
  // Unquoted content (also tolerates stray text after a closing quote).
  let end = pos;
  while (end < n) {
    const ch = text[end];
    if (ch === delimiter || ch === '\n' || ch === '\r') {
      break;
    }
    end++;
  }
  return { value: value + text.slice(pos, end), end };
}

export function parseCsv(text: string, delimiter: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  const n = text.length;
  let pos = 0;
  while (pos < n) {
    const start = pos;
    const cells: string[] = [];
    for (;;) {
      const field = scanField(text, pos, delimiter);
      cells.push(field.value);
      pos = field.end;
      if (pos < n && text[pos] === delimiter) {
        pos++;
        continue;
      }
      break;
    }
    records.push({ start, end: pos, cells });
    if (text[pos] === '\r') {
      pos++;
    }
    if (text[pos] === '\n') {
      pos++;
    }
  }
  return records;
}

/** Raw text range (quotes included) of each cell in a record. */
export function locateCells(text: string, record: CsvRecord, delimiter: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let pos = record.start;
  for (;;) {
    const field = scanField(text, pos, delimiter);
    const end = Math.min(field.end, record.end);
    ranges.push({ start: pos, end });
    pos = end;
    if (pos < record.end && text[pos] === delimiter) {
      pos++;
      continue;
    }
    break;
  }
  return ranges;
}

export function serializeCell(value: string, delimiter: string): string {
  if (value.includes(delimiter) || /["\r\n]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function serializeRecord(cells: string[], delimiter: string): string {
  return cells.map((c) => serializeCell(c, delimiter)).join(delimiter);
}

export function applyEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let pos = 0;
  for (const edit of sorted) {
    out += text.slice(pos, edit.start) + edit.text;
    pos = edit.end;
  }
  return out + text.slice(pos);
}

/** Many small edits are slower to apply than one big replace; collapse them past a threshold. */
function compact(text: string, edits: TextEdit[]): TextEdit[] {
  if (edits.length <= 500) {
    return edits;
  }
  return [{ start: 0, end: text.length, text: applyEdits(text, edits) }];
}

export interface CsvContext {
  text: string;
  records: CsvRecord[];
  delimiter: string;
  eol: string;
}

/** Text to append at the end of the file to add `rows` as new records. */
function appendRows(ctx: CsvContext, rows: string[][]): TextEdit {
  const { text, eol, delimiter } = ctx;
  const body = rows.map((r) => serializeRecord(r, delimiter)).join(eol);
  const endsWithEol = /[\r\n]$/.test(text);
  const insert = text.length === 0 ? body : endsWithEol ? body + eol : eol + body;
  return { start: text.length, end: text.length, text: insert };
}

export function editCells(ctx: CsvContext, changes: CellChange[]): TextEdit[] {
  const { text, records, delimiter } = ctx;
  const byRow = new Map<number, CellChange[]>();
  for (const change of changes) {
    if (change.r < 0 || change.c < 0) {
      continue;
    }
    let list = byRow.get(change.r);
    if (!list) {
      byRow.set(change.r, (list = []));
    }
    list.push(change);
  }

  const edits: TextEdit[] = [];
  const appended = new Map<number, string[]>();
  for (const [r, list] of byRow) {
    if (r >= records.length) {
      const cells = appended.get(r) ?? [];
      for (const { c, text: value } of list) {
        while (cells.length <= c) {
          cells.push('');
        }
        cells[c] = value;
      }
      appended.set(r, cells);
      continue;
    }
    const record = records[r];
    const ranges = locateCells(text, record, delimiter);
    const tail: string[] = [];
    for (const { c, text: value } of list) {
      if (c < ranges.length) {
        edits.push({ start: ranges[c].start, end: ranges[c].end, text: serializeCell(value, delimiter) });
      } else {
        const i = c - ranges.length;
        while (tail.length <= i) {
          tail.push('');
        }
        tail[i] = value;
      }
    }
    if (tail.length) {
      edits.push({ start: record.end, end: record.end, text: delimiter + serializeRecord(tail, delimiter) });
    }
  }

  if (appended.size) {
    const last = Math.max(...appended.keys());
    const rows: string[][] = [];
    for (let r = records.length; r <= last; r++) {
      rows.push(appended.get(r) ?? ['']);
    }
    edits.push(appendRows(ctx, rows));
  }
  return compact(text, edits);
}

export function insertRows(ctx: CsvContext, at: number, count: number, colCount: number): TextEdit[] {
  const { records, delimiter, eol } = ctx;
  const blank = new Array<string>(Math.max(1, colCount)).fill('');
  const rows = Array.from({ length: count }, () => blank);
  if (at >= records.length) {
    return [appendRows(ctx, rows)];
  }
  const pos = records[at].start;
  return [{ start: pos, end: pos, text: rows.map((r) => serializeRecord(r, delimiter) + eol).join('') }];
}

export function deleteRows(ctx: CsvContext, at: number, count: number): TextEdit[] {
  const { text, records } = ctx;
  if (at >= records.length || count <= 0) {
    return [];
  }
  const last = Math.min(records.length, at + count);
  if (last < records.length) {
    return [{ start: records[at].start, end: records[last].start, text: '' }];
  }
  // Deleting through the final record: drop the preceding line break instead, keeping any trailing one.
  const start = at > 0 ? records[at - 1].end : 0;
  const end = at > 0 ? records[records.length - 1].end : text.length;
  return [{ start, end, text: '' }];
}

export function insertCols(ctx: CsvContext, at: number, count: number): TextEdit[] {
  const { text, records, delimiter } = ctx;
  const edits: TextEdit[] = [];
  for (const record of records) {
    const ranges = locateCells(text, record, delimiter);
    if (at < ranges.length) {
      edits.push({ start: ranges[at].start, end: ranges[at].start, text: delimiter.repeat(count) });
    } else {
      // Short (ragged) rows are padded so the new column exists everywhere.
      edits.push({ start: record.end, end: record.end, text: delimiter.repeat(at - ranges.length + count) });
    }
  }
  return compact(text, edits);
}

export function deleteCols(ctx: CsvContext, at: number, count: number): TextEdit[] {
  const { text, records, delimiter } = ctx;
  const edits: TextEdit[] = [];
  for (const record of records) {
    const ranges = locateCells(text, record, delimiter);
    if (at >= ranges.length) {
      continue;
    }
    const last = at + count;
    if (last < ranges.length) {
      edits.push({ start: ranges[at].start, end: ranges[last].start, text: '' });
    } else {
      // Removing the trailing cells: take the delimiter in front of them as well.
      edits.push({ start: at > 0 ? ranges[at - 1].end : record.start, end: record.end, text: '' });
    }
  }
  return compact(text, edits);
}
