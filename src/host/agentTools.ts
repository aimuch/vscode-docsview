// Agent Experience (AX) & programmatic inspection APIs for DocsView:
// - `docsview.getViewerState`: deterministic snapshot of open viewer finite-state machines & overlays
// - `docsview.readDocumentMarkdown`: zero-dependency binary/office/sheet/archive -> clean Markdown reader
import * as vscode from 'vscode';
import { getViewerStates, type ViewerStateSnapshot } from './status';

const DEFAULT_MAX_CHARS = 64_000;

function toUri(input: vscode.Uri | string | undefined, fallback?: vscode.Uri): vscode.Uri | undefined {
  if (input instanceof vscode.Uri) {
    return input;
  }
  if (typeof input === 'string' && input.trim()) {
    const trimmed = input.trim();
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
      return vscode.Uri.parse(trimmed);
    }
    return vscode.Uri.file(trimmed);
  }
  return fallback;
}

function extOf(uri: vscode.Uri): string {
  const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) return 'tar.gz';
  const dot = lower.lastIndexOf('.');
  return dot >= 0 ? lower.slice(dot + 1) : '';
}

function escapePipeCell(val: string): string {
  return val.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function rowsToMarkdownTable(rows: string[][], maxRows = 200): string {
  if (!rows.length) {
    return '_(empty sheet)_';
  }
  const sliced = rows.slice(0, maxRows);
  const colCount = Math.max(1, ...sliced.map((r) => r.length));
  const pad = (r: string[]) => Array.from({ length: colCount }, (_, i) => escapePipeCell(r[i] ?? ''));
  const header = pad(sliced[0]);
  const sep = header.map(() => '---');
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...sliced.slice(1).map((r) => `| ${pad(r).join(' | ')} |`),
  ];
  if (rows.length > maxRows) {
    lines.push(`\n_(showing first ${maxRows} of ${rows.length} rows)_`);
  }
  return lines.join('\n');
}

