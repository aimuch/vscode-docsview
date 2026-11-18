// Sort/filter, format conversion and Markdown export helpers.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOLBAR, normalizeToolbarConfig, type Cell } from '../../src/common/protocol';
import { rowsToDelimited, rowsToXlsx, sanitizeSheetName, workbookToDelimited, workbookToXlsx } from '../../src/host/convert';
import { parseCsv } from '../../src/host/csv/csvParser';
import { exportPage, inlineFonts, inlineImages, sanitizeExportHtml } from '../../src/host/markdown/exportPage';
import {
  compareCells,
  computeSelectionStats,
  emptyView,
  isActive,
  numericValue,
  selectionToMarkdownTable,
  viewRows,
  type SheetView,
} from '../../src/webview/sheet/view';

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

  it('computes live selection stats (count, sum, avg, min, max) across multi-cell ranges', () => {
    const statRows: Cell[][] = [
      ['Item', 'Revenue'],
      ['Alpha', '$100.00'],
      ['Beta', '250'],
      ['Gamma', ''],
      ['Delta', '50%'],
    ];
    const cellAt = (r: number, c: number) => statRows[r]?.[c];
    // Single cell returns undefined (no status clutter for 1x1 selection)
    expect(computeSelectionStats(cellAt, 1, 1, 1, 1)).toBeUndefined();

    const stats = computeSelectionStats(cellAt, 1, 0, 4, 1);
    expect(stats).toBeDefined();
    expect(stats!.count).toBe(7); // 4 names + 3 non-empty values (Gamma's revenue is blank)
    expect(stats!.numCount).toBe(3); // 100, 250, 0.5
    expect(stats!.sum).toBeCloseTo(350.5);
    expect(stats!.avg).toBeCloseTo(350.5 / 3);
    expect(stats!.min).toBeCloseTo(0.5);
    expect(stats!.max).toBe(250);

    // GFM Markdown table export with pipe escaping, multiline <br> & numeric right-alignment
    const mdRows: Cell[][] = [
      ['Metric | Name', 'Q1 Value'],
      ['Users\nActive', '1,250'],
      ['Conversion', '12.5%'],
    ];
    const mdOut = selectionToMarkdownTable((r, c) => mdRows[r]?.[c], 0, 0, 2, 1);
    expect(mdOut).toBe(
      [
        '| Metric \\| Name | Q1 Value |',
        '| --- | ---: |',
        '| Users<br>Active | 1,250 |',
        '| Conversion | 12.5% |',
      ].join('\n'),
    );
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

  it('formats pixel RGB/HEX colours, parses pixel BBoxes, crops RGBA/SVG and encodes BMP & ICO', async () => {
    const {
      bboxDimensions,
      cropRgba,
      cropSvgMarkup,
      encodeBmp,
      encodeIcoFromPng,
      formatBBoxTuple,
      formatRgb,
      parseBBoxInput,
      rgbToHex,
    } = await import('../../src/webview/image/bbox');
    expect(rgbToHex(7, 7, 8)).toBe('#070708');
    expect(rgbToHex(59, 130, 246)).toBe('#3B82F6');
    expect(formatRgb(59, 130, 246, 255)).toBe('rgb(59, 130, 246)');
    expect(formatRgb(59, 130, 246, 128)).toBe('rgba(59, 130, 246, 0.50)');

    const box = { x1: 200, y1: 100, x2: 600, y2: 400 };
    expect(bboxDimensions(box)).toEqual({ w: 400, h: 300 });
    expect(formatBBoxTuple(box)).toEqual([200, 100, 600, 400]);

    expect(parseBBoxInput('[200, 100, 600, 400]', 1000, 500)).toEqual({
      x1: 200,
      y1: 100,
      x2: 600,
      y2: 400,
    });
    expect(parseBBoxInput('{"bbox": [50, 40, 180, 120]}', 800, 600)).toEqual({
      x1: 50,
      y1: 40,
      x2: 180,
      y2: 120,
    });

    // Pure RGBA cropping (2x2 -> bottom-right 1x1 pixel)
    const src = new Uint8ClampedArray([
      10, 20, 30, 255, 40, 50, 60, 255,
      70, 80, 90, 255, 11, 22, 33, 255,
    ]);
    const cropped = cropRgba(src, 2, 2, { x1: 1, y1: 1, x2: 2, y2: 2 });
    expect([cropped.width, cropped.height, ...cropped.data]).toEqual([1, 1, 11, 22, 33, 255]);

    // 24-bit opaque BMP & 32-bit translucent BMP headers + BGR order
    const bmp24 = encodeBmp(cropped.data, 1, 1);
    expect([bmp24[0], bmp24[1]]).toEqual([0x42, 0x4d]); // 'BM'
    expect(new DataView(bmp24.buffer).getUint16(28, true)).toBe(24);
    expect([bmp24[54], bmp24[55], bmp24[56]]).toEqual([33, 22, 11]); // BGR

    const alphaPx = new Uint8ClampedArray([100, 150, 200, 128]);
    const bmp32 = encodeBmp(alphaPx, 1, 1);
    expect(new DataView(bmp32.buffer).getUint16(28, true)).toBe(32);
    expect([bmp32[54], bmp32[55], bmp32[56], bmp32[57]]).toEqual([200, 150, 100, 128]); // BGRA

    // ICO wrapper around PNG payload
    const fakePng = new Uint8Array([137, 80, 78, 71]);
    const ico = encodeIcoFromPng(fakePng, 256, 64);
    expect([ico[2], ico[4], ico[6], ico[7]]).toEqual([1, 1, 0, 64]); // 256 encoded as 0 per ICO spec
    expect([...ico.slice(22)]).toEqual([137, 80, 78, 71]);

    // Vector SVG viewBox crop
    const svgBytes = cropSvgMarkup(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100"/></svg>',
      200,
      100,
      { x1: 50, y1: 20, x2: 150, y2: 70 },
    );
    const svgOut = new TextDecoder().decode(svgBytes);
    expect(svgOut).toContain('viewBox="50 20 100 50"');
    expect(svgOut).toContain('width="100"');
    expect(svgOut).toContain('height="50"');

    // Pure RGBA 90° CW/CCW rotation & H/V flip on a 2x1 image ([Red, Blue])
    const { resizeSvgMarkup, transformRgba } = await import('../../src/webview/image/bbox');
    const twoByOne = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]);
    const cw = transformRgba(twoByOne, 2, 1, 'rotCW');
    expect([cw.width, cw.height, ...cw.data]).toEqual([1, 2, 255, 0, 0, 255, 0, 0, 255, 255]);
    const ccw = transformRgba(twoByOne, 2, 1, 'rotCCW');
    expect([ccw.width, ccw.height, ...ccw.data]).toEqual([1, 2, 0, 0, 255, 255, 255, 0, 0, 255]);
    const fh = transformRgba(twoByOne, 2, 1, 'flipH');
    expect([fh.width, fh.height, ...fh.data]).toEqual([2, 1, 0, 0, 255, 255, 255, 0, 0, 255]);
    const fv = transformRgba(cw.data, 1, 2, 'flipV');
    expect([fv.width, fv.height, ...fv.data]).toEqual([1, 2, 0, 0, 255, 255, 255, 0, 0, 255]);

    // Vector SVG resize (adds viewBox if missing so artwork scales cleanly)
    const resizedSvg = new TextDecoder().decode(
      resizeSvgMarkup('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><circle r="10"/></svg>', 100, 50, 300, 150),
    );
    expect(resizedSvg).toContain('viewBox="0 0 100 50"');
    expect(resizedSvg).toContain('width="300"');
    expect(resizedSvg).toContain('height="150"');

    // BBox rotation / flip coordinate mapping
    const { transformBBoxes } = await import('../../src/webview/image/bbox');
    const origBox = [{ x1: 10, y1: 20, x2: 30, y2: 50 }];
    expect(transformBBoxes(origBox, 100, 80, 'rotCW')).toEqual([{ x1: 30, y1: 10, x2: 60, y2: 30 }]);
    expect(transformBBoxes(origBox, 100, 80, 'flipH')).toEqual([{ x1: 70, y1: 20, x2: 90, y2: 50 }]);

    // Memory-bounded ImageSession: nulls out evicted step buffers for GC while preserving dirty & initialBytes
    const { ImageSession, MAX_IMAGE_HISTORY_STEPS } = await import('../../src/host/imageSession');
    const initImg = new Uint8Array([1, 2, 3]);
    const imgSession = new ImageSession(initImg);
    expect(imgSession.dirty).toBe(false);
    const handles = [];
    for (let i = 1; i <= MAX_IMAGE_HISTORY_STEPS + 4; i++) {
      handles.push(imgSession.replace(new Uint8Array([i])));
    }
    expect(imgSession.dirty).toBe(true);
    // Earliest steps have released their byte references (`undefined`) to allow GC
    expect(handles[0].step.before).toBeUndefined();
    expect(handles[0].step.after).toBeUndefined();
    // Undoing all the way back to step 0 still restores initialBytes and clears dirty!
    for (let i = handles.length - 1; i >= 0; i--) {
      handles[i].undo();
    }
    expect([...imgSession.bytes]).toEqual([1, 2, 3]);
    expect(imgSession.dirty).toBe(false);
  });
});

