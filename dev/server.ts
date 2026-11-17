// Browser harness for the webviews: serves the same HTML shell and bundles the extension
// uses, with a mock `acquireVsCodeApi` that forwards messages to this process, which
// answers using the same host-side modules as the real providers.
//
//   npm run dev   ->  http://localhost:5177/
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { basename, dirname, extname, join, normalize, relative, resolve } from 'node:path';
import {
  DEFAULT_APPEARANCE,
  DEFAULT_TOOLBAR,
  normalizeToolbarConfig,
  type Appearance,
  type HostMessage,
  type ToolbarConfig,
  type ViewerKind,
  type WebviewMessage,
} from '../src/common/protocol';
import { renderShell } from '../src/common/shell';
import type { Lang } from '../src/common/strings';
import { applyEdits } from '../src/host/csv/csvParser';
import { CsvSession } from '../src/host/csv/csvSession';
import { extractDocText } from '../src/host/doc/docExtractor';
import { ExcelSession, type EditResult } from '../src/host/excel/excelSession';
import { MarkdownRenderer } from '../src/host/markdown/renderer';
import { OfficeSession, type OfficeEditResult, type OfficeFormat } from '../src/host/office';

const root = process.cwd();
const port = Number(process.env.PORT ?? 5177);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

function kindFor(file: string): { kind: ViewerKind; engine: 'markdown' | 'csv' | 'excel' | 'office' | 'binary' | 'doc' } | undefined {
  switch (extname(file).toLowerCase()) {
    case '.md':
    case '.markdown':
      return { kind: 'markdown', engine: 'markdown' };
    case '.csv':
    case '.tsv':
      return { kind: 'sheet', engine: 'csv' };
    case '.xlsx':
    case '.xlsm':
    case '.xls':
    case '.ods':
      return { kind: 'sheet', engine: 'excel' };
    case '.docx':
      return { kind: 'docx', engine: 'office' };
    case '.doc':
      return { kind: 'text', engine: 'doc' };
    case '.pdf':
      return { kind: 'pdf', engine: 'office' };
    case '.pptx':
      return { kind: 'pptx', engine: 'office' };
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.webp':
    case '.gif':
    case '.bmp':
    case '.svg':
    case '.ico':
    case '.avif':
      return { kind: 'image', engine: 'binary' };
    default:
      return undefined;
  }
}

/** Resolves a request path inside the project, refusing anything that escapes it. */
function safePath(rel: string): string | undefined {
  const full = resolve(root, normalize(rel));
  return relative(root, full).startsWith('..') ? undefined : full;
}

// ---------------------------------------------------------------- sessions

type DevMessage = WebviewMessage | { type: 'dev-save' } | { type: 'dev-undo' } | { type: 'dev-redo' };

interface Session {
  handle(message: DevMessage): Promise<HostMessage[]>;
  text?(): string;
}

const sessions = new Map<string, Session>();
/** Stand-in for the docsview.* settings, shared by every open view like in VS Code. */
let appearance: Appearance = { ...DEFAULT_APPEARANCE };
let toolbar: ToolbarConfig = { left: [...DEFAULT_TOOLBAR.left], right: [...DEFAULT_TOOLBAR.right] };
/** Stand-in for workbench.editorAssociations: extensions DocsView opens by default. */
const defaults = new Set<string>();

function resolveLang(param: string | null): Lang {
  if (param === 'en' || param === 'zh') {
    return param;
  }
  return appearance.language === 'en' ? 'en' : 'zh';
}
const savedDir = join(root, 'out', 'dev-saved');

