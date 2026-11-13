import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from '../../common/protocol';
import { configureWebview, debounce, handleCommonMessage, parentUri, onWebviewMessage } from '../webviewHtml';
import { MarkdownRenderer } from './renderer';

export class MarkdownPreviewProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'docsview.markdown';

  private renderer: MarkdownRenderer | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const renderer = (this.renderer ??= new MarkdownRenderer());
    const post = (message: HostMessage) => void panel.webview.postMessage(message);
    const key = document.uri.toString();

    const update = () => post({ type: 'render', ...renderer.render(document.getText()) });
    const scheduleUpdate = debounce(update, 120);

    // Each side ignores scroll events for a moment after it was scrolled programmatically,
    // otherwise the two views chase each other.
    let ignoreEditorScrollUntil = 0;
    const scrollSync = () =>
      vscode.workspace.getConfiguration('docsview', document.uri).get<boolean>('markdown.scrollSync', true);

    const disposables: vscode.Disposable[] = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === key && e.contentChanges.length) {
          scheduleUpdate();
        }
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        if (e.textEditor.document.uri.toString() !== key || !scrollSync() || Date.now() < ignoreEditorScrollUntil) {
          return;
        }
        const first = e.visibleRanges[0];
        if (first) {
          post({ type: 'scrollTo', line: first.start.line });
        }
      }),
      onWebviewMessage(panel.webview, (message: WebviewMessage) => {
        handleCommonMessage(panel.webview, document.uri, 'markdown', message);
        switch (message.type) {
          case 'ready':
            update();
            break;
          case 'openLink':
            void this.openLink(document, message.href);
            break;
          case 'revealLine': {
            if (!scrollSync()) {
              break;
            }
            const line = Math.max(0, Math.min(document.lineCount - 1, Math.floor(message.line)));
            ignoreEditorScrollUntil = Date.now() + 400;
            for (const editor of vscode.window.visibleTextEditors) {
              if (editor.document.uri.toString() === key) {
                editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.AtTop);
              }
            }
            break;
          }
        }
      }),
    ];
    panel.onDidDispose(() => disposables.forEach((d) => d.dispose()));

    configureWebview(panel, this.context.extensionUri, 'markdown', {
      documentUri: document.uri,
      allowLocalFiles: true,
      tracksSource: true,
    });
  }

  private async openLink(document: vscode.TextDocument, href: string): Promise<void> {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      if (/^(https?|mailto):/i.test(href)) {
        await vscode.env.openExternal(vscode.Uri.parse(href, true));
      }
      return;
    }
    const pathPart = href.split('#')[0].split('?')[0];
    if (!pathPart) {
      return;
    }
    let decoded = pathPart;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      // Keep the raw path when it is not valid percent-encoding.
    }
    const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri ?? parentUri(document.uri);
    const target = decoded.startsWith('/')
      ? vscode.Uri.joinPath(root, decoded)
      : vscode.Uri.joinPath(parentUri(document.uri), decoded);
    try {
      await vscode.workspace.fs.stat(target);
      await vscode.commands.executeCommand('vscode.open', target);
    } catch {
      void vscode.window.showWarningMessage(`DocsView: ${decoded}`);
    }
  }
}
