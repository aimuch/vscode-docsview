import { userInfo } from 'node:os';
import * as vscode from 'vscode';
import type { DocMutation, HostMessage, ViewerKind, WebviewMessage } from '../../common/protocol';
import { snapshot } from '../history';
import type { OfficeEditResult, OfficeFormat, OfficeSession } from '../office';
import { configureWebview, debounce, handleCommonMessage, onWebviewMessage, parentUri, t } from '../webviewHtml';

const pendingInitialPages = new Map<string, number>();

/** Queues a 1-based page/slide number to jump to when `uri` opens or focuses (e.g. `spec.pdf#page=12`). */
export function setPendingOfficePage(uri: vscode.Uri, page: number): void {
  if (Number.isFinite(page) && page >= 1) {
    pendingInitialPages.set(uri.toString(), Math.floor(page));
  }
}

function defaultCommentAuthor(uri: vscode.Uri): string {
  const configured = vscode.workspace.getConfiguration('docsview', uri).get<string>('comments.author')?.trim();
  if (configured) {
    return configured;
  }
  try {
    const sysUser = userInfo().username?.trim();
    if (sysUser) {
      return sysUser;
    }
  } catch {
    // Restricted OS environment.
  }
  return 'DocsView';
}

function baseName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

function extOf(uri: vscode.Uri): string {
  const name = baseName(uri);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function kindForUri(uri: vscode.Uri): { kind: ViewerKind; officeFormat?: OfficeFormat } {
  switch (extOf(uri)) {
    case 'pdf':
      return { kind: 'pdf', officeFormat: 'pdf' };
    case 'pptx':
      return { kind: 'pptx', officeFormat: 'pptx' };
    case 'doc':
      return { kind: 'text' };
    default:
      return { kind: 'docx', officeFormat: 'docx' };
  }
}

class OfficeDocument implements vscode.CustomDocument {
  loadError: string | undefined;
  session: OfficeSession | undefined;
  legacyDocText: string | undefined;
  ignoreWatcherUntil = 0;
  diskChangedWhileDirty = false;
  mutationQueue: Promise<void> = Promise.resolve();
  post: (message: HostMessage) => void = () => undefined;

  constructor(
    readonly uri: vscode.Uri,
    readonly kind: ViewerKind,
    readonly officeFormat?: OfficeFormat,
  ) {}

  dispose(): void {
    this.session = undefined;
    this.legacyDocText = undefined;
  }
}

/**
 * Custom editor for Word (.docx / .doc), PDF (.pdf) and PowerPoint (.pptx).
 * Supports standard interoperable comments/annotations and in-place text editing on
 * .docx / .pptx / .pdf with full VS Code Undo/Redo, Save, Version History and Hot Exit;
 * legacy .doc opens read-only via extracted text.
 */
export class OfficeEditorProvider implements vscode.CustomEditorProvider<OfficeDocument> {
  static readonly viewTypes = ['docsview.word', 'docsview.pdf', 'docsview.pptx'] as const;

  private readonly changeEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<OfficeDocument>>();
  readonly onDidChangeCustomDocument = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private async load(document: OfficeDocument): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(document.uri);
      if (!document.officeFormat) {
        const { extractDocText } = await import('../doc/docExtractor');
        document.legacyDocText = await extractDocText(bytes);
        document.session = undefined;
      } else {
        const { OfficeSession: Session } = await import('../office');
        if (document.session) {
          await document.session.load(bytes);
        } else {
          document.session = await Session.open(document.officeFormat, bytes, baseName(document.uri));
        }
      }
      document.loadError = undefined;
      document.diskChangedWhileDirty = false;
    } catch (err) {
      document.session = undefined;
      document.legacyDocText = undefined;
      document.loadError = t('loadFailed', err instanceof Error ? err.message : String(err));
    }
  }

  private sendCurrent(document: OfficeDocument, post: (m: HostMessage) => void): void {
    const key = document.uri.toString();
    const initialPage = pendingInitialPages.get(key);
    if (initialPage !== undefined) {
      pendingInitialPages.delete(key);
    }
    if (document.loadError) {
      post({ type: 'error', message: document.loadError });
    } else if (document.session) {
      const msg = document.session.loadMessage();
      if (msg.type === 'load' && initialPage !== undefined) {
        msg.initialPage = initialPage;
      }
      post(msg);
    } else if (document.legacyDocText !== undefined) {
      post({ type: 'text', name: baseName(document.uri), body: document.legacyDocText });
    }
  }

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<OfficeDocument> {
    const { kind, officeFormat } = kindForUri(uri);
    const document = new OfficeDocument(uri, kind, officeFormat);
    await this.load(document);
    if (openContext.backupId && document.session) {
      try {
        const backup = await vscode.workspace.fs.readFile(vscode.Uri.parse(openContext.backupId));
        await document.session.restore(Buffer.from(backup).toString('utf8'));
      } catch {
        // Unreadable or absent backup.
      }
    }
    return document;
  }

  resolveCustomEditor(document: OfficeDocument, panel: vscode.WebviewPanel): void {
    const post = (message: HostMessage) => void panel.webview.postMessage(message);
    document.post = post;

    const disposables: vscode.Disposable[] = [
      onWebviewMessage(panel.webview, (message: WebviewMessage) => {
        handleCommonMessage(panel.webview, document.uri, document.kind, message);
        if (message.type === 'ready') {
          this.sendCurrent(document, post);
          return;
        }
        if (message.type === 'docMutate' && document.session) {
          const session = document.session;
          const mutation: DocMutation =
            message.mutation.kind === 'addComment' && !message.mutation.author
              ? { ...message.mutation, author: defaultCommentAuthor(document.uri) }
              : message.mutation;
          document.mutationQueue = document.mutationQueue
            .then(async () => {
              const result: OfficeEditResult | undefined = await session.apply(mutation);
              if (!result) {
                if (mutation.kind === 'editDocxParagraph' || mutation.kind === 'editPptxText') {
                  post(session.loadMessage());
                }
                return;
              }
              post(result.message);
              this.changeEmitter.fire({
                document,
                label: mutation.kind,
                undo: () => Promise.resolve(result.undo()).then((m) => document.post(m)),
                redo: () => Promise.resolve(result.redo()).then((m) => document.post(m)),
              });
            })
            .catch((err: unknown) => {
              void vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err));
            });
          return;
        }
        if (message.type === 'exportDocMarkdown' && document.session) {
          const session = document.session;
          const fmt = document.officeFormat;
          void (async () => {
            const { docxToMarkdown, pptxToMarkdown } = await import('../office');
            const md =
              fmt === 'docx'
                ? docxToMarkdown(session.export())
                : fmt === 'pptx'
                  ? pptxToMarkdown(session.export(), baseName(document.uri))
                  : '';
            if (!md) return;
            const stem = baseName(document.uri).replace(/\.[^.]+$/, '');
            const target = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.joinPath(parentUri(document.uri), `${stem}.md`),
              filters: { Markdown: ['md'] },
            });
            if (!target) return;
            await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(md));
            await vscode.commands.executeCommand('vscode.open', target);
            void vscode.window.showInformationMessage(t('exportSaved', target.fsPath));
          })().catch((err: unknown) =>
            vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err)),
          );
          return;
        }
        if (message.type === 'extractPdfPages' && document.officeFormat === 'pdf' && document.session) {
          const session = document.session;
          void (async () => {
            const spec = await vscode.window.showInputBox({
              prompt: t('pdfExtractPrompt'),
              value: `${message.currentPage}-${message.totalPages}`,
            });
            if (!spec) {
              return;
            }
            const { extractPdfPagesToBytes, parsePageRangeSpec } = await import('../office');
            const pages = parsePageRangeSpec(spec, message.totalPages);
            if (!pages.length) {
              return;
            }
            const stem = baseName(document.uri).replace(/\.pdf$/i, '');
            const target = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.joinPath(parentUri(document.uri), `${stem}-pages.pdf`),
              filters: { PDF: ['pdf'] },
            });
            if (!target) {
              return;
            }
            const outBytes = await extractPdfPagesToBytes(session.export(), pages);
            await vscode.workspace.fs.writeFile(target, outBytes);
            await vscode.commands.executeCommand('vscode.openWith', target, 'docsview.pdf');
          })().catch((err: unknown) =>
            vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err)),
          );
          return;
        }
        if (message.type === 'mergePdfs' && document.officeFormat === 'pdf' && document.session) {
          const session = document.session;
          void (async () => {
            const picked = await vscode.window.showOpenDialog({
              defaultUri: parentUri(document.uri),
              canSelectMany: true,
              filters: { PDF: ['pdf'] },
            });
            if (!picked?.length) {
              return;
            }
            for (const uri of picked) {
              const otherBytes = await vscode.workspace.fs.readFile(uri);
              document.mutationQueue = document.mutationQueue.then(async () => {
                const res = await session.apply({
                  kind: 'appendPdfBytes',
                  otherBytes: new Uint8Array(otherBytes.buffer, otherBytes.byteOffset, otherBytes.byteLength),
                  label: baseName(uri),
                });
                if (res) {
                  post(res.message);
                  this.changeEmitter.fire({
                    document,
                    label: 'Merge PDF',
                    undo: () => Promise.resolve(res.undo()).then((m) => document.post(m)),
                    redo: () => Promise.resolve(res.redo()).then((m) => document.post(m)),
                  });
                }
              });
            }
            await document.mutationQueue;
          })().catch((err: unknown) =>
            vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err)),
          );
        }
      }),
    ];

    // Office / WPS save via temp-file + rename, which surfaces as create/change.
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
      this.sendCurrent(document, post);
    }, 350);
    disposables.push(watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload));

    panel.onDidDispose(() => {
      disposables.forEach((d) => d.dispose());
      document.post = () => undefined;
    });
    configureWebview(panel, this.context.extensionUri, document.kind, { documentUri: document.uri });
  }

  async saveCustomDocument(document: OfficeDocument, cancellation: vscode.CancellationToken): Promise<void> {
    await document.mutationQueue;
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
    await snapshot(document.uri);
    document.ignoreWatcherUntil = Date.now() + 2000;
    await vscode.workspace.fs.writeFile(document.uri, bytes);
    session.markSaved();
    document.diskChangedWhileDirty = false;
  }

  async saveCustomDocumentAs(document: OfficeDocument, destination: vscode.Uri): Promise<void> {
    await document.mutationQueue;
    if (document.session) {
      await vscode.workspace.fs.writeFile(destination, document.session.export());
    }
  }

  async revertCustomDocument(document: OfficeDocument): Promise<void> {
    await document.mutationQueue;
    await this.load(document);
    this.sendCurrent(document, document.post);
  }

  async backupCustomDocument(
    document: OfficeDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    await document.mutationQueue;
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
          // Already removed.
        }
      },
    };
  }
}
