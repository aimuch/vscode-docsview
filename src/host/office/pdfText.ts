// Pure TypeScript PDF text extractor using pdf-lib + fflate (zero extra dependencies).
// Supports Flate-compressed content streams, Form XObjects, and full ISO 32000 /ToUnicode CMap
// decoding (begincodespacerange, beginbfchar, beginbfrange scalar & array forms) for CJK/CID fonts.
import { unzlibSync } from 'fflate';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from 'pdf-lib';

export interface CodespaceRange {
  byteLen: number;
  low: Uint8Array;
  high: Uint8Array;
}

export interface BfRangeEntry {
  byteLen: number;
  lo: number;
  hi: number;
  dstStartUnits: number[];
}

export interface ToUnicodeCMap {
  codespaceRanges: CodespaceRange[];
  byteLengths: number[];
  bfchar: Map<number, Map<number, string>>;
  bfranges: BfRangeEntry[];
}

const MAX_INFLATED_STREAM = 16 * 1024 * 1024;
const MAX_XOBJECT_DEPTH = 4;
const isPdfDelim = (ch: string | undefined) => !ch || /[\s/([<\]>)%]/.test(ch);

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  if (!clean) return new Uint8Array(0);
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return bytes;
}

function readCodeValue(bytes: Uint8Array, offset: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) {
    v = v * 256 + bytes[offset + i];
  }
  return v;
}

function bytesToUtf16Units(bytes: Uint8Array): number[] {
  if (bytes.length === 0) return [];
  if (bytes.length === 1) return [bytes[0]];
  const units: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    units.push((bytes[i] << 8) | bytes[i + 1]);
  }
  return units;
}

function decodeUtf16BeBytes(bytes: Uint8Array): string {
  const units = bytesToUtf16Units(bytes);
  return units.length ? String.fromCharCode(...units) : '';
}

function decodePdfNameToken(raw: string): string {
  return raw.replace(/#([0-9a-fA-F]{2})/g, (_, hh: string) => String.fromCharCode(parseInt(hh, 16)));
}

function decodePdfLiteralBytes(raw: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') {
      out.push(raw.charCodeAt(i) & 0xff);
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break;
    switch (next) {
      case 'n':
        out.push(0x0a);
        break;
      case 'r':
        out.push(0x0d);
        break;
      case 't':
        out.push(0x09);
        break;
      case 'b':
        out.push(0x08);
        break;
      case 'f':
        out.push(0x0c);
        break;
      case '(':
      case ')':
      case '\\':
        out.push(next.charCodeAt(0));
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
          out.push(parseInt(oct, 8) & 0xff);
        } else {
          out.push(next.charCodeAt(0) & 0xff);
        }
        break;
    }
  }
  return new Uint8Array(out);
}

function decodeFallbackBytes(bytes: Uint8Array, isLiteral: boolean): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16BeBytes(bytes.subarray(2));
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if ((b >= 32 && b < 127) || b >= 160 || (isLiteral && (b === 9 || b === 10 || b === 13))) {
      s += String.fromCharCode(b);
    }
  }
  return s;
}

type CMapToken =
  | { kind: 'hex'; value: string }
  | { kind: 'lbracket' }
  | { kind: 'rbracket' }
  | { kind: 'word'; value: string };

