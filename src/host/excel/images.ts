// Pure OOXML (.xlsx/.xlsm) & ODS (.ods) spreadsheet image extractor (zero extra dependencies).
// Extracts:
//   1. Floating DrawingML images (xl/drawings/drawing*.xml: twoCellAnchor, oneCellAnchor,
//      absoluteAnchor, mc:AlternateContent, grpSp group shapes, rotation/flip, svgBlip fallback).
//   2. WPS Office in-cell images (xl/cellimages.xml + =DISPIMG("ID_...", ...)).
//   3. Microsoft Excel 365 "Place in Cell" images (xl/metadata.xml + xl/richData/rdRichValue*.xml).
//   4. OpenDocument Spreadsheet (.ods) embedded images (content.xml + Pictures/*).
import { DOMParser, type Element as XElement } from '@xmldom/xmldom';
import { strFromU8, unzipSync } from 'fflate';
import type { Cell, CellObject, SheetImage, SheetModel } from '../../common/protocol';
import { colToIndex } from './formula';

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMU_PER_PX = 9525;
const MAX_SINGLE_MEDIA_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_MEDIA_BYTES = 60 * 1024 * 1024;
const DISPIMG_RE = /^=?(?:_xlfn\.)?DISPIMG\(\s*["']([^"']+)["']/i;
const CELL_IMAGE_ERROR_TEXT_RE = /^(?:#NAME\?|#VALUE!|#UNKNOWN!|=?(?:_xlfn\.)?DISPIMG\()/i;

export interface WorkbookImageExtraction {
  /** Exact sheet name -> extracted floating & Excel 365 Place-in-Cell images. */
  bySheetName: Map<string, SheetImage[]>;
  /** WPS `xl/cellimages.xml` ID -> media reference + optional alt text. */
  wpsCellImages: Map<string, { mediaId: string; alt?: string }>;
  /** Deduplicated media data URLs (`mediaId -> data:...`). */
  media: Record<string, string>;
}

const EMPTY_EXTRACTION: WorkbookImageExtraction = {
  bySheetName: new Map(),
  wpsCellImages: new Map(),
  media: {},
};

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

function childElements(parent: XElement | null | undefined): XElement[] {
  if (!parent) return [];
  const out: XElement[] = [];
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) {
      out.push(n as XElement);
    }
  }
  return out;
}

function firstChildByLocalName(parent: XElement | null | undefined, localName: string): XElement | undefined {
  if (!parent) return undefined;
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as XElement).localName === localName) {
      return n as XElement;
    }
  }
  return undefined;
}

function firstDescendantByLocalName(parent: XElement | null | undefined, localName: string): XElement | undefined {
  if (!parent) return undefined;
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) {
      const el = n as XElement;
      if (el.localName === localName) return el;
      const nested = firstDescendantByLocalName(el, localName);
      if (nested) return nested;
    }
  }
  return undefined;
}

function getAttr(el: XElement | null | undefined, localName: string, ns?: string): string {
  if (!el) return '';
  if (ns) {
    const v = el.getAttributeNS(ns, localName);
    if (v) return v;
  }
  const direct = el.getAttribute(localName);
  if (direct) return direct;
  const rPrefixed = ns === REL_NS ? el.getAttribute(`r:${localName}`) : '';
  if (rPrefixed) return rPrefixed;
  const attrs = el.attributes;
  if (attrs) {
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      if (a.localName === localName && (!ns || !a.namespaceURI || a.namespaceURI === ns)) {
        return a.value;
      }
    }
  }
  return '';
}

function normalizeZipPath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.trim().replace(/\\/g, '/').replace(/^\/+/, '').split('/')) {
    if (seg === '..') {
      parts.pop();
    } else if (seg && seg !== '.') {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

function resolveRelativeTarget(ownerPath: string, target: string): string {
  const clean = target.trim().replace(/\\/g, '/');
  if (!clean) return '';
  if (clean.startsWith('/')) {
    return normalizeZipPath(clean);
  }
  const slash = ownerPath.lastIndexOf('/');
  const dir = slash >= 0 ? ownerPath.slice(0, slash) : '';
  return normalizeZipPath(dir ? `${dir}/${clean}` : clean);
}

function relsPathFor(partPath: string): string {
  const slash = partPath.lastIndexOf('/');
  return slash >= 0 ? `${partPath.slice(0, slash)}/_rels/${partPath.slice(slash + 1)}.rels` : `_rels/${partPath}.rels`;
}

function emuToPx(raw: string | undefined | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n / EMU_PER_PX) * 10) / 10;
}

