// Workbook bytes -> SheetModel. exceljs for xlsx/xlsm (keeps styles), SheetJS for the
// legacy/other formats or as a resilient fallback. Pure module.
import { DOMParser, XMLSerializer, type Element as XElement } from '@xmldom/xmldom';
import ExcelJS from 'exceljs';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import * as XLSX from 'xlsx';
import type { Cell, CellObject, CellStyle, MergeRange, SheetModel } from '../../common/protocol';
import { colToIndex, expandSharedFormula } from './formula';
import { attachImagesToSheetModel, extractWorkbookImages, type WorkbookImageExtraction } from './images';
import { sheetPaths } from './xlsxPatcher';

export interface LoadedSheet {
  name: string;
  readonly date1904?: boolean;
  readonly model: SheetModel;
  /** Number format per cell ("r,c"), used to format values typed or calculated in that cell. */
  readonly numFmts: Map<string, string>;
  /** Exact underlying scalar values ("r,c") from the file (numbers, date serials, booleans, strings). */
  readonly scalars: Map<string, number | string | boolean>;
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

function scalarOfValue(value: unknown): number | string | boolean | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (value instanceof Date) {
    return dateToSerial(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object' && Array.isArray((value as { richText?: unknown }).richText)) {
    return richText(value as never);
  }
  return undefined;
}

function convertCell(
  ws: ExcelJS.Worksheet,
  cell: ExcelJS.Cell,
  r: number,
  c: number,
  styleIndex: (style: CellStyle) => number,
): { cell: Cell; numFmt?: string; scalar?: number | string | boolean } {
  const value = cell.value as unknown;
  const numFmt = cell.numFmt || undefined;
  const out: CellObject = { v: '' };
  let scalar: number | string | boolean | undefined;

  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const obj = value as Record<string, unknown>;
    if ('formula' in obj || 'sharedFormula' in obj) {
      const result = formatScalar(obj.result, numFmt);
      out.v = result.text;
      out.n = result.numeric || undefined;
      scalar = scalarOfValue(obj.result);
      let formula = (obj.formula as string | undefined) ?? cell.formula;
      if (!formula && typeof obj.sharedFormula === 'string') {
        const refMatch = /^([A-Za-z]{1,3})(\d+)$/.exec(obj.sharedFormula);
        if (refMatch) {
          const master = ws.getCell(obj.sharedFormula);
          const masterVal = master.value as { formula?: string } | null;
          const masterFormula = masterVal?.formula ?? master.formula;
          if (masterFormula) {
            formula = expandSharedFormula(masterFormula, Number(refMatch[2]) - 1, colToIndex(refMatch[1]), r, c);
          }
        }
      }
      if (formula) {
        out.raw = `=${formula}`;
      }
      // Multi-cell CSE array formulas remain protected if their range spans multiple cells.
      if (obj.shareType === 'array' && typeof obj.ref === 'string' && obj.ref.includes(':')) {
        out.ro = true;
      }
    } else if ('hyperlink' in obj) {
      const text = obj.text;
      out.v =
        text && typeof text === 'object' && Array.isArray((text as { richText?: unknown }).richText)
          ? richText(text as never)
          : String(text ?? obj.hyperlink ?? '');
      scalar = out.v;
    } else {
      out.v = formatScalar(value, numFmt).text;
      scalar = scalarOfValue(value);
    }
  } else {
    const formatted = formatScalar(value, numFmt);
    out.v = formatted.text;
    out.n = formatted.numeric || undefined;
    scalar = scalarOfValue(value);
    if (typeof value === 'number' && String(value) !== formatted.text) {
      out.raw = String(value);
    }
  }

  const style = convertStyle(cell);
  if (style) {
    out.s = styleIndex(style);
  }
  const plain = out.s === undefined && out.raw === undefined && !out.n && !out.ro;
  return {
    cell: plain ? out.v : out,
    numFmt: numFmt && numFmt !== 'General' ? numFmt : undefined,
    scalar,
  };
}

function fillHoles(row: Cell[], length: number): Cell[] {
  for (let i = 0; i < length; i++) {
    if (row[i] === undefined) {
      row[i] = null;
    }
  }
  return row;
}