function createSession(file: string): Session {
  const full = safePath(file)!;
  const name = basename(full);
  const bytes = () => new Uint8Array(readFileSync(full));
  const engine = kindFor(file)!.engine;

  if (engine === 'markdown') {
    const renderer = new MarkdownRenderer();
    // Edits stay in memory: the sample file on disk is never changed by the harness.
    let source = readFileSync(full, 'utf8');
    return {
      text: () => source,
      async handle(message) {
        if (message.type === 'ready') {
          return [{ type: 'render', ...renderer.render(source), source }];
        }
        if (message.type === 'editBlock') {
          const lines = source.split('\n');
          if (lines.slice(message.start, message.end).join('\n') !== message.expected) {
            console.log('[dev] editBlock: outdated');
            return [];
          }
          lines.splice(message.start, message.end - message.start, ...message.text.split('\n'));
          source = lines.join('\n');
          return [{ type: 'render', ...renderer.render(source), source }];
        }
        return [];
      },
    };
  }

  if (engine === 'csv') {
    const session = new CsvSession(name, 'auto');
    return {
      text: () => session.currentText,
      async handle(message) {
        switch (message.type) {
          case 'ready':
            session.setText(readFileSync(full, 'utf8'));
            return [{ type: 'workbook', info: session.info, active: 0 }];
          case 'getSheet':
            return [{ type: 'sheet', index: 0, model: session.model() }];
          case 'edit':
            return [session.setText(applyEdits(session.currentText, session.editCells(message.changes)))];
          case 'structure':
            return [
              session.setText(
                applyEdits(session.currentText, session.structure(message.op, message.at, message.count)),
              ),
            ];
          case 'dev-save':
            mkdirSync(savedDir, { recursive: true });
            writeFileSync(join(savedDir, name), session.currentText);
            return [];
          default:
            return [];
        }
      },
    };
  }

  if (engine === 'excel') {
    let session: ExcelSession | undefined;
    const undoStack: EditResult[] = [];
    const redoStack: EditResult[] = [];
    return {
      async handle(message) {
        switch (message.type) {
          case 'ready':
            session = await ExcelSession.open(bytes(), name);
            return [{ type: 'workbook', info: session.info, active: 0 }];
          case 'getSheet': {
            const model = session?.sheet(message.index);
            return model ? [{ type: 'sheet', index: message.index, model }] : [];
          }
          case 'edit': {
            const result = session?.edit(message.index, message.changes);
            if (!result) {
              return [];
            }
            undoStack.push(result);
            redoStack.length = 0;
            return result.messages;
          }
          case 'structure': {
            const result = session?.structure(message.index, message.op, message.at, message.count);
            if (!result) {
              return [];
            }
            undoStack.push(result);
            redoStack.length = 0;
            return result.messages;
          }
          case 'sheetOp': {
            const result =
              message.op === 'add'
                ? session?.addSheet(message.name)
                : message.op === 'rename'
                  ? session?.renameSheet(message.index, message.name)
                  : session?.deleteSheet(message.index);
            if (!result) {
              return [];
            }
            undoStack.push(result);
            redoStack.length = 0;
            return result.messages;
          }
          case 'dev-undo': {
            const last = undoStack.pop();
            if (!last) {
              return [];
            }
            redoStack.push(last);
            return last.undo();
          }
          case 'dev-redo': {
            const next = redoStack.pop();
            if (!next) {
              return [];
            }
            undoStack.push(next);
            return next.redo();
          }
          case 'dev-save': {
            if (session) {
              const out = session.export();
              mkdirSync(savedDir, { recursive: true });
              writeFileSync(join(savedDir, name), out);
              session.markSaved(out);
            }
            return [];
          }
          default:
            return [];
        }
      },
    };
  }

  if (engine === 'office') {
    const format = kindFor(file)!.kind as OfficeFormat;
    let session: OfficeSession | undefined;
    const undoStack: OfficeEditResult[] = [];
    const redoStack: OfficeEditResult[] = [];
    return {
      async handle(message) {
        switch (message.type) {
          case 'ready':
            session = await OfficeSession.open(format, bytes(), name);
            return [session.loadMessage()];
          case 'docMutate': {
            const result = await session?.apply(message.mutation);
            if (!result) {
              return [];
            }
            undoStack.push(result);
            redoStack.length = 0;
            return [result.message];
          }
          case 'dev-undo': {
            const last = undoStack.pop();
            if (!last) {
              return [];
            }
            redoStack.push(last);
            return [last.undo()];
          }
          case 'dev-redo': {
            const next = redoStack.pop();
            if (!next) {
              return [];
            }
            undoStack.push(next);
            return [next.redo()];
          }
          case 'dev-save': {
            if (session) {
              mkdirSync(savedDir, { recursive: true });
              writeFileSync(join(savedDir, name), session.export());
              session.markSaved();
            }
            return [];
          }
          default:
            return [];
        }
      },
    };
  }

  return {
    async handle(message) {
      if (message.type !== 'ready') {
        return [];
      }
      if (engine === 'doc') {
        return [{ type: 'text', name, body: await extractDocText(bytes()) }];
      }
      return [{ type: 'load', name, bytes: bytes() }];
    },
  };
}

function encode(messages: HostMessage[]): string {
  return JSON.stringify(messages, (_key, value) =>
    value instanceof Uint8Array ? { __u8: Buffer.from(value).toString('base64') } : value,
  );
}

// ---------------------------------------------------------------- http

function listSamples(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listSamples(full, out);
    } else if (kindFor(entry)) {
      out.push(relative(root, full).split('\\').join('/'));
    }
  }
  return out;
}