function tokenizeCMap(text: string): CMapToken[] {
  const tokens: CMapToken[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '%') {
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i++;
      continue;
    }
    if (ch === '<' && text[i + 1] === '<') {
      i += 2;
      continue;
    }
    if (ch === '>' && text[i + 1] === '>') {
      i += 2;
      continue;
    }
    if (ch === '<') {
      const end = text.indexOf('>', i + 1);
      if (end < 0) break;
      tokens.push({ kind: 'hex', value: text.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (ch === '[') {
      tokens.push({ kind: 'lbracket' });
      i++;
      continue;
    }
    if (ch === ']') {
      tokens.push({ kind: 'rbracket' });
      i++;
      continue;
    }
    if (ch === '(') {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
        i++;
      }
      continue;
    }
    const start = i;
    while (i < n && !/[\s<>\[\]()/%]/.test(text[i])) i++;
    if (i > start) {
      tokens.push({ kind: 'word', value: text.slice(start, i) });
    } else {
      i++;
    }
  }
  return tokens;
}

/** Parses an ISO 32000 `/ToUnicode` CMap stream into a compact lookup structure. */
export function parseToUnicodeCMap(cmapText: string): ToUnicodeCMap {
  const codespaceRanges: CodespaceRange[] = [];
  const bfchar = new Map<number, Map<number, string>>();
  const bfranges: BfRangeEntry[] = [];
  const lenSet = new Set<number>();

  const setBfChar = (byteLen: number, code: number, unicode: string) => {
    if (byteLen < 1 || byteLen > 4 || !unicode) return;
    let bucket = bfchar.get(byteLen);
    if (!bucket) {
      bucket = new Map();
      bfchar.set(byteLen, bucket);
    }
    bucket.set(code, unicode);
    lenSet.add(byteLen);
  };

  const tokens = tokenizeCMap(cmapText);
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.kind !== 'word') {
      i++;
      continue;
    }

    if (tok.value === 'begincodespacerange') {
      i++;
      while (i < tokens.length) {
        const cur = tokens[i];
        if (cur.kind === 'word' && cur.value === 'endcodespacerange') {
          i++;
          break;
        }
        if (cur.kind === 'hex' && tokens[i + 1]?.kind === 'hex') {
          const low = hexToBytes(cur.value);
          const high = hexToBytes((tokens[i + 1] as { kind: 'hex'; value: string }).value);
          if (low.length >= 1 && low.length <= 4 && low.length === high.length) {
            codespaceRanges.push({ byteLen: low.length, low, high });
            lenSet.add(low.length);
          }
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    if (tok.value === 'beginbfchar') {
      i++;
      while (i < tokens.length) {
        const cur = tokens[i];
        if (cur.kind === 'word' && cur.value === 'endbfchar') {
          i++;
          break;
        }
        if (cur.kind === 'hex' && tokens[i + 1]?.kind === 'hex') {
          const srcBytes = hexToBytes(cur.value);
          const dstBytes = hexToBytes((tokens[i + 1] as { kind: 'hex'; value: string }).value);
          if (srcBytes.length >= 1 && srcBytes.length <= 4) {
            setBfChar(srcBytes.length, readCodeValue(srcBytes, 0, srcBytes.length), decodeUtf16BeBytes(dstBytes));
          }
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    if (tok.value === 'beginbfrange') {
      i++;
      while (i < tokens.length) {
        const cur = tokens[i];
        if (cur.kind === 'word' && cur.value === 'endbfrange') {
          i++;
          break;
        }
        if (cur.kind === 'hex' && tokens[i + 1]?.kind === 'hex') {
          const loBytes = hexToBytes(cur.value);
          const hiBytes = hexToBytes((tokens[i + 1] as { kind: 'hex'; value: string }).value);
          const target = tokens[i + 2];
          if (loBytes.length >= 1 && loBytes.length <= 4 && loBytes.length === hiBytes.length && target) {
            const byteLen = loBytes.length;
            const lo = readCodeValue(loBytes, 0, byteLen);
            const hi = readCodeValue(hiBytes, 0, byteLen);
            if (target.kind === 'hex') {
              const dstStartUnits = bytesToUtf16Units(hexToBytes(target.value));
              if (lo <= hi && dstStartUnits.length > 0) {
                bfranges.push({ byteLen, lo, hi, dstStartUnits });
                lenSet.add(byteLen);
              }
              i += 3;
              continue;
            }
            if (target.kind === 'lbracket') {
              i += 3;
              let code = lo;
              while (i < tokens.length && tokens[i].kind !== 'rbracket') {
                const elem = tokens[i];
                if (elem.kind === 'hex' && code <= hi) {
                  setBfChar(byteLen, code, decodeUtf16BeBytes(hexToBytes(elem.value)));
                  code++;
                }
                i++;
              }
              if (i < tokens.length && tokens[i].kind === 'rbracket') i++;
              continue;
            }
          }
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    i++;
  }

  // Sort codespace ranges by ascending byteLen (standard CMap precedence: shortest valid match first)
  codespaceRanges.sort((a, b) => a.byteLen - b.byteLen);
  const byteLengths = [...lenSet].sort((a, b) => b - a);
  return { codespaceRanges, byteLengths, bfchar, bfranges };
}

function lookupCMap(cmap: ToUnicodeCMap, byteLen: number, code: number): string | undefined {
  const direct = cmap.bfchar.get(byteLen)?.get(code);
  if (direct !== undefined) return direct;
  for (let i = 0; i < cmap.bfranges.length; i++) {
    const r = cmap.bfranges[i];
    if (r.byteLen === byteLen && code >= r.lo && code <= r.hi) {
      const offset = code - r.lo;
      const units = r.dstStartUnits.slice();
      units[units.length - 1] = (units[units.length - 1] + offset) & 0xffff;
      return String.fromCharCode(...units);
    }
  }
  return undefined;
}

function matchesCodespace(range: CodespaceRange, bytes: Uint8Array, pos: number): boolean {
  if (pos + range.byteLen > bytes.length) return false;
  for (let k = 0; k < range.byteLen; k++) {
    const b = bytes[pos + k];
    if (b < range.low[k] || b > range.high[k]) return false;
  }
  return true;
}

/** Decodes raw character code bytes using a parsed `/ToUnicode` CMap. */
export function decodeBytesWithCMap(bytes: Uint8Array, cmap: ToUnicodeCMap): string {
  let out = '';
  let pos = 0;
  while (pos < bytes.length) {
    if (cmap.codespaceRanges.length > 0) {
      let matchedLen = 0;
      for (let r = 0; r < cmap.codespaceRanges.length; r++) {
        const range = cmap.codespaceRanges[r];
        if (matchesCodespace(range, bytes, pos)) {
          matchedLen = range.byteLen;
          break;
        }
      }
      if (matchedLen > 0) {
        const code = readCodeValue(bytes, pos, matchedLen);
        const mapped = lookupCMap(cmap, matchedLen, code);
        if (mapped !== undefined) {
          out += mapped;
        } else if (matchedLen === 1 && ((code >= 32 && code < 127) || code >= 160)) {
          out += String.fromCharCode(code);
        }
        pos += matchedLen;
      } else {
        pos += 1;
      }
      continue;
    }

    // Fallback when a malformed CMap omits begincodespacerange
    let hit = false;
    for (let l = 0; l < cmap.byteLengths.length; l++) {
      const len = cmap.byteLengths[l];
      if (pos + len > bytes.length) continue;
      const code = readCodeValue(bytes, pos, len);
      const mapped = lookupCMap(cmap, len, code);
      if (mapped !== undefined) {
        out += mapped;
        pos += len;
        hit = true;
        break;
      }
    }
    if (!hit) {
      const b = bytes[pos++];
      if ((b >= 32 && b < 127) || b >= 160) out += String.fromCharCode(b);
    }
  }
  return out;
}

interface ContentExtractContext {
  doc?: PDFDocument;
  fonts: Map<string, ToUnicodeCMap>;
  xObjects?: Map<string, PDFRawStream>;
  cmapCache?: Map<unknown, ToUnicodeCMap | null>;
  depth?: number;
}

function extractTextFromContentStream(streamText: string, ctx: ContentExtractContext): string {
  const chunks: string[] = [];
  let inText = false;
  let i = 0;
  const n = streamText.length;
  let lastName = '';
  let currentFont: ToUnicodeCMap | undefined;
  const fontStack: (ToUnicodeCMap | undefined)[] = [];

  const readParenBytes = (): Uint8Array => {
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
    return decodePdfLiteralBytes(buf);
  };

  const decodeOperand = (bytes: Uint8Array, isLiteral: boolean): string => {
    if (currentFont) {
      return decodeBytesWithCMap(bytes, currentFont);
    }
    return decodeFallbackBytes(bytes, isLiteral);
  };

  while (i < n) {
    const ch = streamText[i];

    // Skip PDF comments outside strings
    if (ch === '%') {
      while (i < n && streamText[i] !== '\n' && streamText[i] !== '\r') i++;
      continue;
    }

    // Skip PDF dictionaries `<< ... >>` completely so they are never mistaken for hex strings
    if (ch === '<' && streamText[i + 1] === '<') {
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

    // Track PDF /Name tokens for Tf (font selection) and Do (Form XObject invocation)
    if (ch === '/') {
      const start = i + 1;
      i++;
      while (i < n && !isPdfDelim(streamText[i])) i++;
      lastName = decodePdfNameToken(streamText.slice(start, i));
      continue;
    }

    // Track font selection `Tf` both inside and outside BT..ET
    if (
      ch === 'T' &&
      streamText[i + 1] === 'f' &&
      isPdfDelim(streamText[i - 1]) &&
      isPdfDelim(streamText[i + 2])
    ) {
      currentFont = ctx.fonts.get(lastName);
      i += 2;
      continue;
    }

    // Graphics state save/restore for active font
    if (!inText && ch === 'q' && isPdfDelim(streamText[i - 1]) && isPdfDelim(streamText[i + 1])) {
      fontStack.push(currentFont);
      i++;
      continue;
    }
    if (!inText && ch === 'Q' && isPdfDelim(streamText[i - 1]) && isPdfDelim(streamText[i + 1])) {
      if (fontStack.length > 0) {
        currentFont = fontStack.pop();
      }
      i++;
      continue;
    }

    // Form XObject invocation `/Fm1 Do`
    if (
      !inText &&
      ch === 'D' &&
      streamText[i + 1] === 'o' &&
      isPdfDelim(streamText[i - 1]) &&
      isPdfDelim(streamText[i + 2])
    ) {
      const xobj = ctx.xObjects?.get(lastName);
      const depth = ctx.depth ?? 0;
      if (xobj && ctx.doc && depth < MAX_XOBJECT_DEPTH) {
        const subRes = resolveResources(ctx.doc, xobj.dict);
        const subFonts = new Map(ctx.fonts);
        if (subRes) {
          for (const [k, v] of extractFontsFromResources(ctx.doc, subRes, ctx.cmapCache ?? new Map())) {
            subFonts.set(k, v);
          }
        }
        const subXObjs = subRes ? extractFormXObjects(ctx.doc, subRes) : ctx.xObjects;
        const subText = extractTextFromContentStream(decodeRawStream(xobj), {
          doc: ctx.doc,
          fonts: subFonts,
          xObjects: subXObjs,
          cmapCache: ctx.cmapCache,
          depth: depth + 1,
        });
        if (subText) {
          if (chunks.length && chunks[chunks.length - 1] !== '\n') chunks.push('\n');
          chunks.push(subText, '\n');
        }
      }
      i += 2;
      continue;
    }

    // Check BT / ET boundaries (PDF allows delimiters like `/` or `(` immediately after BT)
    if (
      ch === 'B' &&
      streamText[i + 1] === 'T' &&
      isPdfDelim(streamText[i - 1]) &&
      isPdfDelim(streamText[i + 2])
    ) {
      inText = true;
      i += 2;
      continue;
    }
    if (
      ch === 'E' &&
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
      // Still skip literal/hex strings outside BT so a `Tf`/`BT` inside metadata string isn't misread
      if (ch === '(') {
        readParenBytes();
        continue;
      }
      if (ch === '<' && streamText[i + 1] !== '<') {
        const end = streamText.indexOf('>', i + 1);
        if (end > i) {
          i = end + 1;
          continue;
        }
      }
      i++;
      continue;
    }

    if (ch === '(') {
      const s = decodeOperand(readParenBytes(), true);
      if (s) chunks.push(s);
      continue;
    }
    if (ch === '<' && streamText[i + 1] !== '<') {
      const end = streamText.indexOf('>', i + 1);
      if (end > i) {
        const s = decodeOperand(hexToBytes(streamText.slice(i + 1, end)), false);
        if (s) chunks.push(s);
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      i++;
      while (i < n && streamText[i] !== ']') {
        if (streamText[i] === '(') {
          const s = decodeOperand(readParenBytes(), true);
          if (s) chunks.push(s);
        } else if (streamText[i] === '<' && streamText[i + 1] !== '<') {
          const end = streamText.indexOf('>', i + 1);
          if (end > i) {
            const s = decodeOperand(hexToBytes(streamText.slice(i + 1, end)), false);
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

function resolveResources(doc: PDFDocument, startNode: PDFDict): PDFDict | undefined {
  let current: PDFDict | undefined = startNode;
  const visited = new Set<unknown>();
  for (let hop = 0; hop < 16 && current; hop++) {
    if (visited.has(current)) break;
    visited.add(current);
    const res = doc.context.lookup(current.get(PDFName.of('Resources')));
    if (res instanceof PDFDict) return res;
    const parent: unknown = doc.context.lookup(current.get(PDFName.of('Parent')));
    current = parent instanceof PDFDict ? parent : undefined;
  }
  return undefined;
}

function extractFontsFromResources(
  doc: PDFDocument,
  resources: PDFDict,
  cmapCache: Map<unknown, ToUnicodeCMap | null>,
): Map<string, ToUnicodeCMap> {
  const fonts = new Map<string, ToUnicodeCMap>();
  const fontDict = doc.context.lookup(resources.get(PDFName.of('Font')));
  if (!(fontDict instanceof PDFDict)) return fonts;

  for (const [nameObj, fontVal] of fontDict.entries()) {
    const fontObj = doc.context.lookup(fontVal);
    if (!(fontObj instanceof PDFDict)) continue;
    const toUniRef = fontObj.get(PDFName.of('ToUnicode'));
    if (!toUniRef) continue;

    let cmap = cmapCache.get(toUniRef);
    if (cmap === undefined) {
      const toUniObj = doc.context.lookup(toUniRef);
      if (toUniObj instanceof PDFRawStream) {
        const parsed = parseToUnicodeCMap(decodeRawStream(toUniObj));
        cmap = parsed.bfchar.size > 0 || parsed.bfranges.length > 0 ? parsed : null;
      } else {
        cmap = null;
      }
      cmapCache.set(toUniRef, cmap);
    }
    if (cmap) {
      fonts.set(nameObj.decodeText(), cmap);
    }
  }
  return fonts;
}

function extractFormXObjects(doc: PDFDocument, resources: PDFDict): Map<string, PDFRawStream> {
  const xObjects = new Map<string, PDFRawStream>();
  const xobjDict = doc.context.lookup(resources.get(PDFName.of('XObject')));
  if (!(xobjDict instanceof PDFDict)) return xObjects;

  for (const [nameObj, val] of xobjDict.entries()) {
    const obj = doc.context.lookup(val);
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype'))?.toString() === '/Form') {
      xObjects.set(nameObj.decodeText(), obj);
    }
  }
  return xObjects;
}

/** Extracts plain text per page plus the true total page count from a PDF byte buffer. */
export async function extractPdfTextWithMeta(
  bytes: Uint8Array,
  maxPages = 100,
): Promise<{ pages: string[]; totalPages: number }> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  const limit = Math.min(pages.length, maxPages);
  const cmapCache = new Map<unknown, ToUnicodeCMap | null>();
  const out: string[] = [];

  for (let p = 0; p < limit; p++) {
    const page = pages[p];
    const resources = resolveResources(doc, page.node);
    const fonts = resources ? extractFontsFromResources(doc, resources, cmapCache) : new Map<string, ToUnicodeCMap>();
    const xObjects = resources ? extractFormXObjects(doc, resources) : undefined;

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

    // Per PDF spec §7.7.3.3, multiple content streams in a page array form one logical stream
    const combined = streams.map((s) => decodeRawStream(s)).filter(Boolean).join('\n');
    const text = combined
      ? extractTextFromContentStream(combined, { doc, fonts, xObjects, cmapCache, depth: 0 })
      : '';
    out.push(text);
  }

  return { pages: out, totalPages: pages.length };
}

/** Extracts plain text per page from a PDF byte buffer. */
export async function extractPdfText(bytes: Uint8Array, maxPages = 100): Promise<string[]> {
  return (await extractPdfTextWithMeta(bytes, maxPages)).pages;
}
