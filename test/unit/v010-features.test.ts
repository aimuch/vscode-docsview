import { degrees, PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/webview/shared/api', () => ({
  el: () => ({}),
  post: () => undefined,
  t: (k: string) => k,
  config: { lang: 'en', appearance: {} },
}));
vi.mock('../../src/webview/shared/ui', () => ({
  iconButton: () => ({}),
  segmented: () => ({ node: {} }),
}));
vi.mock('../../src/webview/shared/overlayStack', () => ({
  overlayStack: { push: () => undefined, remove: () => undefined },
}));

import { buildParagraphDiff, buildSheetsDiff } from '../../src/common/docDiff';
import { diffInlineText, diffLineArrays } from '../../src/common/textDiff';
import { readParquetFile, readSqliteDatabase } from '../../src/host/database';
import { applyPdfMutations, extractPdfText, extractPdfTextWithMeta, OfficeSession } from '../../src/host/office';
import { ExcelSession, rowsToXlsx } from '../../src/host/spreadsheet';
import { extractChartDataset, renderChartSvg } from '../../src/webview/sheet/charts';
import {
  computeSelectionTextClean,
  computeSplitColumn,
  findDuplicateRowIndices,
} from '../../src/webview/sheet/cleaning';
import { computePivotSummary } from '../../src/webview/sheet/pivot';

/** Minimal valid 1x1 transparent PNG bytes. */
const ONE_BY_ONE_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

/** Builds a minimal valid SQLite 3 binary buffer with one table `users(id, name)`. */
function buildSyntheticSqlite(): Uint8Array {
  const pageSize = 4096;
  const buf = new Uint8Array(pageSize * 2);
  const view = new DataView(buf.buffer);

  // Page 1 header (100 bytes)
  const magic = new TextEncoder().encode('SQLite format 3\0');
  buf.set(magic, 0);
  view.setUint16(16, pageSize, false);
  buf[18] = 1;
  buf[19] = 1;
  buf[20] = 0; // reserved
  buf[21] = 64;
  buf[22] = 32;
  buf[23] = 32;
  view.setUint32(28, 2, false); // 2 pages
  view.setUint32(56, 1, false); // UTF-8

  const encodeVarint = (n: number): number[] => {
    if (n < 128) return [n];
    return [((n >> 7) & 0x7f) | 0x80, n & 0x7f];
  };

  const makeRecord = (vals: (string | number)[]): Uint8Array => {
    const serials: number[] = [];
    const dataParts: Uint8Array[] = [];
    const enc = new TextEncoder();
    for (const v of vals) {
      if (typeof v === 'number') {
        serials.push(1); // 1-byte signed int
        dataParts.push(new Uint8Array([v & 0xff]));
      } else {
        const bytes = enc.encode(v);
        serials.push(...encodeVarint(bytes.length * 2 + 13));
        dataParts.push(bytes);
      }
    }
    const hdrSize = 1 + serials.length;
    const bodyLen = dataParts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(hdrSize + bodyLen);
    out[0] = hdrSize;
    out.set(serials, 1);
    let pos = hdrSize;
    for (const p of dataParts) {
      out.set(p, pos);
      pos += p.length;
    }
    return out;
  };

  const writeLeafPage = (pageIdx0: number, records: Uint8Array[]) => {
    const base = pageIdx0 * pageSize;
    const hdrOff = pageIdx0 === 0 ? base + 100 : base;
    buf[hdrOff] = 0x0d; // leaf table B-tree
    view.setUint16(hdrOff + 3, records.length, false);
    let cursor = pageSize;
    records.forEach((rec, i) => {
      const pLen = encodeVarint(rec.length);
      const rowId = encodeVarint(i + 1);
      const cellLen = pLen.length + rowId.length + rec.length;
      cursor -= cellLen;
      let p = base + cursor;
      buf.set(pLen, p);
      p += pLen.length;
      buf.set(rowId, p);
      p += rowId.length;
      buf.set(rec, p);
      view.setUint16(hdrOff + 8 + i * 2, cursor, false);
    });
    view.setUint16(hdrOff + 5, cursor, false);
  };

  // Page 1: sqlite_master referencing table `users` on rootPage 2
  const masterRec = makeRecord(['table', 'users', 'users', 2, 'CREATE TABLE users (id INT, name TEXT)']);
  writeLeafPage(0, [masterRec]);

  // Page 2: two rows in `users`
  writeLeafPage(1, [makeRecord([1, 'Alice']), makeRecord([2, 'Bob'])]);
  return buf;
}

