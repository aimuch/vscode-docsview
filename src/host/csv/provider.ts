import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from '../../common/protocol';
import { compareDelimitedDocument } from '../diff';
import { saveConverted } from '../fileActions';
import { configureWebview, debounce, handleCommonMessage, parentUri, t, onWebviewMessage } from '../webviewHtml';
import type { TextEdit } from './csvParser';
import { CsvSession } from './csvSession';

/** Beyond this the table view is not worth attempting (and VS Code stops syncing text at 50 MB anyway). */
const MAX_CHARS = 40 * 1024 * 1024;

/**
 * Table editor for CSV/TSV backed by the regular TextDocument: every cell edit becomes a
 * WorkspaceEdit, so undo/redo, dirty state, save, hot exit and encoding are VS Code's.
 */
export class CsvEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'docsview.csv';

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const name = document.uri.path.slice(document.uri.path.lastIndexOf('/') + 1);
    const setting = vscode.workspace.getConfiguration('docsview', document.uri).get<string>('csv.delimiter', 'auto');
    const eol = () => (document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
    const session = new CsvSession(name, setting, eol());
    let disposed = false;
    let editQueue: Promise<void> = Promise.resolve();
    const post = (message: HostMessage) => {
      if (!disposed) {
        void panel.webview.postMessage(message);
      }
    };
    const key = document.uri.toString();

    let syncedVersion = -1;
    let webviewReady = false;

    /** Brings the session (and the webview) up to date with the document. */
    const sync = () => {
      if (disposed || syncedVersion === document.version) {
        return;
      }
      syncedVersion = document.version;
      const message = session.setText(document.getText(), eol());
      if (webviewReady) {
        post(message);
      }
    };
    const scheduleSync = debounce(sync, 50);
    const scheduleDiskSync = debounce(async () => {
      if (disposed || !webviewReady || document.isDirty) {
        return;
      }
      try {
        const diskText = new TextDecoder().decode(await vscode.workspace.fs.readFile(document.uri));
        if (diskText !== session.currentText) {
          post(session.setText(diskText, eol()));
        }
      } catch {
        // ignore transient read errors
      }
    }, 120);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(parentUri(document.uri), name),
    );

    const apply = async (edits: TextEdit[]) => {
      if (!edits.length) {
        return;
      }
      const workspaceEdit = new vscode.WorkspaceEdit();
      for (const edit of edits) {
        workspaceEdit.replace(
          document.uri,
          new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
          edit.text,
        );
      }
      await vscode.workspace.applyEdit(workspaceEdit);
      sync();
    };

    const enqueueEdit = (compute: () => TextEdit[]) => {
      editQueue = editQueue
        .then(async () => {
          if (disposed) return;
          sync();
          await apply(compute());
        })
        .catch(() => undefined);
    };

    const disposables: vscode.Disposable[] = [
      watcher,
      watcher.onDidChange(scheduleDiskSync),
      watcher.onDidCreate(scheduleDiskSync),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === key && e.contentChanges.length) {
          scheduleSync();
        }
      }),
      onWebviewMessage(panel.webview, (message: WebviewMessage) => {
        handleCommonMessage(panel.webview, document.uri, 'sheet', message);
        switch (message.type) {
          case 'ready': {
            const text = document.getText();
            if (text.length > MAX_CHARS) {
              post({ type: 'error', message: t('tooLarge', Math.round(text.length / 1024 / 1024)) });
              return;
            }
            webviewReady = true;
            syncedVersion = document.version;
            session.setText(text, eol());
            // The webview answers with getSheet.
            post({ type: 'workbook', info: session.info, active: 0 });
            break;
          }
          case 'getSheet':
            post({ type: 'sheet', index: 0, model: session.model() });
            break;
          case 'edit':
            // Serialised so consecutive edits compute offsets against the latest document version.
            enqueueEdit(() => session.editCells(message.changes));
            break;
          case 'convert': {
            sync();
            const rows = session.model().rows as string[][];
            const format = message.format;
            const currentEol = eol();
            const run = async () => {
              const { rowsToDelimited, rowsToJsonl, rowsToXlsx } = await import('../spreadsheet');
              const bytes =
                format === 'xlsx'
                  ? await rowsToXlsx(rows, name)
                  : format === 'jsonl'
                    ? new TextEncoder().encode(rowsToJsonl(rows, currentEol))
                    : new TextEncoder().encode(rowsToDelimited(rows, format, currentEol));
              await saveConverted(document.uri, format, bytes);
            };
            void run().catch((err: unknown) =>
              vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err)),
            );
            break;
          }
          case 'structure':
            enqueueEdit(() => session.structure(message.op, message.at, message.count));
            break;
          case 'compareDocument': {
            sync();
            const delim = session.currentDelimiter;
            void compareDelimitedDocument(document.uri, 'csv', document.getText(), delim, message.fromHistory)
              .then((report) => {
                if (report) post({ type: 'diffReport', report });
              })
              .catch((err: unknown) =>
                vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err)),
              );
            break;
          }
        }
      }),
    ];
    panel.onDidDispose(() => {
      disposed = true;
      disposables.forEach((d) => d.dispose());
    });

    configureWebview(panel, this.context.extensionUri, 'sheet', { documentUri: document.uri, tracksSource: true });
  }
}
