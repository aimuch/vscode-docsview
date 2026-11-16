// Writes cell edits back into an .xlsx by patching only the affected worksheet XML.
// Every other part of the package (styles, charts, pivot tables, macros, images) is
// carried over byte-for-byte, which a load-modify-save through a workbook library
// cannot guarantee. Pure module.
import { DOMParser, XMLSerializer, type Document as XDocument, type Element as XElement } from '@xmldom/xmldom';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { parseCellInput } from './cellInput';

export interface CellEdit {
  r: number;
  c: number;
  text: string;
}

const XML = 'text/xml';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PRECOMPRESSED_MEDIA = /\.(?:png|jpe?g|gif|webp|avif|mp4|m4v|mov|mp3|wav|ogg|zip|gz)$/i;

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
  if (target.startsWith('/')) {
    return target.slice(1);
  }
  const parts = ['xl'];
  for (const part of target.split('/')) {
    if (part === '..') {
      parts.pop();
    } else if (part !== '.') {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/** Maps sheet name -> zip path of its XML. */
export function sheetPaths(files: Record<string, Uint8Array>): Map<string, string> {
  const workbook = files['xl/workbook.xml'];
  const rels = files['xl/_rels/workbook.xml.rels'];
  if (!workbook || !rels) {
    throw new Error('Not a valid xlsx file (workbook part missing).');
  }
  const parser = new DOMParser();
  const relDoc = parser.parseFromString(strFromU8(rels), XML);
  const targets = new Map<string, string>();
  const relNodes = relDoc.getElementsByTagName('Relationship');
  for (let i = 0; i < relNodes.length; i++) {
    const rel = relNodes.item(i)!;
    targets.set(rel.getAttribute('Id') ?? '', resolveTarget(rel.getAttribute('Target') ?? ''));
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

function patchSheetXml(xml: string, edits: CellEdit[]): string {
  const doc: XDocument = new DOMParser().parseFromString(xml, XML);
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
        // No cached value: the workbook is flagged for a full recalculation on load.
        cell.appendChild(child('f', input.formula));
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

/** Makes Excel recompute everything on open, since cached formula results may now be stale. */
function forceRecalculation(files: Record<string, Uint8Array>): void {
  const parser = new DOMParser();

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

/**
 * Returns a new xlsx with the given edits applied.
 * @param edits cell edits keyed by sheet name
 */
export function patchXlsx(bytes: Uint8Array, edits: Map<string, CellEdit[]>): Uint8Array {
  const files = unzipSync(bytes);
  const paths = sheetPaths(files);
  let touched = false;
  for (const [name, list] of edits) {
    if (!list.length) {
      continue;
    }
    const path = paths.get(name);
    if (!path || !files[path]) {
      throw new Error(`Sheet "${name}" was not found in the workbook.`);
    }
    files[path] = strToU8(patchSheetXml(strFromU8(files[path]), list));
    touched = true;
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
