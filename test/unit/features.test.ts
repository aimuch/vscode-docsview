// Sort/filter, format conversion and Markdown export helpers.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOLBAR, normalizeToolbarConfig, type Cell } from '../../src/common/protocol';
import { rowsToDelimited, rowsToXlsx, sanitizeSheetName, workbookToDelimited, workbookToXlsx } from '../../src/host/convert';
import { parseCsv } from '../../src/host/csv/csvParser';
import { exportPage, inlineFonts, inlineImages, sanitizeExportHtml } from '../../src/host/markdown/exportPage';
import { compareCells, emptyView, isActive, numericValue, viewRows, type SheetView } from '../../src/webview/sheet/view';

// ---------------------------------------------------------------- sort & filter

describe('sheet view', () => {
  const rows: Cell[][] = [
    ['name', 'dept', 'salary'],
    ['Zoe', 'R&D', '28000'],
    ['amy', 'Design', '9500'],
    ['Bob', 'R&D', ''],
    ['Cy', 'Sales', '120000'],
    ['Al', 'r&d', '9500'],
  ];

  it('is inactive until a sort or a non-empty filter is set', () => {
    const view = emptyView();
    expect(isActive(view)).toBe(false);
    view.filters[1] = '  ';
    expect(isActive(view)).toBe(false);
    view.filters[1] = 'x';
    expect(isActive(view)).toBe(true);
  });

  it('sorts numbers numerically, keeps the header, puts blanks last and is stable', () => {
    const asc = viewRows(rows, rows.length, 1, { ...emptyView(), sortCol: 2, sortDir: 1 });
    expect(asc).toEqual([0, 2, 5, 1, 4, 3]);
    const desc = viewRows(rows, rows.length, 1, { ...emptyView(), sortCol: 2, sortDir: -1 });
    // Blanks stay last in both directions; equal values keep file order.
    expect(desc).toEqual([0, 4, 1, 2, 5, 3]);
  });

  it('sorts text naturally and case-insensitively', () => {
    const order = viewRows(rows, rows.length, 1, { ...emptyView(), sortCol: 0, sortDir: 1 });
    expect(order.map((r) => rows[r][0])).toEqual(['name', 'Al', 'amy', 'Bob', 'Cy', 'Zoe']);
  });

  it('filters by "contains", case-insensitively, combining columns', () => {
    const view: SheetView = { ...emptyView(), filters: { 1: 'r&d' } };
    expect(viewRows(rows, rows.length, 1, view)).toEqual([0, 1, 3, 5]);
    view.filters[2] = '9500';
    expect(viewRows(rows, rows.length, 1, view)).toEqual([0, 5]);
  });

  it('sorts everything when there is no header row, and ignores padding rows', () => {
    const order = viewRows(rows, 3, 0, { ...emptyView(), sortCol: 0, sortDir: 1 });
    expect(order).toEqual([2, 0, 1]);
  });

  it('reads formatted numbers and formula results', () => {
    expect(numericValue('1,299.50')).toBe(1299.5);
    expect(numericValue('¥15,594.00')).toBe(15594);
    expect(numericValue('87.65%')).toBeCloseTo(0.8765);
    expect(numericValue({ v: '10', raw: '=B2*2.5', n: true })).toBe(10);
    expect(numericValue('2024-01-05')).toBeUndefined();
    expect(compareCells('10', 'abc', 1)).toBeLessThan(0);
    expect(compareCells('', 'abc', -1)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- conversion

describe('format conversion', () => {
  const rows = [
    ['name', 'note', 'amount'],
    ['Smith, J', 'say "hi"', '12.5'],
    ['李娜', 'two\nlines', '007'],
    ['', '', ''],
  ];

  it('writes CSV and TSV with quoting, dropping empty trailing rows', () => {
    expect(rowsToDelimited(rows, 'csv')).toBe(
      'name,note,amount\n"Smith, J","say ""hi""",12.5\n李娜,"two\nlines",007\n',
    );
    const tsv = rowsToDelimited(rows, 'tsv', '\r\n');
    expect(parseCsv(tsv, '\t').map((r) => r.cells)).toEqual(rows.slice(0, 3));
    expect(tsv.endsWith('\r\n')).toBe(true);
  });

  it('builds a typed workbook from text rows', async () => {
    const bytes = await rowsToXlsx(rows, 'people.csv');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const ws = wb.worksheets[0];
    expect(ws.name).toBe('people');
    expect(ws.getCell('C2').value).toBe(12.5);
    // Identifiers with leading zeros stay text.
    expect(ws.getCell('C3').value).toBe('007');
    expect(ws.getCell('A2').value).toBe('Smith, J');
    expect(ws.getCell('B3').value).toBe('two\nlines');
  });

  it('turns a workbook sheet back into CSV with displayed values', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Data');
    ws.addRow(['item', 'price']);
    ws.addRow(['pen', 1.5]);
    ws.getCell('B2').numFmt = '0.00';
    wb.addWorksheet('Other').addRow(['x']);
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
    expect(workbookToDelimited(bytes, 0, 'csv')).toBe('item,price\npen,1.50\n');
    expect(workbookToDelimited(bytes, 1, 'tsv')).toBe('x\n');
    // Re-saving as xlsx keeps the sheets.
    const again = workbookToXlsx(bytes);
    expect(workbookToDelimited(again, 0, 'csv')).toBe('item,price\npen,1.50\n');
  });

  it('makes valid sheet names', () => {
    expect(sanitizeSheetName('a/b:c?.csv')).toBe('a_b_c_');
    expect(sanitizeSheetName('x'.repeat(40) + '.csv')).toHaveLength(31);
    expect(sanitizeSheetName('.csv')).toBe('Sheet1');
  });
});

// ---------------------------------------------------------------- Markdown export

describe('markdown export', () => {
  it('inlines woff2 fonts and drops the other formats', () => {
    const css =
      '@font-face{src:url("./assets/A.woff2") format("woff2"), url("./assets/A.woff") format("woff"), url("./assets/A.ttf") format("truetype");}';
    const out = inlineFonts(css, (path) => (path === './assets/A.woff2' ? new Uint8Array([1, 2, 3]) : undefined));
    expect(out).toBe('@font-face{src:url(data:font/woff2;base64,AQID) format("woff2");}');
  });

  it('inlines local images and leaves remote ones alone', async () => {
    const html =
      '<p><img src="assets/logo.svg" alt="a"><img src="https://x.test/a.png"><img src="data:image/png;base64,AA=="><img src="missing.png"><img src="pic%20one.png"></p>';
    const read = async (path: string) =>
      path === 'assets/logo.svg' ? new TextEncoder().encode('<svg/>') : path === 'pic one.png' ? new Uint8Array([9]) : undefined;
    const out = await inlineImages(html, read);
    expect(out).toContain('src="data:image/svg+xml;base64,PHN2Zy8+"');
    expect(out).toContain('src="https://x.test/a.png"');
    expect(out).toContain('src="data:image/png;base64,AA=="');
    expect(out).toContain('src="missing.png"');
    expect(out).toContain('src="data:image/png;base64,CQ=="');
  });

  it('builds a standalone page with theme, direction and optional print', () => {
    const base = { title: 'Notes <1>', css: 'body{}', body: '<p>x</p>', theme: 'paper' as const, dark: true, rtl: true };
    const page = exportPage({ ...base, print: false });
    expect(page).toContain('<title>Notes &lt;1&gt;</title>');
    expect(page).toContain('<body data-theme="paper" data-scheme="dark" class="dv-dark">');
    expect(page).toContain('<article class="markdown-body" dir="rtl">');
    expect(page).toContain('http-equiv="Content-Security-Policy"');
    expect(page).not.toContain('script-src');
    expect(page).not.toContain('window.print');

    const printable = exportPage({ ...base, dark: false, rtl: false, lang: 'en', print: true });
    expect(printable).toContain('<html lang="en">');
    expect(printable).toContain('window.print()');
    const nonce = /script-src 'nonce-([^']+)'/.exec(printable)?.[1];
    expect(nonce).toBeTruthy();
    expect(printable).toContain(`<script nonce="${nonce}">`);
  });

  it('strips scripts, active embeds, event handlers and unsafe URLs from exported HTML', () => {
    const dirty = [
      '<p onclick="alert(1)" title="ok">Hello</p>',
      '<scr<script>ipt>evil()</script>ipt>',
      '<iframe src="https://evil.example"></iframe>',
      '<img src="data:image/png;base64,AA==" onerror="alert(2)">',
      '<a href="javascript:alert(3)">bad1</a>',
      '<a href="&#106;avascript:alert(4)">bad2</a>',
      '<a href="data:text/html,<script>alert(5)</script>">bad3</a>',
      '<a href="https://example.com">good</a>',
    ].join('');
    const clean = sanitizeExportHtml(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('<iframe');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('onerror');
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('&#106;avascript');
    expect(clean).not.toContain('data:text/html');
    expect(clean).toContain('<p title="ok">Hello</p>');
    expect(clean).toContain('<img src="data:image/png;base64,AA==">');
    expect(clean).toContain('<a href="https://example.com">good</a>');
  });

  it('normalises custom toolbar layouts, dropping unknown and duplicate entries', () => {
    expect(normalizeToolbarConfig(null)).toEqual(DEFAULT_TOOLBAR);
    expect(
      normalizeToolbarConfig({
        left: ['zoom', 'unknown', 'zoom', 'nav'],
        right: ['nav', 'theme', 'scheme'],
      }),
    ).toEqual({
      left: ['zoom', 'nav'],
      right: ['theme', 'scheme'],
    });
  });

  it('formats pixel RGB/HEX colours and converts/parses BBoxes in px and 0–1000 scales', async () => {
    const { bboxDimensions, formatBBoxTuple, formatRgb, parseBBoxInput, rgbToHex } = await import(
      '../../src/webview/image/bbox'
    );
    expect(rgbToHex(59, 130, 246)).toBe('#3B82F6');
    expect(formatRgb(59, 130, 246, 255)).toBe('rgb(59, 130, 246)');
    expect(formatRgb(59, 130, 246, 128)).toBe('rgba(59, 130, 246, 0.50)');

    const box = { x1: 200, y1: 100, x2: 600, y2: 400 };
    expect(bboxDimensions(box)).toEqual({ w: 400, h: 300 });
    expect(formatBBoxTuple(box, 1000, 500, 'px')).toEqual([200, 100, 600, 400]);
    expect(formatBBoxTuple(box, 1000, 500, 'norm')).toEqual([200, 200, 600, 800]);

    expect(parseBBoxInput('[200, 200, 600, 800]', 1000, 500, 'norm')).toEqual({
      x1: 200,
      y1: 100,
      x2: 600,
      y2: 400,
    });
    expect(parseBBoxInput('{"bbox": [50, 40, 180, 120]}', 800, 600, 'px')).toEqual({
      x1: 50,
      y1: 40,
      x2: 180,
      y2: 120,
    });
  });
});
