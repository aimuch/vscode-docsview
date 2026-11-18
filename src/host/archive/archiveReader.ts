// Pure ZIP, VSIX/WHL/JAR & TAR/TGZ archive directory reader and safe extractor (`fflate`).
// Parses ZIP Central Directory headers in O(entries) without decompressing payload streams,
// enforces decompression size caps against zip/gzip bombs, and prevents Zip-Slip path traversal.
import { Gunzip, unzipSync } from 'fflate';
import type { ArchiveEntryInfo } from '../../common/protocol';

export const MAX_GUNZIP_BYTES = 256 * 1024 * 1024;
export const MAX_PREVIEW_ENTRY_BYTES = 32 * 1024 * 1024;
export const MAX_EXTRACT_ALL_BYTES = 512 * 1024 * 1024;

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
  'ini', 'cfg', 'conf', 'env', 'sql', 'graphql', 'svg', 'gitignore', 'vscodeignore', 'properties',
  'mf', 'pom', 'gradle', 'lock', 'dockerfile', 'makefile',
]);

export function isTarName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.tar') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz');
}

/** Sanitises an archive path into a safe relative POSIX path, or `undefined` if Zip-Slip / absolute. */
export function sanitizeArchiveRelativePath(rawPath: string): string | undefined {
  const trimmedRaw = rawPath.trim();
  if (!trimmedRaw || trimmedRaw.startsWith('/') || trimmedRaw.startsWith('\\') || /^[A-Za-z]:/.test(trimmedRaw)) {
    return undefined;
  }
  const norm = trimmedRaw.replace(/\\/g, '/');
  const parts: string[] = [];
  for (const seg of norm.split('/')) {
    const trimmed = seg.trim();
    if (!trimmed || trimmed === '.') {
      continue;
    }
    if (trimmed === '..') {
      if (parts.length === 0) {
        return undefined;
      }
      parts.pop();
      continue;
    }
    parts.push(trimmed.replace(/[\u0000-\u001f]/g, '_'));
  }
  return parts.length > 0 ? parts.join('/') : undefined;
}

