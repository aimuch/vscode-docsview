import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from '../../common/protocol';
import { configureWebview, debounce, handleCommonMessage, parentUri, onWebviewMessage, t } from '../webviewHtml';
import { exportMarkdown } from './export';
import { MarkdownRenderer } from './renderer';

export class MarkdownPreviewProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'docsview.markdown';

  private renderer: MarkdownRenderer | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const renderer = (this.renderer ??= new MarkdownRenderer());
    const post = (message: HostMessage) => void panel.webview.postMessage(message);
    const key = document.uri.toString();

    const update = () => {
      const source = document.getText();
      post({ type: 'render', ...renderer.render(source), source });
    };
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
          case 'export':
            void exportMarkdown(this.context.extensionUri, document.uri, message).catch((err: unknown) =>
              vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err)),
            );
            break;
          case 'editBlock':
            void this.editBlock(document, message.start, message.end, message.text, message.expected);
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

  /** Replaces source lines [start, end) with `text`, if they still read `expected`. */
  private async editBlock(
    document: vscode.TextDocument,
    start: number,
    end: number,
    text: string,
    expected: string,
  ): Promise<void> {
    const lineCount = document.lineCount;
    if (start < 0 || end <= start || start >= lineCount) {
      return;
    }
    const lastLine = Math.min(end, lineCount) - 1;
    const current = [];
    for (let i = start; i <= lastLine; i++) {
      current.push(document.lineAt(i).text);
    }
    if (current.join('\n') !== expected) {
      void vscode.window.showWarningMessage(t('editOutdated'));
      return;
    }
    // Replace the lines' text only (not the line break after the last one). `text` carries the
    // block's own trailing blank lines, so the separation from the next block is kept.
    const range = new vscode.Range(start, 0, lastLine, document.lineAt(lastLine).text.length);
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, range, text.replace(/\r?\n/g, eol));
    await vscode.workspace.applyEdit(edit);
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
