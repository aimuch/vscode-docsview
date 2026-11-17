// Inspects and patches .docx packages in place (standard OOXML Word/WPS comments in
// word/comments.xml and paragraph text edits in word/document.xml) while preserving styles,
// media, tables, headers/footers and untouched zip entries byte-for-byte. Pure module.
import { DOMParser, XMLSerializer, type Document as XDocument, type Element as XElement, type Node as XNode } from '@xmldom/xmldom';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { DocComment, DocMutation } from '../../common/protocol';

const XML = 'text/xml';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_PKG_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const COMMENTS_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const COMMENTS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
const PRECOMPRESSED_MEDIA = /\.(?:png|jpe?g|gif|webp|avif|mp4|m4v|mov|mp3|wav|ogg|zip|gz)$/i;

function serializeXml(doc: XDocument): string {
  const out = new XMLSerializer().serializeToString(doc);
  return out.startsWith('<?xml') ? out : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${out}`;
}

function getAttr(el: XElement, local: string): string {
  return el.getAttributeNS(W_NS, local) || el.getAttribute(`w:${local}`) || el.getAttribute(local) || '';
}

function resolveWordTarget(target: string): string {
  if (target.startsWith('/')) {
    return target.slice(1);
  }
  const parts = ['word'];
  for (const seg of target.split('/')) {
    if (seg === '..') {
      parts.pop();
    } else if (seg && seg !== '.') {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

/** Collects body flow paragraphs (including table cell paragraphs), skipping mc:Fallback and floating textboxes. */
function collectBodyParagraphs(doc: XDocument): XElement[] {
  const bodies = doc.getElementsByTagNameNS('*', 'body');
  const body = bodies.item(0);
  if (!body) {
    return [];
  }
  const out: XElement[] = [];
  const walk = (node: XNode) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) {
        continue;
      }
      const el = child as XElement;
      const ln = el.localName || el.tagName.replace(/^.*:/, '');
      if (ln === 'Fallback' || ln === 'txbxContent') {
        continue;
      }
      if (ln === 'p') {
        out.push(el);
        continue;
      }
      walk(el);
    }
  };
  walk(body);
  return out;
}

/** Extracts visible plain text from a `<w:p>` element. */
export function extractParagraphText(p: XElement): string {
  const chunks: string[] = [];
  const walk = (node: XNode) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) {
        continue;
      }
      const el = child as XElement;
      const ln = el.localName || el.tagName.replace(/^.*:/, '');
      if (ln === 'Fallback' || ln === 'txbxContent' || ln === 'del' || ln === 'pPr' || ln === 'instrText') {
        continue;
      }
      if (ln === 't') {
        chunks.push(el.textContent ?? '');
      } else if (ln === 'tab') {
        chunks.push('\t');
      } else if (ln === 'br' || ln === 'cr') {
        chunks.push('\n');
      } else {
        walk(el);
      }
    }
  };
  walk(p);
  return chunks.join('');
}

function findCommentsPath(relsBytes: Uint8Array | undefined): string {
  if (!relsBytes) {
    return 'word/comments.xml';
  }
  const doc = new DOMParser().parseFromString(strFromU8(relsBytes), XML);
  const rels = doc.getElementsByTagName('Relationship');
  for (let i = 0; i < rels.length; i++) {
    const r = rels.item(i)!;
    if (r.getAttribute('Type') === COMMENTS_REL_TYPE) {
      const target = r.getAttribute('Target');
      if (target) {
        return resolveWordTarget(target);
      }
    }
  }
  return 'word/comments.xml';
}

export interface DocxInspection {
  paragraphs: string[];
  comments: DocComment[];
}

export function inspectDocx(bytes: Uint8Array): DocxInspection {
  const relsOnly = unzipSync(bytes, {
    filter: (f) => f.name === 'word/_rels/document.xml.rels',
  });
  const commentsPath = findCommentsPath(relsOnly['word/_rels/document.xml.rels']);
  const files = unzipSync(bytes, {
    filter: (f) => f.name === 'word/document.xml' || f.name === commentsPath,
  });

  const docBytes = files['word/document.xml'];
  if (!docBytes) {
    return { paragraphs: [], comments: [] };
  }
  const parser = new DOMParser();
  const docXml = parser.parseFromString(strFromU8(docBytes), XML);
  const pNodes = collectBodyParagraphs(docXml);
  const paragraphs = pNodes.map(extractParagraphText);

  // Map comment w:id -> paragraph index & excerpt quote.
  const anchors = new Map<string, { pIndex: number; quote: string }>();
  pNodes.forEach((p, idx) => {
    const scan = (node: XNode) => {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) {
          continue;
        }
        const el = c as XElement;
        const ln = el.localName || el.tagName.replace(/^.*:/, '');
        if (ln === 'commentRangeStart' || ln === 'commentReference' || ln === 'commentRangeEnd') {
          const cid = getAttr(el, 'id');
          if (cid && !anchors.has(cid)) {
            anchors.set(cid, {
              pIndex: idx,
              quote: paragraphs[idx].replace(/\s+/g, ' ').trim().slice(0, 80),
            });
          }
        }
        scan(el);
      }
    };
    scan(p);
  });

  const comments: DocComment[] = [];
  const commentsBytes = files[commentsPath];
  if (commentsBytes) {
    const cDoc = parser.parseFromString(strFromU8(commentsBytes), XML);
    const cNodes = cDoc.getElementsByTagNameNS('*', 'comment');
    for (let i = 0; i < cNodes.length; i++) {
      const cEl = cNodes.item(i)!;
      const id = getAttr(cEl, 'id');
      if (!id) {
        continue;
      }
      const author = getAttr(cEl, 'author') || 'Reviewer';
      const date = getAttr(cEl, 'date') || undefined;
      const pList: string[] = [];
      for (let ch = cEl.firstChild; ch; ch = ch.nextSibling) {
        if (ch.nodeType === 1) {
          const ln = (ch as XElement).localName || (ch as XElement).tagName.replace(/^.*:/, '');
          if (ln === 'p') {
            pList.push(extractParagraphText(ch as XElement));
          }
        }
      }
      const anchor = anchors.get(id);
      comments.push({
        id,
        author,
        date,
        text: pList.join('\n').trim(),
        pIndex: anchor?.pIndex,
        quote: anchor?.quote,
      });
    }
  }

  return { paragraphs, comments };
}

function appendCommentParagraphs(cDoc: XDocument, commentEl: XElement, text: string): void {
  while (commentEl.firstChild) {
    commentEl.removeChild(commentEl.firstChild);
  }
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const p = cDoc.createElementNS(W_NS, 'w:p');
    const r = cDoc.createElementNS(W_NS, 'w:r');
    const t = cDoc.createElementNS(W_NS, 'w:t');
    t.setAttribute('xml:space', 'preserve');
    t.appendChild(cDoc.createTextNode(line));
    r.appendChild(t);
    p.appendChild(r);
    commentEl.appendChild(p);
  }
}

function ensureCommentsRelationships(files: Record<string, Uint8Array>, commentsPath: string, parser: DOMParser): void {
  // 1. word/_rels/document.xml.rels
  const relsPath = 'word/_rels/document.xml.rels';
  const relsDoc = files[relsPath]
    ? parser.parseFromString(strFromU8(files[relsPath]), XML)
    : parser.parseFromString(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_PKG_NS}"/>`,
        XML,
      );
  const relNodes = relsDoc.getElementsByTagName('Relationship');
  let hasRel = false;
  let maxRid = 0;
  for (let i = 0; i < relNodes.length; i++) {
    const r = relNodes.item(i)!;
    if (r.getAttribute('Type') === COMMENTS_REL_TYPE) {
      hasRel = true;
    }
    const m = /^rId(\d+)$/i.exec(r.getAttribute('Id') ?? '');
    if (m) {
      maxRid = Math.max(maxRid, Number(m[1]));
    }
  }
  if (!hasRel) {
    const rel = relsDoc.createElementNS(REL_PKG_NS, 'Relationship');
    rel.setAttribute('Id', `rId${maxRid + 1}`);
    rel.setAttribute('Type', COMMENTS_REL_TYPE);
    rel.setAttribute('Target', commentsPath.startsWith('word/') ? commentsPath.slice(5) : `/${commentsPath}`);
    relsDoc.documentElement!.appendChild(rel);
    files[relsPath] = strToU8(serializeXml(relsDoc));
  }

  // 2. [Content_Types].xml
  const ctPath = '[Content_Types].xml';
  if (files[ctPath]) {
    const ctDoc = parser.parseFromString(strFromU8(files[ctPath]), XML);
    const partName = `/${commentsPath}`;
    const overrides = ctDoc.getElementsByTagName('Override');
    let hasOverride = false;
    for (let i = 0; i < overrides.length; i++) {
      if (overrides.item(i)!.getAttribute('PartName') === partName) {
        hasOverride = true;
        break;
      }
    }
    if (!hasOverride) {
      const ov = ctDoc.createElementNS(CT_NS, 'Override');
      ov.setAttribute('PartName', partName);
      ov.setAttribute('ContentType', COMMENTS_CONTENT_TYPE);
      ctDoc.documentElement!.appendChild(ov);
      files[ctPath] = strToU8(serializeXml(ctDoc));
    }
  }
}