interface BuiltSheetData {
  model: SheetModel;
  numFmts: Map<string, string>;
  scalars: Map<string, number | string | boolean>;
}

function buildExcelJsSheet(ws: ExcelJS.Worksheet): BuiltSheetData {
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
  const scalars = new Map<string, number | string | boolean>();
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
      const converted = convertCell(ws, cell, r, c, styleIndex);
      out[c] = converted.cell;
      const key = `${r},${c}`;
      if (converted.numFmt) {
        numFmts.set(key, converted.numFmt);
      }
      if (converted.scalar !== undefined) {
        scalars.set(key, converted.scalar);
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
  return { model, numFmts, scalars };
}

function lazySheet(
  initialName: string,
  date1904: boolean,
  factory: () => BuiltSheetData,
): LoadedSheet {
  let currentName = initialName;
  let built: BuiltSheetData | undefined;
  let build: (() => BuiltSheetData) | undefined = factory;
  const ensure = () => {
    if (!built) {
      built = build!();
      built.model.name = currentName;
      build = undefined;
    }
    return built;
  };
  return {
    get name() {
      return currentName;
    },
    set name(next: string) {
      currentName = next;
      if (built) {
        built.model.name = next;
      }
    },
    date1904,
    get model() {
      return ensure().model;
    },
    get numFmts() {
      return ensure().numFmts;
    },
    get scalars() {
      return ensure().scalars;
    },
  };
}

const WORKSHEET_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * Parts ExcelJS never needs for cell values/styles/merges/panes, and which frequently crash
 * ExcelJS's non-namespace-aware Xforms (e.g. `<wsDr>` without `xdr:` -> `undefined.anchors`,
 * VML comments, charts, tables, pivot caches, embedded media).
 */
const SKIPPED_OOXML_PARTS =
  /^(?:docprops\/|customxml\/|xl\/(?:drawings|media|charts|chartsheets|dialogsheets|macrosheets|tables|pivottables|pivotcache|threadedcomments|persons|printersettings|embeddings|activex|ctrlprops|customxml)\/|xl\/(?:comments|vml|calcchain)[^/]*$)/i;

const EXCELJS_IGNORE_NODES = [
  'drawing',
  'legacyDrawing',
  'legacyDrawingHF',
  'picture',
  'tableParts',
  'dataValidations',
  'conditionalFormatting',
  'extLst',
  'autoFilter',
  'pageMargins',
  'pageSetup',
  'printOptions',
  'headerFooter',
  'rowBreaks',
  'colBreaks',
  'sheetProtection',
];

const SHEET_DATA_BYTES = [115, 104, 101, 101, 116, 68, 97, 116, 97]; // "sheetData"

function isZipArchive(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  );
}

function createSilentXmlParser(): DOMParser {
  return new DOMParser({ locator: false, onError: () => undefined });
}

function childElements(parent: XElement): XElement[] {
  const out: XElement[] = [];
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) {
      out.push(n as XElement);
    }
  }
  return out;
}

