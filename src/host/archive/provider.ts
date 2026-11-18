import * as vscode from 'vscode';
import type { ArchiveEntryInfo, HostMessage, WebviewMessage } from '../../common/protocol';
import { configureWebview, debounce, handleCommonMessage, onWebviewMessage, parentUri, t } from '../webviewHtml';

function baseName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

class ArchiveDocument implements vscode.CustomDocument {
  bytes: Uint8Array | undefined;
  summary: { totalSize: number; compressedTotal: number; entries: ArchiveEntryInfo[] } | undefined;
  loadError: string | undefined;

  constructor(readonly uri: vscode.Uri) {}

  dispose(): void {
    this.bytes = undefined;
    this.summary = undefined;
  }
}

export class ArchivePreviewProvider implements vscode.CustomReadonlyEditorProvider<ArchiveDocument> {
  static readonly viewType = 'docsview.archive';

  constructor(private readonly context: vscode.ExtensionContext) {}

  private async load(document: ArchiveDocument): Promise<void> {
    try {
      const [rawBytes, { inspectArchive }] = await Promise.all([
        vscode.workspace.fs.readFile(document.uri),
        import('../containers'),
      ]);
      const clean = rawBytes.constructor === Uint8Array ? rawBytes : new Uint8Array(rawBytes);
      document.bytes = clean;
      document.summary = inspectArchive(clean, baseName(document.uri));
      document.loadError = undefined;
    } catch (err) {
      document.bytes = undefined;
      document.summary = undefined;
      document.loadError = t('loadFailed', err instanceof Error ? err.message : String(err));
    }
  }

  async openCustomDocument(uri: vscode.Uri): Promise<ArchiveDocument> {
    const doc = new ArchiveDocument(uri);
    await this.load(doc);
    return doc;
  }

  resolveCustomEditor(document: ArchiveDocument, panel: vscode.WebviewPanel): void {
    const post = (message: HostMessage) => void panel.webview.postMessage(message);
    const archiveName = baseName(document.uri);

    const sendSummary = () => {
      if (document.summary) {
        post({
          type: 'archive',
          name: archiveName,
          totalSize: document.summary.totalSize,
          compressedTotal: document.summary.compressedTotal,
          entries: document.summary.entries,
        });
      } else {
        post({ type: 'error', message: document.loadError ?? t('loadFailed', '') });
      }
    };

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(parentUri(document.uri), archiveName),
    );
    const reload = debounce(async () => {
      await this.load(document);
      sendSummary();
    }, 300);

    const disposables: vscode.Disposable[] = [
      watcher,
      watcher.onDidChange(reload),
      watcher.onDidCreate(reload),
      onWebviewMessage(panel.webview, (message: WebviewMessage) => {
        handleCommonMessage(panel.webview, document.uri, 'archive', message);
        if (message.type === 'ready') {
          sendSummary();
          return;
        }
        if (message.type === 'previewArchiveEntry' && document.bytes) {
          const raw = document.bytes;
          void import('../containers').then(({ extractArchiveEntryBytes, classifyArchiveEntry }) => {
            const payload = extractArchiveEntryBytes(raw, archiveName, message.path);
            if (!payload) {
              return;
            }
            const info = classifyArchiveEntry(message.path, payload);
            const cleanBytes =
              info.bytes && info.bytes.constructor !== Uint8Array ? new Uint8Array(info.bytes) : info.bytes;
            post({
              type: 'archiveEntry',
              path: message.path,
              kind: info.kind,
              text: info.text,
              mime: info.mime,
              bytes: cleanBytes,
              size: info.size,
            });
          });
        } else if (message.type === 'extractArchiveEntry' && document.bytes) {
          const raw = document.bytes;
          const entryName = message.path.slice(message.path.lastIndexOf('/') + 1);
          void (async () => {
            const { extractArchiveEntryBytes } = await import('../containers');
            const payload = extractArchiveEntryBytes(raw, archiveName, message.path);
            if (!payload) {
              return;
            }
            const target = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.joinPath(parentUri(document.uri), entryName),
            });
            if (!target) {
              return;
            }
            await vscode.workspace.fs.writeFile(target, payload);
            await vscode.commands.executeCommand('vscode.open', target);
          })().catch((err: unknown) =>
            vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err)),
          );
        }
      }),
    ];
    panel.onDidDispose(() => disposables.forEach((d) => d.dispose()));
    configureWebview(panel, this.context.extensionUri, 'archive', { documentUri: document.uri });
  }
}
