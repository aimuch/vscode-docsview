// Reads and writes standard ISO 32000 PDF annotations (/Annots: /Square box comments,
// /Text sticky-note pins, and multi-quad /Highlight text highlights) with full 0°/90°/180°/270°
// page-rotation coordinate transforms, plus page restructuring via pdf-lib.
import {
  degrees,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  rgb,
  StandardFonts,
} from 'pdf-lib';
import type { DocComment, DocMutation } from '../../common/protocol';

const SKIP_SUBTYPES = new Set(['Link', 'Widget', 'Popup', 'Watermark', 'PrinterMark', 'TrapNet', '3D', 'Movie', 'Screen']);

export interface PdfBoxBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function normAngle(angle: number): 0 | 90 | 180 | 270 {
  const m = (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
  return (m === 90 || m === 180 || m === 270 ? m : 0) as 0 | 90 | 180 | 270;
}

function pdfUnitToVisual(u: number, v: number, rot: 0 | 90 | 180 | 270): [number, number] {
  switch (rot) {
    case 90:
      return [v, u];
    case 180:
      return [1 - u, v];
    case 270:
      return [1 - v, 1 - u];
    default:
      return [u, 1 - v];
  }
}

function visualUnitToPdf(vx: number, vy: number, rot: 0 | 90 | 180 | 270): [number, number] {
  switch (rot) {
    case 90:
      return [vy, vx];
    case 180:
      return [1 - vx, vy];
    case 270:
      return [1 - vy, 1 - vx];
    default:
      return [vx, 1 - vy];
  }
}

/** Maps a PDF user-space `[x1, y1, x2, y2]` rectangle onto normalised `[0..1]` visual screen coordinates. */
export function pdfRectToVisualRect(
  pdfCoords: readonly [number, number, number, number],
  box: PdfBoxBounds,
  rotationAngle = 0,
): NormRect {
  const bw = box.width || 612;
  const bh = box.height || 792;
  const bx = box.x || 0;
  const by = box.y || 0;
  const rot = normAngle(rotationAngle);

  const u1 = (pdfCoords[0] - bx) / bw;
  const v1 = (pdfCoords[1] - by) / bh;
  const u2 = (pdfCoords[2] - bx) / bw;
  const v2 = (pdfCoords[3] - by) / bh;

  const [vx1, vy1] = pdfUnitToVisual(u1, v1, rot);
  const [vx2, vy2] = pdfUnitToVisual(u2, v2, rot);

  const x = clamp01(Math.min(vx1, vx2));
  const y = clamp01(Math.min(vy1, vy2));
  const xMax = clamp01(Math.max(vx1, vx2));
  const yMax = clamp01(Math.max(vy1, vy2));
  return { x, y, w: Math.max(0, xMax - x), h: Math.max(0, yMax - y) };
}

/** Maps a normalised `[0..1]` visual screen rectangle back into PDF user-space `[xMin, yMin, xMax, yMax]`. */
export function visualRectToPdfRect(
  r: NormRect,
  box: PdfBoxBounds,
  rotationAngle = 0,
  minSpan = 0,
): [number, number, number, number] {
  const bw = box.width || 612;
  const bh = box.height || 792;
  const bx = box.x || 0;
  const by = box.y || 0;
  const rot = normAngle(rotationAngle);

  const vx1 = clamp01(r.x);
  const vy1 = clamp01(r.y);
  const vx2 = clamp01(r.x + Math.max(minSpan, r.w));
  const vy2 = clamp01(r.y + Math.max(minSpan, r.h));

  const [u1, v1] = visualUnitToPdf(vx1, vy1, rot);
  const [u2, v2] = visualUnitToPdf(vx2, vy2, rot);

  const xMin = bx + Math.min(u1, u2) * bw;
  const xMax = bx + Math.max(u1, u2) * bw;
  const yMin = by + Math.min(v1, v2) * bh;
  const yMax = by + Math.max(v1, v2) * bh;
  return [xMin, yMin, xMax, yMax];
}

function decodePdfText(dict: PDFDict, key: string): string {
  const val = dict.lookupMaybe(PDFName.of(key), PDFString, PDFHexString);
  if (!val) {
    return '';
  }
  try {
    return val.decodeText();
  } catch {
    return val.asString();
  }
}

function rgbArrayToHex(arr: PDFArray | undefined): string | undefined {
  if (!arr || arr.size() < 3) {
    return undefined;
  }
  const ch = [0, 1, 2].map((i) => {
    const n = arr.lookupMaybe(i, PDFNumber)?.asNumber() ?? 0;
    const byte = Math.max(0, Math.min(255, Math.round(n <= 1 ? n * 255 : n)));
    return byte.toString(16).padStart(2, '0');
  });
  return `#${ch.join('')}`;
}

function hexToRgbNumbers(hex: string | undefined): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) {
    return [1, 0.68, 0];
  }
  const v = m[1];
  return [
    parseInt(v.slice(0, 2), 16) / 255,
    parseInt(v.slice(2, 4), 16) / 255,
    parseInt(v.slice(4, 6), 16) / 255,
  ];
}

