// Pure ZIP & TAR/TGZ archive directory reader and on-demand single-entry extractor (`fflate`).
// Parses ZIP Central Directory headers in O(entries) without decompressing payload streams!
import { gunzipSync, unzipSync } from 'fflate';
import type { ArchiveEntryInfo } from '../../common/protocol';

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

const TEXT_EXTS = new Set([
  'md', 'markdown', 'txt', 'log', 'json', 'jsonl', 'ndjson', 'csv', 'tsv', 'xml', 'html', 'htm',
  'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java',
  'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'zsh', 'bash', 'yml', 'yaml', 'toml',
  'ini', 'cfg', 'conf', 'env', 'sql', 'graphql', 'svg', 'gitignore', 'vscodeignore',
]);

function isTarName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.tar') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz');
}

function uncompressIfGzip(bytes: Uint8Array, name: string): Uint8Array {
  const lower = name.toLowerCase();
  if (lower.endsWith('.gz') || lower.endsWith('.tgz') || (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)) {
    return gunzipSync(bytes);
  }
  return bytes;
}

function dosDateTimeToIso(dosTime: number, dosDate: number): string | undefined {
  if (!dosDate) return undefined;
  const year = ((dosDate >> 9) & 0x7f) + 1980;
  const month = String((dosDate >> 5) & 0x0f).padStart(2, '0');
  const day = String(dosDate & 0x1f).padStart(2, '0');
  const hours = String((dosTime >> 11) & 0x1f).padStart(2, '0');
  const mins = String((dosTime >> 5) & 0x3f).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${mins}`;
}

function listZipCentralDirectory(bytes: Uint8Array): ArchiveEntryInfo[] | undefined {
  // Find End of Central Directory (EOCD) signature 0x06054b50 within last 65KB
  const minPos = Math.max(0, bytes.byteLength - 65557);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let p = bytes.byteLength - 22; p >= minPos; p--) {
    if (view.getUint32(p, true) === 0x06054b50) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) {
    return undefined;
  }
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset + cdSize > bytes.byteLength) {
    return undefined;
  }

  const decoder = new TextDecoder();
  const entries: ArchiveEntryInfo[] = [];
  let pos = cdOffset;
  const end = cdOffset + cdSize;

  while (pos + 46 <= end) {
    if (view.getUint32(pos, true) !== 0x02014b50) {
      break;
    }
    const dosTime = view.getUint16(pos + 12, true);
    const dosDate = view.getUint16(pos + 14, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const path = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    const isDir = path.endsWith('/');
    entries.push({
      path: isDir ? path.slice(0, -1) : path,
      isDir,
      size,
      compressedSize,
      mtime: dosDateTimeToIso(dosTime, dosDate),
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function parseTarEntries(tarBytes: Uint8Array, collectPayloadFor?: string): { entries: ArchiveEntryInfo[]; payload?: Uint8Array } {
  const entries: ArchiveEntryInfo[] = [];
  const decoder = new TextDecoder();
  let pos = 0;
  let foundPayload: Uint8Array | undefined;

  while (pos + 512 <= tarBytes.byteLength) {
    const header = tarBytes.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) {
      break;
    }
    const readStr = (off: number, len: number) => {
      let end = off;
      while (end < off + len && header[end] !== 0) end++;
      return decoder.decode(header.subarray(off, end)).trim();
    };
    const name = readStr(0, 100);
    const prefix = readStr(345, 155);
    const fullName = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '');
    const sizeOctal = readStr(124, 12);
    const size = parseInt(sizeOctal || '0', 8) || 0;
    const mtimeSec = parseInt(readStr(136, 12) || '0', 8) || 0;
    const typeFlag = header[156];
    const isDir = typeFlag === 53 /* '5' */ || fullName.endsWith('/');
    const cleanPath = isDir ? fullName.replace(/\/+$/, '') : fullName;

    if (cleanPath && typeFlag !== 76 && typeFlag !== 120 && typeFlag !== 103) {
      const dt = mtimeSec > 0 ? new Date(mtimeSec * 1000) : undefined;
      const pad = (n: number) => String(n).padStart(2, '0');
      const mtime = dt
        ? `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`
        : undefined;
      entries.push({ path: cleanPath, isDir, size, compressedSize: size, mtime });
      if (collectPayloadFor && cleanPath === collectPayloadFor && !isDir) {
        foundPayload = tarBytes.slice(pos + 512, pos + 512 + size);
      }
    }
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  return { entries, payload: foundPayload };
}

export function inspectArchive(
  bytes: Uint8Array,
  fileName: string,
): { totalSize: number; compressedTotal: number; entries: ArchiveEntryInfo[] } {
  if (isTarName(fileName)) {
    const rawTar = uncompressIfGzip(bytes, fileName);
    const { entries } = parseTarEntries(rawTar);
    const filesOnly = entries.filter((e) => !e.isDir);
    const totalSize = filesOnly.reduce((s, e) => s + e.size, 0);
    // Attribute overall gzip compression ratio proportionally across entries
    const ratio = totalSize > 0 ? Math.min(1, bytes.byteLength / totalSize) : 1;
    for (const e of entries) {
      e.compressedSize = Math.round(e.size * ratio);
    }
    return { totalSize, compressedTotal: bytes.byteLength, entries };
  }

  const cdEntries = listZipCentralDirectory(bytes);
  if (cdEntries) {
    const filesOnly = cdEntries.filter((e) => !e.isDir);
    return {
      totalSize: filesOnly.reduce((s, e) => s + e.size, 0),
      compressedTotal: filesOnly.reduce((s, e) => s + e.compressedSize, 0),
      entries: cdEntries,
    };
  }

  // Fallback for zip64 / unusual streams via fflate unzipSync filter
  const fallback: ArchiveEntryInfo[] = [];
  unzipSync(bytes, {
    filter(file) {
      const isDir = file.name.endsWith('/');
      fallback.push({
        path: isDir ? file.name.slice(0, -1) : file.name,
        isDir,
        size: file.originalSize ?? file.size,
        compressedSize: file.size,
      });
      return false;
    },
  });
  const filesOnly = fallback.filter((e) => !e.isDir);
  return {
    totalSize: filesOnly.reduce((s, e) => s + e.size, 0),
    compressedTotal: filesOnly.reduce((s, e) => s + e.compressedSize, 0),
    entries: fallback,
  };
}

export function extractArchiveEntryBytes(bytes: Uint8Array, fileName: string, entryPath: string): Uint8Array | undefined {
  if (isTarName(fileName)) {
    const rawTar = uncompressIfGzip(bytes, fileName);
    return parseTarEntries(rawTar, entryPath).payload;
  }
  const out = unzipSync(bytes, { filter: (f) => f.name === entryPath });
  return out[entryPath];
}

export function classifyArchiveEntry(
  entryPath: string,
  payload: Uint8Array,
): { kind: 'text' | 'image' | 'binary'; text?: string; mime?: string; bytes?: Uint8Array; size: number } {
  const size = payload.byteLength;
  const base = entryPath.slice(entryPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';

  if (IMAGE_MIME[ext] && ext !== 'svg') {
    return { kind: 'image', mime: IMAGE_MIME[ext], bytes: payload, size };
  }

  const knownText = TEXT_EXTS.has(ext) || /^(?:readme|license|changelog|makefile|dockerfile)/i.test(base);
  const maxTextPreview = 512 * 1024;
  if (knownText || size <= maxTextPreview) {
    const slice = payload.subarray(0, Math.min(size, maxTextPreview));
    let hasNull = false;
    for (let i = 0; i < Math.min(slice.length, 4096); i++) {
      if (slice[i] === 0) {
        hasNull = true;
        break;
      }
    }
    if (!hasNull) {
      const decoded = new TextDecoder('utf-8', { fatal: false }).decode(slice);
      const suffix = size > maxTextPreview ? `\n\n… [Truncated at 512 KB of ${(size / 1024).toFixed(1)} KB]` : '';
      return { kind: 'text', text: decoded + suffix, size };
    }
  }

  return { kind: 'binary', size };
}
