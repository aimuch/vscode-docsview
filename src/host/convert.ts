// Format conversion between CSV, TSV and XLSX. Pure module (no vscode imports).
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { serializeRecord } from './csv/csvParser';
import { parseCellInput } from './excel/cellInput';

export type ConvertFormat = 'csv' | 'tsv' | 'xlsx';

export const DELIMITERS: Record<'csv' | 'tsv', string> = { csv: ',', tsv: '\t' };

/** Drops trailing rows and cells that are entirely empty. */
function trim(rows: string[][]): string[][] {
  const out = rows.map((row) => {
    let end = row.length;
    while (end > 0 && row[end - 1] === '') {
      end--;
    }
    return row.slice(0, end);
  });
  while (out.length && out[out.length - 1].length === 0) {
    out.pop();
  }
  return out;
}

/** Rows of text as delimited text, quoting cells where needed, with a final line break. */
export function rowsToDelimited(rows: string[][], format: 'csv' | 'tsv', eol = '\n'): string {
  const delimiter = DELIMITERS[format];
  const body = trim(rows).map((row) => serializeRecord(row, delimiter));
  return body.length ? body.join(eol) + eol : '';
}

/**
 * Rows of text as a one-sheet workbook. Numbers and booleans become typed cells; text
 * that looks like a formula is kept as text, since a CSV cell is data, not a formula.
 */
export async function rowsToXlsx(rows: string[][], sheetName: string): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sanitizeSheetName(sheetName));
  for (const row of trim(rows)) {
    sheet.addRow(
      row.map((text) => {
        const input = parseCellInput(text);
        switch (input.kind) {
          case 'number':
          case 'boolean':
            return input.value;
          case 'empty':
            return null;
          default:
            return text;
        }
      }),
    );
  }
  // Size columns to their content, roughly as a spreadsheet app would on import.
  sheet.columns.forEach((column) => {
    let max = 6;
    column.eachCell?.({ includeEmpty: false }, (cell) => {
      max = Math.max(max, String(cell.value ?? '').length);
    });
    column.width = Math.min(60, max + 2);
  });
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

/** One sheet of a workbook (any format SheetJS reads) as delimited text, using displayed values. */
export function workbookToDelimited(bytes: Uint8Array, sheetIndex: number, format: 'csv' | 'tsv'): string {
  const workbook = XLSX.read(bytes, { type: 'array' });
  const name = workbook.SheetNames[sheetIndex] ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[name];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '', blankrows: true });
  return rowsToDelimited(
    rows.map((row) => row.map((cell) => (cell == null ? '' : String(cell)))),
    format,
  );
}

/** Any workbook format SheetJS reads (xls, ods…) as xlsx. */
export function workbookToXlsx(bytes: Uint8Array): Uint8Array {
  const workbook = XLSX.read(bytes, { type: 'array', cellStyles: true });
  return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

/** Excel sheet names: at most 31 characters, none of : \ / ? * [ ]. */
export function sanitizeSheetName(name: string): string {
  const clean = name.replace(/\.[^.]+$/, '').replace(/[:\\/?*[\]]/g, '_').trim();
  return (clean || 'Sheet1').slice(0, 31);
}