function resolveXlTarget(target: string): string {
  const clean = target.trim().replace(/\\/g, '/');
  if (clean.startsWith('/')) {
    return clean.replace(/^\/+/, '');
  }
  const parts = ['xl'];
  for (const seg of clean.split('/')) {
    if (seg === '..') {
      parts.pop();
    } else if (seg && seg !== '.') {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

/**
 * Strips dangling `r:id` attributes from `<hyperlink>` tags in the tail of a worksheet XML
 * (after `sheetData`) without decoding `<sheetData>` itself.
 */
function sanitizeWorksheetBytes(sheetBytes: Uint8Array, validHyperlinkIds: Set<string>): Uint8Array {
  let tailStart = 0;
  outer: for (let i = sheetBytes.byteLength - SHEET_DATA_BYTES.length; i >= 0; i--) {
    for (let j = 0; j < SHEET_DATA_BYTES.length; j++) {
      if (sheetBytes[i + j] !== SHEET_DATA_BYTES[j]) {
        continue outer;
      }
    }
    tailStart = i + SHEET_DATA_BYTES.length;
    while (tailStart < sheetBytes.byteLength && sheetBytes[tailStart] !== 0x3e) {
      tailStart++;
    }
    if (tailStart < sheetBytes.byteLength) {
      tailStart++;
    }
    break;
  }

  const tail = strFromU8(sheetBytes.subarray(tailStart));
  if (!tail.includes('hyperlink')) {
    return sheetBytes;
  }
  const cleanedTail = tail.replace(/<([a-zA-Z0-9_]+:)?hyperlink\b([^>]*)>/g, (full, prefix = '', attrs: string) => {
    const nextAttrs = attrs.replace(/\s+r:id=(?:"([^"]*)"|'([^']*)')/g, (attrFull, dId, sId) => {
      const id = dId ?? sId ?? '';
      return validHyperlinkIds.has(id) ? attrFull : '';
    });
    return nextAttrs === attrs ? full : `<${prefix}hyperlink${nextAttrs}>`;
  });
  if (cleanedTail === tail) {
    return sheetBytes;
  }
  const tailBytes = strToU8(cleanedTail);
  const merged = new Uint8Array(tailStart + tailBytes.byteLength);
  merged.set(sheetBytes.subarray(0, tailStart), 0);
  merged.set(tailBytes, tailStart);
  return merged;
}

/**
 * Builds a lean, sanitized in-memory `.xlsx` archive strictly for `ExcelJS.Workbook.xlsx.load`.
 * Original `bytes` in `ExcelSession` remain completely untouched so saving preserves all drawings,
 * charts, comments, tables, and media byte-for-byte.
 */
function prepareBufferForExcelJs(bytes: Uint8Array): ArrayBuffer {
  const unzipped = unzipSync(bytes, {
    filter: (file) => {
      const norm = file.name.replace(/\\/g, '/').replace(/^\/+/, '');
      return Boolean(norm) && !norm.endsWith('/') && !SKIPPED_OOXML_PARTS.test(norm);
    },
  });

  const raw: Record<string, Uint8Array> = {};
  const byLower = new Map<string, string>();
  for (const [k, v] of Object.entries(unzipped)) {
    const norm = k.replace(/\\/g, '/').replace(/^\/+/, '');
    raw[norm] = v;
    byLower.set(norm.toLowerCase(), norm);
  }

  const findKey = (candidate: string): string | undefined => {
    if (raw[candidate]) {
      return candidate;
    }
    if (candidate.startsWith('xl/xl/') && raw[candidate.slice(3)]) {
      return candidate.slice(3);
    }
    const lower = candidate.toLowerCase();
    return byLower.get(lower) ?? (lower.startsWith('xl/xl/') ? byLower.get(lower.slice(3)) : undefined);
  };

  const wbKey = findKey('xl/workbook.xml');
  const wbRelsKey = findKey('xl/_rels/workbook.xml.rels');
  if (!wbKey || !wbRelsKey) {
    throw new Error('Missing workbook OOXML parts.');
  }

  const parser = createSilentXmlParser();
  const serializer = new XMLSerializer();
  const out: Zippable = {};

  const rootRelsKey = findKey('_rels/.rels');
  if (rootRelsKey) {
    out['_rels/.rels'] = [raw[rootRelsKey], { level: 0 }];
  }
  const sharedStringsKey = findKey('xl/sharedStrings.xml');
  if (sharedStringsKey) {
    out['xl/sharedStrings.xml'] = [raw[sharedStringsKey], { level: 0 }];
  }
  const stylesKey = findKey('xl/styles.xml');
  if (stylesKey) {
    out['xl/styles.xml'] = [raw[stylesKey], { level: 0 }];
  }

  const wbRelsDoc = parser.parseFromString(strFromU8(raw[wbRelsKey]), 'text/xml');
  const wbRelsRoot = wbRelsDoc.documentElement;
  if (!wbRelsRoot) {
    throw new Error('Malformed workbook.xml.rels.');
  }

  let sheetIdx = 0;
  let themeCopied = false;
  for (const rel of childElements(wbRelsRoot)) {
    if (rel.localName !== 'Relationship') {
      continue;
    }
    const type = (rel.getAttribute('Type') ?? '').toLowerCase();
    const target = rel.getAttribute('Target') ?? '';
    if (type.endsWith('/worksheet')) {
      const sheetKey = findKey(resolveXlTarget(target));
      if (!sheetKey) {
        wbRelsRoot.removeChild(rel);
        continue;
      }
      sheetIdx++;
      rel.setAttribute('Type', WORKSHEET_REL_TYPE);
      rel.setAttribute('Target', `worksheets/sheet${sheetIdx}.xml`);

      const slash = sheetKey.lastIndexOf('/');
      const sheetRelsCandidate =
        slash >= 0 ? `${sheetKey.slice(0, slash)}/_rels/${sheetKey.slice(slash + 1)}.rels` : `_rels/${sheetKey}.rels`;
      const sheetRelsKey = findKey(sheetRelsCandidate);
      const validHyperlinkIds = new Set<string>();

      if (sheetRelsKey) {
        const sRelsDoc = parser.parseFromString(strFromU8(raw[sheetRelsKey]), 'text/xml');
        const sRelsRoot = sRelsDoc.documentElement;
        if (sRelsRoot) {
          for (const sRel of childElements(sRelsRoot)) {
            if (sRel.localName !== 'Relationship') {
              continue;
            }
            const sType = (sRel.getAttribute('Type') ?? '').toLowerCase();
            const sId = sRel.getAttribute('Id') ?? '';
            const sTarget = sRel.getAttribute('Target') ?? '';
            if (sType.endsWith('/hyperlink') && sId && sTarget) {
              validHyperlinkIds.add(sId);
            } else {
              sRelsRoot.removeChild(sRel);
            }
          }
          if (validHyperlinkIds.size > 0) {
            out[`xl/worksheets/_rels/sheet${sheetIdx}.xml.rels`] = [
              strToU8(serializer.serializeToString(sRelsDoc)),
              { level: 0 },
            ];
          }
        }
      }

      out[`xl/worksheets/sheet${sheetIdx}.xml`] = [
        sanitizeWorksheetBytes(raw[sheetKey], validHyperlinkIds),
        { level: 0 },
      ];
    } else if (type.endsWith('/sharedstrings') && sharedStringsKey) {
      rel.setAttribute('Target', 'sharedStrings.xml');
    } else if (type.endsWith('/styles') && stylesKey) {
      rel.setAttribute('Target', 'styles.xml');
    } else if (type.endsWith('/theme')) {
      const themeKey = findKey(resolveXlTarget(target));
      if (themeKey) {
        out['xl/theme/theme1.xml'] = [raw[themeKey], { level: 0 }];
        rel.setAttribute('Target', 'theme/theme1.xml');
        themeCopied = true;
      } else {
        wbRelsRoot.removeChild(rel);
      }
    } else {
      wbRelsRoot.removeChild(rel);
    }
  }

  if (!themeCopied) {
    const fallbackTheme = findKey('xl/theme/theme1.xml');
    if (fallbackTheme) {
      out['xl/theme/theme1.xml'] = [raw[fallbackTheme], { level: 0 }];
    }
  }

  out['xl/_rels/workbook.xml.rels'] = [strToU8(serializer.serializeToString(wbRelsDoc)), { level: 0 }];

  const wbDoc = parser.parseFromString(strFromU8(raw[wbKey]), 'text/xml');
  const wbRoot = wbDoc.documentElement;
  if (wbRoot) {
    for (const child of childElements(wbRoot)) {
      if (child.localName === 'definedNames') {
        wbRoot.removeChild(child);
      } else if (child.localName === 'sheets') {
        for (const s of childElements(child)) {
          if (s.localName === 'sheet' && !s.getAttribute('r:id')) {
            const nsId = s.getAttributeNS(REL_NS, 'id');
            if (nsId) {
              s.setAttribute('r:id', nsId);
            }
          }
        }
      }
    }
    out['xl/workbook.xml'] = [strToU8(serializer.serializeToString(wbDoc)), { level: 0 }];
  } else {
    out['xl/workbook.xml'] = [raw[wbKey], { level: 0 }];
  }

  const packed = zipSync(out, { level: 0 });
  return packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength) as ArrayBuffer;
}