// ---------------------------------------------------------------- v0.7.0 deep analytics, CV, JSONL, EPUB & Archive

describe('spreadsheet deep analytics (value/numeric filters, JSON export, autofill & conditional formatting)', () => {
  it('filters by unique-value sets and numeric comparisons (>=, between, topN)', async () => {
    const { collectColumnUniqueValues, condFormatGradient } = await import('../../src/webview/sheet/view');
    const data: Cell[][] = [
      ['item', 'cat', 'score'],
      ['A', 'Core', '95'],
      ['B', 'Edge', '60'],
      ['C', 'Core', '82'],
      ['D', '', '40'],
      ['E', 'Aux', '99'],
    ];
    const uniques = collectColumnUniqueValues(data, data.length, 1, 1);
    expect(uniques).toEqual([
      { value: '', count: 1 },
      { value: 'Aux', count: 1 },
      { value: 'Core', count: 2 },
      { value: 'Edge', count: 1 },
    ]);

    // Multi-select value filter (allow '' and 'Core')
    const v1: SheetView = { ...emptyView(), valueFilters: { 1: ['', 'Core'] } };
    expect(viewRows(data, data.length, 1, v1)).toEqual([0, 1, 3, 4]);

    // Numeric between [60, 95]
    const v2: SheetView = { ...emptyView(), numFilters: { 2: { op: 'between', a: 60, b: 95 } } };
    expect(viewRows(data, data.length, 1, v2)).toEqual([0, 1, 2, 3]);

    // Top 2 numeric rows
    const v3: SheetView = { ...emptyView(), numFilters: { 2: { op: 'topN', a: 2 } } };
    expect(viewRows(data, data.length, 1, v3)).toEqual([0, 1, 5]);

    // Conditional format CSS gradients
    expect(condFormatGradient('bar', 50, { min: 0, max: 100 })).toContain('50.0%');
    expect(condFormatGradient('heat', 100, { min: 0, max: 100 })).toContain('rgba(34, 197, 94');
  });

  it('exports rectangular selections to typed JSON and extrapolates series & formulas on AutoFill', async () => {
    const { computeAutoFillChanges, selectionToJson, shiftFormulaRefs } = await import('../../src/webview/sheet/view');
    const gridData: Cell[][] = [
      ['id', 'active', 'meta'],
      ['101', 'true', '{"k":1}'],
      ['007', 'false', ''],
    ];
    const jsonMulti = JSON.parse(selectionToJson((r, c) => gridData[r]?.[c], 0, 0, 2, 2));
    expect(jsonMulti).toEqual([
      { id: 101, active: true, meta: { k: 1 } },
      { id: '007', active: false, meta: null },
    ]);
    const jsonSingle = JSON.parse(selectionToJson((r, c) => gridData[r]?.[c], 1, 0, 1, 2));
    expect(jsonSingle).toEqual([101, true, { k: 1 }]);

    // Relative vs $ anchored formula shifting
    expect(shiftFormulaRefs('=A1+B$1+$C2+$D$3', 2, 1)).toBe('=B3+C$1+$C4+$D$3');

    // Vertical AutoFill: numeric step [10, 20] -> 30, 40; padded string ID-001 -> ID-002, ID-003; formula =A1*2
    const srcCells = [
      ['10', 'ID-001', '=A1*2'],
      ['20', 'ID-002', '=A2*2'],
    ];
    const fill = computeAutoFillChanges(
      (r, c) => srcCells[r]?.[c] ?? '',
      { r0: 0, c0: 0, r1: 1, c1: 2 },
      { r0: 0, c0: 0, r1: 3, c1: 2 },
    );
    expect(fill).toEqual([
      { r: 2, c: 0, text: '30' },
      { r: 3, c: 0, text: '40' },
      { r: 2, c: 1, text: 'ID-003' },
      { r: 3, c: 1, text: 'ID-004' },
      { r: 2, c: 2, text: '=A3*2' },
      { r: 3, c: 2, text: '=A4*2' },
    ]);
  });
});

