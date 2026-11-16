import ExcelJS from 'exceljs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { CellObject } from '../../src/common/protocol';
import { parseCellInput } from '../../src/host/excel/cellInput';
import { ExcelSession } from '../../src/host/excel/excelSession';
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
});