/** Builds a minimal valid Apache Parquet (PAR1) buffer with 1 INT32 column `score` = [10, 20, 30]. */
function buildSyntheticParquet(): Uint8Array {
  const out: number[] = [];
  const pushBytes = (b: Uint8Array | number[]) => {
    for (const x of b) out.push(x);
  };
  const pushVarint = (n: number) => {
    let v = n >>> 0;
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v);
  };
  const pushZigZag = (n: number) => pushVarint(n >= 0 ? n * 2 : -n * 2 - 1);
  const pushStr = (s: string) => {
    const b = new TextEncoder().encode(s);
    pushVarint(b.length);
    pushBytes(b);
  };

  // Magic PAR1
  pushBytes(new TextEncoder().encode('PAR1'));

  // Data page at offset 4
  const dataPageOffset = out.length;
  const valuesBuf = new Uint8Array(12);
  const dv = new DataView(valuesBuf.buffer);
  dv.setInt32(0, 10, true);
  dv.setInt32(4, 20, true);
  dv.setInt32(8, 30, true);

  // PageHeader struct (Thrift Compact)
  out.push((1 << 4) | 5); // field 1 (type: I32) = 0 (DATA_PAGE)
  pushZigZag(0);
  out.push((1 << 4) | 5); // field 2 (uncompressed_page_size) = 12
  pushZigZag(12);
  out.push((1 << 4) | 5); // field 3 (compressed_page_size) = 12
  pushZigZag(12);
  out.push((2 << 4) | 12); // field 5 (data_page_header: STRUCT)
  out.push((1 << 4) | 5); // num_values = 3
  pushZigZag(3);
  out.push((1 << 4) | 5); // encoding = 0 (PLAIN)
  pushZigZag(0);
  out.push(0); // end data_page_header
  out.push(0); // end PageHeader
  pushBytes(valuesBuf);
  const totalCompressedSize = out.length - dataPageOffset;

  // Footer FileMetaData
  const footerStart = out.length;
  out.push((1 << 4) | 5); // field 1: version = 1
  pushZigZag(1);
  out.push((1 << 4) | 9); // field 2: schema LIST<STRUCT> len 2 (root + 1 col)
  out.push((2 << 4) | 12);
  // SchemaElement 0: root
  out.push((4 << 4) | 8); // field 4: name
  pushStr('schema');
  out.push((1 << 4) | 5); // field 5: num_children = 1
  pushZigZag(1);
  out.push(0);
  // SchemaElement 1: score (INT32, REQUIRED)
  out.push((1 << 4) | 5); // field 1: type = 1 (INT32)
  pushZigZag(1);
  out.push((2 << 4) | 5); // field 3: repetition_type = 0 (REQUIRED)
  pushZigZag(0);
  out.push((1 << 4) | 8); // field 4: name = 'score'
  pushStr('score');
  out.push(0);
  // field 3: num_rows = 3
  out.push((1 << 4) | 6);
  pushZigZag(3);
  // field 4: row_groups LIST<STRUCT> len 1
  out.push((1 << 4) | 9);
  out.push((1 << 4) | 12);
  // RowGroup.columns (field 1: LIST<STRUCT> len 1)
  out.push((1 << 4) | 9);
  out.push((1 << 4) | 12);
  // ColumnChunk.meta_data (field 3: STRUCT)
  out.push((3 << 4) | 12);
  out.push((1 << 4) | 5); // field 1: type = 1 (INT32)
  pushZigZag(1);
  out.push((3 << 4) | 5); // field 4: codec = 0 (UNCOMPRESSED)
  pushZigZag(0);
  out.push((1 << 4) | 6); // field 5: num_values = 3
  pushZigZag(3);
  out.push((2 << 4) | 6); // field 7: total_compressed_size
  pushZigZag(totalCompressedSize);
  out.push((2 << 4) | 6); // field 9: data_page_offset
  pushZigZag(dataPageOffset);
  out.push(0); // end meta_data
  out.push(0); // end ColumnChunk
  // RowGroup.num_rows (field 3)
  out.push((2 << 4) | 6);
  pushZigZag(3);
  out.push(0); // end RowGroup
  out.push(0); // end FileMetaData

  const footerLen = out.length - footerStart;
  const lenBytes = new Uint8Array(4);
  new DataView(lenBytes.buffer).setUint32(0, footerLen, true);
  pushBytes(lenBytes);
  pushBytes(new TextEncoder().encode('PAR1'));
  return new Uint8Array(out);
}

