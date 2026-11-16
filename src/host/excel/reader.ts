// Workbook bytes -> SheetModel. exceljs for xlsx/xlsm (keeps styles), SheetJS for the
// legacy/other formats (values only). Pure module.
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import type { Cell, CellObject, CellStyle, MergeRange, SheetModel } from '../../common/protocol';

export interface LoadedSheet {
  readonly name: string;
  readonly date1904?: boolean;
  readonly model: SheetModel;
  /** Number format per cell ("r,c"), used to format values typed into that cell. */
  readonly numFmts: Map<string, string>;
}

export interface LoadedWorkbook {
  sheets: LoadedSheet[];
  /** Only OOXML workbooks can be patched in place. */
  editable: boolean;
}

/** Blank rows/columns shown past the used range so there is room to type. */
const EXTRA_ROWS = 20;
const EXTRA_COLS = 3;

const fmtCache = new Map<string, string>();

/**
 * Excel accepts bare non-ASCII literals in number formats ("¥#,##0", "yyyy年m月d日");
 * the formatter only accepts them quoted.
 */
function quoteLiterals(fmt: string): string {
  let cached = fmtCache.get(fmt);
  if (cached === undefined) {
    cached = '';
    let closer = '';
    for (let i = 0; i < fmt.length; i++) {
      const ch = fmt[i];
      if (closer) {
        cached += ch;
        if (ch === closer) {
          closer = '';
        }
      } else if (ch === '"' || ch === '[') {
        closer = ch === '"' ? '"' : ']';
        cached += ch;
      } else if (ch === '\\') {
        cached += ch + (fmt[++i] ?? '');
      } else {
        cached += ch.charCodeAt(0) > 127 ? `"${ch}"` : ch;
      }
    }
    fmtCache.set(fmt, cached);
  }
  return cached;
}

export function formatNumber(value: number, numFmt?: string, date1904 = false): string {
  try {
    const fmt = numFmt && numFmt !== 'General' ? quoteLiterals(numFmt) : 'General';
    return XLSX.SSF.format(fmt, value, date1904 ? ({ date1904: true } as never) : undefined);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------- colours

// Default Office theme; index order is lt1, dk1, lt2, dk2, accent1..6.
const THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'];

// Legacy indexed palette (first 56 entries after the 8 duplicated system colours).
const INDEXED = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

function applyTint(hex: string, tint: number): string {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16);
    const out = tint < 0 ? v * (1 + tint) : v + (255 - v) * tint;
    return Math.round(Math.max(0, Math.min(255, out)))
      .toString(16)
      .padStart(2, '0');
  };
  return channel(0) + channel(2) + channel(4);
}

interface ColorLike {
  argb?: string;
  theme?: number;
  tint?: number;
  indexed?: number;
}

function toHex(color: ColorLike | undefined): string | undefined {
  if (!color) {
    return undefined;
  }
  if (typeof color.argb === 'string' && color.argb.length >= 6) {
    return color.argb.slice(-6).toUpperCase();
  }
  if (typeof color.theme === 'number' && THEME[color.theme]) {
    return color.tint ? applyTint(THEME[color.theme], color.tint).toUpperCase() : THEME[color.theme];
  }
  if (typeof color.indexed === 'number' && INDEXED[color.indexed]) {
    return INDEXED[color.indexed];
  }
  return undefined;
}

const BORDER_CSS: Record<string, string> = {
  thin: '1px solid',
  hair: '1px solid',
  medium: '2px solid',
  thick: '3px solid',
  dashed: '1px dashed',
  mediumDashed: '2px dashed',
  dotted: '1px dotted',
  dashDot: '1px dashed',
  dashDotDot: '1px dashed',
  double: '3px double',
};

function borderCss(side: { style?: string; color?: ColorLike } | undefined): string | undefined {
  if (!side?.style || !BORDER_CSS[side.style]) {
    return undefined;
  }
  return `${BORDER_CSS[side.style]} #${toHex(side.color) ?? '000000'}`;
}

function styleKey(s: CellStyle): string {
  return `${s.bold ? 1 : 0}|${s.italic ? 1 : 0}|${s.underline ? 1 : 0}|${s.strike ? 1 : 0}|${s.color ?? ''}|${s.bg ?? ''}|${s.align ?? ''}|${s.valign ?? ''}|${s.fontSize ?? ''}|${s.wrap ? 1 : 0}|${s.bt ?? ''}|${s.br ?? ''}|${s.bb ?? ''}|${s.bl ?? ''}`;
}