function intText(el: XElement | undefined): number {
  const n = Number(el?.textContent?.trim() ?? '');
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function detectImageMime(bytes: Uint8Array, path: string): string | undefined {
  if (bytes.byteLength < 4) return undefined;
  // Magic-byte sniffing first (handles misnamed extensions cleanly)
  if (bytes.byteLength >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return 'image/x-icon';
  }
  const head = strFromU8(bytes.subarray(0, Math.min(256, bytes.byteLength))).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'image/svg+xml';
  }
  // Extension fallback (only browser-renderable formats; skip raw EMF/WMF/TIFF that <img> cannot decode)
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
    case '.jfif':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.bmp':
    case '.dib':
      return 'image/bmp';
    case '.svg':
      return 'image/svg+xml';
    case '.ico':
      return 'image/x-icon';
    case '.avif':
      return 'image/avif';
    default:
      return undefined;
  }
}

interface ArchiveLookup {
  find(path: string): { key: string; bytes: Uint8Array } | undefined;
  registerMedia(path: string): string | undefined;
  media: Record<string, string>;
}

function createArchiveLookup(entries: Record<string, Uint8Array>): ArchiveLookup {
  const byLower = new Map<string, { key: string; bytes: Uint8Array }>();
  for (const [k, v] of Object.entries(entries)) {
    const norm = normalizeZipPath(k);
    if (norm) {
      byLower.set(norm.toLowerCase(), { key: norm, bytes: v });
    }
  }
  const find = (candidate: string) => {
    const norm = normalizeZipPath(candidate).toLowerCase();
    return (
      byLower.get(norm) ??
      (norm.startsWith('xl/xl/') ? byLower.get(norm.slice(3)) : undefined)
    );
  };

  const media: Record<string, string> = {};
  const pathToMediaId = new Map<string, string>();
  let totalBytes = 0;
  let seq = 0;

  const registerMedia = (candidate: string): string | undefined => {
    const hit = find(candidate);
    if (!hit) return undefined;
    const lowerKey = hit.key.toLowerCase();
    const existing = pathToMediaId.get(lowerKey);
    if (existing) return existing;
    if (hit.bytes.byteLength === 0 || hit.bytes.byteLength > MAX_SINGLE_MEDIA_BYTES) {
      return undefined;
    }
    if (totalBytes + hit.bytes.byteLength > MAX_TOTAL_MEDIA_BYTES) {
      return undefined;
    }
    const mime = detectImageMime(hit.bytes, hit.key);
    if (!mime) return undefined;
    const id = `m${seq++}`;
    totalBytes += hit.bytes.byteLength;
    media[id] = `data:${mime};base64,${Buffer.from(hit.bytes).toString('base64')}`;
    pathToMediaId.set(lowerKey, id);
    return id;
  };

  return { find, registerMedia, media };
}

interface RelEntry {
  id: string;
  type: string;
  target: string;
}

function parseRels(parser: DOMParser, xmlBytes: Uint8Array, ownerPath: string): Map<string, RelEntry> {
  const map = new Map<string, RelEntry>();
  const doc = parser.parseFromString(strFromU8(xmlBytes), 'text/xml');
  const root = doc.documentElement;
  for (const rel of childElements(root)) {
    if (rel.localName !== 'Relationship') continue;
    const mode = (rel.getAttribute('TargetMode') ?? '').toLowerCase();
    if (mode === 'external') continue;
    const id = rel.getAttribute('Id') ?? '';
    const type = rel.getAttribute('Type') ?? '';
    const rawTarget = rel.getAttribute('Target') ?? '';
    if (!id || !rawTarget) continue;
    map.set(id, { id, type, target: resolveRelativeTarget(ownerPath, rawTarget) });
  }
  return map;
}

interface ParsedPic {
  mediaId: string;
  alt?: string;
  rot?: number;
  flipH?: boolean;
  flipV?: boolean;
  extWidthPx?: number;
  extHeightPx?: number;
}

function findBlipEmbedIds(blipFill: XElement): string[] {
  const ids: string[] = [];
  const blip = firstChildByLocalName(blipFill, 'blip');
  if (!blip) return ids;
  const primary = getAttr(blip, 'embed', REL_NS) || getAttr(blip, 'link', REL_NS);
  if (primary) ids.push(primary);
  // Check <a:extLst> for <asvg:svgBlip r:embed="..."/> fallback (e.g. when primary is EMF or SVG)
  const walkExt = (node: XElement) => {
    for (const ch of childElements(node)) {
      if (ch.localName === 'svgBlip') {
        const sid = getAttr(ch, 'embed', REL_NS);
        if (sid && !ids.includes(sid)) ids.push(sid);
      } else {
        walkExt(ch);
      }
    }
  };
  const extLst = firstChildByLocalName(blip, 'extLst');
  if (extLst) walkExt(extLst);
  return ids;
}