function indexPage(): string {
  const samples = existsSync(join(root, 'samples')) ? listSamples(join(root, 'samples')).sort() : [];
  const rows = samples
    .map((file) => {
      const q = encodeURIComponent(file);
      return `<li><code>${file}</code> — <a href="/view?file=${q}&theme=light">light</a> · <a href="/view?file=${q}&theme=dark">dark</a> · <a href="/view?file=${q}&theme=dark&lang=en">dark/en</a></li>`;
    })
    .join('\n');
  return `<!DOCTYPE html><meta charset="utf-8"><title>DocsView dev harness</title>
<body style="font:14px/1.8 system-ui;padding:24px"><h2>DocsView dev harness</h2><ul>${rows}</ul>
<p>Run <code>npm run samples</code> if the list is empty.</p></body>`;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const send = (status: number, type: string, body: string | Buffer) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };

  try {
    if (url.pathname === '/') {
      return send(200, MIME['.html'], indexPage());
    }

    if (url.pathname === '/view') {
      const file = url.searchParams.get('file') ?? '';
      const kind = kindFor(file);
      if (!kind || !safePath(file) || !existsSync(safePath(file)!)) {
        return send(404, 'text/plain', `Unknown file: ${file}`);
      }
      const dark = url.searchParams.get('theme') === 'dark';
      const lang = resolveLang(url.searchParams.get('lang'));
      sessions.set(file, createSession(file));
      const dir = dirname(file).split('\\').join('/');
      return send(
        200,
        MIME['.html'],
        renderShell({
          config: { kind: kind.kind, assets: '/dist/webview', lang, appearance, toolbar },
          cspSource: "'self'",
          baseHref: kind.kind === 'markdown' ? `/files/${dir}/` : undefined,
          bodyClass: dark ? 'vscode-dark' : 'vscode-light',
          extraHead: `<link rel="stylesheet" href="/dev/vscode-vars.css"><script src="/dev/mock.js"></script>`,
        }),
      );
    }

    if (url.pathname === '/msg' && req.method === 'POST') {
      const file = url.searchParams.get('file') ?? '';
      const session = sessions.get(file);
      if (!session) {
        return send(404, 'text/plain', 'No session');
      }
      const message = JSON.parse(await readBody(req)) as DevMessage;
      let replies: HostMessage[];
      if (message.type === 'setAppearance') {
        const languageChanged = message.patch.language !== undefined && message.patch.language !== appearance.language;
        appearance = { ...appearance, ...message.patch };
        const out: unknown[] = [{ type: 'appearance', appearance }];
        if (languageChanged) {
          // VS Code reloads the page when the language changes; mimic that.
          out.push({ type: '__reload' });
        }
        return send(200, MIME['.json'], JSON.stringify(out));
      }
      const ext = extname(file).slice(1).toLowerCase();
      const fileState = (): HostMessage => ({
        type: 'fileState',
        isDefault: ['md', 'markdown', 'csv', 'tsv'].includes(ext) ? defaults.has(ext) : undefined,
        ext,
        history: ['md', 'markdown', 'csv', 'tsv', 'xlsx', 'xlsm', 'docx', 'pptx', 'pdf'].includes(ext),
      });
      if (message.type === 'setDefault') {
        if (message.on) {
          defaults.add(ext);
        } else {
          defaults.delete(ext);
        }
        return send(200, MIME['.json'], JSON.stringify([fileState()]));
      }
      if (message.type === 'export') {
        mkdirSync(join(root, 'out'), { recursive: true });
        writeFileSync(join(root, 'out', `dev-export.${message.format}.html`), message.html);
        console.log(`[dev] export ${message.format}: ${message.html.length} chars`);
        return send(200, MIME['.json'], '[]');
      }
      if (message.type === 'setToolbar') {
        toolbar = normalizeToolbarConfig(message.toolbar);
        return send(200, MIME['.json'], JSON.stringify([{ type: 'toolbar', toolbar }]));
      }
      if (message.type === 'openSettings' || message.type === 'openExternalApp') {
        console.log(`[dev] ${message.type}`);
        return send(200, MIME['.json'], '[]');
      }
      if (message.type === 'history' || message.type === 'convert') {
        console.log(`[dev] ${message.type}`, JSON.stringify(message));
        return send(200, MIME['.json'], '[]');
      }
      if (message.type === 'showSource' || message.type === 'closeSource') {
        console.log(`[dev] ${message.type}`, JSON.stringify(message));
        return send(200, MIME['.json'], '[]');
      }
      try {
        replies = await session.handle(message);
        if (message.type === 'ready') {
          replies.push(fileState());
        }
      } catch (err) {
        replies = [{ type: 'error', message: err instanceof Error ? (err.stack ?? err.message) : String(err) }];
      }
      return send(200, MIME['.json'], encode(replies));
    }

    if (url.pathname === '/text') {
      const session = sessions.get(url.searchParams.get('file') ?? '');
      return send(session?.text ? 200 : 404, 'text/plain; charset=utf-8', session?.text?.() ?? '');
    }

    for (const [prefix, base] of [
      ['/dist/', 'dist'],
      ['/dev/', 'dev'],
      ['/files/', '.'],
    ] as const) {
      if (url.pathname.startsWith(prefix)) {
        const full = safePath(join(base, decodeURIComponent(url.pathname.slice(prefix.length))));
        if (!full || !existsSync(full) || statSync(full).isDirectory()) {
          return send(404, 'text/plain', 'Not found');
        }
        return send(200, MIME[extname(full).toLowerCase()] ?? 'application/octet-stream', readFileSync(full));
      }
    }
    send(404, 'text/plain', 'Not found');
  } catch (err) {
    send(500, 'text/plain', err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`DocsView dev harness: http://localhost:${port}/`);
});
