// Inspects and patches .pptx packages in place: slide aspect ratio (sldSz), standard OOXML
// PowerPoint/WPS slide comments (ppt/comments/comment*.xml + ppt/commentAuthors.xml), and
// in-place slide text shape edits while preserving masters, layouts, media and animations.
import { DOMParser, XMLSerializer, type Document as XDocument, type Element as XElement, type Node as XNode } from '@xmldom/xmldom';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { DocComment, DocMutation } from '../../common/protocol';

import { resolveTargetIndex } from './docxPatcher';

const XML = 'text/xml';
const createXmlParser = () => new DOMParser({ locator: false, onError: () => undefined });
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_PKG_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const COMMENTS_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const COMMENT_AUTHORS_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/commentAuthors';
const NOTES_SLIDE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
const SLIDE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const COMMENTS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.comments+xml';
const COMMENT_AUTHORS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml';
const NOTES_SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';
const PRECOMPRESSED_MEDIA = /\.(?:png|jpe?g|gif|webp|avif|mp4|m4v|mov|mp3|wav|ogg|zip|gz)$/i;

/** Default 16:9 widescreen dimensions in EMUs (960x540 pt). */
const DEFAULT_CX = 12192000;
const DEFAULT_CY = 6858000;
/** 1 comment pos unit = 1/8 pt, 1 pt = 12700 EMU -> 1 pos unit = 1587.5 EMU. */
const EMU_PER_COMMENT_POS = 1587.5;

