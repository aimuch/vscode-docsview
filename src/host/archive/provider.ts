import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ArchiveEntryInfo, HostMessage, WebviewMessage } from '../../common/protocol';
import { configureWebview, debounce, handleCommonMessage, onWebviewMessage, parentUri, t } from '../webviewHtml';

function baseName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

function archiveStem(name: string): string {
  return name.replace(/\.(?:tar\.gz|tgz|tar|zip|vsix|whl|jar|apk|nupkg)$/i, '') || 'extracted';
}

class ArchiveDocument implements vscode.CustomDocument {
  bytes: Uint8Array | undefined;
  uncompressedTar: Uint8Array | undefined;
  summary: { totalSize: number; compressedTotal: number; entries: ArchiveEntryInfo[] } | undefined;
  loadError: string | undefined;
  tempDir: vscode.Uri | undefined;

  constructor(readonly uri: vscode.Uri) {}

  ensureTempDir(): vscode.Uri {
    this.tempDir ??= vscode.Uri.file(join(tmpdir(), `docsview-arc-${randomBytes(6).toString('hex')}`));
    return this.tempDir;
  }

  dispose(): void {
    this.bytes = undefined;
    this.uncompressedTar = undefined;
    this.summary = undefined;
    if (this.tempDir) {
      const dir = this.tempDir;
      this.tempDir = undefined;
      void vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false }).then(undefined, () => undefined);
    }
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
      const inspected = inspectArchive(clean, baseName(document.uri));
      document.bytes = clean;
      document.uncompressedTar = inspected.uncompressedTar;
      document.summary = {
        totalSize: inspected.totalSize,
        compressedTotal: inspected.compressedTotal,
        entries: inspected.entries,
      };
      document.loadError = undefined;
    } catch (err) {
      document.bytes = undefined;
      document.uncompressedTar = undefined;
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
          const cachedTar = document.uncompressedTar;
          const declaredSize = document.summary?.entries.find((e) => e.path === message.path)?.size ?? 0;
          void import('../containers')
            .then(({ extractArchiveEntryBytes, classifyArchiveEntry, MAX_PREVIEW_ENTRY_BYTES }) => {
              if (declaredSize > MAX_PREVIEW_ENTRY_BYTES) {
                post({ type: 'archiveEntry', path: message.path, kind: 'binary', size: declaredSize });
                return;
              }
              const payload = extractArchiveEntryBytes(raw, archiveName, message.path, {
                cachedTar,
                maxBytes: MAX_PREVIEW_ENTRY_BYTES,
              });
              if (!payload) {
                post({ type: 'archiveEntry', path: message.path, kind: 'binary', size: declaredSize });
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
            })
            .catch((err: unknown) =>
              vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err)),
            );
        } else if (message.type === 'openArchiveEntryTemp' && document.bytes) {
          const raw = document.bytes;
          const cachedTar = document.uncompressedTar;
          void (async () => {
            const { extractArchiveEntryBytes, sanitizeArchiveRelativePath } = await import('../containers');
            const safeRel = sanitizeArchiveRelativePath(message.path);
            if (!safeRel) return;
            const payload = extractArchiveEntryBytes(raw, archiveName, message.path, { cachedTar });
            if (!payload) return;
            const target = vscode.Uri.joinPath(document.ensureTempDir(), ...safeRel.split('/'));
            await vscode.workspace.fs.createDirectory(parentUri(target));
            await vscode.workspace.fs.writeFile(target, payload);
            await vscode.commands.executeCommand('vscode.open', target);
          })().catch((err: unknown) =>
            vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err)),
          );
        } else if (message.type === 'extractArchiveEntry' && document.bytes) {
          const raw = document.bytes;
          const cachedTar = document.uncompressedTar;
          void (async () => {
            const { extractArchiveEntryBytes, sanitizeArchiveRelativePath } = await import('../containers');
            const safeRel = sanitizeArchiveRelativePath(message.path);
            const entryName = safeRel?.split('/').pop() || 'extracted';
            const payload = extractArchiveEntryBytes(raw, archiveName, message.path, { cachedTar });
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
        } else if (message.type === 'extractAllArchive' && document.bytes) {
          const raw = document.bytes;
          const cachedTar = document.uncompressedTar;
          void (async () => {
            const picked = await vscode.window.showOpenDialog({
              defaultUri: parentUri(document.uri),
              canSelectFolders: true,
              canSelectFiles: false,
              canSelectMany: false,
            });
            if (!picked?.[0]) {
              return;
            }
            const { extractAllArchiveEntries } = await import('../containers');
            const filesMap = extractAllArchiveEntries(raw, archiveName, cachedTar);
            const destRoot = vscode.Uri.joinPath(picked[0], archiveStem(archiveName));
            await vscode.workspace.fs.createDirectory(destRoot);
            const createdDirs = new Set<string>();
            for (const [relPath, content] of filesMap) {
              const fileUri = vscode.Uri.joinPath(destRoot, ...relPath.split('/'));
              const dirKey = parentUri(fileUri).toString();
              if (!createdDirs.has(dirKey)) {
                createdDirs.add(dirKey);
                await vscode.workspace.fs.createDirectory(parentUri(fileUri));
              }
              await vscode.workspace.fs.writeFile(fileUri, content);
            }
            const openLabel = t('open');
            const choice = await vscode.window.showInformationMessage(
              t('exportSaved', vscode.workspace.asRelativePath(destRoot, false)),
              openLabel,
            );
            if (choice === openLabel) {
              await vscode.commands.executeCommand('revealFileInOS', destRoot);
            }
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
