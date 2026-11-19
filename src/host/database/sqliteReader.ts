// Pure TypeScript SQLite 3 binary B-tree reader (zero native or npm dependencies).
// Parses the SQLite file header, sqlite_master schema, and table B-tree pages (interior + leaf + overflow).

export interface SqliteTable {
  name: string;
  sql: string;
  columns: string[];
  rows: string[][];
  truncated?: boolean;
}

export interface SqliteDatabase {
  tables: SqliteTable[];
  pageSize: number;
}

function readVarint(buf: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let i = 0;
  for (; i < 8 && offset + i < buf.length; i++) {
    const b = buf[offset + i];
    value = value * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      return { value, next: offset + i + 1 };
    }
  }
  if (offset + 8 < buf.length) {
    value = value * 256 + buf[offset + 8];
    return { value, next: offset + 9 };
  }
  return { value, next: offset + i };
}

function readSignedIntBE(buf: Uint8Array, offset: number, byteLen: number): number {
  if (byteLen === 0) return 0;
  let v = buf[offset] & 0x80 ? -1 : 0;
  for (let i = 0; i < byteLen; i++) {
    v = v * 256 + buf[offset + i];
  }
  return v;
}

function readBigInt64BE(view: DataView, offset: number): string {
  try {
    return view.getBigInt64(offset, false).toString();
  } catch {
    const hi = view.getInt32(offset, false);
    const lo = view.getUint32(offset + 4, false);
    return String(hi * 4294967296 + lo);
  }
}

function decodeText(bytes: Uint8Array, encoding: number): string {
  if (encoding === 2) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (encoding === 3) {
    return new TextDecoder('utf-16be').decode(bytes);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

function parseCreateTableColumns(sql: string): string[] {
  const open = sql.indexOf('(');
  const close = sql.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const body = sql.slice(open + 1, close);
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`' || ch === '[') {
      quote = ch === '[' ? ']' : ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(body.slice(start).trim());

  const cols: string[] = [];
  const constraintRe = /^(?:constraint|primary\s+key|unique|check|foreign\s+key)\b/i;
  for (const part of parts) {
    if (!part || constraintRe.test(part)) continue;
    let name = '';
    if (part[0] === '"' || part[0] === '`' || part[0] === "'") {
      const end = part.indexOf(part[0], 1);
      name = end > 0 ? part.slice(1, end) : part;
    } else if (part[0] === '[') {
      const end = part.indexOf(']', 1);
      name = end > 0 ? part.slice(1, end) : part;
    } else {
      name = part.split(/\s+/)[0] ?? '';
    }
    if (name) cols.push(name);
  }
  return cols;
}

