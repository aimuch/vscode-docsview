import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from '../../common/protocol';
import { configureWebview, debounce, handleCommonMessage, parentUri, t, onWebviewMessage } from '../webviewHtml';
import { ExcelSession } from './excelSession';

function baseName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

class ExcelDocument implements vscode.CustomDocument {
  /** Set when the file could not be parsed; shown in the editor instead of a grid. */
  loadError: string | undefined;
  session: ExcelSession | undefined;
  /** Our own writes trigger the file watcher too; ignore events until this time. */
  ignoreWatcherUntil = 0;
  post: (message: HostMessage) => void = () => undefined;

  constructor(readonly uri: vscode.Uri) {}

  dispose(): void {
    this.session = undefined;
  }
}

/**
 * Spreadsheet editor. xlsx/xlsm cells can be edited (VS Code's undo/redo/save drive the
 * ExcelSession); xls/ods open read-only.
 */
export class ExcelEditorProvider implements vscode.CustomEditorProvider<ExcelDocument> {
  static readonly viewType = 'docsview.excel';

  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<ExcelDocument>>();
  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private async load(document: ExcelDocument, source: vscode.Uri = document.uri): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(source);
      if (document.session) {
        await document.session.load(bytes);
      } else {
        document.session = await ExcelSession.open(bytes, baseName(document.uri));
      }
      document.loadError = undefined;
    } catch (err) {
      document.session = undefined;
      document.loadError = t('loadFailed', err instanceof Error ? err.message : String(err));
    }
  }

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<ExcelDocument> {
    const document = new ExcelDocument(uri);
    await this.load(document);
    if (openContext.backupId && document.session) {
      try {
        const backup = await vscode.workspace.fs.readFile(vscode.Uri.parse(openContext.backupId));
        document.session.restore(Buffer.from(backup).toString('utf8'));
      } catch {
        // A missing or unreadable backup just means there is nothing to restore.
      }
    }
    return document;
  }

  resolveCustomEditor(document: ExcelDocument, panel: vscode.WebviewPanel): void {
    const post = (message: HostMessage) => void panel.webview.postMessage(message);
    document.post = post;

    const sendWorkbook = () => {
      if (document.session) {
        post({ type: 'workbook', info: document.session.info, active: 0 });
      } else {
        post({ type: 'error', message: document.loadError ?? t('loadFailed', '') });
      }
    };

    const disposables: vscode.Disposable[] = [
      onWebviewMessage(panel.webview, (message: WebviewMessage) => {
        const session = document.session;
        handleCommonMessage(panel.webview, document.uri, 'sheet', message);
        switch (message.type) {
          case 'ready':
            sendWorkbook();
            break;
          case 'getSheet': {
            const model = session?.sheet(message.index);
            if (model) {
              post({ type: 'sheet', index: message.index, model });
            }
            break;
          }
          case 'edit': {
            const result = session?.edit(message.index, message.changes);
            if (!result) {
              // Rejected (read-only cell or no-op): put the webview back in sync.
              const model = session?.sheet(message.index);
              if (model) {
                post({ type: 'sheet', index: message.index, model });
              }
              break;
            }
            post(result.message);
            this.changeEmitter.fire({
              document,
              label: 'Edit cells',
              undo: () => document.post(result.undo()),
              redo: () => document.post(result.redo()),
            });
            break;
          }
        }
      }),
    ];

    // Reload when another program rewrites the file, unless that would drop unsaved edits.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(parentUri(document.uri), baseName(document.uri)),
    );
    const reload = debounce(async () => {
      if (Date.now() < document.ignoreWatcherUntil || document.session?.dirty) {
        return;
      }
      await this.load(document);
      sendWorkbook();
    }, 400);
    disposables.push(watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload));

    panel.onDidDispose(() => {
      disposables.forEach((d) => d.dispose());
      document.post = () => undefined;
    });
    configureWebview(panel, this.context.extensionUri, 'sheet', { documentUri: document.uri });
  }

  async saveCustomDocument(document: ExcelDocument): Promise<void> {
    const session = document.session;
    if (!session) {
      return;
    }
    const bytes = session.export();
    document.ignoreWatcherUntil = Date.now() + 2000;
    await vscode.workspace.fs.writeFile(document.uri, bytes);
    session.markSaved(bytes);
  }

  async saveCustomDocumentAs(document: ExcelDocument, destination: vscode.Uri): Promise<void> {
    if (document.session) {
      await vscode.workspace.fs.writeFile(destination, document.session.export());
    }
  }

  async revertCustomDocument(document: ExcelDocument): Promise<void> {
    await this.load(document);
    if (document.session) {
      document.post({ type: 'workbook', info: document.session.info, active: 0 });
    } else {
      document.post({ type: 'error', message: document.loadError ?? '' });
    }
  }

  async backupCustomDocument(
    document: ExcelDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    await vscode.workspace.fs.writeFile(
      context.destination,
      Buffer.from(document.session?.backup() ?? '[]', 'utf8'),
    );
    return {
      id: context.destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(context.destination);
        } catch {
          // Already gone.
        }
      },
    };
  }
}