function convertStyle(cell: ExcelJS.Cell): CellStyle | undefined {
  const font = cell.font;
  const fill = cell.fill;
  const alignment = cell.alignment;
  const border = cell.border;
  if (!font && !fill && !alignment && !border) {
    return undefined;
  }
  const style: CellStyle = {};
  let hasAny = false;
  if (font) {
    if (font.bold) {
      style.bold = true;
      hasAny = true;
    }
    if (font.italic) {
      style.italic = true;
      hasAny = true;
    }
    if (font.underline && font.underline !== 'none') {
      style.underline = true;
      hasAny = true;
    }
    if (font.strike) {
      style.strike = true;
      hasAny = true;
    }
    const color = toHex(font.color as ColorLike | undefined);
    // Default text colour is left to the theme so plain workbooks follow dark mode.
    if (color && color !== '000000') {
      style.color = `#${color}`;
      hasAny = true;
    }
    if (font.size && font.size !== 11) {
      style.fontSize = Math.round((font.size * 96) / 72);
      hasAny = true;
    }
  }
  if (fill && fill.type === 'pattern' && fill.pattern === 'solid') {
    const bg = toHex(fill.fgColor as ColorLike | undefined);
    if (bg && bg !== 'FFFFFF') {
      style.bg = `#${bg}`;
      hasAny = true;
    }
  }
  if (alignment) {
    const h = alignment.horizontal;
    if (h === 'left' || h === 'right' || h === 'center') {
      style.align = h;
      hasAny = true;
    } else if (h === 'centerContinuous') {
      style.align = 'center';
      hasAny = true;
    }
    const v = alignment.vertical;
    if (v === 'top' || v === 'bottom' || v === 'middle') {
      style.valign = v;
      hasAny = true;
    }
    if (alignment.wrapText) {
      style.wrap = true;
      hasAny = true;
    }
  }
  if (border) {
    const bt = borderCss(border.top as never);
    const br = borderCss(border.right as never);
    const bb = borderCss(border.bottom as never);
    const bl = borderCss(border.left as never);
    if (bt) {
      style.bt = bt;
      hasAny = true;
    }
    if (br) {
      style.br = br;
      hasAny = true;
    }
    if (bb) {
      style.bb = bb;
      hasAny = true;
    }
    if (bl) {
      style.bl = bl;
      hasAny = true;
    }
  }
  return hasAny ? style : undefined;
}

// ---------------------------------------------------------------- exceljs

/**
 * exceljs yields dates as UTC-midnight Date objects (already adjusted for date1904);
 * convert back to a 1900-based Excel serial for SSF formatting, accounting for the
 * Lotus 1-2-3 non-existent 1900-02-29 (serial 60) offset.
 */
export function dateToSerial(date: Date): number {
  const serial = date.getTime() / 86_400_000 + 25569;
  return serial < 61 ? serial - 1 : serial;
}

function richText(value: { richText: { text: string }[] }): string {
  return value.richText.map((part) => part.text).join('');
}

function formatScalar(value: unknown, numFmt: string | undefined): { text: string; numeric: boolean } {
  if (value === null || value === undefined) {
    return { text: '', numeric: false };
  }
  if (typeof value === 'number') {
    return { text: formatNumber(value, numFmt), numeric: true };
  }
  if (value instanceof Date) {
    const fmt = numFmt && numFmt !== 'General' ? numFmt : 'yyyy-mm-dd';
    return { text: formatNumber(dateToSerial(value), fmt), numeric: true };
  }
  if (typeof value === 'boolean') {
    return { text: value ? 'TRUE' : 'FALSE', numeric: false };
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.richText)) {
      return { text: richText(obj as never), numeric: false };
    }
    if (typeof obj.error === 'string') {
      return { text: obj.error, numeric: false };
    }
    return { text: '', numeric: false };
  }
  return { text: String(value), numeric: false };
}