function parsePicElement(
  pic: XElement,
  rels: Map<string, RelEntry>,
  archive: ArchiveLookup,
): ParsedPic | undefined {
  const blipFill = firstChildByLocalName(pic, 'blipFill');
  if (!blipFill) return undefined;
  const embedIds = findBlipEmbedIds(blipFill);
  let mediaId: string | undefined;
  for (const rid of embedIds) {
    const rel = rels.get(rid);
    if (!rel) continue;
    const resolved = archive.registerMedia(rel.target);
    if (resolved) {
      mediaId = resolved;
      break;
    }
  }
  if (!mediaId) return undefined;

  const nvPicPr = firstChildByLocalName(pic, 'nvPicPr');
  const cNvPr = firstChildByLocalName(nvPicPr, 'cNvPr');
  const alt =
    (cNvPr?.getAttribute('descr') || cNvPr?.getAttribute('title') || cNvPr?.getAttribute('name') || '').trim() ||
    undefined;

  let rot: number | undefined;
  let flipH: boolean | undefined;
  let flipV: boolean | undefined;
  let extWidthPx: number | undefined;
  let extHeightPx: number | undefined;
  const spPr = firstChildByLocalName(pic, 'spPr');
  const xfrm = firstChildByLocalName(spPr, 'xfrm');
  if (xfrm) {
    const rawRot = Number(xfrm.getAttribute('rot') ?? '');
    if (Number.isFinite(rawRot) && rawRot !== 0) {
      rot = Math.round((rawRot / 60000) * 10) / 10;
    }
    const fh = xfrm.getAttribute('flipH');
    if (fh === '1' || fh === 'true') flipH = true;
    const fv = xfrm.getAttribute('flipV');
    if (fv === '1' || fv === 'true') flipV = true;
    const ext = firstChildByLocalName(xfrm, 'ext');
    if (ext) {
      const w = emuToPx(ext.getAttribute('cx'));
      const h = emuToPx(ext.getAttribute('cy'));
      if (w > 0) extWidthPx = w;
      if (h > 0) extHeightPx = h;
    }
  }

  return { mediaId, alt, rot, flipH, flipV, extWidthPx, extHeightPx };
}

/** Collects resolved pictures from an anchor container, deduplicating mc:AlternateContent branches. */
function collectAnchorPics(
  container: XElement,
  rels: Map<string, RelEntry>,
  archive: ArchiveLookup,
): ParsedPic[] {
  const out: ParsedPic[] = [];
  for (const ch of childElements(container)) {
    const name = ch.localName;
    if (name === 'pic') {
      const parsed = parsePicElement(ch, rels, archive);
      if (parsed) out.push(parsed);
    } else if (name === 'AlternateContent') {
      const choice = firstChildByLocalName(ch, 'Choice');
      const choicePics = choice ? collectAnchorPics(choice, rels, archive) : [];
      if (choicePics.length > 0) {
        out.push(...choicePics);
      } else {
        const fallback = firstChildByLocalName(ch, 'Fallback');
        if (fallback) {
          out.push(...collectAnchorPics(fallback, rels, archive));
        }
      }
    } else if (name === 'grpSp') {
      out.push(...collectAnchorPics(ch, rels, archive));
    }
  }
  return out;
}

function parseCellMarker(marker: XElement): { col: number; colOffPx: number; row: number; rowOffPx: number } {
  return {
    col: Math.max(0, intText(firstChildByLocalName(marker, 'col'))),
    colOffPx: Math.max(0, emuToPx(firstChildByLocalName(marker, 'colOff')?.textContent)),
    row: Math.max(0, intText(firstChildByLocalName(marker, 'row'))),
    rowOffPx: Math.max(0, emuToPx(firstChildByLocalName(marker, 'rowOff')?.textContent)),
  };
}

