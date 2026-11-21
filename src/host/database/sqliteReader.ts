// Pure TypeScript SQLite 3 binary B-tree reader (zero native or npm dependencies).
// Parses the SQLite file header, sqlite_master schema, table B-trees (0x05/0x0d),
// WITHOUT ROWID index B-trees (0x02/0x0a), overflow pages, and INTEGER PRIMARY KEY rowid aliases.

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
  isWal?: boolean;
}

const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

function readVarintBig(buf: Uint8Array, offset: number): { value: bigint; next: number } {
  let value = 0n;
  let i = 0;
  for (; i < 8 && offset + i < buf.length; i++) {
    const b = buf[offset + i];
    value = (value << 7n) | BigInt(b & 0x7f);
    if ((b & 0x80) === 0) {
      return { value, next: offset + i + 1 };
    }
  }
  if (offset + 8 < buf.length) {
    value = (value << 8n) | BigInt(buf[offset + 8]);
    // 64-bit two's complement signed conversion
    if (value >= 1n << 63n) {
      value -= 1n << 64n;
    }
    return { value, next: offset + 9 };
  }
  return { value, next: offset + i };
}

function readVarint(buf: Uint8Array, offset: number): { value: number; next: number } {
  const r = readVarintBig(buf, offset);
  return { value: Number(r.value), next: r.next };
}

function readSignedIntBE(buf: Uint8Array, offset: number, byteLen: number): number {
  if (byteLen === 0 || offset + byteLen > buf.length) return 0;
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

function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < sql.length) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += sql[i + 1];
          i += 2;
          continue;
        }
        quote = null;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

interface ParsedCreateTable {
  columns: string[];
  rowidAliasCol: number;
  withoutRowId: boolean;
}

function parseCreateTable(sql: string): ParsedCreateTable {
  const clean = stripSqlComments(sql);
  const open = clean.indexOf('(');
  const close = clean.lastIndexOf(')');
  if (open < 0 || close <= open) {
    return { columns: [], rowidAliasCol: -1, withoutRowId: false };
  }
  const tail = clean.slice(close + 1);
  const withoutRowId = /\bwithout\s+rowid\b/i.test(tail);
  const body = clean.slice(open + 1, close);

  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote) {
        if (body[i + 1] === quote) {
          i++;
          continue;
        }
        quote = null;
      }
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
  let rowidAliasCol = -1;
  let tablePkCol: string | undefined;
  const constraintRe = /^(?:constraint|primary\s+key|unique|check|foreign\s+key)\b/i;

  for (const part of parts) {
    if (!part) continue;
    if (constraintRe.test(part)) {
      const m = /primary\s+key\s*\(\s*([^,)]+)\s*\)/i.exec(part);
      if (m) {
        tablePkCol = m[1].trim().replace(/^["'`[]|["'`\]]$/g, '').toLowerCase();
      }
      continue;
    }
    let name = '';
    let rest = '';
    if (part[0] === '"' || part[0] === '`' || part[0] === "'") {
      const q = part[0];
      let j = 1;
      while (j < part.length) {
        if (part[j] === q) {
          if (part[j + 1] === q) {
            name += q;
            j += 2;
            continue;
          }
          break;
        }
        name += part[j++];
      }
      rest = part.slice(j + 1).trim();
    } else if (part[0] === '[') {
      const end = part.indexOf(']', 1);
      name = end > 0 ? part.slice(1, end) : part;
      rest = end > 0 ? part.slice(end + 1).trim() : '';
    } else {
      const m = /^(\S+)([\s\S]*)$/.exec(part);
      name = m?.[1] ?? '';
      rest = m?.[2]?.trim() ?? '';
    }
    if (!name) continue;
    const colIdx = cols.length;
    cols.push(name);
    if (!withoutRowId && /^integer\b/i.test(rest) && /\bprimary\s+key\b/i.test(rest) && !/\bdesc\b/i.test(rest)) {
      rowidAliasCol = colIdx;
    } else if (!withoutRowId && tablePkCol && name.toLowerCase() === tablePkCol && /^integer\b/i.test(rest)) {
      rowidAliasCol = colIdx;
    }
  }
  return { columns: cols, rowidAliasCol, withoutRowId };
}

