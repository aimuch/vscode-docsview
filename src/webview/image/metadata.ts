// Lightweight, zero-dependency binary metadata reader for PNG (IHDR, pHYs DPI, tEXt / iTXt)
// and JPEG (SOF0/SOF2, JFIF DPI, EXIF IFD0 & ExifSubIFD camera/exposure/date/software tags).

export interface ImageMetaEntry {
  key: string;
  value: string;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readAscii(bytes: Uint8Array, start: number, len: number): string {
  const end = Math.min(bytes.length, start + len);
  let out = '';
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    if (b === 0) {
      break;
    }
    if (b >= 32 && b < 127) {
      out += String.fromCharCode(b);
    }
  }
  return out.trim();
}

function readUtf8(bytes: Uint8Array, start: number, len: number): string {
  const slice = bytes.subarray(start, Math.min(bytes.length, start + len));
  const zero = slice.indexOf(0);
  const clean = zero >= 0 ? slice.subarray(0, zero) : slice;
  return new TextDecoder('utf-8', { fatal: false }).decode(clean).trim();
}

function truncateMetaValue(val: string, maxLen = 220): string {
  const oneLine = val.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
}

function parsePngMetadata(bytes: Uint8Array): ImageMetaEntry[] {
  const entries: ImageMetaEntry[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  const colorTypes: Record<number, string> = {
    0: 'Grayscale',
    2: 'RGB',
    3: 'Indexed Palette',
    4: 'Grayscale + Alpha',
    6: 'RGBA',
  };

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type = readAscii(bytes, offset + 4, 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      break;
    }

    if (type === 'IHDR' && length >= 13) {
      const bitDepth = bytes[dataStart + 8];
      const colorType = bytes[dataStart + 9];
      entries.push({
        key: 'Color',
        value: `${bitDepth}-bit ${colorTypes[colorType] ?? `Type ${colorType}`}`,
      });
    } else if (type === 'pHYs' && length >= 9) {
      const ppuX = view.getUint32(dataStart, false);
      const ppuY = view.getUint32(dataStart + 4, false);
      const unit = bytes[dataStart + 8];
      if (unit === 1 && ppuX > 0 && ppuY > 0) {
        const dpiX = Math.round(ppuX * 0.0254);
        const dpiY = Math.round(ppuY * 0.0254);
        entries.push({ key: 'DPI', value: dpiX === dpiY ? `${dpiX} DPI` : `${dpiX} × ${dpiY} DPI` });
      }
    } else if (type === 'tEXt' && length > 1 && length <= 65536) {
      const chunk = bytes.subarray(dataStart, dataEnd);
      const nul = chunk.indexOf(0);
      if (nul > 0) {
        const k = new TextDecoder('latin1').decode(chunk.subarray(0, nul)).trim();
        const v = new TextDecoder('utf-8', { fatal: false }).decode(chunk.subarray(nul + 1)).trim();
        if (k && v && entries.length < 16) {
          entries.push({ key: k, value: truncateMetaValue(v) });
        }
      }
    } else if (type === 'iTXt' && length > 5 && length <= 65536) {
      const chunk = bytes.subarray(dataStart, dataEnd);
      const nul = chunk.indexOf(0);
      if (nul > 0 && nul + 3 <= chunk.length) {
        const k = new TextDecoder('latin1').decode(chunk.subarray(0, nul)).trim();
        const compFlag = chunk[nul + 1];
        if (compFlag === 0) {
          // Skip language tag + translated keyword (2 null-terminated strings)
          let pos = nul + 3;
          const nul2 = chunk.indexOf(0, pos);
          if (nul2 >= 0) {
            pos = nul2 + 1;
            const nul3 = chunk.indexOf(0, pos);
            if (nul3 >= 0) {
              const v = new TextDecoder('utf-8', { fatal: false }).decode(chunk.subarray(nul3 + 1)).trim();
              if (k && v && entries.length < 16) {
                entries.push({ key: k, value: truncateMetaValue(v) });
              }
            }
          }
        }
      }
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4;
  }
  return entries;
}

const EXIF_TAG_NAMES: Record<number, string> = {
  0x010f: 'Make',
  0x0110: 'Model',
  0x0112: 'Orientation',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x829a: 'Exposure',
  0x829d: 'Aperture',
  0x8827: 'ISO',
  0x9003: 'Captured',
  0x920a: 'Focal Length',
  0xa434: 'Lens',
};

function parseTiffExif(tiff: Uint8Array): ImageMetaEntry[] {
  if (tiff.length < 8) {
    return [];
  }
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!le && !be) {
    return [];
  }
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (view.getUint16(2, le) !== 42) {
    return [];
  }
  const entries: ImageMetaEntry[] = [];
  const seenKeys = new Set<string>();

  const readRational = (off: number): number | undefined => {
    if (off + 8 > tiff.length) {
      return undefined;
    }
    const num = view.getUint32(off, le);
    const den = view.getUint32(off + 4, le);
    return den > 0 ? num / den : undefined;
  };

  const readIfd = (ifdOffset: number, depth: number) => {
    if (depth > 2 || ifdOffset < 8 || ifdOffset + 2 > tiff.length) {
      return;
    }
    const count = view.getUint16(ifdOffset, le);
    for (let i = 0; i < count; i++) {
      const entryOff = ifdOffset + 2 + i * 12;
      if (entryOff + 12 > tiff.length) {
        break;
      }
      const tag = view.getUint16(entryOff, le);
      const fieldType = view.getUint16(entryOff + 2, le);
      const numValues = view.getUint32(entryOff + 4, le);
      const valOff = entryOff + 8;

      // ExifOffset pointer to ExifSubIFD
      if (tag === 0x8769 && (fieldType === 4 || fieldType === 3)) {
        const subOff = fieldType === 4 ? view.getUint32(valOff, le) : view.getUint16(valOff, le);
        readIfd(subOff, depth + 1);
        continue;
      }

      if (tag === 0x011a && fieldType === 5 && !seenKeys.has('DPI')) {
        const ptr = view.getUint32(valOff, le);
        const dpi = readRational(ptr);
        if (dpi && dpi > 0 && dpi < 100000) {
          seenKeys.add('DPI');
          entries.push({ key: 'DPI', value: `${Math.round(dpi)} DPI` });
        }
        continue;
      }

      const name = EXIF_TAG_NAMES[tag];
      if (!name || seenKeys.has(name)) {
        continue;
      }

      if (fieldType === 2 && numValues > 0 && numValues < 4096) {
        const strOff = numValues <= 4 ? valOff : view.getUint32(valOff, le);
        if (strOff + numValues <= tiff.length) {
          const s = readUtf8(tiff, strOff, numValues);
          if (s) {
            seenKeys.add(name);
            entries.push({ key: name, value: truncateMetaValue(s) });
          }
        }
      } else if ((fieldType === 3 || fieldType === 4) && numValues === 1) {
        const v = fieldType === 3 ? view.getUint16(valOff, le) : view.getUint32(valOff, le);
        seenKeys.add(name);
        entries.push({ key: name, value: String(v) });
      } else if (fieldType === 5 && numValues >= 1) {
        const ptr = view.getUint32(valOff, le);
        if (ptr + 8 <= tiff.length) {
          const num = view.getUint32(ptr, le);
          const den = view.getUint32(ptr + 4, le);
          if (den > 0 && num > 0) {
            seenKeys.add(name);
            if (tag === 0x829a) {
              entries.push({
                key: name,
                value: num < den ? `1/${Math.round(den / num)} s` : `${(num / den).toFixed(2)} s`,
              });
            } else if (tag === 0x829d) {
              entries.push({ key: name, value: `f/${(num / den).toFixed(1)}` });
            } else if (tag === 0x920a) {
              entries.push({ key: name, value: `${(num / den).toFixed(1)} mm` });
            }
          }
        }
      }
    }
  };

  readIfd(view.getUint32(4, le), 0);
  return entries;
}

