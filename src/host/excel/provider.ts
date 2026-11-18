import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from '../../common/protocol';
import { saveConverted } from '../fileActions';
import { snapshot } from '../history';
import { configureWebview, debounce, handleCommonMessage, parentUri, t, onWebviewMessage } from '../webviewHtml';
import type { ExcelSession } from './excelSession';

function baseName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

class ExcelDocument implements vscode.CustomDocument {
  /** Set when the file could not be parsed; shown in the editor instead of a grid. */
  loadError: string | undefined;
  session: ExcelSession | undefined;
  /** Our own writes trigger the file watcher too; ignore events until this time. */
  ignoreWatcherUntil = 0;
  /** True when another process rewrote the file while this session had unsaved edits. */
  diskChangedWhileDirty = false;
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
      const [bytes, { ExcelSession: Session }] = await Promise.all([
        vscode.workspace.fs.readFile(source),
        import('../spreadsheet'),
      ]);
      if (document.session) {
        await document.session.load(bytes);
      } else {
        document.session = await Session.open(bytes, baseName(document.uri));
      }
      document.loadError = undefined;
      document.diskChangedWhileDirty = false;
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
          case 'convert': {
            if (!session) {
              break;
            }
            const format = message.format;
            const run = async () => {
              const { workbookToDelimited, workbookToJsonl, workbookToXlsx } = await import('../spreadsheet');
              const bytes = session.export();
              const out =
                format === 'xlsx'
                  ? workbookToXlsx(bytes)
                  : format === 'jsonl'
                    ? new TextEncoder().encode(workbookToJsonl(bytes, message.index))
                    : new TextEncoder().encode(workbookToDelimited(bytes, message.index, format));
              await saveConverted(document.uri, format, out);
            };
            void run().catch((err: unknown) =>
              vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err)),
            );
            break;
          }
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
            result.messages.forEach(post);
            this.changeEmitter.fire({
              document,
              label: 'Edit cells',
              undo: () => result.undo().forEach((m) => document.post(m)),
              redo: () => result.redo().forEach((m) => document.post(m)),
            });
            break;
          }
          case 'structure': {
            const result = session?.structure(message.index, message.op, message.at, message.count);
            if (!result) {
              break;
            }
            result.messages.forEach(post);
            this.changeEmitter.fire({
              document,
              label: message.op,
              undo: () => result.undo().forEach((m) => document.post(m)),
              redo: () => result.redo().forEach((m) => document.post(m)),
            });
            break;
          }
          case 'sheetOp': {
            const result =
              message.op === 'add'
                ? session?.addSheet(message.name)
                : message.op === 'rename'
                  ? session?.renameSheet(message.index, message.name)
                  : session?.deleteSheet(message.index);
            if (!result) {
              break;
            }
            result.messages.forEach(post);
            this.changeEmitter.fire({
              document,
              label: `Sheet: ${message.op}`,
              undo: () => result.undo().forEach((m) => document.post(m)),
              redo: () => result.redo().forEach((m) => document.post(m)),
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
      if (Date.now() < document.ignoreWatcherUntil) {
        return;
      }
      if (document.session?.dirty) {
        if (!document.diskChangedWhileDirty) {
          document.diskChangedWhileDirty = true;
          void vscode.window.showWarningMessage(t('saveConflict'));
        }
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

  async saveCustomDocument(document: ExcelDocument, cancellation: vscode.CancellationToken): Promise<void> {
    const session = document.session;
    if (!session) {
      return;
    }
    if (document.diskChangedWhileDirty) {
      const saveLabel = t('save');
      const choice = await vscode.window.showWarningMessage(t('saveConflict'), { modal: true }, saveLabel);
      if (choice !== saveLabel || cancellation.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
    }
    const bytes = session.export();
    // Keep the previous file as a version before it is overwritten.
    await snapshot(document.uri);
    document.ignoreWatcherUntil = Date.now() + 2000;
    await vscode.workspace.fs.writeFile(document.uri, bytes);
    session.markSaved(bytes);
    document.diskChangedWhileDirty = false;
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
