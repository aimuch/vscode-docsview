import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from '../common/protocol';
import { saveConvertedImage } from './fileActions';
import { snapshot } from './history';
import { configureWebview, debounce, handleCommonMessage, onWebviewMessage, parentUri, t } from './webviewHtml';

function baseName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

function plainU8(bytes: Uint8Array): Uint8Array {
  if (bytes.constructor === Uint8Array) {
    return bytes;
  }
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

interface ImageStep {
  before: Uint8Array;
  after: Uint8Array;
}

class ImageDocument implements vscode.CustomDocument {
  loadError: string | undefined;
  currentBytes: Uint8Array | undefined;
  history: ImageStep[] = [];
  cursor = 0;
  savedCursor = 0;
  ignoreWatcherUntil = 0;
  diskChangedWhileDirty = false;
  post: (message: HostMessage) => void = () => undefined;

  constructor(readonly uri: vscode.Uri) {}

  get dirty(): boolean {
    return this.cursor !== this.savedCursor;
  }

  dispose(): void {
    this.currentBytes = undefined;
    this.history = [];
  }
}

/**
 * Image custom editor (`docsview.image`): supports pixel coordinate & RGB/HEX loupe inspection,
 * BBox measurement, in-place cropping (with full VS Code Undo/Redo, Save & Version History),
 * and one-click format conversion (PNG / JPG / WebP / BMP / ICO).
 */
export class BinaryPreviewProvider implements vscode.CustomEditorProvider<ImageDocument> {
  static readonly viewTypes = ['docsview.image'];

  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<ImageDocument>>();
  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private async load(document: ImageDocument): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(document.uri);
      document.currentBytes = plainU8(bytes);
      document.history = [];
      document.cursor = 0;
      document.savedCursor = 0;
      document.loadError = undefined;
      document.diskChangedWhileDirty = false;
    } catch (err) {
      document.currentBytes = undefined;
      document.loadError = t('loadFailed', err instanceof Error ? err.message : String(err));
    }
  }

  private sendCurrent(document: ImageDocument, post: (m: HostMessage) => void): void {
    if (document.loadError || !document.currentBytes) {
      post({ type: 'error', message: document.loadError ?? t('loadFailed', '') });
    } else {
      post({
        type: 'load',
        name: baseName(document.uri),
        bytes: plainU8(document.currentBytes),
        editable: true,
      });
    }
  }

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<ImageDocument> {
    const document = new ImageDocument(uri);
    await this.load(document);
    if (openContext.backupId && document.currentBytes) {
      try {
        const backup = await vscode.workspace.fs.readFile(vscode.Uri.parse(openContext.backupId));
        if (backup.byteLength > 0) {
          const after = plainU8(backup);
          document.history = [{ before: document.currentBytes, after }];
          document.cursor = 1;
          document.currentBytes = after;
        }
      } catch {
        // Missing or unreadable backup.
      }
    }
    return document;
  }

  resolveCustomEditor(document: ImageDocument, panel: vscode.WebviewPanel): void {
    const post = (message: HostMessage) => void panel.webview.postMessage(message);
    document.post = post;

    const disposables: vscode.Disposable[] = [
      onWebviewMessage(panel.webview, (message: WebviewMessage) => {
        handleCommonMessage(panel.webview, document.uri, 'image', message);
        switch (message.type) {
          case 'ready':
            this.sendCurrent(document, post);
            break;
          case 'imageReplace': {
            if (!document.currentBytes || !message.bytes.byteLength) {
              break;
            }
            const before = document.currentBytes;
            const after = plainU8(message.bytes);
            if (document.cursor < document.history.length) {
              if (document.savedCursor > document.cursor) {
                document.savedCursor = -1;
              }
              document.history.length = document.cursor;
            }
            const step: ImageStep = { before, after };
            document.history.push(step);
            document.cursor = document.history.length;
            document.currentBytes = after;
            this.sendCurrent(document, post);
            this.changeEmitter.fire({
              document,
              label: message.label ?? 'Crop image',
              undo: () => {
                if (document.cursor > 0 && document.history[document.cursor - 1] === step) {
                  document.cursor--;
                }
                document.currentBytes = step.before;
                this.sendCurrent(document, document.post);
              },
              redo: () => {
                if (document.history[document.cursor] === step) {
                  document.cursor++;
                }
                document.currentBytes = step.after;
                this.sendCurrent(document, document.post);
              },
            });
            break;
          }
          case 'saveImageAs': {
            void saveConvertedImage(document.uri, message.format, plainU8(message.bytes), message.suffix).catch(
              (err: unknown) => vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err)),
            );
            break;
          }
        }
      }),
    ];

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(parentUri(document.uri), baseName(document.uri)),
    );
    const reload = debounce(async () => {
      if (Date.now() < document.ignoreWatcherUntil) {
        return;
      }
      if (document.dirty) {
        if (!document.diskChangedWhileDirty) {
          document.diskChangedWhileDirty = true;
          void vscode.window.showWarningMessage(t('saveConflict'));
        }
        return;
      }
      await this.load(document);
      this.sendCurrent(document, post);
    }, 300);
    disposables.push(watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload));

    panel.onDidDispose(() => {
      disposables.forEach((d) => d.dispose());
      document.post = () => undefined;
    });
    configureWebview(panel, this.context.extensionUri, 'image', { documentUri: document.uri });
  }

  async saveCustomDocument(document: ImageDocument, cancellation: vscode.CancellationToken): Promise<void> {
    if (!document.currentBytes) {
      return;
    }
    if (document.diskChangedWhileDirty) {
      const saveLabel = t('save');
      const choice = await vscode.window.showWarningMessage(t('saveConflict'), { modal: true }, saveLabel);
      if (choice !== saveLabel || cancellation.isCancellationRequested) {
        throw new vscode.CancellationError();
      }
    }
    await snapshot(document.uri);
    document.ignoreWatcherUntil = Date.now() + 2000;
    await vscode.workspace.fs.writeFile(document.uri, document.currentBytes);
    document.savedCursor = document.cursor;
    document.diskChangedWhileDirty = false;
  }

  async saveCustomDocumentAs(document: ImageDocument, destination: vscode.Uri): Promise<void> {
    if (document.currentBytes) {
      await vscode.workspace.fs.writeFile(destination, document.currentBytes);
    }
  }

  async revertCustomDocument(document: ImageDocument): Promise<void> {
    await this.load(document);
    this.sendCurrent(document, document.post);
  }

  async backupCustomDocument(
    document: ImageDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    await vscode.workspace.fs.writeFile(context.destination, document.currentBytes ?? new Uint8Array(0));
    return {
      id: context.destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(context.destination);
        } catch {
          // Already removed.
        }
      },
    };
  }
}