function parseJpegMetadata(bytes: Uint8Array): ImageMetaEntry[] {
  const entries: ImageMetaEntry[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;

  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    let marker = bytes[offset + 1];
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset++;
      marker = bytes[offset + 1];
    }
    if (marker === 0xd9 || marker === 0xda) {
      break; // EOI or SOS
    }
    if (offset + 4 > bytes.length) {
      break;
    }
    const segLen = view.getUint16(offset + 2, false);
    if (segLen < 2 || offset + 2 + segLen > bytes.length) {
      break;
    }
    const segStart = offset + 4;
    const payloadLen = segLen - 2;

    if (marker === 0xe0 && payloadLen >= 12 && readAscii(bytes, segStart, 4) === 'JFIF') {
      const units = bytes[segStart + 7];
      const xd = view.getUint16(segStart + 8, false);
      const yd = view.getUint16(segStart + 10, false);
      if (units === 1 && xd > 0 && yd > 0) {
        entries.push({ key: 'DPI', value: xd === yd ? `${xd} DPI` : `${xd} × ${yd} DPI` });
      } else if (units === 2 && xd > 0) {
        entries.push({ key: 'DPI', value: `${Math.round(xd * 2.54)} DPI` });
      }
    } else if (marker === 0xe1 && payloadLen > 14 && readAscii(bytes, segStart, 4) === 'Exif') {
      const exifEntries = parseTiffExif(bytes.subarray(segStart + 6, segStart + payloadLen));
      for (const item of exifEntries) {
        if (!entries.some((e) => e.key === item.key)) {
          entries.push(item);
        }
      }
    } else if (marker === 0xc0 || marker === 0xc2) {
      entries.push({
        key: 'Encoding',
        value: marker === 0xc2 ? 'Progressive JPEG' : 'Baseline JPEG',
      });
    }

    offset += 2 + segLen;
  }
  return entries;
}

export function extractImageMetadata(bytes: Uint8Array): ImageMetaEntry[] {
  if (!bytes || bytes.length < 4) {
    return [];
  }
  const isPng = bytes.length >= 8 && PNG_SIG.every((b, i) => bytes[i] === b);
  if (isPng) {
    return parsePngMetadata(bytes);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return parseJpegMetadata(bytes);
  }
  return [];
}

export function formatFileSize(byteLength: number): string {
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    return '';
  }
  if (byteLength < 1024) {
    return `${byteLength} B`;
  }
  if (byteLength < 1024 * 1024) {
    return `${(byteLength / 1024).toFixed(1)} KB`;
  }
  return `${(byteLength / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatAspectRatio(w: number, h: number): string {
  if (w <= 0 || h <= 0) {
    return '';
  }
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(Math.round(w), Math.round(h));
  const rw = Math.round(w) / d;
  const rh = Math.round(h) / d;
  if (rw <= 64 && rh <= 64) {
    return `${rw}:${rh}`;
  }
  return `${(w / h).toFixed(2)}:1`;
}