function toUint8Array(raw: Uint8Array | ArrayLike<number> | Record<string, number>): Uint8Array {
  if (raw instanceof Uint8Array) {
    return raw;
  }
  if (Array.isArray(raw) || typeof (raw as ArrayLike<number>).length === 'number') {
    return Uint8Array.from(raw as ArrayLike<number>);
  }
  const record = raw as Record<string, number>;
  const keys = Object.keys(record)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const out = new Uint8Array(keys.length);
  keys.forEach((k, idx) => {
    out[idx] = record[String(k)] ?? 0;
  });
  return out;
}

export async function inspectPdf(bytes: Uint8Array): Promise<DocComment[]> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  const comments: DocComment[] = [];

  pages.forEach((page, pageIdx) => {
    const annots = page.node.Annots();
    if (!annots) {
      return;
    }
    const box = page.getCropBox() ?? page.getMediaBox();
    const rot = page.getRotation().angle || 0;

    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookupMaybe(i, PDFDict);
      if (!dict) {
        continue;
      }
      const subtypeName = dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() ?? '';
      if (SKIP_SUBTYPES.has(subtypeName)) {
        continue;
      }
      const text = decodePdfText(dict, 'Contents').trim();
      const subj = decodePdfText(dict, 'Subj').trim();
      const nm = decodePdfText(dict, 'NM').trim();
      const author = decodePdfText(dict, 'T').trim();
      const isHighlight = subtypeName === 'Highlight';
      if (!text && !nm.startsWith('dv-') && subtypeName !== 'Text' && !isHighlight) {
        continue;
      }

      let rect: NormRect = { x: 0.1, y: 0.1, w: 0, h: 0 };
      const rectArr = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
      if (rectArr && rectArr.size() >= 4) {
        const n0 = rectArr.lookupMaybe(0, PDFNumber)?.asNumber() ?? 0;
        const n1 = rectArr.lookupMaybe(1, PDFNumber)?.asNumber() ?? 0;
        const n2 = rectArr.lookupMaybe(2, PDFNumber)?.asNumber() ?? 0;
        const n3 = rectArr.lookupMaybe(3, PDFNumber)?.asNumber() ?? 0;
        const mapped = pdfRectToVisualRect([n0, n1, n2, n3], box, rot);
        rect = subtypeName === 'Text' ? { x: mapped.x, y: mapped.y, w: 0, h: 0 } : mapped;
      }

      let quads: NormRect[] | undefined;
      if (isHighlight) {
        const qpArr = dict.lookupMaybe(PDFName.of('QuadPoints'), PDFArray);
        if (qpArr && qpArr.size() >= 8) {
          quads = [];
          for (let q = 0; q + 7 < qpArr.size(); q += 8) {
            const xs = [0, 2, 4, 6].map((k) => qpArr.lookupMaybe(q + k, PDFNumber)?.asNumber() ?? 0);
            const ys = [1, 3, 5, 7].map((k) => qpArr.lookupMaybe(q + k, PDFNumber)?.asNumber() ?? 0);
            quads.push(
              pdfRectToVisualRect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], box, rot),
            );
          }
        }
      }

      const mRaw = decodePdfText(dict, 'M');
      const color = rgbArrayToHex(dict.lookupMaybe(PDFName.of('C'), PDFArray));
      const subtype: 'pin' | 'box' | 'highlight' = isHighlight
        ? 'highlight'
        : subtypeName === 'Square' || (rect.w > 0 && rect.h > 0)
          ? 'box'
          : 'pin';
      comments.push({
        id: nm || `pdf-p${pageIdx + 1}-${i}`,
        author: author || 'Reviewer',
        date: mRaw || undefined,
        text: text || (isHighlight ? 'Highlight' : ''),
        quote: subj || undefined,
        page: pageIdx + 1,
        rect,
        quads: quads && quads.length > 1 ? quads : undefined,
        color,
        subtype,
      });
    }
  });

  return comments;
}

