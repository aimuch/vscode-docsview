import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from '../../common/protocol';
import type { TextEdit } from '../csv/csvParser';
import { saveConverted } from '../fileActions';
import { configureWebview, debounce, handleCommonMessage, onWebviewMessage, parentUri, t } from '../webviewHtml';
import { JsonlSession } from './jsonlSession';

const MAX_CHARS = 40 * 1024 * 1024;

export class JsonlEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'docsview.jsonl';

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const name = document.uri.path.slice(document.uri.path.lastIndexOf('/') + 1);
    const eol = () => (document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
    const session = new JsonlSession(name, eol());
    const post = (message: HostMessage) => void panel.webview.postMessage(message);
    const key = document.uri.toString();

    let syncedVersion = -1;
    let webviewReady = false;

    const sync = () => {
      if (syncedVersion === document.version) {
        return;
      }
      syncedVersion = document.version;
      const message = session.setText(document.getText(), eol());
      if (webviewReady) {
        post(message);
      }
    };
    const scheduleSync = debounce(sync, 50);

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

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(parentUri(document.uri), name),
    );
    const scheduleDiskSync = debounce(async () => {
      if (!webviewReady || document.isDirty) {
        return;
      }
      try {
        const diskText = new TextDecoder().decode(await vscode.workspace.fs.readFile(document.uri));
        if (diskText !== session.currentText) {
          post(session.setText(diskText, eol()));
        }
      } catch {
        // ignore transient errors
      }
    }, 120);

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
            post({ type: 'workbook', info: session.info, active: 0 });
            break;
          }
          case 'getSheet':
            post({ type: 'sheet', index: 0, model: session.model() });
            break;
          case 'edit': {
            sync();
            const res = session.editCells(message.changes);
            if (res.hadInvalidJson) {
              void vscode.window.showWarningMessage(t('jsonlInvalidJson'));
            }
            void apply(res.edits);
            break;
          }
          case 'editJsonlRecord': {
            sync();
            const edits = session.replaceRecordJson(message.recordIndex, message.jsonText);
            if (!edits) {
              void vscode.window.showWarningMessage(t('jsonlInvalidJson'));
              break;
            }
            void apply(edits);
            break;
          }
          case 'structure':
            sync();
            void apply(session.structure(message.op, message.at, message.count));
            break;
          case 'convert': {
            sync();
            const rows = session.exportRows();
            const format = message.format;
            const currentEol = eol();
            if (format === 'jsonl') {
              break;
            }
            const run = async () => {
              const { rowsToDelimited, rowsToXlsx } = await import('../spreadsheet');
              const bytes =
                format === 'xlsx'
                  ? await rowsToXlsx(rows, name)
                  : new TextEncoder().encode(rowsToDelimited(rows, format, currentEol));
              await saveConverted(document.uri, format, bytes);
            };
            void run().catch((err: unknown) =>
              vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err)),
            );
            break;
          }
        }
      }),
    ];
    panel.onDidDispose(() => disposables.forEach((d) => d.dispose()));
    configureWebview(panel, this.context.extensionUri, 'sheet', { documentUri: document.uri, tracksSource: true });
  }
}