function canPatchOoxml(bytes: Uint8Array): boolean {
  if (!isZipArchive(bytes)) {
    return false;
  }
  try {
    const meta = unzipSync(bytes, {
      filter: (f) => {
        const norm = f.name.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
        return norm === 'xl/workbook.xml' || norm === 'xl/_rels/workbook.xml.rels';
      },
    });
    return sheetPaths(meta).size > 0;
  } catch {
    return false;
  }
}

async function loadWithExcelJs(bytes: Uint8Array, images: WorkbookImageExtraction): Promise<LoadedWorkbook> {
  const workbook = new ExcelJS.Workbook();
  const buffer = prepareBufferForExcelJs(bytes);
  await workbook.xlsx.load(buffer, { ignoreNodes: EXCELJS_IGNORE_NODES } as never);
  const date1904 = Boolean((workbook.properties as { date1904?: boolean } | undefined)?.date1904);
  const sheets = workbook.worksheets.map((ws) => {
    let ref: ExcelJS.Worksheet | undefined = ws;
    return lazySheet(ws.name, date1904, () => {
      const out = buildExcelJsSheet(ref!);
      attachImagesToSheetModel(out.model, images);
      ref = undefined;
      return out;
    });
  });
  return { sheets, editable: true };
}

// ---------------------------------------------------------------- SheetJS