describe('image CV annotations (YOLO / COCO / LabelMe), HSL, pixel diff & mosaic', () => {
  it('round-trips YOLO, COCO and LabelMe bounding boxes with class labels', async () => {
    const { exportCoco, exportLabelMe, exportYolo, parseAnnotationContent } = await import(
      '../../src/webview/image/annotations'
    );
    const { rgbToHsl } = await import('../../src/webview/image/bbox');
    const { computePixelDiff } = await import('../../src/webview/image/diff');
    const { applyMosaicRgba } = await import('../../src/webview/image/markup');

    expect(rgbToHsl(255, 0, 0)).toBe('hsl(0, 100%, 50%)');

    const boxes = [
      { id: 1, x1: 100, y1: 50, x2: 300, y2: 250, color: '#3b82f6', label: 'person' },
      { id: 2, x1: 400, y1: 120, x2: 520, y2: 220, color: '#10b981', label: 'car' },
    ];

    const yolo = exportYolo(boxes, 800, 600);
    expect(yolo.classesTxt.trim().split('\n')).toEqual(['person', 'car']);
    const fromYolo = parseAnnotationContent(yolo.txt, 800, 600, { classesText: yolo.classesTxt });
    expect(fromYolo).toHaveLength(2);
    expect(fromYolo[0]).toMatchObject({ x1: 100, y1: 50, x2: 300, y2: 250, label: 'person' });
    expect(fromYolo[1]).toMatchObject({ x1: 400, y1: 120, x2: 520, y2: 220, label: 'car' });

    const coco = exportCoco(boxes, 'street.jpg', 800, 600);
    const fromCoco = parseAnnotationContent(coco, 800, 600, { fileName: 'street.jpg' });
    expect(fromCoco[0]).toMatchObject({ x1: 100, y1: 50, x2: 300, y2: 250, label: 'person' });
    expect(fromCoco[1]).toMatchObject({ x1: 400, y1: 120, x2: 520, y2: 220, label: 'car' });

    const lm = exportLabelMe(boxes, 'street.jpg', 800, 600);
    const fromLm = parseAnnotationContent(lm, 800, 600);
    expect(fromLm[0]).toMatchObject({ x1: 100, y1: 50, x2: 300, y2: 250, label: 'person' });

    // Pixel diff: 1 of 2 pixels changed -> ratio = 0.5
    const imgA = new Uint8ClampedArray([10, 10, 10, 255, 20, 20, 20, 255]);
    const imgB = new Uint8ClampedArray([10, 10, 10, 255, 250, 20, 20, 255]);
    const diff = computePixelDiff(imgA, 2, 1, imgB, 2, 1);
    expect(diff.changedPixels).toBe(1);
    expect(diff.ratio).toBeCloseTo(0.5);

    // Mosaic averages 2x1 block in-place
    const mosaicBuf = new Uint8ClampedArray([0, 0, 0, 255, 200, 100, 50, 255]);
    applyMosaicRgba(mosaicBuf, 2, 1, { x1: 0, y1: 0, x2: 2, y2: 1 }, 4);
    expect([...mosaicBuf]).toEqual([100, 50, 25, 255, 100, 50, 25, 255]);
  });
});

