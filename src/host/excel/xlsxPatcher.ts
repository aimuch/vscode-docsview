// Writes cell edits, row/column structural operations, and sheet additions/renames/deletions
// back into an .xlsx by patching only the affected OOXML parts. Untouched worksheets, styles,
// charts, pivot tables, macros and media are carried over byte-for-byte. Pure module.
import { DOMParser, XMLSerializer, type Document as XDocument, type Element as XElement } from '@xmldom/xmldom';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { StructureOp } from '../../common/protocol';
import { parseCellInput } from './cellInput';
import { expandSharedFormula, renameSheetInFormula, shiftFormulaReferences } from './formula';

export interface CellEdit {
  r: number;
  c: number;
  text: string;
  /** Optional evaluated result for formula cells, written to `<v>` alongside `<f>`. */
  cached?: number | string | boolean | { error: string };
}

export type WorkbookOp =
  | { kind: 'cells'; sheet: string; edits: CellEdit[] }
  | { kind: 'structure'; sheet: string; op: StructureOp; at: number; count: number }
  | { kind: 'addSheet'; name: string }
  | { kind: 'renameSheet'; oldName: string; newName: string }
  | { kind: 'deleteSheet'; name: string };

const XML = 'text/xml';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WORKSHEET_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const WORKSHEET_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
const PRECOMPRESSED_MEDIA = /\.(?:png|jpe?g|gif|webp|avif|mp4|m4v|mov|mp3|wav|ogg|zip|gz)$/i;

function createXmlParser(): DOMParser {
  return new DOMParser({ locator: false, onError: () => undefined });
}

