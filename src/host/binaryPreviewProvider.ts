import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from '../common/protocol';
import { saveConvertedImage } from './fileActions';
import { listVersions, snapshot } from './history';
import { ImageSession, plainU8 } from './imageSession';
import { configureWebview, debounce, handleCommonMessage, onWebviewMessage, parentUri, t } from './webviewHtml';

function stemOf(uri: vscode.Uri): string {
  const name = baseName(uri);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function baseName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

function isSvgUri(uri: vscode.Uri): boolean {
  return uri.path.toLowerCase().endsWith('.svg');
}

class ImageDocument implements vscode.CustomDocument {
  loadError: string | undefined;
  session: ImageSession | undefined;
  ignoreWatcherUntil = 0;
  diskChangedWhileDirty = false;
  post: (message: HostMessage) => void = () => undefined;

  constructor(readonly uri: vscode.Uri) {}

  get dirty(): boolean {
    return this.session?.dirty === true;
  }

  dispose(): void {
    this.session?.dispose();
    this.session = undefined;
  }
}

/**
 * Image custom editor (`docsview.image`): supports pixel coordinate & RGB/HEX loupe inspection,
 * BBox measurement, in-place cropping/rotation/flip/resize (with memory-bounded Undo/Redo, Save &
 * Version History), real-time `.svg` XML split-editor sync, and PNG/JPG/WebP/BMP/ICO conversion.
 */
export class BinaryPreviewProvider implements vscode.CustomEditorProvider<ImageDocument> {
  static readonly viewTypes = ['docsview.image'];

  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<ImageDocument>>();
  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private async load(document: ImageDocument): Promise<void> {
    try {
      const openText = isSvgUri(document.uri)
        ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === document.uri.toString())
        : undefined;
      const bytes = openText
        ? new TextEncoder().encode(openText.getText())
        : await vscode.workspace.fs.readFile(document.uri);
      if (document.session) {
        document.session.reset(bytes);
      } else {
        document.session = new ImageSession(bytes);
      }
      document.loadError = undefined;
      document.diskChangedWhileDirty = false;
    } catch (err) {
      document.session = undefined;
      document.loadError = t('loadFailed', err instanceof Error ? err.message : String(err));
    }
  }

  private sendCurrent(document: ImageDocument, post: (m: HostMessage) => void): void {
    if (document.loadError || !document.session) {
      post({ type: 'error', message: document.loadError ?? t('loadFailed', '') });
    } else {
      post({
        type: 'load',
        name: baseName(document.uri),
        bytes: plainU8(document.session.bytes),
        editable: true,
      });
    }
  }

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<ImageDocument> {
    const document = new ImageDocument(uri);
    await this.load(document);
    if (openContext.backupId && document.session) {
      try {
        const backup = await vscode.workspace.fs.readFile(vscode.Uri.parse(openContext.backupId));
        if (backup.byteLength > 0) {
          document.session.replace(backup);
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
    const key = document.uri.toString();
    const isSvg = isSvgUri(document.uri);

    const disposables: vscode.Disposable[] = [
      onWebviewMessage(panel.webview, (message: WebviewMessage) => {
        handleCommonMessage(panel.webview, document.uri, 'image', message);
        switch (message.type) {
          case 'ready':
            this.sendCurrent(document, post);
            break;
          case 'imageReplace': {
            if (!document.session || !message.bytes.byteLength) {
              break;
            }
            // If an SVG is also open in a side-by-side TextDocument, apply via WorkspaceEdit
            // so both panes stay unified without conflicting dirty states.
            if (isSvg) {
              const openText = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
              if (openText) {
                const nextText = new TextDecoder().decode(message.bytes);
                const lastLine = Math.max(0, openText.lineCount - 1);
                const fullRange = new vscode.Range(0, 0, lastLine, openText.lineAt(lastLine).text.length);
                const edit = new vscode.WorkspaceEdit();
                edit.replace(openText.uri, fullRange, nextText);
                void vscode.workspace.applyEdit(edit);
                break;
              }
            }
            const handle = document.session.replace(message.bytes);
            this.sendCurrent(document, post);
            this.changeEmitter.fire({
              document,
              label: message.label ?? 'Edit image',
              undo: () => {
                handle.undo();
                this.sendCurrent(document, document.post);
              },
              redo: () => {
                handle.redo();
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
          case 'pickCompareImage': {
            void (async () => {
              if (message.fromHistory) {
                const versions = await listVersions(document.uri);
                if (!versions.length) {
                  void vscode.window.showInformationMessage(t('historyEmpty'));
                  return;
                }
                const bytes = await vscode.workspace.fs.readFile(versions[0].uri);
                post({
                  type: 'compareImage',
                  name: new Date(versions[0].time).toLocaleString(),
                  bytes: plainU8(bytes),
                });
                return;
              }
              const picked = await vscode.window.showOpenDialog({
                defaultUri: parentUri(document.uri),
                canSelectMany: false,
                filters: { Images: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'avif', 'svg'] },
              });
              if (!picked?.[0]) {
                return;
              }
              const bytes = await vscode.workspace.fs.readFile(picked[0]);
              post({ type: 'compareImage', name: baseName(picked[0]), bytes: plainU8(bytes) });
            })().catch((err: unknown) =>
              vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err)),
            );
            break;
          }
          case 'importAnnotations': {
            void (async () => {
              const picked = await vscode.window.showOpenDialog({
                defaultUri: parentUri(document.uri),
                canSelectMany: false,
                filters: { 'Annotations (YOLO / COCO / LabelMe)': ['txt', 'json'] },
              });
              if (!picked?.[0]) {
                return;
              }
              const fileUri = picked[0];
              const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(fileUri));
              const isTxt = fileUri.path.toLowerCase().endsWith('.txt');
              let classesText: string | undefined;
              if (isTxt) {
                try {
                  const clsUri = vscode.Uri.joinPath(parentUri(fileUri), 'classes.txt');
                  classesText = new TextDecoder().decode(await vscode.workspace.fs.readFile(clsUri));
                } catch {
                  // Optional classes.txt not present.
                }
              }
              post({
                type: 'annotationsLoaded',
                format: isTxt ? 'yolo' : 'coco',
                content,
                classesText,
              });
            })().catch((err: unknown) =>
              vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err)),
            );
            break;
          }
          case 'exportAnnotations': {
            void (async () => {
              const stem = stemOf(document.uri);
              const defaultName =
                message.format === 'yolo'
                  ? `${stem}.txt`
                  : message.format === 'coco'
                    ? `${stem}.coco.json`
                    : `${stem}.json`;
              const target = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.joinPath(parentUri(document.uri), defaultName),
                filters:
                  message.format === 'yolo'
                    ? { 'YOLO Annotations': ['txt'] }
                    : { 'JSON Annotations': ['json'] },
              });
              if (!target) {
                return;
              }
              await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(message.content));
              if (message.format === 'yolo' && message.classesContent) {
                const clsUri = vscode.Uri.joinPath(parentUri(target), 'classes.txt');
                await vscode.workspace.fs.writeFile(clsUri, new TextEncoder().encode(message.classesContent));
              }
              const openLabel = t('open');
              const choice = await vscode.window.showInformationMessage(
                t('exportSaved', vscode.workspace.asRelativePath(target, false)),
                openLabel,
              );
              if (choice === openLabel) {
                await vscode.window.showTextDocument(target);
              }
            })().catch((err: unknown) =>
              vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err)),
            );
            break;
          }
        }
      }),
    ];

    if (isSvg) {
      const syncSvgFromText = debounce(() => {
        const openText = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
        if (!openText || !document.session) {
          return;
        }
        const encoded = new TextEncoder().encode(openText.getText());
        document.session.syncFromTextEditor(encoded);
        this.sendCurrent(document, post);
      }, 80);
      disposables.push(
        vscode.workspace.onDidChangeTextDocument((e) => {
          if (e.document.uri.toString() === key && e.contentChanges.length) {
            syncSvgFromText();
          }
        }),
      );
    }

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
    configureWebview(panel, this.context.extensionUri, 'image', {
      documentUri: document.uri,
      tracksSource: isSvg,
    });
  }

  async saveCustomDocument(document: ImageDocument, cancellation: vscode.CancellationToken): Promise<void> {
    if (!document.session) {
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
    await vscode.workspace.fs.writeFile(document.uri, document.session.bytes);
    document.session.markSaved();
    document.diskChangedWhileDirty = false;
  }

  async saveCustomDocumentAs(document: ImageDocument, destination: vscode.Uri): Promise<void> {
    if (document.session) {
      await vscode.workspace.fs.writeFile(destination, document.session.bytes);
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
    await vscode.workspace.fs.writeFile(context.destination, document.session?.bytes ?? new Uint8Array(0));
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