function hasKeepableSpecialRunChild(rEl: XElement): boolean {
  for (let c = rEl.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 1) {
      continue;
    }
    const ln = (c as XElement).localName || (c as XElement).tagName.replace(/^.*:/, '');
    if (ln === 'drawing' || ln === 'pict' || ln === 'object' || ln === 'commentReference' || ln === 'footnoteReference' || ln === 'endnoteReference') {
      return true;
    }
  }
  return false;
}

function replaceParagraphText(docXml: XDocument, p: XElement, nextText: string): void {
  let savedRPr: XElement | undefined;
  const startKeep: XNode[] = [];
  const endKeep: XNode[] = [];

  for (let c = p.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 1) {
      continue;
    }
    const el = c as XElement;
    const ln = el.localName || el.tagName.replace(/^.*:/, '');
    if (ln === 'pPr' || ln === 'commentRangeStart' || ln === 'bookmarkStart') {
      startKeep.push(el);
      continue;
    }
    if (ln === 'commentRangeEnd' || ln === 'bookmarkEnd') {
      endKeep.push(el);
      continue;
    }
    if (ln === 'r') {
      if (!savedRPr) {
        for (let rc = el.firstChild; rc; rc = rc.nextSibling) {
          if (rc.nodeType === 1 && ((rc as XElement).localName === 'rPr' || (rc as XElement).tagName === 'w:rPr')) {
            savedRPr = rc.cloneNode(true) as XElement;
            break;
          }
        }
      }
      if (hasKeepableSpecialRunChild(el)) {
        endKeep.push(el);
      }
    }
  }

  while (p.firstChild) {
    p.removeChild(p.firstChild);
  }
  for (const node of startKeep) {
    p.appendChild(node);
  }

  const run = docXml.createElementNS(W_NS, 'w:r');
  if (savedRPr) {
    run.appendChild(savedRPr);
  }
  const lines = nextText.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (idx > 0) {
      run.appendChild(docXml.createElementNS(W_NS, 'w:br'));
    }
    const t = docXml.createElementNS(W_NS, 'w:t');
    t.setAttribute('xml:space', 'preserve');
    t.appendChild(docXml.createTextNode(line));
    run.appendChild(t);
  });
  p.appendChild(run);

  for (const node of endKeep) {
    p.appendChild(node);
  }
}

