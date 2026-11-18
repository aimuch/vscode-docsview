import * as vscode from 'vscode';
import type { EpubBookData, HostMessage, WebviewMessage } from '../../common/protocol';
import { configureWebview, debounce, handleCommonMessage, onWebviewMessage, parentUri, t } from '../webviewHtml';

function baseName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

class EpubDocument implements vscode.CustomDocument {
  book: EpubBookData | undefined;
  loadError: string | undefined;

  constructor(readonly uri: vscode.Uri) {}

  dispose(): void {
    this.book = undefined;
  }
}

export class EpubPreviewProvider implements vscode.CustomReadonlyEditorProvider<EpubDocument> {
  static readonly viewType = 'docsview.epub';

  constructor(private readonly context: vscode.ExtensionContext) {}

  private async load(document: EpubDocument): Promise<void> {
    try {
      const [bytes, { parseEpub }] = await Promise.all([
        vscode.workspace.fs.readFile(document.uri),
        import('../containers'),
      ]);
      document.book = parseEpub(bytes);
      document.loadError = undefined;
    } catch (err) {
      document.book = undefined;
      document.loadError = t('loadFailed', err instanceof Error ? err.message : String(err));
    }
  }

  async openCustomDocument(uri: vscode.Uri): Promise<EpubDocument> {
    const doc = new EpubDocument(uri);
    await this.load(doc);
    return doc;
  }

  resolveCustomEditor(document: EpubDocument, panel: vscode.WebviewPanel): void {
    const post = (message: HostMessage) => void panel.webview.postMessage(message);
    const send = () => {
      if (document.book) {
        post({ type: 'epub', book: document.book });
      } else {
        post({ type: 'error', message: document.loadError ?? t('loadFailed', '') });
      }
    };

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(parentUri(document.uri), baseName(document.uri)),
    );
    const reload = debounce(async () => {
      await this.load(document);
      send();
    }, 300);

    const disposables: vscode.Disposable[] = [
      watcher,
      watcher.onDidChange(reload),
      watcher.onDidCreate(reload),
      onWebviewMessage(panel.webview, (message: WebviewMessage) => {
        handleCommonMessage(panel.webview, document.uri, 'epub', message);
        if (message.type === 'ready') {
          send();
        }
      }),
    ];
    panel.onDidDispose(() => disposables.forEach((d) => d.dispose()));
    configureWebview(panel, this.context.extensionUri, 'epub', { documentUri: document.uri });
  }
}