function convertCell(cell: ExcelJS.Cell, styleIndex: (style: CellStyle) => number): { cell: Cell; numFmt?: string } {
  const value = cell.value as unknown;
  const numFmt = cell.numFmt || undefined;
  const out: CellObject = { v: '' };

  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const obj = value as Record<string, unknown>;
    if ('formula' in obj || 'sharedFormula' in obj) {
      const result = formatScalar(obj.result, numFmt);
      out.v = result.text;
      out.n = result.numeric || undefined;
      const formula = (obj.formula as string | undefined) ?? cell.formula;
      if (formula) {
        out.raw = `=${formula}`;
      }
      // Rewriting the master of a shared/array formula would break every dependent cell.
      if (obj.shareType === 'shared' || obj.shareType === 'array') {
        out.ro = true;
      }
    } else if ('hyperlink' in obj) {
      const text = obj.text;
      out.v =
        text && typeof text === 'object' && Array.isArray((text as { richText?: unknown }).richText)
          ? richText(text as never)
          : String(text ?? obj.hyperlink ?? '');
    } else {
      out.v = formatScalar(value, numFmt).text;
    }
  } else {
    const formatted = formatScalar(value, numFmt);
    out.v = formatted.text;
    out.n = formatted.numeric || undefined;
    if (typeof value === 'number' && String(value) !== formatted.text) {
      out.raw = String(value);
    }
  }

  const style = convertStyle(cell);
  if (style) {
    out.s = styleIndex(style);
  }
  const plain = out.s === undefined && out.raw === undefined && !out.n && !out.ro;
  return { cell: plain ? out.v : out, numFmt: numFmt && numFmt !== 'General' ? numFmt : undefined };
}

function fillHoles(row: Cell[], length: number): Cell[] {
  for (let i = 0; i < length; i++) {
    if (row[i] === undefined) {
      row[i] = null;
    }
  }
  return row;
}

function buildExcelJsSheet(ws: ExcelJS.Worksheet): { model: SheetModel; numFmts: Map<string, string> } {
  const styles: CellStyle[] = [];
  const styleKeys = new Map<string, number>();
  const styleIndex = (style: CellStyle) => {
    const key = styleKey(style);
    let index = styleKeys.get(key);
    if (index === undefined) {
      index = styles.push(style) - 1;
      styleKeys.set(key, index);
    }
    return index;
  };

  const rows: Cell[][] = [];
  const numFmts = new Map<string, string>();
  const rowHeights: Record<number, number> = {};
  let usedCols = 0;

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const r = rowNumber - 1;
    const out: Cell[] = [];
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      // Cells swallowed by a merge mirror the master's value; the grid draws only the master.
      if (cell.isMerged && cell.master !== cell) {
        return;
      }
      const c = colNumber - 1;
      const converted = convertCell(cell, styleIndex);
      out[c] = converted.cell;
      if (converted.numFmt) {
        numFmts.set(`${r},${c}`, converted.numFmt);
      }
    });
    usedCols = Math.max(usedCols, out.length);
    rows[r] = fillHoles(out, out.length);
    if (row.height) {
      rowHeights[r] = Math.max(8, Math.round((row.height * 96) / 72));
    }
  });
  for (let r = 0; r < rows.length; r++) {
    rows[r] ??= [];
  }

  const merges: MergeRange[] = [];
  const rawMerges = (ws as unknown as { _merges?: Record<string, unknown> })._merges ?? {};
  for (const entry of Object.values(rawMerges)) {
    const m = ((entry as { model?: unknown }).model ?? entry) as {
      top: number;
      left: number;
      bottom: number;
      right: number;
    };
    if (m && m.bottom >= m.top && m.right >= m.left) {
      merges.push({ r: m.top - 1, c: m.left - 1, rs: m.bottom - m.top + 1, cs: m.right - m.left + 1 });
      usedCols = Math.max(usedCols, m.right);
    }
  }

  usedCols = Math.max(usedCols, ws.columnCount);
  const colCount = Math.max(usedCols + EXTRA_COLS, 10);
  const rowCount = Math.max(Math.max(rows.length, ws.rowCount) + EXTRA_ROWS, 40);

  let anyWidth = false;
  const colWidths: (number | null)[] = [];
  for (let c = 0; c < colCount; c++) {
    const width = c < usedCols ? ws.getColumn(c + 1).width : undefined;
    if (width) {
      anyWidth = true;
      colWidths.push(Math.max(8, Math.round(width * 7 + 5)));
    } else {
      colWidths.push(null);
    }
  }

  const view = ws.views?.[0] as { state?: string; xSplit?: number; ySplit?: number } | undefined;
  const model: SheetModel = { name: ws.name, rowCount, colCount, rows };
  if (styles.length) {
    model.styles = styles;
  }
  if (anyWidth) {
    model.colWidths = colWidths;
  }
  if (Object.keys(rowHeights).length) {
    model.rowHeights = rowHeights;
  }
  if (merges.length) {
    model.merges = merges;
  }
  if (view?.state === 'frozen') {
    model.frozenRows = view.ySplit || 0;
    model.frozenCols = view.xSplit || 0;
  }
  return { model, numFmts };
}