describe('v0.10.0 features', () => {
  it('computes inline word diffs and line diffs accurately', () => {
    const inline = diffInlineText('Hello world today', 'Hello DocsView today');
    expect(inline.some((t) => t.kind === 'del' && t.text.includes('world'))).toBe(true);
    expect(inline.some((t) => t.kind === 'add' && t.text.includes('DocsView'))).toBe(true);

    const lines = diffLineArrays(['a', 'b', 'c'], ['a', 'x', 'c', 'd']);
    expect(lines.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual(['b']);
    expect(lines.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['x', 'd']);
  });

  it('builds paragraph and spreadsheet version diff reports', () => {
    const pDiff = buildParagraphDiff('v1', 'v2', ['Intro', 'Old body'], ['Intro', 'New body', 'Footer']);
    expect(pDiff.addedCount).toBeGreaterThan(0);
    expect(pDiff.removedCount).toBeGreaterThan(0);

    const sDiff = buildSheetsDiff(
      'old.xlsx',
      'new.xlsx',
      [{ name: 'Sheet1', rows: [['Name', 'Qty'], ['A', '10']] }],
      [{ name: 'Sheet1', rows: [['Name', 'Qty'], ['A', '25'], ['B', '5']] }],
    );
    expect(sDiff.changedCount).toBe(1);
    expect(sDiff.addedCount).toBe(2);
  });

  it('extracts datasets and renders Bar/Line/Pie/Scatter SVG charts', () => {
    const grid = [
      ['Month', 'Revenue', 'Cost'],
      ['Jan', '120', '80'],
      ['Feb', '180', '95'],
      ['Mar', '240', '110'],
    ];
    const ds = extractChartDataset((r, c) => grid[r]?.[c], 0, 0, 3, 2);
    expect(ds).toBeDefined();
    expect(ds!.labels).toEqual(['Jan', 'Feb', 'Mar']);
    expect(ds!.series).toHaveLength(2);

    for (const kind of ['bar', 'line', 'pie', 'scatter'] as const) {
      const svg = renderChartSvg(ds!, kind);
      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
    }
  });

  it('computes pivot summaries for count/sum/avg/min/max', () => {
    const rows = [
      ['Region', 'Sales'],
      ['East', '100'],
      ['West', '200'],
      ['East', '300'],
    ];
    const sumRes = computePivotSummary(rows, 1, 0, 1, 'sum');
    expect(sumRes.grandTotal).toBe(600);
    expect(sumRes.rows[0]).toEqual({ group: 'East', count: 2, value: 400 });

    const avgRes = computePivotSummary(rows, 1, 0, 1, 'avg');
    expect(avgRes.rows.find((r) => r.group === 'East')?.value).toBe(200);
  });

  it('performs spreadsheet data cleaning (dedupe, split column, text transforms)', () => {
    const rows = [
      ['Email', 'Tag'],
      ['a@x.com', 'one, two'],
      ['b@x.com', 'three'],
      ['a@x.com', 'one, two'],
    ];
    expect(findDuplicateRowIndices(rows, 1, [0])).toEqual([3]);

    const split = computeSplitColumn(rows, 1, 1, ',');
    expect(split.extraCols).toBe(1);
    expect(split.changes).toEqual([
      { r: 1, c: 1, text: 'one' },
      { r: 1, c: 2, text: 'two' },
      { r: 3, c: 1, text: 'one' },
      { r: 3, c: 2, text: 'two' },
    ]);

    const trimmed = computeSelectionTextClean(
      (r, c) => (r === 0 && c === 0 ? '  hello world  ' : ''),
      0,
      0,
      0,
      0,
      'trim',
    );
    expect(trimmed).toEqual([{ r: 0, c: 0, text: 'hello world' }]);

    const titled = computeSelectionTextClean(
      (r, c) => (r === 0 && c === 0 ? 'hello world' : ''),
      0,
      0,
      0,
      0,
      'title',
    );
    expect(titled).toEqual([{ r: 0, c: 0, text: 'Hello World' }]);
  });

  it('formats Excel cells with styles.xml patching and supports Undo/Redo', async () => {
    const xlsx = await rowsToXlsx(
      [
        ['Item', 'Price'],
        ['Apple', '12.5'],
      ],
      'Sheet1',
    );
    const session = await ExcelSession.open(xlsx, 'test.xlsx');
    const res = session.formatCells(0, 1, 1, 1, 1, { bold: true, bg: '#FEF08A', numFmt: '#,##0.00' });
    expect(res).toBeDefined();

    const exported = session.export();
    const reopened = await ExcelSession.open(exported, 'test.xlsx');
    const cell = reopened.sheet(0)!.rows[1][1];
    expect(typeof cell).toBe('object');
    if (cell && typeof cell === 'object') {
      const style = reopened.sheet(0)!.styles?.[cell.s ?? -1];
      expect(style?.bold).toBe(true);
      expect(style?.bg?.toLowerCase()).toContain('fef08a');
    }

    res!.undo();
    expect(session.dirty).toBe(false);
    res!.redo();
    expect(session.dirty).toBe(true);
  });

  it('embeds PDF image stamps + watermarks and extracts PDF text', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 600]);
    page.drawText('Hello DocsView PDF', { x: 40, y: 500, size: 18, font });
    const rawPdf = new Uint8Array(await doc.save());

    const extracted = await extractPdfText(rawPdf);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toContain('Hello DocsView PDF');

    const stamped = await applyPdfMutations(rawPdf, [
      {
        kind: 'addPdfImageStamp',
        page: 1,
        rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
        pngBytes: ONE_BY_ONE_PNG,
      },
      {
        kind: 'addPdfWatermark',
        watermarkPngBytes: ONE_BY_ONE_PNG,
        pageNumbers: true,
      },
    ]);
    expect(stamped.byteLength).toBeGreaterThan(rawPdf.byteLength);
    const afterText = await extractPdfText(stamped);
    expect(afterText[0]).toContain('1 / 1');
  });

  it('reads SQLite 3 binary databases without native bindings', () => {
    const db = readSqliteDatabase(buildSyntheticSqlite());
    expect(db.tables).toHaveLength(1);
    expect(db.tables[0].name).toBe('users');
    expect(db.tables[0].columns).toEqual(['id', 'name']);
    expect(db.tables[0].rows).toEqual([
      ['1', 'Alice'],
      ['2', 'Bob'],
    ]);
  });

  it('reads Apache Parquet PAR1 files without native bindings', () => {
    const pq = readParquetFile(buildSyntheticParquet());
    expect(pq.columns).toEqual(['score']);
    expect(pq.rowCount).toBe(3);
    expect(pq.rows).toEqual([['10'], ['20'], ['30']]);
  });

  it('preserves cumulative Excel styles on save and protects formula cells during formatCells', async () => {
    const xlsx = await rowsToXlsx(
      [
        ['Item', 'Price', 'Total'],
        ['Apple', '12.5', '0'],
      ],
      'Sheet1',
    );
    const session = await ExcelSession.open(xlsx, 'test.xlsx');
    // Convert C2 into a real evaluated formula cell (=B2*2 -> 25)
    session.edit(0, [{ r: 1, c: 2, text: '=B2*2' }]);
    // Apply 3 separate format patches sequentially: bold -> yellow fill -> currency numFmt
    session.formatCells(0, 1, 2, 1, 2, { bold: true });
    session.formatCells(0, 1, 2, 1, 2, { bg: '#FEF08A' });
    session.formatCells(0, 1, 2, 1, 2, { numFmt: '#,##0.00' });

    // Formula raw text must survive formatting intact in memory, while formatted display value updates!
    const memCell = session.sheet(0)!.rows[1][2];
    expect(typeof memCell).toBe('object');
    if (memCell && typeof memCell === 'object') {
      expect(memCell.raw).toBe('=B2*2');
      expect(memCell.v).toBe('25.00');
    }

    // Export & reopen: BOTH bold AND yellow bg must be preserved (not wiped by later format op)!
    const reopened = await ExcelSession.open(session.export(), 'test.xlsx');
    const diskCell = reopened.sheet(0)!.rows[1][2];
    expect(typeof diskCell).toBe('object');
    if (diskCell && typeof diskCell === 'object') {
      const style = reopened.sheet(0)!.styles?.[diskCell.s ?? -1];
      expect(style?.bold).toBe(true);
      expect(style?.bg?.toLowerCase()).toContain('fef08a');
    }
  });

  it('fills SQLite INTEGER PRIMARY KEY from B-tree rowId and handles 0-byte empty DBs', () => {
    expect(readSqliteDatabase(new Uint8Array(0)).tables).toEqual([]);

    // Build synthetic SQLite with INTEGER PRIMARY KEY stored as NULL (serial type 0) in payload
    const pageSize = 4096;
    const buf = new Uint8Array(pageSize * 2);
    const view = new DataView(buf.buffer);
    buf.set(new TextEncoder().encode('SQLite format 3\0'), 0);
    view.setUint16(16, pageSize, false);
    buf[18] = 1;
    buf[19] = 1;
    view.setUint32(28, 2, false);
    view.setUint32(56, 1, false);

    const encVarint = (n: number): number[] => (n < 128 ? [n] : [((n >> 7) & 0x7f) | 0x80, n & 0x7f]);
    const mkRec = (vals: (string | number | null)[]): Uint8Array => {
      const serials: number[] = [];
      const parts: Uint8Array[] = [];
      for (const v of vals) {
        if (v === null) {
          serials.push(0);
        } else if (typeof v === 'number') {
          serials.push(1);
          parts.push(new Uint8Array([v & 0xff]));
        } else {
          const b = new TextEncoder().encode(v);
          serials.push(...encVarint(b.length * 2 + 13));
          parts.push(b);
        }
      }
      const hdr = 1 + serials.length;
      const out = new Uint8Array(hdr + parts.reduce((s, p) => s + p.length, 0));
      out[0] = hdr;
      out.set(serials, 1);
      let pos = hdr;
      for (const p of parts) {
        out.set(p, pos);
        pos += p.length;
      }
      return out;
    };
    const writePage = (page0: number, rows: { rowId: number; rec: Uint8Array }[]) => {
      const base = page0 * pageSize;
      const hdrOff = page0 === 0 ? base + 100 : base;
      buf[hdrOff] = 0x0d;
      view.setUint16(hdrOff + 3, rows.length, false);
      let cur = pageSize;
      rows.forEach(({ rowId, rec }, i) => {
        const pl = encVarint(rec.length);
        const rid = encVarint(rowId);
        cur -= pl.length + rid.length + rec.length;
        let p = base + cur;
        buf.set(pl, p);
        p += pl.length;
        buf.set(rid, p);
        p += rid.length;
        buf.set(rec, p);
        view.setUint16(hdrOff + 8 + i * 2, cur, false);
      });
      view.setUint16(hdrOff + 5, cur, false);
    };

    writePage(0, [
      { rowId: 1, rec: mkRec(['table', 'items', 'items', 2, 'CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT)']) },
    ]);
    writePage(1, [{ rowId: 42, rec: mkRec([null, 'Widget']) }]);

    const db = readSqliteDatabase(buf);
    expect(db.tables[0].rows).toEqual([['42', 'Widget']]);
  });

  it('round-trips PDF image stamps & watermarks on rotated pages via Base64 backup and reports true page count', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([400, 600]);
    p1.setRotation(degrees(90));
    p1.drawText('Rotated Page', { x: 40, y: 300, size: 16, font });
    doc.addPage([400, 600]);
    const rawPdf = new Uint8Array(await doc.save());

    const meta = await extractPdfTextWithMeta(rawPdf, 1);
    expect(meta.totalPages).toBe(2);
    expect(meta.pages).toHaveLength(1);

    const session = await OfficeSession.open('pdf', rawPdf, 'rotated.pdf');
    await session.apply({
      kind: 'addPdfImageStamp',
      page: 1,
      rect: { x: 0.2, y: 0.2, w: 0.2, h: 0.1 },
      pngBytes: ONE_BY_ONE_PNG,
    });
    await session.apply({
      kind: 'addPdfWatermark',
      watermarkPngBytes: ONE_BY_ONE_PNG,
      pageNumbers: true,
    });
    const bkp = session.backup();
    expect(bkp).toContain('pngBytesB64');
    expect(bkp).toContain('watermarkPngBytesB64');

    const restored = await OfficeSession.open('pdf', rawPdf, 'rotated.pdf');
    await restored.restore(bkp);
    expect(restored.dirty).toBe(true);
    expect(restored.export().byteLength).toBeGreaterThan(rawPdf.byteLength);
  });

  it('skips formula cells during computeSplitColumn', () => {
    const rows = [
      ['Expr'],
      [{ v: 'a,b', raw: '=CONCAT("a",",","b")' }],
      ['x,y'],
    ];
    const split = computeSplitColumn(rows, 1, 0, ',');
    expect(split.extraCols).toBe(1);
    expect(split.changes).toEqual([
      { r: 2, c: 0, text: 'x' },
      { r: 2, c: 1, text: 'y' },
    ]);
  });
});
