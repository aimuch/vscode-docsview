import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from '../../common/protocol';
import { configureWebview, debounce, handleCommonMessage, t } from '../webviewHtml';
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
    const post = (message: HostMessage) => void panel.webview.postMessage(message);
    const key = document.uri.toString();

    let syncedVersion = -1;
    let webviewReady = false;

    /** Brings the session (and the webview) up to date with the document. */
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
    const scheduleSync = debounce(sync, 60);

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

    const disposables: vscode.Disposable[] = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === key && e.contentChanges.length) {
          scheduleSync();
        }
      }),
      panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
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
            // Offsets are only valid against the text the session last parsed.
            sync();
            void apply(session.editCells(message.changes));
            break;
          case 'structure':
            sync();
            void apply(session.structure(message.op, message.at, message.count));
            break;
        }
      }),
    ];
    panel.onDidDispose(() => disposables.forEach((d) => d.dispose()));

    configureWebview(panel, this.context.extensionUri, 'sheet', { documentUri: document.uri, tracksSource: true });
  }
}