function stripSimpleHtmlToMarkdown(html: string): string {
  return html
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) => {
      const hashes = '#'.repeat(Number(lvl));
      return `\n\n${hashes} ${inner.replace(/<[^>]+>/g, '').trim()}\n\n`;
    })
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${inner.replace(/<[^>]+>/g, '').trim()}`)
    .replace(/<(?:p|div|br|tr)\b[^>]*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function readDocumentMarkdown(
  uri: vscode.Uri,
  opts: { maxChars?: number; sheetIndex?: number } = {},
): Promise<string> {
  const maxChars = Math.max(1_000, opts.maxChars ?? DEFAULT_MAX_CHARS);
  const ext = extOf(uri);
  const fileName = uri.path.slice(uri.path.lastIndexOf('/') + 1);

  const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'avif']);
  const MEDIA_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'mp4', 'webm', 'mov', 'm4v']);
  let fileSize = 0;
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    fileSize = stat.size;
  } catch {
    // Let readFile surface the real error if file doesn't exist
  }
  if (IMAGE_EXTS.has(ext) || MEDIA_EXTS.has(ext)) {
    const kindLabel = IMAGE_EXTS.has(ext) ? 'Image' : 'Audio/Video Media';
    return `# ${fileName}\n\n- Type: ${kindLabel} (.${ext})\n- Size: ${(fileSize / 1024).toFixed(1)} KB\n\n_(Binary media asset — open in DocsView to inspect or run Vision AI.)_`;
  }
  if (fileSize > 50 * 1024 * 1024) {
    throw new Error(`File "${fileName}" (${Math.round(fileSize / (1024 * 1024))} MB) exceeds the 50 MB Markdown extraction limit.`);
  }
  const bytes = await vscode.workspace.fs.readFile(uri);

  let out = '';
  switch (ext) {
    case 'md':
    case 'markdown':
    case 'csv':
    case 'tsv':
    case 'jsonl':
    case 'ndjson':
    case 'svg': {
      out = new TextDecoder().decode(bytes);
      break;
    }

    case 'docx': {
      const { docxToMarkdown } = await import('./office');
      out = docxToMarkdown(bytes);
      break;
    }

    case 'pptx': {
      const { pptxToMarkdown } = await import('./office');
      out = pptxToMarkdown(bytes, fileName);
      break;
    }

    case 'doc': {
      const { extractDocText } = await import('./doc/docExtractor');
      const text = await extractDocText(bytes);
      out = `# ${fileName}\n\n${text}`;
      break;
    }

    case 'xlsx':
    case 'xlsm':
    case 'xls':
    case 'ods': {
      const { ExcelSession } = await import('./spreadsheet');
      const session = await ExcelSession.open(bytes, fileName);
      const sheets = session.info.sheets;
      const indices =
        opts.sheetIndex !== undefined
          ? [Math.max(0, Math.min(sheets.length - 1, opts.sheetIndex))]
          : sheets.map((_, i) => i);
      const sections: string[] = [`# ${fileName}`];
      for (const idx of indices) {
        const model = session.sheet(idx);
        if (!model) continue;
        const plainRows = model.rows.map((row) =>
          row.map((c) => (c === null || c === undefined ? '' : typeof c === 'string' ? c : c.v)),
        );
        // Trim trailing completely empty rows
        while (plainRows.length > 0 && plainRows[plainRows.length - 1].every((v) => v === '')) {
          plainRows.pop();
        }
        sections.push(`## ${model.name}\n\n${rowsToMarkdownTable(plainRows)}`);
      }
      out = sections.join('\n\n');
      break;
    }

    case 'epub': {
      const { parseEpub } = await import('./containers');
      const book = parseEpub(bytes);
      const sections: string[] = [`# ${book.title || fileName}`];
      if (book.author) {
        sections.push(`_Author: ${book.author}_`);
      }
      for (const ch of book.chapters) {
        const body = stripSimpleHtmlToMarkdown(ch.html);
        if (body) {
          sections.push(`## ${ch.title}\n\n${body}`);
        }
      }
      out = sections.join('\n\n');
      break;
    }

    case 'pdf': {
      const { extractPdfTextWithMeta, inspectPdf } = await import('./office');
      const [comments, { pages, totalPages }] = await Promise.all([inspectPdf(bytes), extractPdfTextWithMeta(bytes)]);
      const lines = [`# ${fileName}`, `- Pages: ${totalPages}`, `- Annotations / comments: ${comments.length}`];
      pages.forEach((txt, idx) => {
        if (txt) {
          lines.push(`\n## Page ${idx + 1}\n\n${txt}`);
        }
      });
      if (totalPages > pages.length) {
        lines.push(`\n_(Text extracted for first ${pages.length} of ${totalPages} pages.)_`);
      }
      if (comments.length > 0) {
        lines.push('\n## Annotations');
        for (const c of comments) {
          const p = c.page ? `Page ${c.page}` : 'Document';
          const q = c.quote ? ` > "${c.quote}"` : '';
          lines.push(`- **${p}** (${c.author}): ${c.text}${q}`);
        }
      }
      out = lines.join('\n');
      break;
    }

    case 'sqlite':
    case 'sqlite3':
    case 'db': {
      const { readSqliteDatabase } = await import('./database');
      const db = readSqliteDatabase(bytes, 200);
      const sections = [`# ${fileName}`];
      for (const tbl of db.tables) {
        sections.push(`## ${tbl.name}\n\n${rowsToMarkdownTable([tbl.columns, ...tbl.rows], 200)}`);
      }
      out = sections.join('\n\n');
      break;
    }

    case 'parquet': {
      const { readParquetFile } = await import('./database');
      const pq = readParquetFile(bytes, 200);
      out = `# ${fileName}\n\n${rowsToMarkdownTable([pq.columns, ...pq.rows], 200)}`;
      break;
    }

    case 'zip':
    case 'vsix':
    case 'whl':
    case 'jar':
    case 'apk':
    case 'nupkg':
    case 'tar':
    case 'tgz':
    case 'tar.gz': {
      const { inspectArchive } = await import('./containers');
      const archive = inspectArchive(bytes, fileName);
      const files = archive.entries.filter((e) => !e.isDir);
      const lines = [
        `# ${fileName}`,
        `- Entries: ${files.length} files (${archive.totalSize} bytes uncompressed, ${archive.compressedTotal} bytes compressed)`,
        '',
        '## Contents',
        ...files.slice(0, 300).map((f) => `- \`${f.path}\` (${f.size} B)`),
      ];
      if (files.length > 300) {
        lines.push(`- _(and ${files.length - 300} more files)_`);
      }
      out = lines.join('\n');
      break;
    }

    default:
      out = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      break;
  }

  if (out.length > maxChars) {
    return `${out.slice(0, maxChars)}\n\n… [truncated at ${maxChars} chars]`;
  }
  return out;
}

export function registerAgentTools(getActiveResource: () => vscode.Uri | undefined): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      'docsview.getViewerState',
      (uriInput?: vscode.Uri | string): ViewerStateSnapshot[] => {
        const explicit = toUri(uriInput);
        if (explicit) {
          return getViewerStates(explicit);
        }
        const active = getActiveResource();
        if (active) {
          const activeStates = getViewerStates(active);
          if (activeStates.length > 0) {
            return activeStates;
          }
        }
        return getViewerStates();
      },
    ),
    vscode.commands.registerCommand(
      'docsview.readDocumentMarkdown',
      async (
        uriInput?: vscode.Uri | string,
        opts?: { maxChars?: number; sheetIndex?: number },
      ): Promise<string> => {
        const target = toUri(uriInput, getActiveResource());
        if (!target) {
          return '';
        }
        return readDocumentMarkdown(target, opts);
      },
    ),
  ];
}