function parseDrawingXml(
  parser: DOMParser,
  drawingPath: string,
  drawingBytes: Uint8Array,
  archive: ArchiveLookup,
  nextId: () => string,
): SheetImage[] {
  const relsEntry = archive.find(relsPathFor(drawingPath));
  if (!relsEntry) return [];
  const rels = parseRels(parser, relsEntry.bytes, drawingPath);
  if (!rels.size) return [];

  const doc = parser.parseFromString(strFromU8(drawingBytes), 'text/xml');
  const root = doc.documentElement;
  const images: SheetImage[] = [];

  for (const anchor of childElements(root)) {
    const kindName = anchor.localName;
    if (kindName !== 'twoCellAnchor' && kindName !== 'oneCellAnchor' && kindName !== 'absoluteAnchor') {
      continue;
    }
    const pics = collectAnchorPics(anchor, rels, archive);
    if (!pics.length) continue;

    if (kindName === 'twoCellAnchor') {
      const fromEl = firstChildByLocalName(anchor, 'from');
      const toEl = firstChildByLocalName(anchor, 'to');
      if (!fromEl || !toEl) continue;
      const from = parseCellMarker(fromEl);
      const to = parseCellMarker(toEl);
      const degenerate =
        from.row === to.row && from.col === to.col && to.colOffPx <= from.colOffPx && to.rowOffPx <= from.rowOffPx;
      for (const pic of pics) {
        if (degenerate && pic.extWidthPx && pic.extHeightPx) {
          images.push({
            id: nextId(),
            mediaId: pic.mediaId,
            kind: 'floating',
            fromRow: from.row,
            fromCol: from.col,
            fromX: from.colOffPx,
            fromY: from.rowOffPx,
            width: pic.extWidthPx,
            height: pic.extHeightPx,
            alt: pic.alt,
            rot: pic.rot,
            flipH: pic.flipH,
            flipV: pic.flipV,
          });
        } else {
          images.push({
            id: nextId(),
            mediaId: pic.mediaId,
            kind: 'floating',
            fromRow: from.row,
            fromCol: from.col,
            fromX: from.colOffPx,
            fromY: from.rowOffPx,
            toRow: to.row,
            toCol: to.col,
            toX: to.colOffPx,
            toY: to.rowOffPx,
            alt: pic.alt,
            rot: pic.rot,
            flipH: pic.flipH,
            flipV: pic.flipV,
          });
        }
      }
    } else if (kindName === 'oneCellAnchor') {
      const fromEl = firstChildByLocalName(anchor, 'from');
      if (!fromEl) continue;
      const from = parseCellMarker(fromEl);
      const extEl = firstChildByLocalName(anchor, 'ext');
      const anchorW = emuToPx(extEl?.getAttribute('cx'));
      const anchorH = emuToPx(extEl?.getAttribute('cy'));
      for (const pic of pics) {
        images.push({
          id: nextId(),
          mediaId: pic.mediaId,
          kind: 'floating',
          fromRow: from.row,
          fromCol: from.col,
          fromX: from.colOffPx,
          fromY: from.rowOffPx,
          width: anchorW > 0 ? anchorW : (pic.extWidthPx ?? 120),
          height: anchorH > 0 ? anchorH : (pic.extHeightPx ?? 90),
          alt: pic.alt,
          rot: pic.rot,
          flipH: pic.flipH,
          flipV: pic.flipV,
        });
      }
    } else {
      // absoluteAnchor
      const posEl = firstChildByLocalName(anchor, 'pos');
      const extEl = firstChildByLocalName(anchor, 'ext');
      const posX = Math.max(0, emuToPx(posEl?.getAttribute('x')));
      const posY = Math.max(0, emuToPx(posEl?.getAttribute('y')));
      const anchorW = emuToPx(extEl?.getAttribute('cx'));
      const anchorH = emuToPx(extEl?.getAttribute('cy'));
      for (const pic of pics) {
        images.push({
          id: nextId(),
          mediaId: pic.mediaId,
          kind: 'floating',
          fromRow: 0,
          fromCol: 0,
          fromX: posX,
          fromY: posY,
          width: anchorW > 0 ? anchorW : (pic.extWidthPx ?? 120),
          height: anchorH > 0 ? anchorH : (pic.extHeightPx ?? 90),
          alt: pic.alt,
          rot: pic.rot,
          flipH: pic.flipH,
          flipV: pic.flipV,
        });
      }
    }
  }
  return images;
}

/** Parses WPS Office `xl/cellimages.xml` mapping `ID_...` -> mediaId. */
function parseWpsCellImages(
  parser: DOMParser,
  archive: ArchiveLookup,
): Map<string, { mediaId: string; alt?: string }> {
  const out = new Map<string, { mediaId: string; alt?: string }>();
  const ciEntry = archive.find('xl/cellimages.xml');
  if (!ciEntry) return out;
  const relsEntry = archive.find(relsPathFor(ciEntry.key));
  if (!relsEntry) return out;
  const rels = parseRels(parser, relsEntry.bytes, ciEntry.key);
  if (!rels.size) return out;

  const doc = parser.parseFromString(strFromU8(ciEntry.bytes), 'text/xml');
  const root = doc.documentElement;
  for (const item of childElements(root)) {
    if (item.localName !== 'cellImage') continue;
    const pic = firstDescendantByLocalName(item, 'pic');
    if (!pic) continue;
    const nvPicPr = firstChildByLocalName(pic, 'nvPicPr');
    const cNvPr = firstChildByLocalName(nvPicPr, 'cNvPr');
    const id = (cNvPr?.getAttribute('name') ?? '').trim();
    if (!id) continue;
    const parsed = parsePicElement(pic, rels, archive);
    if (!parsed) continue;
    const descr = (cNvPr?.getAttribute('descr') || cNvPr?.getAttribute('title') || '').trim() || undefined;
    out.set(id, { mediaId: parsed.mediaId, alt: descr });
  }
  return out;
}