function buildSheetJsSheet(name: string, ws: XLSX.WorkSheet, editable: boolean): BuiltSheetData {
  const data = ((ws as unknown as Record<string, unknown>)['!data'] ?? []) as (XLSX.CellObject | undefined)[][];
  let usedCols = 0;
  const rows: Cell[][] = [];
  const numFmts = new Map<string, string>();
  const scalars = new Map<string, number | string | boolean>();
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
      const key = `${r},${c}`;
      if (typeof cell.v === 'number' && Number.isFinite(cell.v)) {
        scalars.set(key, cell.v);
      } else if (cell.v instanceof Date) {
        scalars.set(key, dateToSerial(cell.v));
      } else if (typeof cell.v === 'boolean' || typeof cell.v === 'string') {
        scalars.set(key, cell.v);
      }
      if (typeof cell.z === 'string' && cell.z && cell.z !== 'General') {
        numFmts.set(key, cell.z);
      }
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
  for (const m of merges) {
    usedCols = Math.max(usedCols, m.c + m.cs);
  }
  const cols = ws['!cols'];
  const colCount = editable ? Math.max(usedCols + EXTRA_COLS, 10) : Math.max(usedCols, 1);
  const rowCount = editable ? Math.max(rows.length + EXTRA_ROWS, 40) : Math.max(rows.length, 1);
  const model: SheetModel = {
    name,
    rowCount,
    colCount,
    rows,
  };
  if (merges.length) {
    model.merges = merges;
  }
  if (cols?.some((col) => col?.wpx)) {
    model.colWidths = Array.from({ length: model.colCount }, (_, c) => cols[c]?.wpx ?? null);
  }
  return { model, numFmts, scalars };
}

function loadWithSheetJs(bytes: Uint8Array, editable = false, images?: WorkbookImageExtraction): LoadedWorkbook {
  const workbook = XLSX.read(bytes, { type: 'array', dense: true, cellText: true, cellFormula: true, cellNF: true });
  const date1904 = Boolean(workbook.Workbook?.WBProps?.date1904);
  const sheets = workbook.SheetNames.map((name) => {
    let ref: XLSX.WorkSheet | undefined = workbook.Sheets[name];
    return lazySheet(name, date1904, () => {
      const out = buildSheetJsSheet(name, ref!, editable);
      attachImagesToSheetModel(out.model, images);
      ref = undefined;
      return out;
    });
  });
  return { sheets, editable };
}

export async function loadWorkbook(bytes: Uint8Array, fileName: string): Promise<LoadedWorkbook> {
  const images = extractWorkbookImages(bytes, fileName);
  if (/\.(xlsx|xlsm)$/i.test(fileName) && isZipArchive(bytes)) {
    try {
      const loaded = await loadWithExcelJs(bytes, images);
      if (loaded.sheets.length > 0) {
        return loaded;
      }
      const fallback = loadWithSheetJs(bytes, canPatchOoxml(bytes), images);
      return fallback.sheets.length > 0 ? fallback : loaded;
    } catch {
      return loadWithSheetJs(bytes, canPatchOoxml(bytes), images);
    }
  }
  return loadWithSheetJs(bytes, false, images);
}