export async function applyPdfMutations(bytes: Uint8Array, mutations: readonly DocMutation[]): Promise<Uint8Array> {
  if (!mutations.length) {
    return bytes;
  }
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  let seq = 1;

  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) {
      continue;
    }
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookupMaybe(i, PDFDict);
      const nm = dict ? decodePdfText(dict, 'NM') : '';
      const m = /^dv-(\d+)$/.exec(nm);
      if (m) {
        seq = Math.max(seq, Number(m[1]) + 1);
      }
    }
  }

  for (const mut of mutations) {
    if (mut.kind === 'addComment') {
      const pages = doc.getPages();
      if (!pages.length) {
        continue;
      }
      const pageIdx = Math.max(0, Math.min(pages.length - 1, (mut.page ?? 1) - 1));
      const page = pages[pageIdx];
      const box = page.getCropBox() ?? page.getMediaBox();
      const bw = box.width || 612;
      const bh = box.height || 792;
      const bx = box.x || 0;
      const by = box.y || 0;
      const rot = page.getRotation().angle || 0;

      const r = mut.rect ?? { x: 0.1, y: 0.1, w: 0, h: 0 };
      const isHighlight = mut.subtype === 'highlight';
      const isBox = !isHighlight && r.w > 0.004 && r.h > 0.004;

      let pdfRect: [number, number, number, number];
      let quadPoints: number[] | undefined;

      if (isHighlight && mut.quads?.length) {
        const mappedQuads = mut.quads.map((q) => visualRectToPdfRect(q, box, rot, 0.006));
        quadPoints = mappedQuads.flatMap(([qx1, qy1, qx2, qy2]) => [qx1, qy2, qx2, qy2, qx1, qy1, qx2, qy1]);
        pdfRect = [
          Math.min(...mappedQuads.map((q) => q[0])),
          Math.min(...mappedQuads.map((q) => q[1])),
          Math.max(...mappedQuads.map((q) => q[2])),
          Math.max(...mappedQuads.map((q) => q[3])),
        ];
      } else if (isHighlight || isBox) {
        const [x1, y1, x2, y2] = visualRectToPdfRect(r, box, rot, isHighlight ? 0.008 : 0);
        pdfRect = [x1, y1, x2, y2];
        if (isHighlight) {
          quadPoints = [x1, y2, x2, y2, x1, y1, x2, y1];
        }
      } else {
        const [px, py] = visualRectToPdfRect({ x: r.x, y: r.y, w: 0, h: 0 }, box, rot, 0);
        pdfRect = [
          px,
          Math.max(by, py - 20),
          Math.min(bx + bw, px + 20),
          py,
        ];
      }

      const id = `dv-${seq++}`;
      const [cr, cg, cb] = hexToRgbNumbers(mut.color ?? (isHighlight ? '#fde047' : undefined));
      const now = new Date();
      const annotDict = doc.context.obj({
        Type: 'Annot',
        Subtype: isHighlight ? 'Highlight' : isBox ? 'Square' : 'Text',
        ...(isHighlight
          ? { QuadPoints: quadPoints! }
          : isBox
            ? { BS: { W: 2 } }
            : { Name: 'Comment' }),
        Rect: pdfRect,
        Contents: PDFHexString.fromText(mut.text),
        ...(mut.quote ? { Subj: PDFHexString.fromText(mut.quote) } : {}),
        T: PDFHexString.fromText(mut.author?.trim() || 'DocsView'),
        NM: PDFHexString.fromText(id),
        M: PDFString.fromDate(now),
        CreationDate: PDFString.fromDate(now),
        C: [cr, cg, cb],
        CA: isHighlight ? 0.42 : 0.9,
        F: 4,
        P: page.ref,
      });
      const annotRef = doc.context.register(annotDict);
      page.node.addAnnot(annotRef);
    } else if (mut.kind === 'updateComment' || mut.kind === 'deleteComment') {
      const pages = doc.getPages();
      const fallbackMatch = /^pdf-p(\d+)-(\d+)$/.exec(mut.id);
      let handled = false;
      pages.forEach((page, pageIdx) => {
        if (handled) {
          return;
        }
        const annots = page.node.Annots();
        if (!annots) {
          return;
        }
        for (let i = annots.size() - 1; i >= 0; i--) {
          const dict = annots.lookupMaybe(i, PDFDict);
          if (!dict) {
            continue;
          }
          const nm = decodePdfText(dict, 'NM').trim();
          const isMatch =
            (nm && nm === mut.id) ||
            (!nm && fallbackMatch && Number(fallbackMatch[1]) === pageIdx + 1 && Number(fallbackMatch[2]) === i);
          if (!isMatch) {
            continue;
          }
          if (mut.kind === 'deleteComment') {
            annots.remove(i);
          } else {
            dict.set(PDFName.of('Contents'), PDFHexString.fromText(mut.text));
            dict.set(PDFName.of('M'), PDFString.fromDate(new Date()));
          }
          handled = true;
          break;
        }
      });
    } else if (mut.kind === 'rotatePdfPages') {
      const pages = doc.getPages();
      const targets = mut.pages?.length ? mut.pages : pages.map((_, i) => i + 1);
      for (const pNum of targets) {
        const page = pages[pNum - 1];
        if (!page) {
          continue;
        }
        const curAngle = page.getRotation().angle || 0;
        const nextAngle = (((curAngle + mut.delta) % 360) + 360) % 360;
        page.setRotation(degrees(nextAngle));
      }
    } else if (mut.kind === 'deletePdfPage') {
      const total = doc.getPageCount();
      if (total > 1 && mut.page >= 1 && mut.page <= total) {
        doc.removePage(mut.page - 1);
      }
    } else if (mut.kind === 'movePdfPage') {
      const total = doc.getPageCount();
      const fromIdx = mut.fromPage - 1;
      const toIdx = Math.max(0, Math.min(total - 1, mut.toPage - 1));
      if (total > 1 && fromIdx >= 0 && fromIdx < total && fromIdx !== toIdx) {
        const page = doc.getPage(fromIdx);
        doc.removePage(fromIdx);
        doc.insertPage(toIdx, page);
      }
    } else if (mut.kind === 'appendPdfBytes') {
      const otherBytes = toUint8Array(mut.otherBytes);
      if (otherBytes.byteLength > 0) {
        const otherDoc = await PDFDocument.load(otherBytes, { ignoreEncryption: true, updateMetadata: false });
        const copied = await doc.copyPages(otherDoc, otherDoc.getPageIndices());
        for (const p of copied) {
          doc.addPage(p);
        }
      }
    } else if (mut.kind === 'addPdfImageStamp') {
      const pages = doc.getPages();
      if (!pages.length) continue;
      const pageIdx = Math.max(0, Math.min(pages.length - 1, mut.page - 1));
      const page = pages[pageIdx];
      const pngBytes = toUint8Array(mut.pngBytes);
      if (!pngBytes.byteLength) continue;
      const img = await doc.embedPng(pngBytes);
      const box = page.getCropBox() ?? page.getMediaBox();
      const rot = page.getRotation().angle || 0;
      const [x1, y1, x2, y2] = visualRectToPdfRect(mut.rect, box, rot, 0.01);
      page.drawImage(img, {
        x: x1,
        y: y1,
        width: Math.max(4, x2 - x1),
        height: Math.max(4, y2 - y1),
      });
    } else if (mut.kind === 'addPdfWatermark') {
      const pages = doc.getPages();
      if (!pages.length) continue;
      const wmBytes = mut.watermarkPngBytes ? toUint8Array(mut.watermarkPngBytes) : undefined;
      const wmImg = wmBytes && wmBytes.byteLength > 0 ? await doc.embedPng(wmBytes) : undefined;
      const font = mut.pageNumbers ? await doc.embedFont(StandardFonts.Helvetica) : undefined;
      const total = pages.length;
      for (let i = 0; i < total; i++) {
        const page = pages[i];
        const box = page.getCropBox() ?? page.getMediaBox();
        if (wmImg) {
          const targetW = box.width * 0.68;
          const targetH = (targetW * wmImg.height) / Math.max(1, wmImg.width);
          page.drawImage(wmImg, {
            x: box.x + (box.width - targetW) / 2,
            y: box.y + (box.height - targetH) / 2,
            width: targetW,
            height: targetH,
            opacity: 0.22,
          });
        }
        if (font && mut.pageNumbers) {
          const label = `${i + 1} / ${total}`;
          const size = 10;
          const tw = font.widthOfTextAtSize(label, size);
          page.drawText(label, {
            x: box.x + (box.width - tw) / 2,
            y: box.y + 18,
            size,
            font,
            color: rgb(0.35, 0.35, 0.35),
          });
        }
      }
    }
  }

  const saved = await doc.save({ useObjectStreams: false });
  return new Uint8Array(saved.buffer, saved.byteOffset, saved.byteLength);
}

