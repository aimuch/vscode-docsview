// Reads and writes standard ISO 32000 PDF annotations (/Annots: /Square box comments and
// /Text sticky-note pins) via pdf-lib with UTF-16BE strings so Chinese and English comments
// round-trip cleanly across Adobe Acrobat, WPS PDF, macOS Preview and DocsView.
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from 'pdf-lib';
import type { DocComment, DocMutation } from '../../common/protocol';

const SKIP_SUBTYPES = new Set(['Link', 'Widget', 'Popup', 'Watermark', 'PrinterMark', 'TrapNet', '3D', 'Movie', 'Screen']);

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
    const byte = Math.max(0, Math.min(255, Math.round((n <= 1 ? n * 255 : n))));
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
    const bw = box.width || 612;
    const bh = box.height || 792;
    const bx = box.x || 0;
    const by = box.y || 0;

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
      const nm = decodePdfText(dict, 'NM').trim();
      const author = decodePdfText(dict, 'T').trim();
      if (!text && !nm.startsWith('dv-') && subtypeName !== 'Text') {
        continue;
      }

      let rect = { x: 0.1, y: 0.1, w: 0, h: 0 };
      const rectArr = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
      if (rectArr && rectArr.size() >= 4) {
        const n0 = rectArr.lookupMaybe(0, PDFNumber)?.asNumber() ?? 0;
        const n1 = rectArr.lookupMaybe(1, PDFNumber)?.asNumber() ?? 0;
        const n2 = rectArr.lookupMaybe(2, PDFNumber)?.asNumber() ?? 0;
        const n3 = rectArr.lookupMaybe(3, PDFNumber)?.asNumber() ?? 0;
        const xMin = Math.min(n0, n2);
        const xMax = Math.max(n0, n2);
        const yMin = Math.min(n1, n3);
        const yMax = Math.max(n1, n3);
        const nx = Math.max(0, Math.min(1, (xMin - bx) / bw));
        const ny = Math.max(0, Math.min(1, 1 - (yMax - by) / bh));
        const nw = Math.max(0, Math.min(1 - nx, (xMax - xMin) / bw));
        const nh = Math.max(0, Math.min(1 - ny, (yMax - yMin) / bh));
        rect = subtypeName === 'Text' ? { x: nx, y: ny, w: 0, h: 0 } : { x: nx, y: ny, w: nw, h: nh };
      }

      const mRaw = decodePdfText(dict, 'M');
      const color = rgbArrayToHex(dict.lookupMaybe(PDFName.of('C'), PDFArray));
      comments.push({
        id: nm || `pdf-p${pageIdx + 1}-${i}`,
        author: author || 'Reviewer',
        date: mRaw || undefined,
        text,
        page: pageIdx + 1,
        rect,
        color,
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
  const pages = doc.getPages();
  let seq = 1;

  // Ensure new NM IDs never collide with existing ones.
  for (const page of pages) {
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

      const r = mut.rect ?? { x: 0.1, y: 0.1, w: 0, h: 0 };
      const isBox = r.w > 0.004 && r.h > 0.004;
      const pdfRect = isBox
        ? [
            bx + r.x * bw,
            by + (1 - r.y - r.h) * bh,
            bx + (r.x + r.w) * bw,
            by + (1 - r.y) * bh,
          ]
        : [
            bx + r.x * bw,
            Math.max(by, by + (1 - r.y) * bh - 20),
            Math.min(bx + bw, bx + r.x * bw + 20),
            by + (1 - r.y) * bh,
          ];

      const id = `dv-${seq++}`;
      const [cr, cg, cb] = hexToRgbNumbers(mut.color);
      const now = new Date();
      const annotDict = doc.context.obj({
        Type: 'Annot',
        Subtype: isBox ? 'Square' : 'Text',
        ...(isBox ? { BS: { W: 2 } } : { Name: 'Comment' }),
        Rect: pdfRect,
        Contents: PDFHexString.fromText(mut.text),
        T: PDFHexString.fromText(mut.author?.trim() || 'DocsView'),
        NM: PDFHexString.fromText(id),
        M: PDFString.fromDate(now),
        CreationDate: PDFString.fromDate(now),
        C: [cr, cg, cb],
        CA: 0.9,
        F: 4,
        P: page.ref,
      });
      const annotRef = doc.context.register(annotDict);
      page.node.addAnnot(annotRef);
    } else if (mut.kind === 'updateComment' || mut.kind === 'deleteComment') {
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
    }
  }

  const saved = await doc.save({ useObjectStreams: false });
  return new Uint8Array(saved.buffer, saved.byteOffset, saved.byteLength);
}