function decodeRecord(payload: Uint8Array, encoding: number): (string | number | null)[] {
  if (!payload.length) return [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const hdr = readVarint(payload, 0);
  if (hdr.value <= 0 || hdr.value > payload.length) return [];
  const headerEnd = hdr.value;
  const serialTypes: number[] = [];
  let pos = hdr.next;
  while (pos < headerEnd) {
    const st = readVarint(payload, pos);
    serialTypes.push(st.value);
    if (st.next <= pos) break;
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
  if (bytes.length === 0) {
    return { tables: [], pageSize: 4096, isWal: false };
  }
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
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) {
    throw new Error(`Invalid SQLite page size (${pageSize}).`);
  }
  const reserved = bytes[20];
  const usableSize = pageSize - reserved;
  if (usableSize < 480) {
    throw new Error(`Invalid SQLite usable page size (${usableSize}).`);
  }
  const isWal = bytes[18] === 2 || bytes[19] === 2;
  const encoding = view.getUint32(56, false) || 1;
  const totalPages = Math.floor(bytes.length / pageSize);

  const pageOffset = (pageNo: number) => (pageNo - 1) * pageSize;

  const assemblePayload = (
    localStart: number,
    payloadLen: number,
    isIndex: boolean,
  ): Uint8Array => {
    if (payloadLen <= 0 || payloadLen > MAX_PAYLOAD_BYTES || localStart < 0 || localStart >= bytes.length) {
      return new Uint8Array(0);
    }
    const maxLocal = isIndex ? Math.floor(((usableSize - 12) * 64) / 255) - 23 : usableSize - 35;
    if (payloadLen <= maxLocal) {
      return bytes.subarray(localStart, Math.min(bytes.length, localStart + payloadLen));
    }
    const minLocal = Math.floor(((usableSize - 12) * 32) / 255) - 23;
    const k = minLocal + ((payloadLen - minLocal) % (usableSize - 4));
    const localLen = k <= maxLocal ? k : minLocal;
    if (localStart + localLen + 4 > bytes.length) {
      return bytes.subarray(localStart, Math.min(bytes.length, localStart + Math.max(0, localLen)));
    }
    const out = new Uint8Array(payloadLen);
    out.set(bytes.subarray(localStart, localStart + localLen), 0);
    let written = localLen;
    let nextOverflow = view.getUint32(localStart + localLen, false);
    let guard = 0;
    const seenOverflow = new Set<number>();
    while (
      nextOverflow > 0 &&
      nextOverflow <= totalPages &&
      !seenOverflow.has(nextOverflow) &&
      written < payloadLen &&
      guard++ < 10_000
    ) {
      seenOverflow.add(nextOverflow);
      const off = pageOffset(nextOverflow);
      if (off + 4 > bytes.length) break;
      const next = view.getUint32(off, false);
      const chunk = Math.min(payloadLen - written, usableSize - 4, Math.max(0, bytes.length - (off + 4)));
      if (chunk <= 0) break;
      out.set(bytes.subarray(off + 4, off + 4 + chunk), written);
      written += chunk;
      nextOverflow = next;
    }
    return out;
  };

  const scanBTree = (
    rootPage: number,
    limit: number,
  ): { records: { rowId?: bigint; values: (string | number | null)[] }[]; truncated: boolean } => {
    const records: { rowId?: bigint; values: (string | number | null)[] }[] = [];
    let truncated = false;
    const visited = new Set<number>();

    const visit = (pageNo: number) => {
      if (truncated || pageNo < 1 || pageNo > totalPages || visited.has(pageNo)) return;
      visited.add(pageNo);
      const base = pageOffset(pageNo);
      const headerOff = pageNo === 1 ? base + 100 : base;
      if (headerOff + 8 > bytes.length) return;
      const pageType = bytes[headerOff];
      const cellCount = view.getUint16(headerOff + 3, false);

      if (pageType === 0x05) {
        if (headerOff + 12 + cellCount * 2 > bytes.length) return;
        const rightMost = view.getUint32(headerOff + 8, false);
        const ptrArray = headerOff + 12;
        for (let i = 0; i < cellCount; i++) {
          const cellOff = base + view.getUint16(ptrArray + i * 2, false);
          if (cellOff + 4 > bytes.length) continue;
          const childPage = view.getUint32(cellOff, false);
          visit(childPage);
          if (truncated) return;
        }
        visit(rightMost);
      } else if (pageType === 0x0d) {
        if (headerOff + 8 + cellCount * 2 > bytes.length) return;
        const ptrArray = headerOff + 8;
        for (let i = 0; i < cellCount; i++) {
          if (records.length >= limit) {
            truncated = true;
            return;
          }
          const cellOff = base + view.getUint16(ptrArray + i * 2, false);
          if (cellOff >= bytes.length) continue;
          const pLen = readVarint(bytes, cellOff);
          const rowId = readVarintBig(bytes, pLen.next);
          const payload = assemblePayload(rowId.next, pLen.value, false);
          const values = decodeRecord(payload, encoding);
          records.push({ rowId: rowId.value, values });
        }
      } else if (pageType === 0x02) {
        // Interior index B-tree page (used by WITHOUT ROWID tables)
        if (headerOff + 12 + cellCount * 2 > bytes.length) return;
        const rightMost = view.getUint32(headerOff + 8, false);
        const ptrArray = headerOff + 12;
        for (let i = 0; i < cellCount; i++) {
          const cellOff = base + view.getUint16(ptrArray + i * 2, false);
          if (cellOff + 4 > bytes.length) continue;
          const childPage = view.getUint32(cellOff, false);
          visit(childPage);
          if (truncated) return;
          if (records.length >= limit) {
            truncated = true;
            return;
          }
          const pLen = readVarint(bytes, cellOff + 4);
          const payload = assemblePayload(pLen.next, pLen.value, true);
          records.push({ values: decodeRecord(payload, encoding) });
        }
        visit(rightMost);
      } else if (pageType === 0x0a) {
        // Leaf index B-tree page (used by WITHOUT ROWID tables)
        if (headerOff + 8 + cellCount * 2 > bytes.length) return;
        const ptrArray = headerOff + 8;
        for (let i = 0; i < cellCount; i++) {
          if (records.length >= limit) {
            truncated = true;
            return;
          }
          const cellOff = base + view.getUint16(ptrArray + i * 2, false);
          if (cellOff >= bytes.length) continue;
          const pLen = readVarint(bytes, cellOff);
          const payload = assemblePayload(pLen.next, pLen.value, true);
          records.push({ values: decodeRecord(payload, encoding) });
        }
      }
    };

    visit(rootPage);
    return { records, truncated };
  };

  // Read sqlite_master on page 1
  const master = scanBTree(1, 5000);
  const tables: SqliteTable[] = [];

  for (const entry of master.records) {
    const rec = entry.values;
    const type = String(rec[0] ?? '');
    const name = String(rec[1] ?? '');
    const rootPage = Number(rec[3] ?? 0);
    const sql = String(rec[4] ?? '');
    if (type !== 'table' || !name || name.startsWith('sqlite_') || rootPage < 1) {
      continue;
    }
    const { columns, rowidAliasCol } = parseCreateTable(sql);
    const { records, truncated } = scanBTree(rootPage, maxRowsPerTable);
    const colCount = Math.max(columns.length, records[0]?.values.length ?? 0);
    const finalCols =
      columns.length >= colCount
        ? columns
        : [...columns, ...Array.from({ length: colCount - columns.length }, (_, i) => `col_${columns.length + i + 1}`)];
    const rows = records.map(({ rowId, values }) =>
      Array.from({ length: colCount }, (_, c) => {
        const val = values[c];
        if (val == null && c === rowidAliasCol && rowId !== undefined) {
          return rowId.toString();
        }
        return val == null ? '' : String(val);
      }),
    );
    tables.push({ name, sql, columns: finalCols, rows, truncated });
  }

  return { tables, pageSize, isWal };
}