function lazySheet(
  name: string,
  date1904: boolean,
  factory: () => { model: SheetModel; numFmts: Map<string, string> },
): LoadedSheet {
  let built: { model: SheetModel; numFmts: Map<string, string> } | undefined;
  let build: (() => { model: SheetModel; numFmts: Map<string, string> }) | undefined = factory;
  const ensure = () => {
    if (!built) {
      built = build!();
      build = undefined;
    }
    return built;
  };
  return {
    name,
    date1904,
    get model() {
      return ensure().model;
    },
    get numFmts() {
      return ensure().numFmts;
    },
  };
}

async function loadWithExcelJs(bytes: Uint8Array): Promise<LoadedWorkbook> {
  const workbook = new ExcelJS.Workbook();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  await workbook.xlsx.load(buffer);
  const date1904 = Boolean((workbook.properties as { date1904?: boolean } | undefined)?.date1904);
  const sheets = workbook.worksheets.map((ws) => {
    let ref: ExcelJS.Worksheet | undefined = ws;
    return lazySheet(ws.name, date1904, () => {
      const out = buildExcelJsSheet(ref!);
      ref = undefined;
      return out;
    });
  });
  return { sheets, editable: true };
}

// ---------------------------------------------------------------- SheetJS

function buildSheetJsSheet(name: string, ws: XLSX.WorkSheet): { model: SheetModel; numFmts: Map<string, string> } {
  const data = ((ws as unknown as Record<string, unknown>)['!data'] ?? []) as (XLSX.CellObject | undefined)[][];
  let usedCols = 0;
  const rows: Cell[][] = [];
  for (let r = 0; r < data.length; r++) {
    const src = data[r] ?? [];
    const out: Cell[] = [];
    for (let c = 0; c < src.length; c++) {
      const cell = src[c];
      if (!cell || cell.t === 'z') {
        out.push(null);
        continue;
      }
      const text = cell.w ?? (cell.v === undefined ? '' : String(cell.v));
      const numeric = cell.t === 'n' || cell.t === 'd';
      out.push(cell.f || numeric ? { v: text, raw: cell.f ? `=${cell.f}` : undefined, n: numeric || undefined } : text);
    }
    usedCols = Math.max(usedCols, out.length);
    rows.push(out);
  }
  const merges: MergeRange[] = (ws['!merges'] ?? []).map((m) => ({
    r: m.s.r,
    c: m.s.c,
    rs: m.e.r - m.s.r + 1,
    cs: m.e.c - m.s.c + 1,
  }));
  const cols = ws['!cols'];
  const model: SheetModel = {
    name,
    rowCount: Math.max(rows.length, 1),
    colCount: Math.max(usedCols, 1),
    rows,
  };
  if (merges.length) {
    model.merges = merges;
  }
  if (cols?.some((col) => col?.wpx)) {
    model.colWidths = Array.from({ length: model.colCount }, (_, c) => cols[c]?.wpx ?? null);
  }
  return { model, numFmts: new Map() };
}

function loadWithSheetJs(bytes: Uint8Array): LoadedWorkbook {
  const workbook = XLSX.read(bytes, { type: 'array', dense: true, cellText: true, cellFormula: true });
  const date1904 = Boolean(workbook.Workbook?.WBProps?.date1904);
  const sheets = workbook.SheetNames.map((name) => {
    let ref: XLSX.WorkSheet | undefined = workbook.Sheets[name];
    return lazySheet(name, date1904, () => {
      const out = buildSheetJsSheet(name, ref!);
      ref = undefined;
      return out;
    });
  });
  return { sheets, editable: false };
}

export async function loadWorkbook(bytes: Uint8Array, fileName: string): Promise<LoadedWorkbook> {
  return /\.(xlsx|xlsm)$/i.test(fileName) ? loadWithExcelJs(bytes) : loadWithSheetJs(bytes);
}