/** Parses Microsoft Excel 365 Place-in-Cell metadata (`xl/metadata.xml` + `xl/richData/*`). */
function parseExcel365ValueMetadataImages(
  parser: DOMParser,
  archive: ArchiveLookup,
): Map<number, { mediaId: string; alt?: string }> {
  const vmToMedia = new Map<number, { mediaId: string; alt?: string }>();
  const metaEntry = archive.find('xl/metadata.xml');
  const rvEntry = archive.find('xl/richData/rdrichvalue.xml');
  const rvStructEntry = archive.find('xl/richData/rdrichvaluestructure.xml');
  const rvRelEntry = archive.find('xl/richData/richValueRel.xml');
  if (!metaEntry || !rvEntry || !rvStructEntry || !rvRelEntry) {
    return vmToMedia;
  }
  const rvRelRelsEntry = archive.find(relsPathFor(rvRelEntry.key));
  if (!rvRelRelsEntry) return vmToMedia;

  const rels = parseRels(parser, rvRelRelsEntry.bytes, rvRelEntry.key);
  if (!rels.size) return vmToMedia;

  // 1. richValueRel.xml: index -> mediaId
  const relDoc = parser.parseFromString(strFromU8(rvRelEntry.bytes), 'text/xml');
  const relIndexToMedia: (string | undefined)[] = [];
  for (const relEl of childElements(relDoc.documentElement)) {
    if (relEl.localName !== 'rel') continue;
    const rid = getAttr(relEl, 'id', REL_NS);
    const target = rels.get(rid)?.target;
    relIndexToMedia.push(target ? archive.registerMedia(target) : undefined);
  }

  // 2. rdrichvaluestructure.xml: structIdx -> { imgKeyIdx, altKeyIdx }
  const structDoc = parser.parseFromString(strFromU8(rvStructEntry.bytes), 'text/xml');
  const structs: { imgKeyIdx: number; altKeyIdx: number }[] = [];
  for (const sEl of childElements(structDoc.documentElement)) {
    if (sEl.localName !== 's') continue;
    let imgKeyIdx = -1;
    let altKeyIdx = -1;
    let kIdx = 0;
    for (const kEl of childElements(sEl)) {
      if (kEl.localName !== 'k') continue;
      const n = kEl.getAttribute('n') ?? '';
      if (n === '_rvRel:LocalImageIdentifier') imgKeyIdx = kIdx;
      else if (n === 'Text') altKeyIdx = kIdx;
      kIdx++;
    }
    structs.push({ imgKeyIdx, altKeyIdx });
  }

  // 3. rdrichvalue.xml: rvIdx -> { mediaId, alt }
  const rvDoc = parser.parseFromString(strFromU8(rvEntry.bytes), 'text/xml');
  const rvList: ({ mediaId: string; alt?: string } | undefined)[] = [];
  for (const rvEl of childElements(rvDoc.documentElement)) {
    if (rvEl.localName !== 'rv') continue;
    const sIdx = Number(rvEl.getAttribute('s') ?? '-1');
    const st = structs[sIdx];
    if (!st || st.imgKeyIdx < 0) {
      rvList.push(undefined);
      continue;
    }
    const vals = childElements(rvEl).filter((el) => el.localName === 'v');
    const relIdx = Number(vals[st.imgKeyIdx]?.textContent?.trim() ?? '-1');
    const mediaId = relIndexToMedia[relIdx];
    const alt = st.altKeyIdx >= 0 ? vals[st.altKeyIdx]?.textContent?.trim() || undefined : undefined;
    rvList.push(mediaId ? { mediaId, alt } : undefined);
  }

  // 4. metadata.xml: 1-based vm -> rvIdx -> { mediaId, alt }
  const metaDoc = parser.parseFromString(strFromU8(metaEntry.bytes), 'text/xml');
  let richValueTypeIdx = -1;
  const metaTypes = firstChildByLocalName(metaDoc.documentElement, 'metadataTypes');
  if (metaTypes) {
    let tIdx = 0;
    for (const mt of childElements(metaTypes)) {
      if (mt.localName !== 'metadataType') continue;
      tIdx++;
      if ((mt.getAttribute('name') ?? '').toUpperCase() === 'XLRICHVALUE') {
        richValueTypeIdx = tIdx;
        break;
      }
    }
  }
  const valueMeta = firstChildByLocalName(metaDoc.documentElement, 'valueMetadata');
  if (!valueMeta) return vmToMedia;
  let vmIndex = 0;
  for (const bk of childElements(valueMeta)) {
    if (bk.localName !== 'bk') continue;
    vmIndex++;
    for (const rc of childElements(bk)) {
      if (rc.localName !== 'rc') continue;
      const rcType = Number(rc.getAttribute('t') ?? '-1');
      if (richValueTypeIdx > 0 && rcType !== richValueTypeIdx) continue;
      const rvIdx = Number(rc.getAttribute('v') ?? '-1');
      const hit = rvList[rvIdx];
      if (hit) {
        vmToMedia.set(vmIndex, hit);
        break;
      }
    }
  }
  return vmToMedia;
}

