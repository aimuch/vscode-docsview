// Built-in Audio & Video Media Player (MP3/WAV/OGG/M4A/FLAC, MP4/WebM/MOV).
// Streams media directly via webview.asWebviewUri (zero base64 memory bloat) and supports
// capturing video frames straight into DocsView's Image Inspector.
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from '../../common/protocol';
import { configureWebview, handleCommonMessage, onWebviewMessage, toSafeUint8Array } from '../webviewHtml';

const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v']);
const capturedTempUris = new Set<vscode.Uri>();

export async function cleanupMediaTempFiles(): Promise<void> {
  const list = [...capturedTempUris];
  capturedTempUris.clear();
  await Promise.all(
    list.map(async (u) => {
      try {
        await vscode.workspace.fs.delete(u);
      } catch {
        // Already gone.
      }
    }),
  );
}

function baseName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

function extOf(uri: vscode.Uri): string {
  const name = baseName(uri);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

class MediaDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri) {}
  dispose(): void {
    // Nothing to clean up.
  }
}

export class MediaPreviewProvider implements vscode.CustomReadonlyEditorProvider<MediaDocument> {
  static readonly viewType = 'docsview.media';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<MediaDocument> {
    return new MediaDocument(uri);
  }

  resolveCustomEditor(document: MediaDocument, panel: vscode.WebviewPanel): void {
    const post = (message: HostMessage) => void panel.webview.postMessage(message);

    const sub = onWebviewMessage(panel.webview, (message: WebviewMessage) => {
      handleCommonMessage(panel.webview, document.uri, 'media', message);
      if (message.type === 'ready') {
        void (async () => {
          let size = 0;
          try {
            const stat = await vscode.workspace.fs.stat(document.uri);
            size = stat.size;
          } catch {
            // ignore stat error
          }
          const src = panel.webview.asWebviewUri(document.uri).toString();
          const ext = extOf(document.uri);
          const mediaKind = VIDEO_EXTS.has(ext) ? 'video' : 'audio';
          post({ type: 'media', name: baseName(document.uri), src, mediaKind, ext, byteLength: size });
        })();
      } else if (message.type === 'openCapturedImage') {
        void (async () => {
          const safe = (message.suffix || 'frame').replace(/[^a-zA-Z0-9._-]/g, '_');
          const outUri = vscode.Uri.file(path.join(os.tmpdir(), `docsview-${Date.now()}-${safe}.png`));
          const bytes = toSafeUint8Array(message.bytes);
          if (!bytes.byteLength) {
            return;
          }
          capturedTempUris.add(outUri);
          await vscode.workspace.fs.writeFile(outUri, bytes);
          await vscode.commands.executeCommand('vscode.openWith', outUri, 'docsview.image');
        })().catch((err: unknown) =>
          vscode.window.showErrorMessage(String(err instanceof Error ? err.message : err)),
        );
      }
    });

    panel.onDidDispose(() => sub.dispose());
    configureWebview(panel, this.context.extensionUri, 'media', {
      documentUri: document.uri,
      allowLocalFiles: true,
    });
  }
}