function decodeRecord(payload: Uint8Array, encoding: number): (string | number | null)[] {
  if (!payload.length) return [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const hdr = readVarint(payload, 0);
  const headerEnd = Math.min(payload.length, hdr.value);
  const serialTypes: number[] = [];
  let pos = hdr.next;
  while (pos < headerEnd) {
    const st = readVarint(payload, pos);
    serialTypes.push(st.value);
    pos = st.next;
  }

  let dataPos = headerEnd;
  const out: (string | number | null)[] = [];
  for (const st of serialTypes) {
    if (st === 0) {
      out.push(null);
    } else if (st === 1) {
      out.push(dataPos + 1 <= payload.length ? readSignedIntBE(payload, dataPos, 1) : null);
      dataPos += 1;
    } else if (st === 2) {
      out.push(dataPos + 2 <= payload.length ? readSignedIntBE(payload, dataPos, 2) : null);
      dataPos += 2;
    } else if (st === 3) {
      out.push(dataPos + 3 <= payload.length ? readSignedIntBE(payload, dataPos, 3) : null);
      dataPos += 3;
    } else if (st === 4) {
      out.push(dataPos + 4 <= payload.length ? view.getInt32(dataPos, false) : null);
      dataPos += 4;
    } else if (st === 5) {
      out.push(dataPos + 6 <= payload.length ? readSignedIntBE(payload, dataPos, 6) : null);
      dataPos += 6;
    } else if (st === 6) {
      out.push(dataPos + 8 <= payload.length ? readBigInt64BE(view, dataPos) : null);
      dataPos += 8;
    } else if (st === 7) {
      out.push(dataPos + 8 <= payload.length ? view.getFloat64(dataPos, false) : null);
      dataPos += 8;
    } else if (st === 8) {
      out.push(0);
    } else if (st === 9) {
      out.push(1);
    } else if (st >= 12 && st % 2 === 0) {
      const len = (st - 12) / 2;
      const slice = payload.subarray(dataPos, Math.min(payload.length, dataPos + len));
      out.push(`<BLOB ${slice.length} B>`);
      dataPos += len;
    } else if (st >= 13 && st % 2 === 1) {
      const len = (st - 13) / 2;
      const slice = payload.subarray(dataPos, Math.min(payload.length, dataPos + len));
      out.push(decodeText(slice, encoding));
      dataPos += len;
    } else {
      out.push(null);
    }
  }
  return out;
}

/** Reads an SQLite 3 database buffer into tables with columns and stringified rows. */
export function readSqliteDatabase(bytes: Uint8Array, maxRowsPerTable = 50_000): SqliteDatabase {
  if (bytes.length < 100) {
    throw new Error('Not a valid SQLite 3 database (file too short).');
  }
  const magic = new TextDecoder('ascii').decode(bytes.subarray(0, 16));
  if (magic !== 'SQLite format 3\0') {
    throw new Error('Not a valid SQLite 3 database (invalid header).');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rawPageSize = view.getUint16(16, false);
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
  const reserved = bytes[20];
  const usableSize = pageSize - reserved;
  const encoding = view.getUint32(56, false) || 1;
  const totalPages = Math.floor(bytes.length / pageSize);

  const pageOffset = (pageNo: number) => (pageNo - 1) * pageSize;

  const assemblePayload = (
    localStart: number,
    payloadLen: number,
  ): Uint8Array => {
    const maxLocal = usableSize - 35;
    if (payloadLen <= maxLocal) {
      return bytes.subarray(localStart, Math.min(bytes.length, localStart + payloadLen));
    }
    const minLocal = ((usableSize - 12) * 32) / 255 - 23;
    const k = Math.floor(minLocal) + ((payloadLen - Math.floor(minLocal)) % (usableSize - 4));
    const localLen = k <= maxLocal ? k : Math.floor(minLocal);
    const out = new Uint8Array(payloadLen);
    out.set(bytes.subarray(localStart, Math.min(bytes.length, localStart + localLen)), 0);
    let written = localLen;
    let nextOverflow = view.getUint32(localStart + localLen, false);
    let guard = 0;
    while (nextOverflow > 0 && nextOverflow <= totalPages && written < payloadLen && guard++ < 10_000) {
      const off = pageOffset(nextOverflow);
      const next = view.getUint32(off, false);
      const chunk = Math.min(payloadLen - written, usableSize - 4);
      out.set(bytes.subarray(off + 4, off + 4 + chunk), written);
      written += chunk;
      nextOverflow = next;
    }
    return out;
  };

  const scanTableBTree = (
    rootPage: number,
    limit: number,
  ): { records: (string | number | null)[][]; truncated: boolean } => {
    const records: (string | number | null)[][] = [];
    let truncated = false;
    const visited = new Set<number>();

    const visit = (pageNo: number) => {
      if (truncated || pageNo < 1 || pageNo > totalPages || visited.has(pageNo)) return;
      visited.add(pageNo);
      const base = pageOffset(pageNo);
      const headerOff = pageNo === 1 ? base + 100 : base;
      const pageType = bytes[headerOff];
      const cellCount = view.getUint16(headerOff + 3, false);

      if (pageType === 0x05) {
        // Interior table B-tree page
        const rightMost = view.getUint32(headerOff + 8, false);
        const ptrArray = headerOff + 12;
        for (let i = 0; i < cellCount; i++) {
          const cellOff = base + view.getUint16(ptrArray + i * 2, false);
          const childPage = view.getUint32(cellOff, false);
          visit(childPage);
          if (truncated) return;
        }
        visit(rightMost);
      } else if (pageType === 0x0d) {
        // Leaf table B-tree page
        const ptrArray = headerOff + 8;
        for (let i = 0; i < cellCount; i++) {
          if (records.length >= limit) {
            truncated = true;
            return;
          }
          const cellOff = base + view.getUint16(ptrArray + i * 2, false);
          const pLen = readVarint(bytes, cellOff);
          const rowId = readVarint(bytes, pLen.next);
          const payload = assemblePayload(rowId.next, pLen.value);
          const rec = decodeRecord(payload, encoding);
          records.push(rec);
        }
      }
    };

    visit(rootPage);
    return { records, truncated };
  };

  // Read sqlite_master on page 1
  const master = scanTableBTree(1, 5000);
  const tables: SqliteTable[] = [];

  for (const rec of master.records) {
    const type = String(rec[0] ?? '');
    const name = String(rec[1] ?? '');
    const rootPage = Number(rec[3] ?? 0);
    const sql = String(rec[4] ?? '');
    if (type !== 'table' || !name || name.startsWith('sqlite_') || rootPage < 1) {
      continue;
    }
    const columns = parseCreateTableColumns(sql);
    const { records, truncated } = scanTableBTree(rootPage, maxRowsPerTable);
    const colCount = Math.max(columns.length, records[0]?.length ?? 0);
    const finalCols =
      columns.length >= colCount
        ? columns
        : [...columns, ...Array.from({ length: colCount - columns.length }, (_, i) => `col_${columns.length + i + 1}`)];
    const rows = records.map((r) =>
      Array.from({ length: colCount }, (_, c) => (r[c] == null ? '' : String(r[c]))),
    );
    tables.push({ name, sql, columns: finalCols, rows, truncated });
  }

  return { tables, pageSize };
}
