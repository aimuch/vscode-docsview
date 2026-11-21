// Read-only custom editor for SQLite (.sqlite, .sqlite3, .db) and Apache Parquet (.parquet).
// Reuses the virtualized 'sheet' webview so users immediately get sorting, filtering, charts,
// pivot summaries, AI insights, and CSV/TSV/XLSX/JSONL export!
import * as vscode from 'vscode';
import type { HostMessage, SheetModel, WebviewMessage, WorkbookInfo } from '../../common/protocol';
import { saveConverted } from '../fileActions';
import { configureWebview, handleCommonMessage, onWebviewMessage, t } from '../webviewHtml';

function baseName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

function extOf(uri: vscode.Uri): string {
  const name = baseName(uri);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

class DatabaseDocument implements vscode.CustomDocument {
  info: WorkbookInfo | undefined;
  sheets: SheetModel[] = [];
  loadError: string | undefined;

  constructor(readonly uri: vscode.Uri) {}

  dispose(): void {
    this.sheets = [];
    this.info = undefined;
  }
}

export class DatabasePreviewProvider implements vscode.CustomReadonlyEditorProvider<DatabaseDocument> {
  static readonly viewType = 'docsview.database';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<DatabaseDocument> {
    const doc = new DatabaseDocument(uri);
    try {
      const [bytes, { readParquetFile, readSqliteDatabase }] = await Promise.all([
        vscode.workspace.fs.readFile(uri),
        import('../database'),
      ]);
      const name = baseName(uri);
      const ext = extOf(uri);
      if (ext === 'parquet') {
        const pq = readParquetFile(bytes);
        const rows = [pq.columns, ...pq.rows];
        const model: SheetModel = {
          name: name.replace(/\.parquet$/i, '') || 'Parquet',
          rows,
          rowCount: rows.length,
          colCount: pq.columns.length,
          frozenRows: 1,
        };
        doc.sheets = [model];
        doc.info = {
          sheets: [{ name: model.name }],
          editable: false,
          canStructure: false,
          supportsFormulas: false,
          canCompare: false,
          noticeText: pq.truncated
            ? `Showing first ${pq.rows.length.toLocaleString()} of ${pq.rowCount.toLocaleString()} rows.`
            : undefined,
        };
      } else {
        const db = readSqliteDatabase(bytes);
        if (!db.tables.length) {
          doc.sheets = [{ name: 'Empty', rows: [['(No tables found)']], rowCount: 1, colCount: 1 }];
        } else {
          doc.sheets = db.tables.map((tbl) => {
            const rows = [tbl.columns, ...tbl.rows];
            return {
              name: tbl.name,
              rows,
              rowCount: rows.length,
              colCount: Math.max(1, tbl.columns.length),
              frozenRows: 1,
            };
          });
        }
        const anyTrunc = db.tables.some((tbl) => tbl.truncated);
        const notes: string[] = [];
        if (db.isWal) notes.push('WAL mode detected: uncommitted -wal changes may not appear until checkpointed.');
        if (anyTrunc) notes.push('Large tables truncated to first 50,000 rows.');
        doc.info = {
          sheets: doc.sheets.map((s) => ({ name: s.name })),
          editable: false,
          canStructure: false,
          supportsFormulas: false,
          canCompare: false,
          noticeText: notes.length ? notes.join(' ') : undefined,
        };
      }
    } catch (err) {
      doc.loadError = t('loadFailed', err instanceof Error ? err.message : String(err));
    }
    return doc;
  }

  resolveCustomEditor(document: DatabaseDocument, panel: vscode.WebviewPanel): void {
    const post = (message: HostMessage) => void panel.webview.postMessage(message);

    const sub = onWebviewMessage(panel.webview, (message: WebviewMessage) => {
      handleCommonMessage(panel.webview, document.uri, 'sheet', message);
      switch (message.type) {
        case 'ready':
          if (document.info) {
            post({ type: 'workbook', info: document.info, active: 0 });
          } else {
            post({ type: 'error', message: document.loadError ?? t('loadFailed', '') });
          }
          break;
        case 'getSheet': {
          const model = document.sheets[message.index];
          if (model) {
            post({ type: 'sheet', index: message.index, model });
          }
          break;
        }
        case 'convert': {
          const model = document.sheets[message.index];
          if (!model) break;
          const rows = model.rows as string[][];
          const format = message.format;
          const run = async () => {
            const { rowsToDelimited, rowsToJsonl, rowsToXlsx } = await import('../spreadsheet');
            const out =
              format === 'xlsx'
                ? await rowsToXlsx(rows, model.name)
                : format === 'jsonl'
                  ? new TextEncoder().encode(rowsToJsonl(rows, '\n'))
                  : new TextEncoder().encode(rowsToDelimited(rows, format, '\n'));
            await saveConverted(document.uri, format, out);
          };
          void run().catch((err: unknown) =>
            vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err)),
          );
          break;
        }
      }
    });

    panel.onDidDispose(() => sub.dispose());
    configureWebview(panel, this.context.extensionUri, 'sheet', { documentUri: document.uri });
  }
}