describe('JSONL, EPUB & Archive engines', () => {
  it('parses and edits .jsonl records in place while preserving typed JSON fields', async () => {
    const { applyEdits } = await import('../../src/host/csv/csvParser');
    const { JsonlSession } = await import('../../src/host/jsonl/jsonlSession');

    const raw = '{"id":1,"name":"Alice","tags":["a"]}\n{"id":2,"score":9.5}\n';
    const session = new JsonlSession('train.jsonl');
    session.setText(raw);
    const model = session.model();
    expect(model.frozenRows).toBe(1);
    expect(model.rows[0].map((c) => (typeof c === 'object' && c ? c.v : c))).toEqual(['id', 'name', 'tags', 'score']);

    // Edit row 1 col 1 ("Alice" -> "Alicia") and row 2 col 3 (9.5 -> 12)
    const { edits } = session.editCells([
      { r: 1, c: 1, text: 'Alicia' },
      { r: 2, c: 3, text: '12' },
    ]);
    const updated = applyEdits(session.currentText, edits);
    session.setText(updated);
    const lines = updated.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ id: 1, name: 'Alicia', tags: ['a'] });
    expect(lines[1]).toEqual({ id: 2, score: 12 });

    // Insert a new JSON record row
    const afterIns = applyEdits(session.currentText, session.structure('insertRow', 2, 1));
    expect(afterIns.trim().split('\n')).toHaveLength(3);
  });

  it('parses EPUB 2/3 books, inlines images and strips unsafe scripts', async () => {
    const { strToU8, zipSync } = await import('fflate');
    const { parseEpub } = await import('../../src/host/epub/epubParser');

    const epubBytes = zipSync({
      'META-INF/container.xml': strToU8(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ),
      'OEBPS/content.opf': strToU8(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Deep Guide</dc:title><dc:creator>Ada</dc:creator></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="img1" href="img/pic.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/></spine></package>',
      ),
      'OEBPS/ch1.xhtml': strToU8(
        '<html><head><title>Chapter One</title></head><body><h1 id="intro">Welcome</h1><script>evil()</script><img src="img/pic.png" onerror="bad()"/></body></html>',
      ),
      'OEBPS/img/pic.png': new Uint8Array([137, 80, 78, 71]),
    });

    const book = parseEpub(epubBytes);
    expect(book.title).toBe('Deep Guide');
    expect(book.author).toBe('Ada');
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0].title).toBe('Chapter One');
    expect(book.chapters[0].html).toContain('data:image/png;base64,');
    expect(book.chapters[0].html).not.toContain('<script');
    expect(book.chapters[0].html).not.toContain('onerror');
  });

  it('inspects ZIP Central Directory entries and previews text/image payloads on demand', async () => {
    const { strToU8, zipSync } = await import('fflate');
    const { classifyArchiveEntry, extractArchiveEntryBytes, inspectArchive } = await import(
      '../../src/host/archive/archiveReader'
    );

    const zipBytes = zipSync({
      'src/hello.ts': strToU8('export const x = 42;\n'),
      'assets/icon.png': new Uint8Array([137, 80, 78, 71]),
    });
    const info = inspectArchive(zipBytes, 'bundle.zip');
    expect(info.entries.map((e) => e.path)).toEqual(['src/hello.ts', 'assets/icon.png']);
    expect(info.totalSize).toBe(25);

    const tsBytes = extractArchiveEntryBytes(zipBytes, 'bundle.zip', 'src/hello.ts')!;
    const tsClassified = classifyArchiveEntry('src/hello.ts', tsBytes);
    expect(tsClassified.kind).toBe('text');
    expect(tsClassified.text).toContain('export const x = 42;');

    const pngBytes = extractArchiveEntryBytes(zipBytes, 'bundle.zip', 'assets/icon.png')!;
    expect(classifyArchiveEntry('assets/icon.png', pngBytes).kind).toBe('image');
  });

  it('covers v0.8.0 sanitizer hardening, cross-chapter EPUB links, Zip-Slip & GNU LongLink TAR', async () => {
    const { strToU8, zipSync } = await import('fflate');
    const { parseEpub } = await import('../../src/host/epub/epubParser');
    const { inspectArchive, sanitizeArchiveRelativePath } = await import('../../src/host/archive/archiveReader');

    // 1. Sanitizer: '>' inside quoted attribute, stripStyles, and SVG <image> data URL
    const tricky =
      '<style>body{display:none}</style><span title="x > y" style="position:fixed;color:red">ok</span><svg><image xlink:href="data:image/png;base64,AA=="/></svg>';
    const cleanEpub = sanitizeExportHtml(tricky, { stripStyles: true, allowSvgImageData: true });
    expect(cleanEpub).not.toContain('<style');
    expect(cleanEpub).not.toContain('position:fixed');
    expect(cleanEpub).toContain('title="x > y"');
    expect(cleanEpub).toContain('data:image/png;base64,AA==');

    // 2. EPUB cross-chapter link rewriting + SVG cover image inlining
    const epub2 = zipSync({
      'META-INF/container.xml': strToU8(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ),
      'OEBPS/content.opf': strToU8(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Cross Ref</dc:title></metadata><manifest><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/><item id="cov" href="img/cover.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
      ),
      'OEBPS/text/ch1.xhtml': strToU8(
        '<html><body><svg><image xlink:href="../img/cover.png"/></svg><a href="ch2.xhtml#part-b">Jump</a></body></html>',
      ),
      'OEBPS/text/ch2.xhtml': strToU8('<html><body><h2 id="part-b">Part B</h2></body></html>'),
      'OEBPS/img/cover.png': new Uint8Array([137, 80, 78, 71]),
    });
    const parsedBook = parseEpub(epub2);
    expect(parsedBook.chapters[0].html).toContain('href="#epub-ch-1::part-b"');
    expect(parsedBook.chapters[0].html).toContain('data:image/png;base64,');

    // 3. Zip-Slip path sanitization
    expect(sanitizeArchiveRelativePath('../etc/passwd')).toBeUndefined();
    expect(sanitizeArchiveRelativePath('/etc/passwd')).toBeUndefined();
    expect(sanitizeArchiveRelativePath('a/../../secret.txt')).toBeUndefined();
    expect(sanitizeArchiveRelativePath('src\\utils\\helper.ts')).toBe('src/utils/helper.ts');

    // 4. GNU LongLink ('L') TAR header > 100 chars
    const longPath = `packages/deeply/nested/module/${' very_long_segment_'.replace(/\s/g, '')}`.repeat(3) + 'index.ts';
    const payload = strToU8('export default 1;\n');
    const makeTarBlock = (name: string, size: number, typeflag: string) => {
      const header = new Uint8Array(512);
      header.set(strToU8(name.slice(0, 100)), 0);
      header.set(strToU8('0000644\0'), 100);
      header.set(strToU8(size.toString(8).padStart(11, '0') + '\0'), 124);
      header[156] = typeflag.charCodeAt(0);
      // Fill checksum field with spaces first
      header.fill(0x20, 148, 156);
      let sum = 0;
      for (const b of header) sum += b;
      header.set(strToU8(sum.toString(8).padStart(6, '0') + '\0 '), 148);
      return header;
    };
    const pad512 = (u8: Uint8Array) => {
      const rem = u8.length % 512;
      if (rem === 0) return u8;
      const out = new Uint8Array(u8.length + (512 - rem));
      out.set(u8);
      return out;
    };
    const longNameBytes = strToU8(`${longPath}\0`);
    const tarBuf = new Uint8Array(
      512 + pad512(longNameBytes).length + 512 + pad512(payload).length + 1024,
    );
    let off = 0;
    tarBuf.set(makeTarBlock('././@LongLink', longNameBytes.length, 'L'), off);
    off += 512;
    tarBuf.set(pad512(longNameBytes), off);
    off += pad512(longNameBytes).length;
    tarBuf.set(makeTarBlock('truncated.ts', payload.length, '0'), off);
    off += 512;
    tarBuf.set(pad512(payload), off);

    const tarInfo = inspectArchive(tarBuf, 'repo.tar');
    expect(tarInfo.entries).toHaveLength(1);
    expect(tarInfo.entries[0].path).toBe(longPath);
  });

  it('covers v0.8.0 JSONL schema CRUD, string-ID preservation, formula sheet refs, ISO date autofill & PNG metadata', async () => {
    const { applyEdits } = await import('../../src/host/csv/csvParser');
    const { rowsToJsonl } = await import('../../src/host/convert');
    const { JsonlSession } = await import('../../src/host/jsonl/jsonlSession');
    const { computeAutoFillChanges, shiftFormulaRefs, viewRows } = await import('../../src/webview/sheet/view');
    const { ImageSession } = await import('../../src/host/imageSession');
    const { extractImageMetadata } = await import('../../src/webview/image/metadata');

    // 1. rowsToJsonl preserves leading-zero strings & converts numbers/booleans
    const jsonlOut = rowsToJsonl([
      ['code', 'qty', 'enabled'],
      ['0042', '15', 'true'],
    ]);
    expect(JSON.parse(jsonlOut.trim())).toEqual({ code: '0042', qty: 15, enabled: true });

    // 2. JsonlSession: preserves string type on string IDs, guards nested objects, supports Row 0 rename & col CRUD
    const js = new JsonlSession('items.jsonl');
    js.setText('{"code":"0042","meta":{"a":1}}\n');
    // Editing string "0042" -> "43" keeps string type!
    let nextTxt = applyEdits(js.currentText, js.editCells([{ r: 1, c: 0, text: '43' }]).edits);
    js.setText(nextTxt);
    expect(JSON.parse(nextTxt.trim()).code).toBe('43');

    // Invalid JSON edit on nested object column is ignored instead of corrupting object into string
    const badRes = js.editCells([{ r: 1, c: 1, text: '{broken' }]);
    expect(badRes.edits).toEqual([]);
    expect(badRes.hadInvalidJson).toBe(true);

    // Rename key in Row 0 ('code' -> 'sku'), insert column, and replace whole record JSON
    nextTxt = applyEdits(js.currentText, js.editCells([{ r: 0, c: 0, text: 'sku' }]).edits);
    js.setText(nextTxt);
    expect(JSON.parse(nextTxt.trim())).toEqual({ sku: '43', meta: { a: 1 } });

    nextTxt = applyEdits(js.currentText, js.structure('insertCol', 1, 1));
    js.setText(nextTxt);
    expect(Object.keys(JSON.parse(nextTxt.trim()))).toEqual(['sku', 'field_1', 'meta']);

    nextTxt = applyEdits(js.currentText, js.replaceRecordJson(0, '{"sku":"99","extra":[1,2]}')!);
    js.setText(nextTxt);
    expect(JSON.parse(nextTxt.trim())).toEqual({ sku: '99', extra: [1, 2] });

    // 3. shiftFormulaRefs skips Sheet! prefixes and string literals
    expect(shiftFormulaRefs('=Q1!A2 + \'Sales Q2\'!$B3 + "A1" + C4', 1, 2)).toBe(
      '=Q1!C3 + \'Sales Q2\'!$B4 + "A1" + E5',
    );

    // 4. Calendar-accurate ISO date AutoFill across month boundary
    const dateSrc = [['2026-01-30'], ['2026-01-31']];
    const dateFill = computeAutoFillChanges(
      (r, c) => dateSrc[r]?.[c] ?? '',
      { r0: 0, c0: 0, r1: 1, c1: 0 },
      { r0: 0, c0: 0, r1: 3, c1: 0 },
    );
    expect(dateFill).toEqual([
      { r: 2, c: 0, text: '2026-02-01' },
      { r: 3, c: 0, text: '2026-02-02' },
    ]);

    // 5. excludedValues filter mode
    const rows: Cell[][] = [['k'], ['a'], ['b'], ['c']];
    expect(viewRows(rows, 4, 1, { ...emptyView(), excludedValues: { 0: ['b'] } })).toEqual([0, 1, 3]);

    // 6. ImageSession preserves originBytes even after markSaved()
    const im = new ImageSession(new Uint8Array([10]));
    const h1 = im.replace(new Uint8Array([20]));
    im.markSaved();
    expect(im.dirty).toBe(false);
    expect([...h1.undo()]).toEqual([10]);
    expect(im.dirty).toBe(true);

    // 7. PNG metadata reader (IHDR + pHYs 300 DPI + tEXt Software)
    const makePngChunk = (type: string, data: Uint8Array) => {
      const out = new Uint8Array(12 + data.length);
      new DataView(out.buffer).setUint32(0, data.length, false);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      out.set(data, 8);
      return out;
    };
    const ihdr = new Uint8Array(13);
    ihdr[8] = 8; // 8-bit
    ihdr[9] = 6; // RGBA
    const phys = new Uint8Array(9);
    new DataView(phys.buffer).setUint32(0, 11811, false); // ~300 DPI
    new DataView(phys.buffer).setUint32(4, 11811, false);
    phys[8] = 1;
    const textPayload = new TextEncoder().encode('Software\0DocsView Studio');
    const pngSig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks = [pngSig, makePngChunk('IHDR', ihdr), makePngChunk('pHYs', phys), makePngChunk('tEXt', textPayload), makePngChunk('IEND', new Uint8Array(0))];
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const pngBuf = new Uint8Array(totalLen);
    let p = 0;
    for (const c of chunks) {
      pngBuf.set(c, p);
      p += c.length;
    }
    const meta = extractImageMetadata(pngBuf);
    expect(meta).toEqual([
      { key: 'Color', value: '8-bit RGBA' },
      { key: 'DPI', value: '300 DPI' },
      { key: 'Software', value: 'DocsView Studio' },
    ]);
  });
});