function serializeXml(doc: XDocument): string {
  const out = new XMLSerializer().serializeToString(doc);
  return out.startsWith('<?xml') ? out : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${out}`;
}

function resolveRelativePath(baseDir: string, target: string): string {
  if (target.startsWith('/')) {
    return target.slice(1);
  }
  const parts = baseDir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') {
      parts.pop();
    } else if (seg && seg !== '.') {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

function relsPathFor(partPath: string): string {
  const slash = partPath.lastIndexOf('/');
  const dir = slash >= 0 ? partPath.slice(0, slash) : '';
  const base = slash >= 0 ? partPath.slice(slash + 1) : partPath;
  return dir ? `${dir}/_rels/${base}.rels` : `_rels/${base}.rels`;
}

function readPresentationInfo(
  files: Record<string, Uint8Array>,
  parser: DOMParser,
): { slidePaths: string[]; cx: number; cy: number; authorsPath: string } {
  let cx = DEFAULT_CX;
  let cy = DEFAULT_CY;
  let authorsPath = 'ppt/commentAuthors.xml';
  const slidePaths: string[] = [];

  const presBytes = files['ppt/presentation.xml'];
  const presRelsBytes = files['ppt/_rels/presentation.xml.rels'];
  const relMap = new Map<string, string>();

  if (presRelsBytes) {
    const rDoc = parser.parseFromString(strFromU8(presRelsBytes), XML);
    const rels = rDoc.getElementsByTagName('Relationship');
    for (let i = 0; i < rels.length; i++) {
      const r = rels.item(i)!;
      const id = r.getAttribute('Id') ?? '';
      const target = r.getAttribute('Target') ?? '';
      const type = r.getAttribute('Type') ?? '';
      if (id && target) {
        const resolved = resolveRelativePath('ppt', target);
        relMap.set(id, resolved);
        if (type === COMMENT_AUTHORS_REL_TYPE) {
          authorsPath = resolved;
        }
      }
    }
  }

  if (presBytes) {
    const pDoc = parser.parseFromString(strFromU8(presBytes), XML);
    const sldSz = pDoc.getElementsByTagNameNS('*', 'sldSz').item(0);
    if (sldSz) {
      const parsedCx = Number(sldSz.getAttribute('cx'));
      const parsedCy = Number(sldSz.getAttribute('cy'));
      if (parsedCx > 0 && parsedCy > 0) {
        cx = parsedCx;
        cy = parsedCy;
      }
    }
    const sldIds = pDoc.getElementsByTagNameNS('*', 'sldId');
    for (let i = 0; i < sldIds.length; i++) {
      const el = sldIds.item(i)!;
      const rid = el.getAttributeNS(REL_NS, 'id') || el.getAttribute('r:id') || '';
      const target = relMap.get(rid);
      if (target) {
        slidePaths.push(target);
      }
    }
  }

  if (!slidePaths.length) {
    const fallback = Object.keys(files)
      .filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
      .sort((a, b) => {
        const na = Number(/(\d+)\.xml$/i.exec(a)?.[1] ?? 0);
        const nb = Number(/(\d+)\.xml$/i.exec(b)?.[1] ?? 0);
        return na - nb;
      });
    slidePaths.push(...fallback);
  }

  return { slidePaths, cx, cy, authorsPath };
}

/** Extracts plain text from a `<p:txBody>` node, joining `<a:p>` lines with `\n`. */
export function extractTxBodyText(txBody: XElement): string {
  const paragraphs: string[] = [];
  for (let child = txBody.firstChild; child; child = child.nextSibling) {
    if (child.nodeType !== 1) {
      continue;
    }
    const pEl = child as XElement;
    const ln = pEl.localName || pEl.tagName.replace(/^.*:/, '');
    if (ln !== 'p') {
      continue;
    }
    const parts: string[] = [];
    const walk = (n: XNode) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) {
          continue;
        }
        const el = c as XElement;
        const tag = el.localName || el.tagName.replace(/^.*:/, '');
        if (tag === 'Fallback' || tag === 'pPr' || tag === 'rPr' || tag === 'endParaRPr') {
          continue;
        }
        if (tag === 't') {
          parts.push(el.textContent ?? '');
        } else if (tag === 'tab') {
          parts.push('\t');
        } else if (tag === 'br') {
          parts.push('\n');
        } else {
          walk(el);
        }
      }
    };
    walk(pEl);
    paragraphs.push(parts.join(''));
  }
  return paragraphs.join('\n');
}

function collectSlideTxBodies(slideDoc: XDocument): XElement[] {
  const out: XElement[] = [];
  const spTrees = slideDoc.getElementsByTagNameNS('*', 'spTree');
  const root = spTrees.item(0) ?? slideDoc.documentElement;
  if (!root) {
    return out;
  }
  const walk = (node: XNode) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) {
        continue;
      }
      const el = c as XElement;
      const ln = el.localName || el.tagName.replace(/^.*:/, '');
      if (ln === 'Fallback') {
        continue;
      }
      if (ln === 'txBody') {
        if (extractTxBodyText(el).trim().length > 0) {
          out.push(el);
        }
        continue;
      }
      walk(el);
    }
  };
  walk(root);
  return out;
}

function replaceTxBodyText(slideDoc: XDocument, txBody: XElement, nextText: string): void {
  let savedPPr: XElement | undefined;
  let savedRPr: XElement | undefined;
  const keepStart: XNode[] = [];

  for (let c = txBody.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 1) {
      continue;
    }
    const el = c as XElement;
    const ln = el.localName || el.tagName.replace(/^.*:/, '');
    if (ln === 'bodyPr' || ln === 'lstStyle') {
      keepStart.push(el);
      continue;
    }
    if (ln === 'p') {
      for (let pc = el.firstChild; pc; pc = pc.nextSibling) {
        if (pc.nodeType !== 1) {
          continue;
        }
        const pel = pc as XElement;
        const pln = pel.localName || pel.tagName.replace(/^.*:/, '');
        if (pln === 'pPr' && !savedPPr) {
          savedPPr = pel.cloneNode(true) as XElement;
        } else if (pln === 'r' && !savedRPr) {
          for (let rc = pel.firstChild; rc; rc = rc.nextSibling) {
            if (rc.nodeType === 1 && ((rc as XElement).localName === 'rPr' || (rc as XElement).tagName === 'a:rPr')) {
              savedRPr = rc.cloneNode(true) as XElement;
              break;
            }
          }
        }
      }
    }
  }

  while (txBody.firstChild) {
    txBody.removeChild(txBody.firstChild);
  }
  for (const k of keepStart) {
    txBody.appendChild(k);
  }

  const lines = nextText.split(/\r?\n/);
  for (const line of lines) {
    const aP = slideDoc.createElementNS(A_NS, 'a:p');
    if (savedPPr) {
      aP.appendChild(savedPPr.cloneNode(true));
    }
    const aR = slideDoc.createElementNS(A_NS, 'a:r');
    if (savedRPr) {
      aR.appendChild(savedRPr.cloneNode(true));
    }
    const aT = slideDoc.createElementNS(A_NS, 'a:t');
    aT.appendChild(slideDoc.createTextNode(line));
    aR.appendChild(aT);
    aP.appendChild(aR);
    txBody.appendChild(aP);
  }
}

function findSlideRelTarget(
  files: Record<string, Uint8Array>,
  slidePath: string,
  relType: string,
  parser: DOMParser,
): string | undefined {
  const rPath = relsPathFor(slidePath);
  const rBytes = files[rPath];
  if (!rBytes) {
    return undefined;
  }
  const slash = slidePath.lastIndexOf('/');
  const baseDir = slash >= 0 ? slidePath.slice(0, slash) : 'ppt/slides';
  const rDoc = parser.parseFromString(strFromU8(rBytes), XML);
  const rels = rDoc.getElementsByTagName('Relationship');
  for (let i = 0; i < rels.length; i++) {
    const r = rels.item(i)!;
    if (r.getAttribute('Type') === relType) {
      const target = r.getAttribute('Target');
      if (target) {
        return resolveRelativePath(baseDir, target);
      }
    }
  }
  return undefined;
}

function findSlideCommentsPath(files: Record<string, Uint8Array>, slidePath: string, parser: DOMParser): string | undefined {
  return findSlideRelTarget(files, slidePath, COMMENTS_REL_TYPE, parser);
}

function findSlideNotesPath(files: Record<string, Uint8Array>, slidePath: string, parser: DOMParser): string | undefined {
  return findSlideRelTarget(files, slidePath, NOTES_SLIDE_REL_TYPE, parser);
}

function findNotesBodyTxBody(notesDoc: XDocument): XElement | undefined {
  const sps = notesDoc.getElementsByTagNameNS('*', 'sp');
  let fallback: XElement | undefined;
  for (let i = 0; i < sps.length; i++) {
    const sp = sps.item(i)!;
    const txBody = sp.getElementsByTagNameNS('*', 'txBody').item(0) as XElement | null;
    if (!txBody) {
      continue;
    }
    const ph = sp.getElementsByTagNameNS('*', 'ph').item(0);
    const phType = ph?.getAttribute('type') ?? '';
    if (phType === 'body') {
      return txBody;
    }
    if (!ph && !fallback) {
      fallback = txBody;
    }
  }
  return fallback;
}

export interface PptxInspection {
  slideAspect: number;
  shapes: string[][];
  notes: string[];
  comments: DocComment[];
}

/** Fast read-only inspection of slide aspect ratio from ppt/presentation.xml. */
export function readPptxAspect(bytes: Uint8Array): number {
  try {
    const extracted = unzipSync(bytes, { filter: (f) => f.name === 'ppt/presentation.xml' });
    const pres = extracted['ppt/presentation.xml'];
    if (!pres) {
      return 16 / 9;
    }
    const xml = strFromU8(pres);
    const m = /<(?:p:)?sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i.exec(xml) ??
      /<(?:p:)?sldSz\b[^>]*\bcy="(\d+)"[^>]*\bcx="(\d+)"/i.exec(xml);
    if (m) {
      const isCxFirst = /cx="\d+"[^>]*cy="/i.test(m[0]);
      const cx = Number(isCxFirst ? m[1] : m[2]);
      const cy = Number(isCxFirst ? m[2] : m[1]);
      if (cx > 0 && cy > 0) {
        return cx / cy;
      }
    }
  } catch {
    // Fall back to widescreen 16:9.
  }
  return 16 / 9;
}

export function inspectPptx(bytes: Uint8Array): PptxInspection {
  const files = unzipSync(bytes, {
    filter: (f) =>
      f.name === 'ppt/presentation.xml' ||
      f.name === 'ppt/_rels/presentation.xml.rels' ||
      f.name.startsWith('ppt/slides/') ||
      f.name.startsWith('ppt/notesSlides/') ||
      f.name.startsWith('ppt/comments/') ||
      f.name.endsWith('commentAuthors.xml'),
  });
  const parser = createXmlParser();
  const { slidePaths, cx, cy, authorsPath } = readPresentationInfo(files, parser);
  const posMaxX = cx / EMU_PER_COMMENT_POS;
  const posMaxY = cy / EMU_PER_COMMENT_POS;

  const authors = new Map<string, string>();
  if (files[authorsPath]) {
    const aDoc = parser.parseFromString(strFromU8(files[authorsPath]), XML);
    const aNodes = aDoc.getElementsByTagNameNS('*', 'cmAuthor');
    for (let i = 0; i < aNodes.length; i++) {
      const a = aNodes.item(i)!;
      const id = a.getAttribute('id') ?? '';
      const name = a.getAttribute('name') ?? 'Reviewer';
      if (id) {
        authors.set(id, name);
      }
    }
  }

  const shapes: string[][] = [];
  const notes: string[] = [];
  const comments: DocComment[] = [];

  slidePaths.forEach((slidePath, slideIdx) => {
    const sBytes = files[slidePath];
    if (!sBytes) {
      shapes.push([]);
      notes.push('');
      return;
    }
    const sDoc = parser.parseFromString(strFromU8(sBytes), XML);
    const txBodies = collectSlideTxBodies(sDoc);
    shapes.push(txBodies.map(extractTxBodyText));

    const nPath = findSlideNotesPath(files, slidePath, parser);
    if (nPath && files[nPath]) {
      const nDoc = parser.parseFromString(strFromU8(files[nPath]), XML);
      const bodyTx = findNotesBodyTxBody(nDoc);
      notes.push(bodyTx ? extractTxBodyText(bodyTx).trim() : '');
    } else {
      notes.push('');
    }

    const cPath = findSlideCommentsPath(files, slidePath, parser);
    if (cPath && files[cPath]) {
      const cDoc = parser.parseFromString(strFromU8(files[cPath]), XML);
      const cmNodes = cDoc.getElementsByTagNameNS('*', 'cm');
      for (let i = 0; i < cmNodes.length; i++) {
        const cm = cmNodes.item(i)!;
        const authorId = cm.getAttribute('authorId') ?? '0';
        const idx = cm.getAttribute('idx') ?? String(i + 1);
        const dt = cm.getAttribute('dt') || undefined;
        const posEl = cm.getElementsByTagNameNS('*', 'pos').item(0);
        const rawX = Number(posEl?.getAttribute('x') ?? posMaxX * 0.1);
        const rawY = Number(posEl?.getAttribute('y') ?? posMaxY * 0.1);
        const x = Math.max(0, Math.min(1, rawX / posMaxX));
        const y = Math.max(0, Math.min(1, rawY / posMaxY));
        const textEl = cm.getElementsByTagNameNS('*', 'text').item(0);
        const text = (textEl?.textContent ?? '').trim();
        comments.push({
          id: `s${slideIdx + 1}:${authorId}:${idx}`,
          author: authors.get(authorId) ?? 'Reviewer',
          date: dt,
          text,
          page: slideIdx + 1,
          rect: { x, y, w: 0, h: 0 },
        });
      }
    }
  });

  return {
    slideAspect: cx / cy,
    shapes,
    notes,
    comments,
  };
}

function ensureContentTypeOverride(ctDoc: XDocument, partName: string, contentType: string): boolean {
  const overrides = ctDoc.getElementsByTagName('Override');
  for (let i = 0; i < overrides.length; i++) {
    if (overrides.item(i)!.getAttribute('PartName') === partName) {
      return false;
    }
  }
  const ov = ctDoc.createElementNS(CT_NS, 'Override');
  ov.setAttribute('PartName', partName);
  ov.setAttribute('ContentType', contentType);
  ctDoc.documentElement!.appendChild(ov);
  return true;
}

function ensureRelationship(relsDoc: XDocument, relType: string, target: string): void {
  const rels = relsDoc.getElementsByTagName('Relationship');
  let maxRid = 0;
  for (let i = 0; i < rels.length; i++) {
    const r = rels.item(i)!;
    if (r.getAttribute('Type') === relType) {
      return;
    }
    const m = /^rId(\d+)$/i.exec(r.getAttribute('Id') ?? '');
    if (m) {
      maxRid = Math.max(maxRid, Number(m[1]));
    }
  }
  const rel = relsDoc.createElementNS(REL_PKG_NS, 'Relationship');
  rel.setAttribute('Id', `rId${maxRid + 1}`);
  rel.setAttribute('Type', relType);
  rel.setAttribute('Target', target);
  relsDoc.documentElement!.appendChild(rel);
}

export function applyPptxMutations(bytes: Uint8Array, mutations: readonly DocMutation[]): Uint8Array {
  if (!mutations.length) {
    return bytes;
  }
  const files = unzipSync(bytes);
  const parser = createXmlParser();
  const { slidePaths, cx, cy, authorsPath } = readPresentationInfo(files, parser);
  const posMaxX = cx / EMU_PER_COMMENT_POS;
  const posMaxY = cy / EMU_PER_COMMENT_POS;

  const ctPath = '[Content_Types].xml';
  const ctDoc = files[ctPath] ? parser.parseFromString(strFromU8(files[ctPath]), XML) : undefined;
  let ctDirty = false;

  const ensureAuthor = (authorName: string): { authorId: string; nextIdx: number } => {
    let aDoc: XDocument;
    if (files[authorsPath]) {
      aDoc = parser.parseFromString(strFromU8(files[authorsPath]), XML);
    } else {
      aDoc = parser.parseFromString(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:cmAuthorLst xmlns:p="${P_NS}"/>`,
        XML,
      );
      const presRelsPath = 'ppt/_rels/presentation.xml.rels';
      const presRelsDoc = files[presRelsPath]
        ? parser.parseFromString(strFromU8(files[presRelsPath]), XML)
        : parser.parseFromString(
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_PKG_NS}"/>`,
            XML,
          );
      ensureRelationship(
        presRelsDoc,
        COMMENT_AUTHORS_REL_TYPE,
        authorsPath.startsWith('ppt/') ? authorsPath.slice(4) : `/${authorsPath}`,
      );
      files[presRelsPath] = strToU8(serializeXml(presRelsDoc));
      if (ctDoc && ensureContentTypeOverride(ctDoc, `/${authorsPath}`, COMMENT_AUTHORS_CONTENT_TYPE)) {
        ctDirty = true;
      }
    }

    const nodes = aDoc.getElementsByTagNameNS('*', 'cmAuthor');
    let found: XElement | undefined;
    let maxId = -1;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes.item(i)!;
      const nid = Number(n.getAttribute('id') ?? 0);
      if (Number.isFinite(nid)) {
        maxId = Math.max(maxId, nid);
      }
      if ((n.getAttribute('name') ?? '') === authorName) {
        found = n;
      }
    }
    if (!found) {
      const newId = String(maxId + 1);
      found = aDoc.createElementNS(P_NS, 'p:cmAuthor');
      found.setAttribute('id', newId);
      found.setAttribute('name', authorName);
      found.setAttribute('initials', authorName.slice(0, 2).toUpperCase() || 'DV');
      found.setAttribute('lastIdx', '0');
      found.setAttribute('clrIdx', String((maxId + 1) % 8));
      aDoc.documentElement!.appendChild(found);
    }
    const nextIdx = (Number(found.getAttribute('lastIdx') ?? 0) || 0) + 1;
    found.setAttribute('lastIdx', String(nextIdx));
    files[authorsPath] = strToU8(serializeXml(aDoc));
    return { authorId: found.getAttribute('id') ?? '0', nextIdx };
  };

  const ensureSlideCommentsFile = (slideIdx: number): { cPath: string; cDoc: XDocument } => {
    const slidePath = slidePaths[slideIdx];
    const existing = findSlideCommentsPath(files, slidePath, parser);
    if (existing && files[existing]) {
      return { cPath: existing, cDoc: parser.parseFromString(strFromU8(files[existing]), XML) };
    }
    let num = slideIdx + 1;
    let cPath = existing ?? `ppt/comments/comment${num}.xml`;
    while (!existing && files[cPath]) {
      num++;
      cPath = `ppt/comments/comment${num}.xml`;
    }
    const sRelsPath = relsPathFor(slidePath);
    const sRelsDoc = files[sRelsPath]
      ? parser.parseFromString(strFromU8(files[sRelsPath]), XML)
      : parser.parseFromString(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_PKG_NS}"/>`,
          XML,
        );
    const relTarget = cPath.startsWith('ppt/') ? `../${cPath.slice(4)}` : `/${cPath}`;
    ensureRelationship(sRelsDoc, COMMENTS_REL_TYPE, relTarget);
    files[sRelsPath] = strToU8(serializeXml(sRelsDoc));
    if (ctDoc && ensureContentTypeOverride(ctDoc, `/${cPath}`, COMMENTS_CONTENT_TYPE)) {
      ctDirty = true;
    }
    const cDoc = parser.parseFromString(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:cmLst xmlns:p="${P_NS}"/>`,
      XML,
    );
    return { cPath, cDoc };
  };

  for (const mut of mutations) {
    if (mut.kind === 'addComment') {
      if (!slidePaths.length) {
        continue;
      }
      const slideIdx = Math.max(0, Math.min(slidePaths.length - 1, (mut.page ?? 1) - 1));
      const { authorId, nextIdx } = ensureAuthor(mut.author?.trim() || 'DocsView');
      const { cPath, cDoc } = ensureSlideCommentsFile(slideIdx);

      // Ensure idx is also strictly greater than any existing idx in this comment file.
      let idx = nextIdx;
      const existingCm = cDoc.getElementsByTagNameNS('*', 'cm');
      for (let i = 0; i < existingCm.length; i++) {
        const exIdx = Number(existingCm.item(i)!.getAttribute('idx') ?? 0);
        if (exIdx >= idx) {
          idx = exIdx + 1;
        }
      }

      const rx = Math.max(0.02, Math.min(0.98, mut.rect?.x ?? 0.12));
      const ry = Math.max(0.02, Math.min(0.98, mut.rect?.y ?? 0.12));
      const cm = cDoc.createElementNS(P_NS, 'p:cm');
      cm.setAttribute('authorId', authorId);
      cm.setAttribute('dt', new Date().toISOString().replace('Z', ''));
      cm.setAttribute('idx', String(idx));

      const pos = cDoc.createElementNS(P_NS, 'p:pos');
      pos.setAttribute('x', String(Math.round(rx * posMaxX)));
      pos.setAttribute('y', String(Math.round(ry * posMaxY)));
      cm.appendChild(pos);

      const txt = cDoc.createElementNS(P_NS, 'p:text');
      txt.appendChild(cDoc.createTextNode(mut.text));
      cm.appendChild(txt);

      cDoc.documentElement!.appendChild(cm);
      files[cPath] = strToU8(serializeXml(cDoc));
    } else if (mut.kind === 'updateComment' || mut.kind === 'deleteComment') {
      const m = /^s(\d+):([^:]+):([^:]+)$/.exec(mut.id);
      if (!m) {
        continue;
      }
      const slideIdx = Number(m[1]) - 1;
      const targetAuthor = m[2];
      const targetIdx = m[3];
      const slidePath = slidePaths[slideIdx];
      if (!slidePath) {
        continue;
      }
      const cPath = findSlideCommentsPath(files, slidePath, parser);
      if (!cPath || !files[cPath]) {
        continue;
      }
      const cDoc = parser.parseFromString(strFromU8(files[cPath]), XML);
      const cmNodes = cDoc.getElementsByTagNameNS('*', 'cm');
      let changed = false;
      for (let i = cmNodes.length - 1; i >= 0; i--) {
        const cm = cmNodes.item(i)!;
        if ((cm.getAttribute('authorId') ?? '0') === targetAuthor && (cm.getAttribute('idx') ?? '') === targetIdx) {
          if (mut.kind === 'deleteComment') {
            cm.parentNode?.removeChild(cm);
          } else {
            let txt = cm.getElementsByTagNameNS('*', 'text').item(0);
            if (!txt) {
              txt = cDoc.createElementNS(P_NS, 'p:text');
              cm.appendChild(txt);
            }
            while (txt.firstChild) {
              txt.removeChild(txt.firstChild);
            }
            txt.appendChild(cDoc.createTextNode(mut.text));
            cm.setAttribute('dt', new Date().toISOString().replace('Z', ''));
          }
          changed = true;
        }
      }
      if (changed) {
        files[cPath] = strToU8(serializeXml(cDoc));
      }
    } else if (mut.kind === 'editPptxText') {
      const slidePath = slidePaths[mut.slideIndex];
      if (!slidePath || !files[slidePath]) {
        continue;
      }
      const sDoc = parser.parseFromString(strFromU8(files[slidePath]), XML);
      const txBodies = collectSlideTxBodies(sDoc);
      const resolvedIdx = resolveTargetIndex(
        txBodies.map(extractTxBodyText),
        mut.shapeIndex,
        mut.expected,
        6,
      );
      const target = resolvedIdx >= 0 ? txBodies[resolvedIdx] : undefined;
      if (target) {
        replaceTxBodyText(sDoc, target, mut.text);
        files[slidePath] = strToU8(serializeXml(sDoc));
      }
    } else if (mut.kind === 'editPptxNote') {
      const slidePath = slidePaths[mut.slideIndex];
      if (!slidePath || !files[slidePath]) {
        continue;
      }
      let nPath = findSlideNotesPath(files, slidePath, parser);
      let nDoc: XDocument;
      if (nPath && files[nPath]) {
        nDoc = parser.parseFromString(strFromU8(files[nPath]), XML);
      } else {
        let num = mut.slideIndex + 1;
        nPath = nPath ?? `ppt/notesSlides/notesSlide${num}.xml`;
        while (files[nPath]) {
          num++;
          nPath = `ppt/notesSlides/notesSlide${num}.xml`;
        }
        const sRelsPath = relsPathFor(slidePath);
        const sRelsDoc = files[sRelsPath]
          ? parser.parseFromString(strFromU8(files[sRelsPath]), XML)
          : parser.parseFromString(
              `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_PKG_NS}"/>`,
              XML,
            );
        const relTarget = nPath.startsWith('ppt/') ? `../${nPath.slice(4)}` : `/${nPath}`;
        ensureRelationship(sRelsDoc, NOTES_SLIDE_REL_TYPE, relTarget);
        files[sRelsPath] = strToU8(serializeXml(sRelsDoc));

        const nRelsPath = relsPathFor(nPath);
        const slideBase = slidePath.startsWith('ppt/') ? `../${slidePath.slice(4)}` : `/${slidePath}`;
        files[nRelsPath] = strToU8(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_PKG_NS}"><Relationship Id="rId1" Type="${SLIDE_REL_TYPE}" Target="${slideBase}"/></Relationships>`,
        );
        if (ctDoc && ensureContentTypeOverride(ctDoc, `/${nPath}`, NOTES_SLIDE_CONTENT_TYPE)) {
          ctDirty = true;
        }
        nDoc = parser.parseFromString(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:notes xmlns:a="${A_NS}" xmlns:r="${REL_NS}" xmlns:p="${P_NS}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t/></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
          XML,
        );
      }
      const bodyTx = findNotesBodyTxBody(nDoc);
      if (bodyTx) {
        replaceTxBodyText(nDoc, bodyTx, mut.text);
        files[nPath] = strToU8(serializeXml(nDoc));
      }
    }
  }

  if (ctDirty && ctDoc) {
    files[ctPath] = strToU8(serializeXml(ctDoc));
  }

  const archive: Zippable = {};
  for (const [name, data] of Object.entries(files)) {
    archive[name] = PRECOMPRESSED_MEDIA.test(name) ? [data, { level: 0 }] : [data, { level: 6 }];
  }
  return zipSync(archive);
}
