import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from '../../common/protocol';
import { configureWebview, debounce, handleCommonMessage, parentUri, onWebviewMessage, t } from '../webviewHtml';
import type { MarkdownRenderer } from './renderer';

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export class MarkdownPreviewProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'docsview.markdown';

  private rendererPromise: Promise<MarkdownRenderer> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private getRenderer(): Promise<MarkdownRenderer> {
    this.rendererPromise ??= import('./renderer').then((m) => new m.MarkdownRenderer());
    return this.rendererPromise;
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const post = (message: HostMessage) => void panel.webview.postMessage(message);
    const key = document.uri.toString();
    let disposed = false;

    const baseName = document.uri.path.slice(document.uri.path.lastIndexOf('/') + 1);
    let lastRenderedSource = '';
    const update = async (fromDisk = false) => {
      const renderer = await this.getRenderer();
      if (disposed) {
        return;
      }
      let source = document.getText();
      if (fromDisk && !document.isDirty) {
        try {
          source = new TextDecoder().decode(await vscode.workspace.fs.readFile(document.uri));
        } catch {
          // fall back to document.getText()
        }
      }
      if (fromDisk && source === lastRenderedSource) {
        return;
      }
      lastRenderedSource = source;
      post({ type: 'render', ...renderer.render(source), source });
    };
    const scheduleUpdate = debounce(() => void update(false), 60);
    const scheduleDiskUpdate = debounce(() => void update(true), 120);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(parentUri(document.uri), baseName),
    );

    // Each side ignores scroll events for a moment after it was scrolled programmatically,
    // otherwise the two views chase each other.
    let ignoreEditorScrollUntil = 0;
    const scrollSync = () =>
      vscode.workspace.getConfiguration('docsview', document.uri).get<boolean>('markdown.scrollSync', true);

    const disposables: vscode.Disposable[] = [
      watcher,
      watcher.onDidChange(scheduleDiskUpdate),
      watcher.onDidCreate(scheduleDiskUpdate),
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
            void update();
            break;
          case 'openLink':
            void this.openLink(document, message.href);
            break;
          case 'export':
            void import('./export')
              .then((m) => m.exportMarkdown(this.context.extensionUri, document.uri, message))
              .catch((err: unknown) => vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err)));
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
    panel.onDidDispose(() => {
      disposed = true;
      disposables.forEach((d) => d.dispose());
    });

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
    const edit = new vscode.WorkspaceEdit();
    if (text === '') {
      // Deleting the entire block: remove its line break as well so no blank gap remains.
      const deleteRange =
        lastLine + 1 < lineCount
          ? new vscode.Range(start, 0, lastLine + 1, 0)
          : start > 0
            ? new vscode.Range(start - 1, document.lineAt(start - 1).text.length, lastLine, document.lineAt(lastLine).text.length)
            : new vscode.Range(0, 0, lastLine, document.lineAt(lastLine).text.length);
      edit.delete(document.uri, deleteRange);
    } else {
      // Replace the lines' text only (not the line break after the last one). `text` carries the
      // block's own trailing blank lines, so the separation from the next block is kept.
      const range = new vscode.Range(start, 0, lastLine, document.lineAt(lastLine).text.length);
      const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
      edit.replace(document.uri, range, text.replace(/\r?\n/g, eol));
    }
    await vscode.workspace.applyEdit(edit);
  }

  private async openLink(document: vscode.TextDocument, href: string): Promise<void> {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      if (/^(https?|mailto):/i.test(href)) {
        await vscode.env.openExternal(vscode.Uri.parse(href, true));
      }
      return;
    }
    const hashAt = href.indexOf('#');
    const rawFragment = hashAt >= 0 ? href.slice(hashAt + 1) : '';
    const pathPart = (hashAt >= 0 ? href.slice(0, hashAt) : href).split('?')[0];
    if (!pathPart) {
      return;
    }
    const decoded = safeDecode(pathPart);
    const fragment = rawFragment ? safeDecode(rawFragment) : '';
    const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri ?? parentUri(document.uri);
    const target = decoded.startsWith('/')
      ? vscode.Uri.joinPath(root, decoded)
      : vscode.Uri.joinPath(parentUri(document.uri), decoded);
    try {
      await vscode.workspace.fs.stat(target);
      const lineMatch = /^L(\d+)(?:-L?(\d+))?$/i.exec(fragment);
      if (lineMatch) {
        const startLine = Math.max(0, Number(lineMatch[1]) - 1);
        const endLine = lineMatch[2] ? Math.max(startLine, Number(lineMatch[2]) - 1) : startLine;
        await vscode.commands.executeCommand('vscode.open', target, {
          selection: new vscode.Range(startLine, 0, endLine, 0),
        });
        return;
      }
      if (fragment && /\.(md|markdown)$/i.test(target.path)) {
        const renderer = await this.getRenderer();
        const targetDoc = await vscode.workspace.openTextDocument(target);
        const { toc } = renderer.render(targetDoc.getText());
        const hit = toc.find((entry) => entry.id === fragment || entry.id === fragment.toLowerCase());
        if (hit) {
          await vscode.commands.executeCommand('vscode.open', target.with({ fragment }), {
            selection: new vscode.Range(hit.line, 0, hit.line, 0),
          });
          return;
        }
      }
      await vscode.commands.executeCommand('vscode.open', fragment ? target.with({ fragment }) : target);
    } catch {
      void vscode.window.showWarningMessage(`DocsView: ${decoded}`);
    }
  }
}