/** Streams gzip decompression with a hard byte ceiling so gzip bombs cannot OOM the host. */
export function uncompressIfGzip(bytes: Uint8Array, name: string, maxBytes = MAX_GUNZIP_BYTES): Uint8Array {
  const lower = name.toLowerCase();
  const isGz =
    lower.endsWith('.gz') || lower.endsWith('.tgz') || (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b);
  if (!isGz) {
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const gz = new Gunzip((chunk) => {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error(`Uncompressed archive exceeds ${Math.round(maxBytes / (1024 * 1024))} MB safety limit.`);
    }
    chunks.push(chunk);
  });
  gz.push(bytes, true);
  if (chunks.length === 1) {
    return chunks[0];
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
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

  const utf8 = new TextDecoder('utf-8');
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
    const rawName = utf8.decode(bytes.subarray(pos + 46, pos + 46 + nameLen)).replace(/\\/g, '/');
    const isDir = rawName.endsWith('/');
    entries.push({
      path: isDir ? rawName.replace(/\/+$/, '') : rawName,
      isDir,
      size,
      compressedSize,
      mtime: dosDateTimeToIso(dosTime, dosDate),
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function parsePaxPath(payload: Uint8Array, decoder: TextDecoder): string | undefined {
  const text = decoder.decode(payload);
  for (const line of text.split('\n')) {
    const m = /^\d+\s+path=(.+)$/.exec(line);
    if (m) {
      return m[1];
    }
  }
  return undefined;
}

function parseTarEntries(
  tarBytes: Uint8Array,
  collectPayloadFor?: string,
  collectAll?: Map<string, Uint8Array>,
): { entries: ArchiveEntryInfo[]; payload?: Uint8Array } {
  const entries: ArchiveEntryInfo[] = [];
  const decoder = new TextDecoder();
  let pos = 0;
  let foundPayload: Uint8Array | undefined;
  let pendingLongName: string | undefined;

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
    const sizeOctal = readStr(124, 12);
    const size = parseInt(sizeOctal || '0', 8) || 0;
    const mtimeSec = parseInt(readStr(136, 12) || '0', 8) || 0;
    const typeFlag = header[156];
    const dataStart = pos + 512;
    const dataEnd = Math.min(tarBytes.byteLength, dataStart + size);

    // GNU LongLink ('L' = 76) or PAX extended header ('x' = 120)
    if (typeFlag === 76) {
      pendingLongName = decoder.decode(tarBytes.subarray(dataStart, dataEnd)).replace(/\0+$/, '').trim();
      pos += 512 + Math.ceil(size / 512) * 512;
      continue;
    }
    if (typeFlag === 120) {
      const paxPath = parsePaxPath(tarBytes.subarray(dataStart, dataEnd), decoder);
      if (paxPath) {
        pendingLongName = paxPath;
      }
      pos += 512 + Math.ceil(size / 512) * 512;
      continue;
    }

    const rawFull = (pendingLongName ?? (prefix ? `${prefix}/${name}` : name)).replace(/\\/g, '/').replace(/^\.\//, '');
    pendingLongName = undefined;

    // Skip global PAX ('g'=103) and symlinks/hardlinks ('2'=50, '1'=49) when extracting files
    const isSymlink = typeFlag === 50 || typeFlag === 49;
    const isDir = typeFlag === 53 /* '5' */ || rawFull.endsWith('/');
    const cleanPath = isDir ? rawFull.replace(/\/+$/, '') : rawFull;

    if (cleanPath && typeFlag !== 103 && !isSymlink) {
      const dt = mtimeSec > 0 ? new Date(mtimeSec * 1000) : undefined;
      const pad = (n: number) => String(n).padStart(2, '0');
      const mtime = dt
        ? `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`
        : undefined;
      entries.push({ path: cleanPath, isDir, size, compressedSize: size, mtime });
      if (!isDir) {
        if (collectPayloadFor && cleanPath === collectPayloadFor) {
          foundPayload = tarBytes.slice(dataStart, dataEnd);
        }
        if (collectAll) {
          const safeRel = sanitizeArchiveRelativePath(cleanPath);
          if (safeRel) {
            collectAll.set(safeRel, tarBytes.slice(dataStart, dataEnd));
          }
        }
      }
    }
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  return { entries, payload: foundPayload };
}

export function inspectArchive(
  bytes: Uint8Array,
  fileName: string,
): { totalSize: number; compressedTotal: number; entries: ArchiveEntryInfo[]; uncompressedTar?: Uint8Array } {
  if (isTarName(fileName)) {
    const rawTar = uncompressIfGzip(bytes, fileName);
    const { entries } = parseTarEntries(rawTar);
    const filesOnly = entries.filter((e) => !e.isDir);
    const totalSize = filesOnly.reduce((s, e) => s + e.size, 0);
    const ratio = totalSize > 0 ? Math.min(1, bytes.byteLength / totalSize) : 1;
    for (const e of entries) {
      e.compressedSize = Math.round(e.size * ratio);
    }
    return { totalSize, compressedTotal: bytes.byteLength, entries, uncompressedTar: rawTar };
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

  const fallback: ArchiveEntryInfo[] = [];
  unzipSync(bytes, {
    filter(file) {
      const norm = file.name.replace(/\\/g, '/');
      const isDir = norm.endsWith('/');
      fallback.push({
        path: isDir ? norm.replace(/\/+$/, '') : norm,
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

export function extractArchiveEntryBytes(
  bytes: Uint8Array,
  fileName: string,
  entryPath: string,
  opts?: { cachedTar?: Uint8Array; maxBytes?: number },
): Uint8Array | undefined {
  if (isTarName(fileName)) {
    const rawTar = opts?.cachedTar ?? uncompressIfGzip(bytes, fileName);
    const payload = parseTarEntries(rawTar, entryPath).payload;
    if (payload && opts?.maxBytes && payload.byteLength > opts.maxBytes) {
      return undefined;
    }
    return payload;
  }
  let matchedKey: string | undefined;
  const out = unzipSync(bytes, {
    filter: (f) => {
      const norm = f.name.replace(/\\/g, '/');
      if (norm === entryPath) {
        if (opts?.maxBytes && (f.originalSize ?? 0) > opts.maxBytes) {
          return false;
        }
        matchedKey = f.name;
        return true;
      }
      return false;
    },
  });
  return matchedKey ? out[matchedKey] : undefined;
}

export function extractAllArchiveEntries(
  bytes: Uint8Array,
  fileName: string,
  cachedTar?: Uint8Array,
  maxTotalBytes = MAX_EXTRACT_ALL_BYTES,
): Map<string, Uint8Array> {
  const result = new Map<string, Uint8Array>();
  if (isTarName(fileName)) {
    const rawTar = cachedTar ?? uncompressIfGzip(bytes, fileName);
    parseTarEntries(rawTar, undefined, result);
    return result;
  }
  let runningTotal = 0;
  const all = unzipSync(bytes, {
    filter(f) {
      if (f.name.endsWith('/') || f.name.endsWith('\\')) {
        return false;
      }
      runningTotal += f.originalSize ?? f.size;
      if (runningTotal > maxTotalBytes) {
        throw new Error(`Archive exceeds ${Math.round(maxTotalBytes / (1024 * 1024))} MB extraction limit.`);
      }
      return true;
    },
  });
  for (const [k, v] of Object.entries(all)) {
    const safeRel = sanitizeArchiveRelativePath(k);
    if (safeRel) {
      result.set(safeRel, v);
    }
  }
  return result;
}

export function classifyArchiveEntry(
  entryPath: string,
  payload: Uint8Array,
): { kind: 'text' | 'image' | 'binary'; text?: string; mime?: string; bytes?: Uint8Array; size: number } {
  const size = payload.byteLength;
  const base = entryPath.slice(entryPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';

  if (IMAGE_MIME[ext]) {
    return { kind: 'image', mime: IMAGE_MIME[ext], bytes: payload, size };
  }

  const knownText = TEXT_EXTS.has(ext) || /^(?:readme|license|changelog|makefile|dockerfile|manifest)/i.test(base);
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