/** Fast regex scan of `<c ... vm="N" ...>` attributes on a worksheet XML without full DOM parsing. */
function scanWorksheetVmCells(
  sheetBytes: Uint8Array,
  vmToMedia: Map<number, { mediaId: string; alt?: string }>,
  nextId: () => string,
): SheetImage[] {
  const xml = strFromU8(sheetBytes);
  if (!xml.includes('vm=')) return [];
  const out: SheetImage[] = [];
  const cellRe = /<(?:[a-zA-Z0-9_]+:)?c\b([^>]*\bvm=(?:"(\d+)"|'(\d+)')[^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(xml))) {
    const attrs = m[1];
    const vm = Number(m[2] ?? m[3]);
    const hit = vmToMedia.get(vm);
    if (!hit) continue;
    const refMatch = /\br=(?:"([A-Za-z]{1,3})(\d+)"|'([A-Za-z]{1,3})(\d+)')/.exec(attrs);
    if (!refMatch) continue;
    const col = colToIndex(refMatch[1] ?? refMatch[3]);
    const row = Number(refMatch[2] ?? refMatch[4]) - 1;
    if (row < 0 || col < 0) continue;
    out.push({
      id: nextId(),
      mediaId: hit.mediaId,
      kind: 'cell',
      fromRow: row,
      fromCol: col,
      fromX: 0,
      fromY: 0,
      alt: hit.alt,
    });
  }
  return out;
}

function cssLengthToPx(raw: string | undefined | null): number {
  if (!raw) return 0;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*(cm|mm|in|pt|pc|px)?$/i.exec(raw.trim());
  if (!m) return 0;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v <= 0) return 0;
  switch ((m[2] ?? 'px').toLowerCase()) {
    case 'in':
      return Math.round(v * 96 * 10) / 10;
    case 'cm':
      return Math.round((v * 96) / 2.54 * 10) / 10;
    case 'mm':
      return Math.round((v * 96) / 25.4 * 10) / 10;
    case 'pt':
      return Math.round((v * 96) / 72 * 10) / 10;
    case 'pc':
      return Math.round(v * 16 * 10) / 10;
    default:
      return Math.round(v * 10) / 10;
  }
}

function extractOdsImages(bytes: Uint8Array): WorkbookImageExtraction {
  let hasMedia = false;
  const unzipped = unzipSync(bytes, {
    filter: (f) => {
      const norm = normalizeZipPath(f.name).toLowerCase();
      if (norm.startsWith('pictures/') && !norm.endsWith('/')) {
        hasMedia = true;
        return true;
      }
      return norm === 'content.xml';
    },
  });
  if (!hasMedia) return EMPTY_EXTRACTION;

  const archive = createArchiveLookup(unzipped);
  const contentEntry = archive.find('content.xml');
  if (!contentEntry) return EMPTY_EXTRACTION;

  const parser = createSilentXmlParser();
  const doc = parser.parseFromString(strFromU8(contentEntry.bytes), 'text/xml');
  const body = firstChildByLocalName(doc.documentElement, 'body');
  const spreadsheet = firstChildByLocalName(body, 'spreadsheet');
  if (!spreadsheet) return EMPTY_EXTRACTION;

  const bySheetName = new Map<string, SheetImage[]>();
  let imgSeq = 0;
  const nextId = () => `img${imgSeq++}`;

  const collectFrameImages = (frame: XElement, row: number, col: number, target: SheetImage[], absolute = false) => {
    const imgEl = firstChildByLocalName(frame, 'image');
    if (!imgEl) return;
    const href = getAttr(imgEl, 'href');
    if (!href) return;
    const mediaId = archive.registerMedia(href);
    if (!mediaId) return;
    const x = cssLengthToPx(getAttr(frame, 'x'));
    const y = cssLengthToPx(getAttr(frame, 'y'));
    const w = cssLengthToPx(getAttr(frame, 'width'));
    const h = cssLengthToPx(getAttr(frame, 'height'));
    const alt = (getAttr(frame, 'name') || '').trim() || undefined;
    target.push({
      id: nextId(),
      mediaId,
      kind: 'floating',
      fromRow: absolute ? 0 : row,
      fromCol: absolute ? 0 : col,
      fromX: x,
      fromY: y,
      width: w > 0 ? w : 140,
      height: h > 0 ? h : 100,
      alt,
    });
  };

  for (const table of childElements(spreadsheet)) {
    if (table.localName !== 'table') continue;
    const sheetName = getAttr(table, 'name');
    if (!sheetName) continue;
    const list: SheetImage[] = [];
    let rowIdx = 0;
    for (const child of childElements(table)) {
      if (child.localName === 'shapes') {
        for (const sh of childElements(child)) {
          if (sh.localName === 'frame') {
            collectFrameImages(sh, 0, 0, list, true);
          }
        }
      } else if (child.localName === 'table-row') {
        const rowRepeat = Math.max(1, Number(getAttr(child, 'number-rows-repeated')) || 1);
        let colIdx = 0;
        for (const cell of childElements(child)) {
          if (cell.localName !== 'table-cell' && cell.localName !== 'covered-table-cell') continue;
          const colRepeat = Math.max(1, Number(getAttr(cell, 'number-columns-repeated')) || 1);
          for (const cellChild of childElements(cell)) {
            if (cellChild.localName === 'frame') {
              collectFrameImages(cellChild, rowIdx, colIdx, list, false);
            }
          }
          colIdx += colRepeat;
        }
        rowIdx += rowRepeat;
      }
    }
    if (list.length) {
      bySheetName.set(sheetName, list);
    }
  }

  return { bySheetName, wpsCellImages: new Map(), media: archive.media };
}

