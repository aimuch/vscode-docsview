import ExcelJS from 'exceljs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { CellObject } from '../../src/common/protocol';
import { parseCellInput } from '../../src/host/excel/cellInput';
import { ExcelSession } from '../../src/host/excel/excelSession';
import {
  evaluateFormula,
  expandSharedFormula,
  FormulaError,
  renameSheetInFormula,
  shiftFormulaReferences,
} from '../../src/host/excel/formula';
import { dateToSerial, formatNumber, loadWorkbook } from '../../src/host/excel/reader';
import { patchXlsx } from '../../src/host/excel/xlsxPatcher';

/** A styled workbook plus parts no cell edit should ever touch (stand-ins for a chart and an image). */
async function makeWorkbook(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [{ width: 20 }, { width: 12 }, { width: 12 }];
  ws.addRow(['Item', 'Qty', 'Total']);
  ws.addRow(['Widget', 4, { formula: 'B2*2.5', result: 10 }]);
  ws.addRow(['Gadget', 10, { formula: 'B3*2.5', result: 25 }]);
  ws.getCell('A1').font = { bold: true, color: { argb: 'FFFF0000' } };
  ws.getCell('B2').numFmt = '0.00';
  ws.getCell('B2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
  ws.mergeCells('A5:C5');
  ws.getCell('A5').value = 'merged';
  wb.addWorksheet('Other').addRow(['untouched']);

  const files = unzipSync(new Uint8Array(await wb.xlsx.writeBuffer()));
  files['xl/charts/chart1.xml'] = strToU8('<c:chartSpace xmlns:c="urn:x"><c:chart/></c:chartSpace>');
  files['xl/media/image1.png'] = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  files['xl/calcChain.xml'] = strToU8('<calcChain xmlns="urn:x"><c r="C2" i="1"/></calcChain>');
  files['[Content_Types].xml'] = strToU8(
    strFromU8(files['[Content_Types].xml']).replace(
      '</Types>',
      '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>',
    ),
  );
  return zipSync(files);
}

async function read(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return wb;
}

describe('parseCellInput', () => {
  it('classifies typed text', () => {
    expect(parseCellInput('')).toEqual({ kind: 'empty' });
    expect(parseCellInput('42')).toEqual({ kind: 'number', value: 42 });
    expect(parseCellInput(' -3.5e2 ')).toEqual({ kind: 'number', value: -350 });
    expect(parseCellInput('true')).toEqual({ kind: 'boolean', value: true });
    expect(parseCellInput('=SUM(A1:A3)')).toEqual({ kind: 'formula', formula: 'SUM(A1:A3)' });
    expect(parseCellInput('hello')).toEqual({ kind: 'string', value: 'hello' });
  });

  it('keeps values that only look numeric as text', () => {
    expect(parseCellInput('007')).toEqual({ kind: 'string', value: '007' });
    expect(parseCellInput('12345678901234567890')).toEqual({ kind: 'string', value: '12345678901234567890' });
    expect(parseCellInput("'123")).toEqual({ kind: 'string', value: '123' });
    expect(parseCellInput('0.5')).toEqual({ kind: 'number', value: 0.5 });
  });
});

describe('formatNumber', () => {
  it('formats with Excel number formats, including bare non-ASCII literals', () => {
    expect(formatNumber(1234.5, '#,##0.00')).toBe('1,234.50');
    expect(formatNumber(0.8765, '0.00%')).toBe('87.65%');
    expect(formatNumber(15594, '¥#,##0.00')).toBe('¥15,594.00');
    expect(formatNumber(45000, 'yyyy年m月d日')).toBe('2023年3月15日');
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
  });

  it('handles 1900 leap-year offset and 1904 date system accurately', () => {
    expect(formatNumber(dateToSerial(new Date(Date.UTC(1900, 0, 1))), 'yyyy-mm-dd')).toBe('1900-01-01');
    expect(formatNumber(dateToSerial(new Date(Date.UTC(1900, 1, 28))), 'yyyy-mm-dd')).toBe('1900-02-28');
    expect(formatNumber(dateToSerial(new Date(Date.UTC(1900, 2, 1))), 'yyyy-mm-dd')).toBe('1900-03-01');
    expect(formatNumber(0, 'yyyy-mm-dd', true)).toBe('1904-01-01');
  });
});

describe('patchXlsx', () => {
  it('writes edits and leaves every other part byte-identical', async () => {
    const original = await makeWorkbook();
    const patched = patchXlsx(
      original,
      new Map([
        [
          'Data',
          [
            { r: 1, c: 1, text: '7' }, // number into a styled cell
            { r: 1, c: 0, text: 'Renamed & <escaped>' }, // string
            { r: 7, c: 4, text: 'new cell' }, // beyond the used range
            { r: 2, c: 2, text: '=B3*3' }, // formula
            { r: 2, c: 0, text: '' }, // clear
            { r: 3, c: 0, text: 'TRUE' }, // boolean in a brand new row between existing ones
          ],
        ],
      ]),
    );

    const before = unzipSync(original);
    const after = unzipSync(patched);
    const changed = Object.keys(before).filter(
      (name) => !after[name] || Buffer.compare(Buffer.from(before[name]), Buffer.from(after[name])) !== 0,
    );
    expect(changed.sort()).toEqual(
      ['[Content_Types].xml', 'xl/calcChain.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'].sort(),
    );
    expect(Buffer.from(after['xl/charts/chart1.xml']).equals(Buffer.from(before['xl/charts/chart1.xml']))).toBe(true);
    expect(Buffer.from(after['xl/media/image1.png']).equals(Buffer.from(before['xl/media/image1.png']))).toBe(true);
    expect(Buffer.from(after['xl/styles.xml']).equals(Buffer.from(before['xl/styles.xml']))).toBe(true);

    // Stale calculation chain is gone and Excel is told to recalculate.
    expect(after['xl/calcChain.xml']).toBeUndefined();
    expect(strFromU8(after['[Content_Types].xml'])).not.toContain('calcChain');
    expect(strFromU8(after['xl/workbook.xml'])).toMatch(/<calcPr[^>]*fullCalcOnLoad="1"/);

    const ws = (await read(patched)).getWorksheet('Data')!;
    expect(ws.getCell('B2').value).toBe(7);
    expect(ws.getCell('B2').numFmt).toBe('0.00');
    expect((ws.getCell('B2').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFFFF00');
    expect(ws.getCell('A2').value).toBe('Renamed & <escaped>');
    expect(ws.getCell('E8').value).toBe('new cell');
    expect(ws.getCell('C3').value).toMatchObject({ formula: 'B3*3' });
    expect(ws.getCell('A3').value).toBeNull();
    expect(ws.getCell('A4').value).toBe(true);
    // Untouched content and structure survive.
    expect(ws.getCell('A1').value).toBe('Item');
    expect(ws.getCell('A1').font).toMatchObject({ bold: true, color: { argb: 'FFFF0000' } });
    expect(ws.getCell('C2').value).toMatchObject({ formula: 'B2*2.5' });
    expect(ws.getCell('A5').isMerged).toBe(true);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });

  it('returns the input unchanged when there is nothing to write', async () => {
    const original = await makeWorkbook();
    expect(patchXlsx(original, new Map())).toBe(original);
    expect(patchXlsx(original, new Map([['Data', []]]))).toBe(original);
  });

  it('rejects an unknown sheet instead of silently dropping edits', async () => {
    const original = await makeWorkbook();
    expect(() => patchXlsx(original, new Map([['Missing', [{ r: 0, c: 0, text: 'x' }]]]))).toThrow(/Missing/);
  });

  it('handles prefixed and non-self-closing <calcPr> and drops stale cell metadata attributes', async () => {
    const original = await makeWorkbook();
    const files = unzipSync(original);
    // Simulate a prefixed workbook XML with a paired <x:calcPr></x:calcPr> and metadata attributes on B2.
    const origWb = strFromU8(files['xl/workbook.xml']);
    const rId = /name="Data"[^>]*r:id="([^"]+)"/.exec(origWb)?.[1] ?? 'rId1';
    files['xl/workbook.xml'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<x:sheets><x:sheet name="Data" sheetId="1" r:id="${rId}"/></x:sheets>` +
        '<x:calcPr calcId="191029"></x:calcPr></x:workbook>',
    );
    files['xl/worksheets/sheet1.xml'] = strToU8(
      strFromU8(files['xl/worksheets/sheet1.xml']).replace('<c r="B2"', '<c r="B2" cm="1" vm="2" ph="1"'),
    );
    const patched = patchXlsx(zipSync(files), new Map([['Data', [{ r: 1, c: 1, text: '' }]]]));
    const after = unzipSync(patched);
    const wbXml = strFromU8(after['xl/workbook.xml']);
    expect(wbXml.match(/<(?:x:)?calcPr\b/g)).toHaveLength(1);
    expect(wbXml).toContain('<x:calcPr');
    expect(wbXml).toContain('calcId="191029"');
    expect(wbXml).toContain('fullCalcOnLoad="1"');
    const sheetXml = strFromU8(after['xl/worksheets/sheet1.xml']);
    expect(sheetXml).not.toMatch(/\b(?:cm|vm|ph)=/);
  });
});

describe('loadWorkbook', () => {
  it('builds a display model with styles, formats, merges and frozen panes', async () => {
    const { sheets, editable } = await loadWorkbook(await makeWorkbook(), 'book.xlsx');
    expect(editable).toBe(true);
    expect(sheets.map((s) => s.model.name)).toEqual(['Data', 'Other']);
    const model = sheets[0].model;
    expect(model.frozenRows).toBe(1);
    expect(model.merges).toEqual([{ r: 4, c: 0, rs: 1, cs: 3 }]);
    expect(model.colWidths?.slice(0, 3)).toEqual([145, 89, 89]);

    const header = model.rows[0][0] as CellObject;
    expect(header.v).toBe('Item');
    expect(model.styles?.[header.s!]).toMatchObject({ bold: true, color: '#FF0000' });

    const qty = model.rows[1][1] as CellObject;
    expect(qty).toMatchObject({ v: '4.00', raw: '4', n: true });
    expect(model.styles?.[qty.s!]).toMatchObject({ bg: '#FFFF00' });

    const total = model.rows[1][2] as CellObject;
    expect(total).toMatchObject({ v: '10', raw: '=B2*2.5', n: true });
  });

  it('opens workbooks whose unprefixed <wsDr> drawings crash ExcelJS ("reading \'anchors\'") and preserves drawings on save', async () => {
    const files = unzipSync(await makeWorkbook());
    const drawingXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<wsDr xmlns="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<twoCellAnchor><from><col>0</col><colOff>0</colOff><row>0</row><rowOff>0</rowOff></from>' +
      '<to><col>2</col><colOff>0</colOff><row>3</row><rowOff>0</rowOff></to><clientData/></twoCellAnchor></wsDr>';
    files['xl/drawings/drawing1.xml'] = strToU8(drawingXml);
    files['xl/drawings/_rels/drawing1.xml.rels'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>' +
        '</Relationships>',
    );
    files['xl/worksheets/_rels/sheet1.xml.rels'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rIdDraw1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>' +
        '</Relationships>',
    );
    files['xl/worksheets/sheet1.xml'] = strToU8(
      strFromU8(files['xl/worksheets/sheet1.xml']).replace(
        '</worksheet>',
        '<drawing r:id="rIdDraw1"/></worksheet>',
      ),
    );
    const wpsBytes = zipSync(files);

    // Sanity check: raw ExcelJS crashes with the exact user-reported anchors TypeError.
    await expect(read(wpsBytes)).rejects.toThrow(/anchors/);

    const session = await ExcelSession.open(wpsBytes, 'wps-book.xlsx');
    expect(session.editable).toBe(true);
    const model = session.sheet(0)!;
    const header = model.rows[0][0] as CellObject;
    expect(header.v).toBe('Item');
    expect(model.styles?.[header.s!]).toMatchObject({ bold: true, color: '#FF0000' });

    session.edit(0, [{ r: 1, c: 1, text: '16' }]);
    expect(model.rows[1][2]).toMatchObject({ v: '40', raw: '=B2*2.5', n: true });

    const saved = unzipSync(session.export());
    expect(strFromU8(saved['xl/drawings/drawing1.xml'])).toBe(drawingXml);
    expect(strFromU8(saved['xl/worksheets/sheet1.xml'])).toContain('<drawing r:id="rIdDraw1"/>');
  });

  it('survives VML/comments rels, missing tables, broken Print_Area names, dangling hyperlinks and custom sheet paths', async () => {
    const files = unzipSync(await makeWorkbook());
    // Rename sheet1.xml to a non-standard filename & casing + SharedStrings casing
    files['xl/worksheets/Sales_Report.xml'] = strToU8(
      strFromU8(files['xl/worksheets/sheet1.xml']).replace(
        '</mergeCells>',
        '</mergeCells><hyperlinks>' +
          '<hyperlink ref="A1" r:id="rIdValid"/>' +
          '<hyperlink ref="A2" r:id="rIdDangling"/>' +
          '</hyperlinks>' +
          '<legacyDrawing r:id="rIdVml"/>' +
          '<tableParts count="1"><tablePart r:id="rIdTbl"/></tableParts>',
      ),
    );
    delete files['xl/worksheets/sheet1.xml'];
    files['xl/worksheets/_rels/Sales_Report.xml.rels'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rIdValid" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>' +
        '<Relationship Id="rIdCom" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="/xl/comments1.xml"/>' +
        '<Relationship Id="rIdVml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="/xl/drawings/vmlDrawing1.vml"/>' +
        '<Relationship Id="rIdTbl" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>' +
        '</Relationships>',
    );
    files['xl/drawings/vmlDrawing1.vml'] = strToU8('<v:group xmlns:v="urn:schemas-microsoft-com:vml"/>');
    files['xl/_rels/workbook.xml.rels'] = strToU8(
      strFromU8(files['xl/_rels/workbook.xml.rels']).replace('worksheets/sheet1.xml', 'worksheets/Sales_Report.xml'),
    );
    files['xl/workbook.xml'] = strToU8(
      strFromU8(files['xl/workbook.xml']).replace(
        '</sheets>',
        '</sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">#REF!</definedName></definedNames>',
      ),
    );

    const quirkyBytes = zipSync(files);
    const session = await ExcelSession.open(quirkyBytes, 'quirky.xlsx');
    expect(session.editable).toBe(true);
    expect(session.info.sheets.map((s) => s.name)).toEqual(['Data', 'Other']);

    const model = session.sheet(0)!;
    const header = model.rows[0][0] as CellObject;
    expect(header.v).toBe('Item');
    expect(model.styles?.[header.s!]).toMatchObject({ bold: true, color: '#FF0000' });

    // Edit & export patches the custom worksheet path cleanly
    session.edit(0, [{ r: 1, c: 0, text: 'Updated Widget' }]);
    const saved = unzipSync(session.export());
    expect(strFromU8(saved['xl/worksheets/Sales_Report.xml'])).toContain('Updated Widget');
  });

  it('falls back cleanly for prefixed <x:worksheet> OOXML and misnamed non-ZIP .xlsx files', async () => {
    // 1. Prefixed <x:workbook> + <x:worksheet> (ClosedXML / POI style) remains editable via SheetJS + DOM patcher
    const prefixedFiles: Record<string, Uint8Array> = {
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '</Types>',
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
      ),
      'xl/workbook.xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<x:sheets><x:sheet name="Prefixed" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '</Relationships>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Hello</x:t></x:is></x:c>' +
          '<x:c r="B1"><x:v>21</x:v></x:c></x:row></x:sheetData></x:worksheet>',
      ),
    };
    const prefixedSession = await ExcelSession.open(zipSync(prefixedFiles), 'prefixed.xlsx');
    expect(prefixedSession.editable).toBe(true);
    expect(prefixedSession.sheet(0)!.rows[0][0]).toBe('Hello');
    prefixedSession.edit(0, [{ r: 0, c: 2, text: '=B1*2' }]);
    expect(prefixedSession.sheet(0)!.rows[0][2]).toMatchObject({ v: '42', raw: '=B1*2' });
    expect(strFromU8(unzipSync(prefixedSession.export())['xl/worksheets/sheet1.xml'])).toContain('B1*2');

    // 2. Plain CSV / HTML bytes misnamed as .xlsx opens read-only instead of throwing a ZIP error
    const misnamed = await ExcelSession.open(strToU8('Name,Score\nAlice,95\n'), 'export.xlsx');
    expect(misnamed.editable).toBe(false);
    expect(misnamed.sheet(0)!.rows[0][0]).toBe('Name');
    expect(misnamed.sheet(0)!.rows[1][1]).toMatchObject({ v: '95', n: true });
  });
});

describe('ExcelSession', () => {
  it('applies, undoes and redoes edits', async () => {
    const session = await ExcelSession.open(await makeWorkbook(), 'book.xlsx');
    const model = session.sheet(0)!;
    expect(session.dirty).toBe(false);

    const result = session.edit(0, [{ r: 1, c: 1, text: '12.5' }])!;
    expect(result.message).toMatchObject({ type: 'cells', index: 0 });
    // The cell's own number format is applied to the typed value, and its style kept.
    expect(model.rows[1][1]).toMatchObject({ v: '12.50', raw: '12.5', n: true });
    expect((model.rows[1][1] as CellObject).s).toBeDefined();
    expect(session.dirty).toBe(true);

    result.undo();
    expect(model.rows[1][1]).toMatchObject({ v: '4.00', raw: '4' });
    expect(session.dirty).toBe(false);

    result.redo();
    expect(model.rows[1][1]).toMatchObject({ v: '12.50' });
    expect(session.dirty).toBe(true);
  });

  it('ignores no-op edits and edits outside the sheet', async () => {
    const session = await ExcelSession.open(await makeWorkbook(), 'book.xlsx');
    expect(session.edit(0, [{ r: 0, c: 0, text: 'Item' }])).toBeUndefined();
    expect(session.edit(0, [{ r: 9999, c: 0, text: 'x' }])).toBeUndefined();
    expect(session.edit(5, [{ r: 0, c: 0, text: 'x' }])).toBeUndefined();
  });

  it('saves edits, and an undo after saving writes the old value back', async () => {
    const session = await ExcelSession.open(await makeWorkbook(), 'book.xlsx');
    const result = session.edit(0, [{ r: 1, c: 0, text: 'Changed' }])!;

    const saved = session.export();
    session.markSaved(saved);
    expect(session.dirty).toBe(false);
    expect((await read(saved)).getWorksheet('Data')!.getCell('A2').value).toBe('Changed');

    // The saved file now contains "Changed", so undoing must become a pending edit.
    result.undo();
    expect(session.dirty).toBe(true);
    expect((await read(session.export())).getWorksheet('Data')!.getCell('A2').value).toBe('Widget');
  });

  it('restores pending edits from a backup', async () => {
    const bytes = await makeWorkbook();
    const first = await ExcelSession.open(bytes, 'book.xlsx');
    first.edit(0, [{ r: 2, c: 1, text: '99' }]);
    first.edit(1, [{ r: 0, c: 1, text: 'note' }]);
    const backup = first.backup();

    const second = await ExcelSession.open(bytes, 'book.xlsx');
    second.restore(backup);
    expect(second.dirty).toBe(true);
    const wb = await read(second.export());
    expect(wb.getWorksheet('Data')!.getCell('B3').value).toBe(99);
    expect(wb.getWorksheet('Other')!.getCell('B1').value).toBe('note');
  });

  it('evaluates typed formulas and recalculates dependent cells live, including cross-sheet refs', async () => {
    const session = await ExcelSession.open(await makeWorkbook(), 'book.xlsx');
    const data = session.sheet(0)!;
    // Editing B2 from 4 -> 8 automatically updates dependent C2 (=B2*2.5) from 10 -> 20!
    const editRes = session.edit(0, [{ r: 1, c: 1, text: '8' }])!;
    expect(data.rows[1][2]).toMatchObject({ v: '20', raw: '=B2*2.5', n: true });
    expect(editRes.message).toMatchObject({
      type: 'cells',
      index: 0,
      cells: expect.arrayContaining([
        expect.objectContaining({ r: 1, c: 1 }),
        expect.objectContaining({ r: 1, c: 2, cell: expect.objectContaining({ v: '20' }) }),
      ]),
    });

    // Type a new SUM formula in C4 and a cross-sheet formula in Other!A2
    session.edit(0, [{ r: 3, c: 2, text: '=SUM(C2:C3)' }]);
    expect(data.rows[3][2]).toMatchObject({ v: '45', raw: '=SUM(C2:C3)', n: true });

    session.sheet(1);
    session.edit(1, [{ r: 1, c: 0, text: '=IF(Data!C4>40, "HIGH", "LOW")' }]);
    expect(session.sheet(1)!.rows[1][0]).toMatchObject({ v: 'HIGH', raw: '=IF(Data!C4>40, "HIGH", "LOW")' });

    editRes.undo();
    expect(data.rows[1][2]).toMatchObject({ v: '10', raw: '=B2*2.5', n: true });
    expect(data.rows[3][2]).toMatchObject({ v: '35', raw: '=SUM(C2:C3)', n: true });
    expect(session.sheet(1)!.rows[1][0]).toMatchObject({ v: 'LOW' });
  });

  it('inserts and deletes rows and columns, shifting merges and formulas and roundtripping to xlsx', async () => {
    const session = await ExcelSession.open(await makeWorkbook(), 'book.xlsx');
    const model = session.sheet(0)!;

    // Insert 1 row before row index 1 (Excel row 2): B2*2.5 moves to row index 2 as =B3*2.5, merge A5:C5 -> A6:C6
    const ins = session.structure(0, 'insertRow', 1, 1)!;
    expect(model.rows[2][2]).toMatchObject({ v: '10', raw: '=B3*2.5' });
    expect(model.merges).toEqual([{ r: 5, c: 0, rs: 1, cs: 3 }]);

    // Insert 1 column before col index 1 (col B -> col C): formula =B3*2.5 becomes =C3*2.5
    session.structure(0, 'insertCol', 1, 1);
    expect(model.rows[2][3]).toMatchObject({ v: '10', raw: '=C3*2.5' });
    expect(model.merges).toEqual([{ r: 5, c: 0, rs: 1, cs: 4 }]);

    const wb = await read(session.export());
    const ws = wb.getWorksheet('Data')!;
    expect(ws.getCell('C3').value).toBe(4);
    expect(ws.getCell('D3').value).toMatchObject({ formula: 'C3*2.5' });
    expect(ws.getCell('A6').isMerged).toBe(true);

    // Undo column insert and row insert
    session.structure(0, 'deleteCols', 1, 1);
    expect(session.sheet(0)!.rows[2][2]).toMatchObject({ v: '10', raw: '=B3*2.5' });
    ins.undo(); // Note: undo restores snapshot before insertRow
    expect(session.sheet(0)!.rows[1][2]).toMatchObject({ v: '10', raw: '=B2*2.5' });
  });

  it('adds, renames and deletes worksheets with undo/redo and xlsx persistence', async () => {
    const session = await ExcelSession.open(await makeWorkbook(), 'book.xlsx');
    session.sheet(1);
    session.edit(1, [{ r: 0, c: 1, text: '=Data!B2+5' }]);
    expect(session.sheet(1)!.rows[0][1]).toMatchObject({ v: '9', raw: '=Data!B2+5' });

    // Rename 'Data' -> 'Sales Data': cross-sheet formula in 'Other' updates automatically!
    const ren = session.renameSheet(0, 'Sales Data')!;
    expect(session.info.sheets.map((s) => s.name)).toEqual(['Sales Data', 'Other']);
    expect(session.sheet(1)!.rows[0][1]).toMatchObject({ v: '9', raw: "='Sales Data'!B2+5" });

    // Create a new sheet and write a formula in it
    const added = session.addSheet('Summary')!;
    expect(session.info.sheets.map((s) => s.name)).toEqual(['Sales Data', 'Other', 'Summary']);
    session.edit(2, [{ r: 0, c: 0, text: "='Sales Data'!C2+100" }]);
    expect(session.sheet(2)!.rows[0][0]).toMatchObject({ v: '110' });

    // Delete 'Other'
    const del = session.deleteSheet(1)!;
    expect(session.info.sheets.map((s) => s.name)).toEqual(['Sales Data', 'Summary']);

    const exported = await read(session.export());
    expect(exported.worksheets.map((w) => w.name)).toEqual(['Sales Data', 'Summary']);
    expect(exported.getWorksheet('Summary')!.getCell('A1').value).toMatchObject({
      formula: "'Sales Data'!C2+100",
      result: 110,
    });

    // Undo delete, add, and rename
    del.undo();
    expect(session.info.sheets.map((s) => s.name)).toEqual(['Sales Data', 'Other', 'Summary']);
    added.undo();
    expect(session.info.sheets.map((s) => s.name)).toEqual(['Sales Data', 'Other']);
    ren.undo();
    expect(session.info.sheets.map((s) => s.name)).toEqual(['Data', 'Other']);
  });
});

describe('formula engine', () => {
  const ctx = {
    currentSheet: 0,
    sheetIndexByName: (n: string) => (n.toLowerCase() === 's1' ? 0 : n.toLowerCase() === 's2' ? 1 : -1),
    getCellValue: (s: number, r: number, c: number) => {
      if (s === 0 && r === 0) return [10, 20, 30][c] ?? null;
      if (s === 0 && r === 1) return ['apple', 'banana', 'apple'][c] ?? null;
      if (s === 1 && r === 0 && c === 0) return 5;
      return null;
    },
    getRangeValues: (s: number, r0: number, c0: number, r1: number, c1: number) => {
      const rows = [];
      for (let r = r0; r <= r1; r++) {
        const row = [];
        for (let c = c0; c <= c1; c++) {
          row.push(ctx.getCellValue(s, r, c));
        }
        rows.push(row);
      }
      return rows;
    },
  };

  it('evaluates math, logic, conditionals, lookups and text functions', () => {
    expect(evaluateFormula('SUM(A1:C1) * S2!A1', ctx)).toBe(300);
    expect(evaluateFormula('AVERAGE(A1:C1)', ctx)).toBe(20);
    expect(evaluateFormula('COUNTIF(A2:C2, "apple")', ctx)).toBe(2);
    expect(evaluateFormula('SUMIF(A2:C2, "apple", A1:C1)', ctx)).toBe(40);
    expect(evaluateFormula('IF(B1>=20, UPPER(B2), "no")', ctx)).toBe('BANANA');
    expect(evaluateFormula('XLOOKUP("banana", A2:C2, A1:C1)', ctx)).toBe(20);
    expect(evaluateFormula('ROUND(10/3, 2)', ctx)).toBe(3.33);
    expect(evaluateFormula('10/0', ctx)).toEqual(new FormulaError('#DIV/0!'));
    expect(evaluateFormula('IFERROR(10/0, 99)', ctx)).toBe(99);
  });

  it('shifts references, expands shared formulas and renames sheets accurately', () => {
    expect(shiftFormulaReferences('SUM($B$2:B5)+D2+"B2"', 'Data', 'Data', 'insertRow', 1, 2)).toBe(
      'SUM($B$4:B7)+D4+"B2"',
    );
    expect(shiftFormulaReferences('B3*2', 'Data', 'Data', 'deleteRows', 2, 1)).toBe('#REF!*2');
    expect(expandSharedFormula('$A2*B$1', 1, 1, 3, 2)).toBe('$A4*C$1');
    expect(renameSheetInFormula('Data!A1 + Other!B2', 'Data', 'Q1 Report')).toBe("'Q1 Report'!A1 + Other!B2");
  });
});

describe('Excel embedded & floating images', () => {
  const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const TINY_PNG = Uint8Array.from(Buffer.from(TINY_PNG_B64, 'base64'));

  it('extracts floating DrawingML images (twoCellAnchor & oneCellAnchor), expands bounds, shifts on edits, and preserves on save', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Gallery');
    ws.getCell('A1').value = 'Header';
    const imgId = wb.addImage({ base64: TINY_PNG_B64, extension: 'png' });
    // Two-cell anchored image spanning C2:F8
    ws.addImage(imgId, 'C2:F8');
    // One-cell anchored image placed far right/bottom past text cells (M48)
    ws.addImage(imgId, { tl: { col: 12, row: 47 }, ext: { width: 160, height: 120 } });

    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
    const session = await ExcelSession.open(bytes, 'gallery.xlsx');
    const model = session.sheet(0)!;

    expect(model.images).toHaveLength(2);
    // Same media binary is deduplicated to a single entry
    expect(Object.keys(model.media ?? {})).toHaveLength(1);
    const mediaId = model.images![0].mediaId;
    expect(model.media![mediaId]).toMatch(/^data:image\/png;base64,/);

    const twoCell = model.images!.find((i) => i.toRow !== undefined)!;
    expect(twoCell.kind).toBe('floating');
    expect(twoCell.fromCol).toBe(2);
    expect(twoCell.fromRow).toBe(1);
    // ExcelJS writes exclusive end-edge of C2:F8 as start of col G (6) and row 9 (8)
    expect(twoCell.toCol).toBe(6);
    expect(twoCell.toRow).toBe(8);

    const oneCell = model.images!.find((i) => i.toRow === undefined)!;
    expect(oneCell.fromCol).toBe(12);
    expect(oneCell.fromRow).toBe(47);
    expect(oneCell.width).toBeCloseTo(160, 0);
    expect(oneCell.height).toBeCloseTo(120, 0);
    // Grid bounds expanded to cover the distant image
    expect(model.colCount).toBeGreaterThanOrEqual(14);
    expect(model.rowCount).toBeGreaterThanOrEqual(52);

    // Inserting 2 rows at row 0 shifts image anchors and undo restores them cleanly
    const ins = session.structure(0, 'insertRow', 0, 2)!;
    expect(session.sheet(0)!.images![0].fromRow).toBe(3);
    expect(session.sheet(0)!.images![1].fromRow).toBe(49);
    ins.undo();
    expect(session.sheet(0)!.images![0].fromRow).toBe(1);
    expect(session.sheet(0)!.media?.[mediaId]).toMatch(/^data:image\/png;base64,/);

    // Editing a text cell and exporting preserves the original drawings & media in the saved xlsx
    session.edit(0, [{ r: 0, c: 0, text: 'Updated Header' }]);
    const reopened = await ExcelSession.open(session.export(), 'gallery.xlsx');
    expect(reopened.sheet(0)!.images).toHaveLength(2);
    expect(Object.keys(reopened.sheet(0)!.media ?? {})).toHaveLength(1);
  });

  it('extracts namespace-less wsDr, mc:AlternateContent (no duplicates), absoluteAnchor, and rotation/flip', async () => {
    const base = await makeWorkbook();
    const files = unzipSync(base);
    files['xl/media/logo.png'] = TINY_PNG;
    files['xl/worksheets/_rels/sheet1.xml.rels'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rIdDr1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>' +
        '</Relationships>',
    );
    files['xl/drawings/_rels/drawing1.xml.rels'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="/xl/media/logo.png"/>' +
        '</Relationships>',
    );
    files['xl/drawings/drawing1.xml'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<wsDr xmlns="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
        'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
        '<absoluteAnchor>' +
        '<pos x="95250" y="190500"/>' +
        '<ext cx="952500" cy="476250"/>' +
        '<mc:AlternateContent>' +
        '<mc:Choice Requires="a14"><pic><nvPicPr><cNvPr id="2" name="Logo" descr="Brand Logo"/></nvPicPr>' +
        '<blipFill><a:blip r:embed="rIdImg1"/></blipFill>' +
        '<spPr><a:xfrm rot="5400000" flipH="1"/></spPr></pic></mc:Choice>' +
        '<mc:Fallback><pic><nvPicPr><cNvPr id="2" name="Dup"/></nvPicPr>' +
        '<blipFill><a:blip r:embed="rIdImg1"/></blipFill><spPr/></pic></mc:Fallback>' +
        '</mc:AlternateContent>' +
        '</absoluteAnchor></wsDr>',
    );

    const session = await ExcelSession.open(zipSync(files), 'alt.xlsx');
    const imgs = session.sheet(0)!.images!;
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toMatchObject({
      kind: 'floating',
      fromRow: 0,
      fromCol: 0,
      fromX: 10,
      fromY: 20,
      width: 100,
      height: 50,
      alt: 'Brand Logo',
      rot: 90,
      flipH: true,
    });
  });

  it('extracts WPS Office in-cell images (xl/cellimages.xml + =DISPIMG) without #NAME? errors', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Catalog');
    ws.getCell('A1').value = 'Product';
    ws.getCell('B1').value = 'Photo';
    ws.getCell('A2').value = 'Camera';
    ws.getCell('B2').value = { formula: 'DISPIMG("ID_CAM01",1)', result: { error: '#NAME?' } };
    const files = unzipSync(new Uint8Array(await wb.xlsx.writeBuffer()));

    files['xl/media/cam.png'] = TINY_PNG;
    files['xl/_rels/cellimages.xml.rels'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/cam.png"/>' +
        '</Relationships>',
    );
    files['xl/cellimages.xml'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<etc:cellImages xmlns:etc="http://www.wps.cn/officeDocument/2017/etCustomData" ' +
        'xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<etc:cellImage><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="ID_CAM01" descr="Camera Photo"/></xdr:nvPicPr>' +
        '<xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill></xdr:pic></etc:cellImage>' +
        '</etc:cellImages>',
    );

    const session = await ExcelSession.open(zipSync(files), 'wps.xlsx');
    const model = session.sheet(0)!;
    expect(model.images).toHaveLength(1);
    expect(model.images![0]).toMatchObject({
      kind: 'cell',
      fromRow: 1,
      fromCol: 1,
      alt: 'Camera Photo',
    });
    const cell = model.rows[1][1] as CellObject;
    expect(cell.v).toBe('');
    expect(cell.raw).toContain('DISPIMG("ID_CAM01",1)');

    // Editing another cell triggers formula recalculation: DISPIMG must stay empty instead of #NAME?
    session.edit(0, [{ r: 1, c: 0, text: 'Camera Pro' }]);
    expect((session.sheet(0)!.rows[1][1] as CellObject).v).toBe('');
  });

  it('extracts Microsoft Excel 365 Place-in-Cell images (xl/metadata.xml + xl/richData/*)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Rich');
    ws.getCell('A1').value = 'Item';
    ws.getCell('B2').value = { error: '#VALUE!' };
    const files = unzipSync(new Uint8Array(await wb.xlsx.writeBuffer()));

    // Inject vm="1" on cell B2 (Excel 365 Place-in-Cell reference)
    files['xl/worksheets/sheet1.xml'] = strToU8(
      strFromU8(files['xl/worksheets/sheet1.xml']).replace('<c r="B2"', '<c r="B2" vm="1"'),
    );
    files['xl/media/e365.png'] = TINY_PNG;
    files['xl/metadata.xml'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<metadataTypes count="2">' +
        '<metadataType name="XLDAPR"/>' +
        '<metadataType name="XLRICHVALUE"/>' +
        '</metadataTypes>' +
        '<valueMetadata count="1"><bk><rc t="2" v="0"/></bk></valueMetadata>' +
        '</metadata>',
    );
    files['xl/richData/rdrichvaluestructure.xml'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<rvStructures xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="1">' +
        '<s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="Text" t="s"/></s>' +
        '</rvStructures>',
    );
    files['xl/richData/rdrichvalue.xml'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<rvData xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="1">' +
        '<rv s="0"><v>0</v><v>Product Thumbnail</v></rv>' +
        '</rvData>',
    );
    files['xl/richData/richValueRel.xml'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<richValueRels xmlns="http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<rel r:id="rId1"/>' +
        '</richValueRels>',
    );
    files['xl/richData/_rels/richValueRel.xml.rels'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/e365.png"/>' +
        '</Relationships>',
    );

    const session = await ExcelSession.open(zipSync(files), 'e365.xlsx');
    const model = session.sheet(0)!;
    expect(model.images).toHaveLength(1);
    expect(model.images![0]).toMatchObject({
      kind: 'cell',
      fromRow: 1,
      fromCol: 1,
      alt: 'Product Thumbnail',
    });
    expect(model.media?.[model.images![0].mediaId]).toMatch(/^data:image\/png;base64,/);
    // #VALUE! placeholder is cleared
    expect(model.rows[1][1]).toBe('');
  });
});