/** Parses a human page range specification like `"1-3, 5, 8-7"` into 1-based page numbers within `[1..totalPages]`. */
export function parsePageRangeSpec(spec: string, totalPages: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const part of spec.split(/[,;]+/)) {
    const token = part.trim();
    if (!token) {
      continue;
    }
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (rangeMatch) {
      const a = Number(rangeMatch[1]);
      const b = Number(rangeMatch[2]);
      const step = a <= b ? 1 : -1;
      for (let p = a; step > 0 ? p <= b : p >= b; p += step) {
        if (p >= 1 && p <= totalPages && !seen.has(p)) {
          seen.add(p);
          out.push(p);
        }
      }
    } else if (/^\d+$/.test(token)) {
      const p = Number(token);
      if (p >= 1 && p <= totalPages && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out;
}

/** Extracts 1-based `pageNumbers` from `bytes` into a standalone PDF byte buffer. */
export async function extractPdfPagesToBytes(bytes: Uint8Array, pageNumbers: readonly number[]): Promise<Uint8Array> {
  const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const total = srcDoc.getPageCount();
  const validIndices = pageNumbers
    .map((p) => p - 1)
    .filter((idx) => idx >= 0 && idx < total);
  const outDoc = await PDFDocument.create();
  if (validIndices.length) {
    const copied = await outDoc.copyPages(srcDoc, validIndices);
    for (const p of copied) {
      outDoc.addPage(p);
    }
  }
  const saved = await outDoc.save({ useObjectStreams: false });
  return new Uint8Array(saved.buffer, saved.byteOffset, saved.byteLength);
}