function serializeXml(doc: XDocument): string {
  const out = new XMLSerializer().serializeToString(doc);
  return out.startsWith('<?xml') ? out : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${out}`;
}

function colName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function colIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i);
    if (code < 65 || code > 90) {
      break;
    }
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

function parseCellCoord(ref: string): { r: number; c: number } | undefined {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase());
  if (!m) {
    return undefined;
  }
  return { c: colIndex(m[1]), r: Number(m[2]) - 1 };
}

function elements(parent: XElement, localName: string): XElement[] {
  const out: XElement[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 && (node as XElement).localName === localName) {
      out.push(node as XElement);
    }
  }
  return out;
}

function resolveTarget(target: string): string {
  const clean = target.trim().replace(/\\/g, '/');
  if (clean.startsWith('/')) {
    return clean.replace(/^\/+/, '');
  }
  const parts = ['xl'];
  for (const part of clean.split('/')) {
    if (part === '..') {
      parts.pop();
    } else if (part && part !== '.') {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function findArchiveEntry(files: Record<string, Uint8Array>, candidate: string): string | undefined {
  if (files[candidate]) {
    return candidate;
  }
  if (candidate.startsWith('xl/xl/') && files[candidate.slice(3)]) {
    return candidate.slice(3);
  }
  const lower = candidate.toLowerCase();
  const trimmedLower = candidate.startsWith('xl/xl/') ? lower.slice(3) : undefined;
  for (const key of Object.keys(files)) {
    const norm = key.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    if (norm === lower || (trimmedLower && norm === trimmedLower)) {
      return key;
    }
  }
  return undefined;
}

/** Maps sheet name -> zip path of its XML. */
export function sheetPaths(files: Record<string, Uint8Array>): Map<string, string> {
  const wbKey = findArchiveEntry(files, 'xl/workbook.xml');
  const relsKey = findArchiveEntry(files, 'xl/_rels/workbook.xml.rels');
  const workbook = wbKey ? files[wbKey] : undefined;
  const rels = relsKey ? files[relsKey] : undefined;
  if (!workbook || !rels) {
    throw new Error('Not a valid xlsx file (workbook part missing).');
  }
  const parser = createXmlParser();
  const relDoc = parser.parseFromString(strFromU8(rels), XML);
  const targets = new Map<string, string>();
  const relNodes = relDoc.getElementsByTagName('Relationship');
  for (let i = 0; i < relNodes.length; i++) {
    const rel = relNodes.item(i)!;
    const resolved = resolveTarget(rel.getAttribute('Target') ?? '');
    targets.set(rel.getAttribute('Id') ?? '', findArchiveEntry(files, resolved) ?? resolved);
  }
  const wbDoc = parser.parseFromString(strFromU8(workbook), XML);
  const result = new Map<string, string>();
  const sheets = wbDoc.getElementsByTagNameNS('*', 'sheet');
  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets.item(i)!;
    const id = sheet.getAttributeNS(REL_NS, 'id') ?? sheet.getAttribute('r:id') ?? '';
    const path = targets.get(id);
    const name = sheet.getAttribute('name');
    if (path && name !== null) {
      result.set(name, path);
    }
  }
  return result;
}

/**
 * Expands `<f t="shared" si="...">` groups inside `sheetData` into standalone `<f>` formulas
 * so individual cell edits and row/column shifts never leave broken shared-formula followers.
 */
function materializeSharedFormulas(doc: XDocument, sheetData: XElement): void {
  const masters = new Map<string, { r: number; c: number; formula: string }>();
  let rowPos = 0;
  for (const rowEl of elements(sheetData, 'row')) {
    const rAttr = rowEl.getAttribute('r');
    rowPos = rAttr ? Number(rAttr) : rowPos + 1;
    let colPos = -1;
    for (const cEl of elements(rowEl, 'c')) {
      const ref = cEl.getAttribute('r');
      colPos = ref ? colIndex(ref) : colPos + 1;
      const fEl = elements(cEl, 'f')[0];
      if (fEl && fEl.getAttribute('t') === 'shared') {
        const si = fEl.getAttribute('si') ?? '';
        const body = (fEl.textContent ?? '').trim();
        if (body) {
          masters.set(si, { r: rowPos - 1, c: colPos, formula: body });
        }
      }
    }
  }
  if (!masters.size) {
    return;
  }
  rowPos = 0;
  for (const rowEl of elements(sheetData, 'row')) {
    const rAttr = rowEl.getAttribute('r');
    rowPos = rAttr ? Number(rAttr) : rowPos + 1;
    let colPos = -1;
    for (const cEl of elements(rowEl, 'c')) {
      const ref = cEl.getAttribute('r');
      colPos = ref ? colIndex(ref) : colPos + 1;
      const fEl = elements(cEl, 'f')[0];
      if (fEl && fEl.getAttribute('t') === 'shared') {
        const si = fEl.getAttribute('si') ?? '';
        const master = masters.get(si);
        fEl.removeAttribute('t');
        fEl.removeAttribute('ref');
        fEl.removeAttribute('si');
        if (master) {
          const expanded = expandSharedFormula(master.formula, master.r, master.c, rowPos - 1, colPos);
          while (fEl.firstChild) {
            fEl.removeChild(fEl.firstChild);
          }
          fEl.appendChild(doc.createTextNode(expanded));
        }
      }
    }
  }
}

function patchSheetXml(xml: string, edits: CellEdit[]): string {
  const doc: XDocument = createXmlParser().parseFromString(xml, XML);
  const root = doc.documentElement;
  if (!root) {
    throw new Error('Worksheet XML is empty.');
  }
  const ns = root.namespaceURI;
  const prefix = root.prefix ? `${root.prefix}:` : '';
  const create = (name: string) => doc.createElementNS(ns, prefix + name);

  let sheetData = elements(root, 'sheetData')[0];
  if (!sheetData) {
    sheetData = create('sheetData');
    root.appendChild(sheetData);
  }
  materializeSharedFormulas(doc, sheetData);

  // Row index -> element. Rows without an explicit number follow the previous one.
  const rows: { n: number; el: XElement }[] = [];
  let lastRow = 0;
  for (const el of elements(sheetData, 'row')) {
    const attr = el.getAttribute('r');
    lastRow = attr ? Number(attr) : lastRow + 1;
    rows.push({ n: lastRow, el });
  }

  const findRow = (n: number): XElement => {
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].n < n) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (rows[lo]?.n === n) {
      return rows[lo].el;
    }
    const el = create('row');
    el.setAttribute('r', String(n));
    sheetData.insertBefore(el, rows[lo]?.el ?? null);
    rows.splice(lo, 0, { n, el });
    return el;
  };

  const findCell = (row: XElement, rowNumber: number, c: number): XElement => {
    let position = -1;
    let before: XElement | null = null;
    for (const el of elements(row, 'c')) {
      const ref = el.getAttribute('r');
      position = ref ? colIndex(ref) : position + 1;
      if (position === c) {
        return el;
      }
      if (position > c) {
        before = el;
        break;
      }
    }
    const el = create('c');
    el.setAttribute('r', `${colName(c)}${rowNumber}`);
    row.insertBefore(el, before);
    // "spans" is only an optimisation hint; drop it rather than keep a stale one.
    row.removeAttribute('spans');
    return el;
  };

  for (const edit of edits) {
    const rowNumber = edit.r + 1;
    const cell = findCell(findRow(rowNumber), rowNumber, edit.c);
    // Keep the style attribute ("s"); drop stale value/formula metadata and replace content.
    while (cell.firstChild) {
      cell.removeChild(cell.firstChild);
    }
    cell.removeAttribute('t');
    cell.removeAttribute('cm');
    cell.removeAttribute('vm');
    cell.removeAttribute('ph');
    const input = parseCellInput(edit.text);
    const child = (name: string, text: string) => {
      const el = create(name);
      el.appendChild(doc.createTextNode(text));
      return el;
    };
    switch (input.kind) {
      case 'empty':
        break;
      case 'number':
        cell.appendChild(child('v', String(input.value)));
        break;
      case 'boolean':
        cell.setAttribute('t', 'b');
        cell.appendChild(child('v', input.value ? '1' : '0'));
        break;
      case 'formula':
        cell.appendChild(child('f', input.formula));
        if (edit.cached !== undefined) {
          if (typeof edit.cached === 'number') {
            cell.appendChild(child('v', String(edit.cached)));
          } else if (typeof edit.cached === 'boolean') {
            cell.setAttribute('t', 'b');
            cell.appendChild(child('v', edit.cached ? '1' : '0'));
          } else if (typeof edit.cached === 'string') {
            cell.setAttribute('t', 'str');
            cell.appendChild(child('v', edit.cached));
          } else if (typeof edit.cached === 'object' && 'error' in edit.cached) {
            cell.setAttribute('t', 'e');
            cell.appendChild(child('v', edit.cached.error));
          }
        }
        break;
      case 'string': {
        cell.setAttribute('t', 'inlineStr');
        const is = create('is');
        const t = child('t', input.value);
        t.setAttribute('xml:space', 'preserve');
        is.appendChild(t);
        cell.appendChild(is);
        break;
      }
    }
  }

  return serializeXml(doc);
}

// ---------------------------------------------------------------- structural XML patching

function shiftInterval(
  lo: number,
  hi: number,
  isInsert: boolean,
  at: number,
  count: number,
): [number, number] | undefined {
  if (isInsert) {
    if (lo >= at) {
      return [lo + count, hi + count];
    }
    if (hi >= at) {
      return [lo, hi + count];
    }
    return [lo, hi];
  }
  const delEnd = at + count - 1;
  if (hi < at) {
    return [lo, hi];
  }
  if (lo > delEnd) {
    return [lo - count, hi - count];
  }
  if (lo >= at && hi <= delEnd) {
    return undefined;
  }
  const nextLo = lo < at ? lo : at;
  const nextHi = hi > delEnd ? hi - count : at - 1;
  return nextLo <= nextHi ? [nextLo, nextHi] : undefined;
}

function patchStructureInSheetXml(
  xml: string,
  sheetName: string,
  op: StructureOp,
  at: number,
  count: number,
): string {
  const doc: XDocument = createXmlParser().parseFromString(xml, XML);
  const root = doc.documentElement;
  if (!root) {
    return xml;
  }
  const isRow = op === 'insertRow' || op === 'deleteRows';
  const isInsert = op.startsWith('insert');

  // Drop stale <dimension>; Excel & ExcelJS derive bounds from <sheetData>.
  for (const dim of elements(root, 'dimension')) {
    root.removeChild(dim);
  }

  // Update <cols> column width ranges on column insert/delete.
  if (!isRow) {
    const colsWrap = elements(root, 'cols')[0];
    if (colsWrap) {
      for (const colEl of elements(colsWrap, 'col')) {
        const min = Number(colEl.getAttribute('min') ?? '0') - 1;
        const max = Number(colEl.getAttribute('max') ?? '0') - 1;
        if (min < 0 || max < min) {
          continue;
        }
        const next = shiftInterval(min, max, isInsert, at, count);
        if (!next) {
          colsWrap.removeChild(colEl);
        } else {
          colEl.setAttribute('min', String(next[0] + 1));
          colEl.setAttribute('max', String(next[1] + 1));
        }
      }
      if (!elements(colsWrap, 'col').length) {
        root.removeChild(colsWrap);
      }
    }
  }

  const sheetData = elements(root, 'sheetData')[0];
  if (sheetData) {
    materializeSharedFormulas(doc, sheetData);

    let lastRowNum = 0;
    for (const rowEl of elements(sheetData, 'row')) {
      const rAttr = rowEl.getAttribute('r');
      lastRowNum = rAttr ? Number(rAttr) : lastRowNum + 1;
      const rIdx = lastRowNum - 1;

      let nextRowIdx = rIdx;
      if (isRow) {
        if (isInsert) {
          if (rIdx >= at) {
            nextRowIdx = rIdx + count;
          }
        } else {
          if (rIdx >= at && rIdx < at + count) {
            sheetData.removeChild(rowEl);
            continue;
          }
          if (rIdx >= at + count) {
            nextRowIdx = rIdx - count;
          }
        }
        if (nextRowIdx !== rIdx) {
          rowEl.setAttribute('r', String(nextRowIdx + 1));
        }
      }

      rowEl.removeAttribute('spans');
      let lastColIdx = -1;
      for (const cEl of elements(rowEl, 'c')) {
        const ref = cEl.getAttribute('r');
        lastColIdx = ref ? colIndex(ref) : lastColIdx + 1;
        let nextColIdx = lastColIdx;
        if (!isRow) {
          if (isInsert) {
            if (lastColIdx >= at) {
              nextColIdx = lastColIdx + count;
            }
          } else {
            if (lastColIdx >= at && lastColIdx < at + count) {
              rowEl.removeChild(cEl);
              continue;
            }
            if (lastColIdx >= at + count) {
              nextColIdx = lastColIdx - count;
            }
          }
        }
        if (nextRowIdx !== rIdx || nextColIdx !== lastColIdx) {
          cEl.setAttribute('r', `${colName(nextColIdx)}${nextRowIdx + 1}`);
        }
        const fEl = elements(cEl, 'f')[0];
        if (fEl && fEl.textContent) {
          const updated = shiftFormulaReferences(fEl.textContent, sheetName, sheetName, op, at, count);
          if (updated !== fEl.textContent) {
            while (fEl.firstChild) {
              fEl.removeChild(fEl.firstChild);
            }
            fEl.appendChild(doc.createTextNode(updated));
          }
        }
      }
    }
  }

  // Update <mergeCells>
  const mergesWrap = elements(root, 'mergeCells')[0];
  if (mergesWrap) {
    const mergeEls = elements(mergesWrap, 'mergeCell');
    for (const mEl of mergeEls) {
      const ref = mEl.getAttribute('ref') ?? '';
      const [a, b] = ref.split(':');
      const p1 = a ? parseCellCoord(a) : undefined;
      const p2 = b ? parseCellCoord(b) : undefined;
      if (!p1 || !p2) {
        continue;
      }
      const nextR = isRow ? shiftInterval(p1.r, p2.r, isInsert, at, count) : ([p1.r, p2.r] as [number, number]);
      const nextC = !isRow ? shiftInterval(p1.c, p2.c, isInsert, at, count) : ([p1.c, p2.c] as [number, number]);
      if (!nextR || !nextC || (nextR[0] === nextR[1] && nextC[0] === nextC[1])) {
        mergesWrap.removeChild(mEl);
      } else {
        mEl.setAttribute('ref', `${colName(nextC[0])}${nextR[0] + 1}:${colName(nextC[1])}${nextR[1] + 1}`);
      }
    }
    const remaining = elements(mergesWrap, 'mergeCell').length;
    if (!remaining) {
      root.removeChild(mergesWrap);
    } else {
      mergesWrap.setAttribute('count', String(remaining));
    }
  }

  return serializeXml(doc);
}

function rewriteFormulasInSheetXml(xml: string, transform: (formula: string) => string): string | undefined {
  const doc: XDocument = createXmlParser().parseFromString(xml, XML);
  const root = doc.documentElement;
  if (!root) {
    return undefined;
  }
  const sheetData = elements(root, 'sheetData')[0];
  if (!sheetData) {
    return undefined;
  }
  materializeSharedFormulas(doc, sheetData);
  let changed = false;
  for (const rowEl of elements(sheetData, 'row')) {
    for (const cEl of elements(rowEl, 'c')) {
      const fEl = elements(cEl, 'f')[0];
      if (fEl && fEl.textContent) {
        const next = transform(fEl.textContent);
        if (next !== fEl.textContent) {
          while (fEl.firstChild) {
            fEl.removeChild(fEl.firstChild);
          }
          fEl.appendChild(doc.createTextNode(next));
          changed = true;
        }
      }
    }
  }
  return changed ? serializeXml(doc) : undefined;
}

// ---------------------------------------------------------------- sheet CRUD XML patching

function applyAddSheet(files: Record<string, Uint8Array>, name: string): void {
  const parser = createXmlParser();
  let n = 1;
  while (files[`xl/worksheets/sheet${n}.xml`]) {
    n++;
  }
  const relPath = `worksheets/sheet${n}.xml`;
  const fullPath = `xl/${relPath}`;

  // 1. Add Relationship to xl/_rels/workbook.xml.rels
  const relsDoc = parser.parseFromString(strFromU8(files['xl/_rels/workbook.xml.rels']), XML);
  const relsRoot = relsDoc.documentElement!;
  const usedIds = new Set<string>();
  for (const el of elements(relsRoot, 'Relationship')) {
    usedIds.add(el.getAttribute('Id') ?? '');
  }
  let rNum = 1;
  while (usedIds.has(`rId${rNum}`)) {
    rNum++;
  }
  const rId = `rId${rNum}`;
  const relEl = relsDoc.createElementNS(relsRoot.namespaceURI, 'Relationship');
  relEl.setAttribute('Id', rId);
  relEl.setAttribute('Type', WORKSHEET_REL_TYPE);
  relEl.setAttribute('Target', relPath);
  relsRoot.appendChild(relEl);
  files['xl/_rels/workbook.xml.rels'] = strToU8(serializeXml(relsDoc));

  // 2. Append <sheet> to xl/workbook.xml
  const wbDoc = parser.parseFromString(strFromU8(files['xl/workbook.xml']), XML);
  const wbRoot = wbDoc.documentElement!;
  const wbPrefix = wbRoot.prefix ? `${wbRoot.prefix}:` : '';
  let sheetsWrap = elements(wbRoot, 'sheets')[0];
  if (!sheetsWrap) {
    sheetsWrap = wbDoc.createElementNS(wbRoot.namespaceURI, `${wbPrefix}sheets`);
    wbRoot.appendChild(sheetsWrap);
  }
  let maxSheetId = 0;
  for (const s of elements(sheetsWrap, 'sheet')) {
    maxSheetId = Math.max(maxSheetId, Number(s.getAttribute('sheetId') ?? '0'));
  }
  const sheetEl = wbDoc.createElementNS(wbRoot.namespaceURI, `${wbPrefix}sheet`);
  sheetEl.setAttribute('name', name);
  sheetEl.setAttribute('sheetId', String(maxSheetId + 1));
  if (!wbRoot.getAttribute('xmlns:r')) {
    wbRoot.setAttribute('xmlns:r', REL_NS);
  }
  sheetEl.setAttribute('r:id', rId);
  sheetsWrap.appendChild(sheetEl);
  files['xl/workbook.xml'] = strToU8(serializeXml(wbDoc));

  // 3. Register content type in [Content_Types].xml
  const typesRaw = files['[Content_Types].xml'];
  if (typesRaw) {
    const typesDoc = parser.parseFromString(strFromU8(typesRaw), XML);
    const typesRoot = typesDoc.documentElement;
    if (typesRoot) {
      const ov = typesDoc.createElementNS(typesRoot.namespaceURI, 'Override');
      ov.setAttribute('PartName', `/${fullPath}`);
      ov.setAttribute('ContentType', WORKSHEET_CONTENT_TYPE);
      typesRoot.appendChild(ov);
      files['[Content_Types].xml'] = strToU8(serializeXml(typesDoc));
    }
  }

  // 4. Write empty worksheet XML
  files[fullPath] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData/></worksheet>',
  );
}

function applyRenameSheet(files: Record<string, Uint8Array>, oldName: string, newName: string): void {
  const parser = createXmlParser();
  const wbDoc = parser.parseFromString(strFromU8(files['xl/workbook.xml']), XML);
  const wbRoot = wbDoc.documentElement!;
  const sheetsWrap = elements(wbRoot, 'sheets')[0];
  if (sheetsWrap) {
    for (const s of elements(sheetsWrap, 'sheet')) {
      if (s.getAttribute('name') === oldName) {
        s.setAttribute('name', newName);
      }
    }
  }
  const definedWrap = elements(wbRoot, 'definedNames')[0];
  if (definedWrap) {
    for (const d of elements(definedWrap, 'definedName')) {
      if (d.textContent) {
        const next = renameSheetInFormula(d.textContent, oldName, newName);
        if (next !== d.textContent) {
          while (d.firstChild) {
            d.removeChild(d.firstChild);
          }
          d.appendChild(wbDoc.createTextNode(next));
        }
      }
    }
  }
  files['xl/workbook.xml'] = strToU8(serializeXml(wbDoc));

  const needle = oldName.toLowerCase();
  for (const [, path] of sheetPaths(files)) {
    const raw = files[path] ? strFromU8(files[path]) : '';
    if (raw.toLowerCase().includes(needle)) {
      const updated = rewriteFormulasInSheetXml(raw, (f) => renameSheetInFormula(f, oldName, newName));
      if (updated !== undefined) {
        files[path] = strToU8(updated);
      }
    }
  }
}

function applyDeleteSheet(files: Record<string, Uint8Array>, name: string): void {
  const parser = createXmlParser();
  const wbDoc = parser.parseFromString(strFromU8(files['xl/workbook.xml']), XML);
  const wbRoot = wbDoc.documentElement!;
  const sheetsWrap = elements(wbRoot, 'sheets')[0];
  if (!sheetsWrap) {
    return;
  }
  const sheetEls = elements(sheetsWrap, 'sheet');
  if (sheetEls.length <= 1) {
    throw new Error('Cannot delete the last remaining worksheet.');
  }
  let removedRelId = '';
  for (const s of sheetEls) {
    if (s.getAttribute('name') === name) {
      removedRelId = s.getAttributeNS(REL_NS, 'id') ?? s.getAttribute('r:id') ?? '';
      sheetsWrap.removeChild(s);
      break;
    }
  }
  if (!removedRelId) {
    return;
  }
  const remainingCount = elements(sheetsWrap, 'sheet').length;
  const bookViews = elements(wbRoot, 'bookViews')[0];
  if (bookViews) {
    for (const view of elements(bookViews, 'workbookView')) {
      const activeTab = Number(view.getAttribute('activeTab') ?? '0');
      if (activeTab >= remainingCount) {
        view.setAttribute('activeTab', String(Math.max(0, remainingCount - 1)));
      }
    }
  }
  files['xl/workbook.xml'] = strToU8(serializeXml(wbDoc));

  let targetPath = '';
  const relsDoc = parser.parseFromString(strFromU8(files['xl/_rels/workbook.xml.rels']), XML);
  const relsRoot = relsDoc.documentElement!;
  for (const rel of elements(relsRoot, 'Relationship')) {
    if (rel.getAttribute('Id') === removedRelId) {
      targetPath = resolveTarget(rel.getAttribute('Target') ?? '');
      relsRoot.removeChild(rel);
      break;
    }
  }
  files['xl/_rels/workbook.xml.rels'] = strToU8(serializeXml(relsDoc));

  if (targetPath) {
    delete files[targetPath];
    const slash = targetPath.lastIndexOf('/');
    const sheetRels =
      slash >= 0 ? `${targetPath.slice(0, slash)}/_rels/${targetPath.slice(slash + 1)}.rels` : '';
    if (sheetRels && files[sheetRels]) {
      delete files[sheetRels];
    }
    const typesRaw = files['[Content_Types].xml'];
    if (typesRaw) {
      const typesDoc = parser.parseFromString(strFromU8(typesRaw), XML);
      const typesRoot = typesDoc.documentElement;
      if (typesRoot) {
        for (const ov of elements(typesRoot, 'Override')) {
          if ((ov.getAttribute('PartName') ?? '').replace(/^\/+/, '') === targetPath) {
            typesRoot.removeChild(ov);
          }
        }
        files['[Content_Types].xml'] = strToU8(serializeXml(typesDoc));
      }
    }
  }
}

/** Makes Excel recompute everything on open, since cached formula results may now be stale. */
function forceRecalculation(files: Record<string, Uint8Array>): void {
  const parser = createXmlParser();

  // Remove calcChain.xml if present (or referenced), using DOM manipulation rather than regex.
  const hasCalcChain = Object.keys(files).find((k) => k.toLowerCase() === 'xl/calcchain.xml');
  if (hasCalcChain) {
    delete files[hasCalcChain];
  }
  const types = files['[Content_Types].xml'];
  if (types) {
    const typesDoc = parser.parseFromString(strFromU8(types), XML);
    const root = typesDoc.documentElement;
    if (root) {
      let removed = false;
      for (const el of elements(root, 'Override')) {
        if ((el.getAttribute('PartName') ?? '').replace(/^\/+/, '').toLowerCase() === 'xl/calcchain.xml') {
          root.removeChild(el);
          removed = true;
        }
      }
      if (removed) {
        files['[Content_Types].xml'] = strToU8(serializeXml(typesDoc));
      }
    }
  }
  const rels = files['xl/_rels/workbook.xml.rels'];
  if (rels) {
    const relsDoc = parser.parseFromString(strFromU8(rels), XML);
    const root = relsDoc.documentElement;
    if (root) {
      let removed = false;
      for (const el of elements(root, 'Relationship')) {
        if (resolveTarget(el.getAttribute('Target') ?? '').toLowerCase() === 'xl/calcchain.xml') {
          root.removeChild(el);
          removed = true;
        }
      }
      if (removed) {
        files['xl/_rels/workbook.xml.rels'] = strToU8(serializeXml(relsDoc));
      }
    }
  }

  const wbDoc = parser.parseFromString(strFromU8(files['xl/workbook.xml']), XML);
  const wbRoot = wbDoc.documentElement;
  if (wbRoot) {
    let calcPr = elements(wbRoot, 'calcPr')[0];
    if (!calcPr) {
      const prefix = wbRoot.prefix ? `${wbRoot.prefix}:` : '';
      calcPr = wbDoc.createElementNS(wbRoot.namespaceURI, `${prefix}calcPr`);
      // Schema order: sheets, functionGroups, externalReferences, definedNames, calcPr.
      let after: XElement | undefined;
      for (const name of ['definedNames', 'externalReferences', 'functionGroups', 'sheets']) {
        const list = elements(wbRoot, name);
        if (list.length) {
          after = list[list.length - 1];
          break;
        }
      }
      wbRoot.insertBefore(calcPr, after ? after.nextSibling : null);
    }
    calcPr.setAttribute('fullCalcOnLoad', '1');
    files['xl/workbook.xml'] = strToU8(serializeXml(wbDoc));
  }
}

function coalesceOps(ops: readonly WorkbookOp[]): WorkbookOp[] {
  const out: WorkbookOp[] = [];
  for (const op of ops) {
    if (op.kind === 'cells' && !op.edits.length) {
      continue;
    }
    const prev = out[out.length - 1];
    if (op.kind === 'cells' && prev?.kind === 'cells' && prev.sheet === op.sheet) {
      const byCoord = new Map<string, CellEdit>();
      for (const e of prev.edits) {
        byCoord.set(`${e.r},${e.c}`, e);
      }
      for (const e of op.edits) {
        byCoord.set(`${e.r},${e.c}`, e);
      }
      prev.edits = [...byCoord.values()];
    } else if (op.kind === 'cells') {
      out.push({ kind: 'cells', sheet: op.sheet, edits: [...op.edits] });
    } else {
      out.push(op);
    }
  }
  return out;
}

/** Applies an ordered sequence of cell, row/column structure, and sheet operations to an `.xlsx` archive. */
export function applyWorkbookOps(bytes: Uint8Array, ops: readonly WorkbookOp[]): Uint8Array {
  const merged = coalesceOps(ops);
  if (!merged.length) {
    return bytes;
  }
  const files = unzipSync(bytes);
  let touched = false;

  for (const op of merged) {
    switch (op.kind) {
      case 'cells': {
        const paths = sheetPaths(files);
        const path = paths.get(op.sheet);
        if (!path || !files[path]) {
          throw new Error(`Sheet "${op.sheet}" was not found in the workbook.`);
        }
        files[path] = strToU8(patchSheetXml(strFromU8(files[path]), op.edits));
        touched = true;
        break;
      }
      case 'structure': {
        const paths = sheetPaths(files);
        const path = paths.get(op.sheet);
        if (!path || !files[path]) {
          throw new Error(`Sheet "${op.sheet}" was not found in the workbook.`);
        }
        files[path] = strToU8(patchStructureInSheetXml(strFromU8(files[path]), op.sheet, op.op, op.at, op.count));
        const needle = op.sheet.toLowerCase();
        for (const [otherName, otherPath] of paths) {
          if (otherName === op.sheet || !files[otherPath]) {
            continue;
          }
          const raw = strFromU8(files[otherPath]);
          if (raw.toLowerCase().includes(needle)) {
            const updated = rewriteFormulasInSheetXml(raw, (f) =>
              shiftFormulaReferences(f, op.sheet, otherName, op.op, op.at, op.count),
            );
            if (updated !== undefined) {
              files[otherPath] = strToU8(updated);
            }
          }
        }
        touched = true;
        break;
      }
      case 'addSheet':
        applyAddSheet(files, op.name);
        touched = true;
        break;
      case 'renameSheet':
        applyRenameSheet(files, op.oldName, op.newName);
        touched = true;
        break;
      case 'deleteSheet':
        applyDeleteSheet(files, op.name);
        touched = true;
        break;
    }
  }

  if (!touched) {
    return bytes;
  }
  forceRecalculation(files);
  const archive: Zippable = {};
  for (const [name, data] of Object.entries(files)) {
    archive[name] = PRECOMPRESSED_MEDIA.test(name) ? [data, { level: 0 }] : [data, { level: 6 }];
  }
  return zipSync(archive);
}

/**
 * Returns a new xlsx with the given cell edits applied.
 * @param edits cell edits keyed by sheet name
 */
export function patchXlsx(bytes: Uint8Array, edits: Map<string, CellEdit[]>): Uint8Array {
  const ops: WorkbookOp[] = [];
  for (const [sheet, list] of edits) {
    if (list.length) {
      ops.push({ kind: 'cells', sheet, edits: list });
    }
  }
  return applyWorkbookOps(bytes, ops);
}