/**
 * Extracts all embedded & floating images from an `.xlsx`, `.xlsm`, or `.ods` workbook archive.
 * Fast-paths to an empty result with near-zero overhead when no media parts exist in the archive.
 */
export function extractWorkbookImages(bytes: Uint8Array, fileName = ''): WorkbookImageExtraction {
  if (!isZipArchive(bytes)) return EMPTY_EXTRACTION;
  try {
    if (/\.ods$/i.test(fileName)) {
      return extractOdsImages(bytes);
    }

    let hasMedia = false;
    let hasRichData = false;
    const unzipped = unzipSync(bytes, {
      filter: (file) => {
        const norm = normalizeZipPath(file.name).toLowerCase();
        if (!norm || norm.endsWith('/')) return false;
        if (norm.startsWith('xl/media/')) {
          hasMedia = true;
          return true;
        }
        if (norm.startsWith('xl/richdata/') || norm === 'xl/metadata.xml') {
          hasRichData = true;
          return true;
        }
        return (
          norm === 'xl/workbook.xml' ||
          norm === 'xl/_rels/workbook.xml.rels' ||
          norm === 'xl/cellimages.xml' ||
          norm === 'xl/_rels/cellimages.xml.rels' ||
          norm.startsWith('xl/drawings/') ||
          norm.startsWith('xl/worksheets/_rels/')
        );
      },
    });
    if (!hasMedia) return EMPTY_EXTRACTION;

    const archive = createArchiveLookup(unzipped);
    const wbEntry = archive.find('xl/workbook.xml');
    const wbRelsEntry = archive.find('xl/_rels/workbook.xml.rels');
    if (!wbEntry || !wbRelsEntry) return EMPTY_EXTRACTION;

    const parser = createSilentXmlParser();
    const wbRels = parseRels(parser, wbRelsEntry.bytes, wbEntry.key);
    const wbDoc = parser.parseFromString(strFromU8(wbEntry.bytes), 'text/xml');
    const sheetsEl = firstChildByLocalName(wbDoc.documentElement, 'sheets');

    const sheets: { name: string; path: string }[] = [];
    for (const sEl of childElements(sheetsEl)) {
      if (sEl.localName !== 'sheet') continue;
      const name = sEl.getAttribute('name') ?? '';
      const rid = getAttr(sEl, 'id', REL_NS);
      const rel = wbRels.get(rid);
      if (name && rel?.target) {
        sheets.push({ name, path: rel.target });
      }
    }

    let imgSeq = 0;
    const nextId = () => `img${imgSeq++}`;
    const bySheetName = new Map<string, SheetImage[]>();

    // 1. Floating drawings per worksheet (via sheetN.xml.rels -> drawingM.xml)
    for (const sheet of sheets) {
      const sRelsEntry = archive.find(relsPathFor(sheet.path));
      if (!sRelsEntry) continue;
      const sRels = parseRels(parser, sRelsEntry.bytes, sheet.path);
      const sheetImgs: SheetImage[] = [];
      for (const rel of sRels.values()) {
        if (!rel.type.toLowerCase().endsWith('/drawing')) continue;
        const drawEntry = archive.find(rel.target);
        if (!drawEntry) continue;
        sheetImgs.push(...parseDrawingXml(parser, drawEntry.key, drawEntry.bytes, archive, nextId));
      }
      if (sheetImgs.length) {
        bySheetName.set(sheet.name, sheetImgs);
      }
    }

    // 2. WPS Office in-cell embedded images (`xl/cellimages.xml`)
    const wpsCellImages = parseWpsCellImages(parser, archive);

    // 3. Microsoft Excel 365 Place-in-Cell images (`xl/metadata.xml` + `xl/richData/*`)
    if (hasRichData) {
      const vmToMedia = parseExcel365ValueMetadataImages(parser, archive);
      if (vmToMedia.size > 0) {
        // Unzip only worksheet XMLs on demand when richData image metadata is actually present
        const targetPaths = new Set(sheets.map((s) => s.path.toLowerCase()));
        const sheetXmlMap = unzipSync(bytes, {
          filter: (file) => targetPaths.has(normalizeZipPath(file.name).toLowerCase()),
        });
        const wsLookup = createArchiveLookup(sheetXmlMap);
        for (const sheet of sheets) {
          const wsEntry = wsLookup.find(sheet.path);
          if (!wsEntry) continue;
          const cellImgs = scanWorksheetVmCells(wsEntry.bytes, vmToMedia, nextId);
          if (cellImgs.length) {
            const list = bySheetName.get(sheet.name) ?? [];
            list.push(...cellImgs);
            bySheetName.set(sheet.name, list);
          }
        }
      }
    }

    return { bySheetName, wpsCellImages, media: archive.media };
  } catch {
    return EMPTY_EXTRACTION;
  }
}

