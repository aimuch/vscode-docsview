// Pure TypeScript PDF text extractor using pdf-lib + fflate (zero extra dependencies).
// Decompresses page content streams and extracts text from BT..ET Tj / TJ / ' / " operators.
import { unzlibSync } from 'fflate';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef } from 'pdf-lib';

function decodePdfStringLiteral(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break;
    switch (next) {
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case '(':
      case ')':
      case '\\':
        out += next;
        break;
      case '\r':
        if (raw[i + 1] === '\n') i++;
        break;
      case '\n':
        break;
      default:
        if (next >= '0' && next <= '7') {
          let oct = next;
          if (raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
          if (raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
          out += String.fromCharCode(parseInt(oct, 8));
        } else {
          out += next;
        }
        break;
    }
  }
  return out;
}

function decodePdfHexString(hex: string): string {
  const clean = hex.replace(/\s+/g, '');
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return s;
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if ((b >= 32 && b < 127) || b >= 160) s += String.fromCharCode(b);
  }
  return s;
}

const isPdfDelim = (ch: string | undefined) => !ch || /[\s/([<\]>)]/.test(ch);

function extractTextFromContentStream(streamText: string): string {
  const chunks: string[] = [];
  let inText = false;
  let i = 0;
  const n = streamText.length;

  const readParen = (): string => {
    let depth = 1;
    let buf = '';
    i++; // skip '('
    while (i < n && depth > 0) {
      const ch = streamText[i];
      if (ch === '\\' && i + 1 < n) {
        buf += ch + streamText[i + 1];
        i += 2;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      buf += ch;
      i++;
    }
    return decodePdfStringLiteral(buf);
  };

  while (i < n) {
    // Skip PDF dictionaries `<< ... >>` completely so they are never mistaken for hex strings
    if (streamText[i] === '<' && streamText[i + 1] === '<') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (streamText[i] === '<' && streamText[i + 1] === '<') {
          depth++;
          i += 2;
        } else if (streamText[i] === '>' && streamText[i + 1] === '>') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    // Check BT / ET boundaries (PDF allows delimiters like `/` or `(` immediately after BT)
    if (
      streamText[i] === 'B' &&
      streamText[i + 1] === 'T' &&
      isPdfDelim(streamText[i - 1]) &&
      isPdfDelim(streamText[i + 2])
    ) {
      inText = true;
      i += 2;
      continue;
    }
    if (
      streamText[i] === 'E' &&
      streamText[i + 1] === 'T' &&
      isPdfDelim(streamText[i - 1]) &&
      isPdfDelim(streamText[i + 2])
    ) {
      inText = false;
      if (chunks.length && chunks[chunks.length - 1] !== '\n') chunks.push('\n');
      i += 2;
      continue;
    }
    if (!inText) {
      i++;
      continue;
    }
    const ch = streamText[i];
    if (ch === '(') {
      const s = readParen();
      if (s) chunks.push(s);
      continue;
    }
    if (ch === '<' && streamText[i + 1] !== '<') {
      const end = streamText.indexOf('>', i + 1);
      if (end > i) {
        const s = decodePdfHexString(streamText.slice(i + 1, end));
        if (s) chunks.push(s);
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      i++;
      while (i < n && streamText[i] !== ']') {
        if (streamText[i] === '(') {
          const s = readParen();
          if (s) chunks.push(s);
        } else if (streamText[i] === '<' && streamText[i + 1] !== '<') {
          const end = streamText.indexOf('>', i + 1);
          if (end > i) {
            const s = decodePdfHexString(streamText.slice(i + 1, end));
            if (s) chunks.push(s);
            i = end + 1;
          } else {
            i++;
          }
        } else if (streamText[i] === '-' || (streamText[i] >= '0' && streamText[i] <= '9')) {
          const start = i;
          while (i < n && /[-0-9.]/.test(streamText[i])) i++;
          const kern = Number(streamText.slice(start, i));
          if (Number.isFinite(kern) && kern <= -180) {
            chunks.push(' ');
          }
        } else {
          i++;
        }
      }
      if (i < n && streamText[i] === ']') i++;
      continue;
    }
    if (
      ch === 'T' &&
      (streamText[i + 1] === 'd' || streamText[i + 1] === 'D' || streamText[i + 1] === '*' || streamText[i + 1] === 'm') &&
      isPdfDelim(streamText[i - 1]) &&
      isPdfDelim(streamText[i + 2])
    ) {
      if (chunks.length && chunks[chunks.length - 1] !== '\n') chunks.push('\n');
      i += 2;
      continue;
    }
    i++;
  }

  return chunks
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MAX_INFLATED_STREAM = 16 * 1024 * 1024;

function decodeRawStream(raw: PDFRawStream): string {
  const filter = raw.dict.get(PDFName.of('Filter'));
  const bytes = raw.contents;
  const isSingleFlate =
    filter?.toString() === '/FlateDecode' ||
    (filter instanceof PDFArray && filter.size() === 1 && filter.get(0)?.toString() === '/FlateDecode');
  if (isSingleFlate) {
    try {
      const inflated = unzlibSync(bytes);
      if (inflated.byteLength > MAX_INFLATED_STREAM) {
        return '';
      }
      return Buffer.from(inflated).toString('latin1');
    } catch {
      return '';
    }
  }
  if (filter) {
    return '';
  }
  return Buffer.from(bytes).toString('latin1');
}

/** Extracts plain text per page plus the true total page count from a PDF byte buffer. */
export async function extractPdfTextWithMeta(
  bytes: Uint8Array,
  maxPages = 100,
): Promise<{ pages: string[]; totalPages: number }> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  const limit = Math.min(pages.length, maxPages);
  const out: string[] = [];

  for (let p = 0; p < limit; p++) {
    const page = pages[p];
    const contents = page.node.get(PDFName.of('Contents'));
    const streams: PDFRawStream[] = [];
    if (contents instanceof PDFRef) {
      const obj = doc.context.lookup(contents);
      if (obj instanceof PDFRawStream) streams.push(obj);
      else if (obj instanceof PDFArray) {
        for (let k = 0; k < obj.size(); k++) {
          const item = doc.context.lookup(obj.get(k));
          if (item instanceof PDFRawStream) streams.push(item);
        }
      }
    } else if (contents instanceof PDFRawStream) {
      streams.push(contents);
    } else if (contents instanceof PDFArray) {
      for (let k = 0; k < contents.size(); k++) {
        const item = doc.context.lookup(contents.get(k));
        if (item instanceof PDFRawStream) streams.push(item);
      }
    }

    const pageParts = streams.map((s) => extractTextFromContentStream(decodeRawStream(s))).filter(Boolean);
    out.push(pageParts.join('\n').trim());
  }

  return { pages: out, totalPages: pages.length };
}

/** Extracts plain text per page from a PDF byte buffer. */
export async function extractPdfText(bytes: Uint8Array, maxPages = 100): Promise<string[]> {
  return (await extractPdfTextWithMeta(bytes, maxPages)).pages;
}