export function applyDocxMutations(bytes: Uint8Array, mutations: readonly DocMutation[]): Uint8Array {
  if (!mutations.length) {
    return bytes;
  }
  const files = unzipSync(bytes);
  const docBytes = files['word/document.xml'];
  if (!docBytes) {
    throw new Error('Invalid .docx file: word/document.xml is missing.');
  }
  const parser = new DOMParser();
  const docXml = parser.parseFromString(strFromU8(docBytes), XML);
  const commentsPath = findCommentsPath(files['word/_rels/document.xml.rels']);

  let commentsDoc: XDocument | undefined;
  let docDirty = false;
  let commentsDirty = false;

  const getCommentsDoc = (createIfMissing: boolean): XDocument | undefined => {
    if (commentsDoc) {
      return commentsDoc;
    }
    if (files[commentsPath]) {
      commentsDoc = parser.parseFromString(strFromU8(files[commentsPath]), XML);
      return commentsDoc;
    }
    if (!createIfMissing) {
      return undefined;
    }
    ensureCommentsRelationships(files, commentsPath, parser);
    commentsDoc = parser.parseFromString(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${W_NS}"/>`,
      XML,
    );
    return commentsDoc;
  };

  for (const mut of mutations) {
    if (mut.kind === 'addComment') {
      const cDoc = getCommentsDoc(true)!;
      const existing = cDoc.getElementsByTagNameNS('*', 'comment');
      let maxId = 0;
      for (let i = 0; i < existing.length; i++) {
        const n = Number(getAttr(existing.item(i)!, 'id'));
        if (Number.isFinite(n)) {
          maxId = Math.max(maxId, n);
        }
      }
      const newId = String(maxId + 1);
      const author = mut.author?.trim() || 'DocsView';
      const initials = author.slice(0, 2).toUpperCase();
      const cEl = cDoc.createElementNS(W_NS, 'w:comment');
      cEl.setAttribute('w:id', newId);
      cEl.setAttribute('w:author', author);
      cEl.setAttribute('w:date', new Date().toISOString());
      cEl.setAttribute('w:initials', initials);
      appendCommentParagraphs(cDoc, cEl, mut.text);
      cDoc.documentElement!.appendChild(cEl);
      commentsDirty = true;

      const pNodes = collectBodyParagraphs(docXml);
      const targetP = pNodes[Math.max(0, Math.min(pNodes.length - 1, mut.pIndex ?? 0))];
      if (targetP) {
        const rangeStart = docXml.createElementNS(W_NS, 'w:commentRangeStart');
        rangeStart.setAttribute('w:id', newId);
        let pPr: XNode | null = null;
        for (let c = targetP.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 1 && ((c as XElement).localName === 'pPr' || (c as XElement).tagName === 'w:pPr')) {
            pPr = c;
            break;
          }
        }
        if (pPr) {
          targetP.insertBefore(rangeStart, pPr.nextSibling);
        } else {
          targetP.insertBefore(rangeStart, targetP.firstChild);
        }

        const rangeEnd = docXml.createElementNS(W_NS, 'w:commentRangeEnd');
        rangeEnd.setAttribute('w:id', newId);
        targetP.appendChild(rangeEnd);

        const refRun = docXml.createElementNS(W_NS, 'w:r');
        const refEl = docXml.createElementNS(W_NS, 'w:commentReference');
        refEl.setAttribute('w:id', newId);
        refRun.appendChild(refEl);
        targetP.appendChild(refRun);
        docDirty = true;
      }
    } else if (mut.kind === 'updateComment') {
      const cDoc = getCommentsDoc(false);
      if (!cDoc) {
        continue;
      }
      const existing = cDoc.getElementsByTagNameNS('*', 'comment');
      for (let i = 0; i < existing.length; i++) {
        const cEl = existing.item(i)!;
        if (getAttr(cEl, 'id') === mut.id) {
          appendCommentParagraphs(cDoc, cEl, mut.text);
          cEl.setAttribute('w:date', new Date().toISOString());
          commentsDirty = true;
          break;
        }
      }
    } else if (mut.kind === 'deleteComment') {
      const cDoc = getCommentsDoc(false);
      if (cDoc) {
        const existing = cDoc.getElementsByTagNameNS('*', 'comment');
        for (let i = existing.length - 1; i >= 0; i--) {
          const cEl = existing.item(i)!;
          if (getAttr(cEl, 'id') === mut.id) {
            cEl.parentNode?.removeChild(cEl);
            commentsDirty = true;
          }
        }
      }
      for (const tag of ['commentRangeStart', 'commentRangeEnd', 'commentReference']) {
        const nodes = docXml.getElementsByTagNameNS('*', tag);
        const toRemove: XElement[] = [];
        for (let i = 0; i < nodes.length; i++) {
          const el = nodes.item(i)!;
          if (getAttr(el, 'id') === mut.id) {
            toRemove.push(el);
          }
        }
        for (const el of toRemove) {
          const parent = el.parentNode as XElement | null;
          parent?.removeChild(el);
          if (
            tag === 'commentReference' &&
            parent &&
            (parent.localName === 'r' || parent.tagName === 'w:r')
          ) {
            let hasOther = false;
            for (let c = parent.firstChild; c; c = c.nextSibling) {
              if (c.nodeType === 1 && (c as XElement).localName !== 'rPr' && (c as XElement).tagName !== 'w:rPr') {
                hasOther = true;
                break;
              }
            }
            if (!hasOther) {
              parent.parentNode?.removeChild(parent);
            }
          }
          docDirty = true;
        }
      }
    } else if (mut.kind === 'editDocxParagraph') {
      const pNodes = collectBodyParagraphs(docXml);
      let target: XElement | undefined = pNodes[mut.pIndex];
      if (!target || extractParagraphText(target).trim() !== mut.expected.trim()) {
        target = pNodes.find((p) => extractParagraphText(p).trim() === mut.expected.trim());
      }
      if (target) {
        replaceParagraphText(docXml, target, mut.text);
        docDirty = true;
      }
    }
  }

  if (docDirty) {
    files['word/document.xml'] = strToU8(serializeXml(docXml));
  }
  if (commentsDirty && commentsDoc) {
    files[commentsPath] = strToU8(serializeXml(commentsDoc));
  }

  const archive: Zippable = {};
  for (const [name, data] of Object.entries(files)) {
    archive[name] = PRECOMPRESSED_MEDIA.test(name) ? [data, { level: 0 }] : [data, { level: 6 }];
  }
  return zipSync(archive);
}