function clearCellErrorDisplay(rows: Cell[][], r: number, c: number): void {
  const row = rows[r];
  if (!row) return;
  const cell = row[c];
  if (cell == null) return;
  if (typeof cell === 'string') {
    if (CELL_IMAGE_ERROR_TEXT_RE.test(cell.trim())) {
      row[c] = '';
    }
    return;
  }
  if (CELL_IMAGE_ERROR_TEXT_RE.test(cell.v.trim())) {
    const next: CellObject = { ...cell, v: '' };
    row[c] = next;
  }
}

/**
 * Attaches extracted floating & in-cell images (including WPS `=DISPIMG(...)` formulas) to a `SheetModel`,
 * copies only referenced media entries, and expands grid bounds if any image extends past used cells.
 */
export function attachImagesToSheetModel(
  model: SheetModel,
  extraction: WorkbookImageExtraction | undefined,
): void {
  if (!extraction) return;
  const images: SheetImage[] = [];
  const existing = extraction.bySheetName.get(model.name);
  if (existing?.length) {
    for (const img of existing) {
      images.push({ ...img });
      if (img.kind === 'cell') {
        clearCellErrorDisplay(model.rows, img.fromRow, img.fromCol);
      }
    }
  }

  // Bind WPS `=DISPIMG("ID_...", 1)` cells
  if (extraction.wpsCellImages.size > 0) {
    let wpsSeq = 0;
    for (let r = 0; r < model.rows.length; r++) {
      const row = model.rows[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        if (cell == null) continue;
        const candidate = typeof cell === 'string' ? cell : (cell.raw ?? cell.v);
        const match = DISPIMG_RE.exec(candidate.trim());
        if (!match) continue;
        const hit = extraction.wpsCellImages.get(match[1]);
        if (!hit) continue;
        images.push({
          id: `wps${wpsSeq++}`,
          mediaId: hit.mediaId,
          kind: 'cell',
          fromRow: r,
          fromCol: c,
          fromX: 0,
          fromY: 0,
          alt: hit.alt,
        });
        clearCellErrorDisplay(model.rows, r, c);
      }
    }
  }

  if (!images.length) return;

  const media: Record<string, string> = {};
  let maxRow = model.rowCount;
  let maxCol = model.colCount;
  for (const img of images) {
    const dataUrl = extraction.media[img.mediaId];
    if (dataUrl) {
      media[img.mediaId] = dataUrl;
    }
    const endRow = img.toRow !== undefined ? img.toRow + 2 : img.fromRow + Math.max(2, Math.ceil((img.height ?? 0) / 24) + 1);
    const endCol = img.toCol !== undefined ? img.toCol + 2 : img.fromCol + Math.max(2, Math.ceil((img.width ?? 0) / 80) + 1);
    if (endRow > maxRow) maxRow = Math.min(endRow, 200_000);
    if (endCol > maxCol) maxCol = Math.min(endCol, 16_384);
  }

  if (maxRow > model.rowCount) {
    model.rowCount = maxRow;
  }
  if (maxCol > model.colCount) {
    if (model.colWidths) {
      while (model.colWidths.length < maxCol) {
        model.colWidths.push(null);
      }
    }
    model.colCount = maxCol;
  }

  model.images = images;
  model.media = media;
}
