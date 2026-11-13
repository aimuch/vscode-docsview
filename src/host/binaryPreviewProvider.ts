import * as vscode from 'vscode';
import type { HostMessage, ViewerKind, WebviewMessage } from '../common/protocol';
import { extractDocText } from './doc/docExtractor';
import { configureWebview, debounce, handleCommonMessage, parentUri, t } from './webviewHtml';

function baseName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

function kindFor(uri: vscode.Uri): ViewerKind {
  const ext = uri.path.slice(uri.path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'pdf':
      return 'pdf';
    case 'pptx':
      return 'pptx';
    case 'doc':
      return 'text';
    default:
      return 'docx';
  }
}

/**
 * Read-only previews (docx / doc / pdf / pptx). The host only ships bytes (or extracted
 * text for .doc); rendering happens in the webview. Reloads when the file changes on disk.
 */
export class BinaryPreviewProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewTypes = ['docsview.word', 'docsview.pdf', 'docsview.pptx'];

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const { uri } = document;
    const kind = kindFor(uri);
    const post = (message: HostMessage) => void panel.webview.postMessage(message);

    const send = async () => {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (kind === 'text') {
          post({ type: 'text', name: baseName(uri), body: await extractDocText(bytes) });
        } else {
          // readFile yields a Node Buffer, which webview.postMessage would JSON-encode
          // (arriving as an object, not bytes). A plain Uint8Array is transferred as binary.
          const plain = new Uint8Array(bytes.byteLength);
          plain.set(bytes);
          post({ type: 'load', name: baseName(uri), bytes: plain });
        }
      } catch (err) {
        post({ type: 'error', message: t('loadFailed', err instanceof Error ? err.message : String(err)) });
      }
    };

    const disposables: vscode.Disposable[] = [];
    disposables.push(
      panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        handleCommonMessage(panel.webview, uri, kind, message);
        if (message.type === 'ready') {
          void send();
        }
      }),
    );

    // Office apps save via temp-file + rename, which surfaces as create/delete, so watch all three.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(parentUri(uri), baseName(uri)),
    );
    const reload = debounce(() => void send(), 300);
    disposables.push(watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload));

    panel.onDidDispose(() => disposables.forEach((d) => d.dispose()));
    configureWebview(panel, this.context.extensionUri, kind, { documentUri: uri });
  }
}
