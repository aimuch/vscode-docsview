import * as vscode from 'vscode';
import type { ViewerKind, WebviewMessage } from '../common/protocol';

export interface ViewerStatus {
  uri: vscode.Uri;
  kind: ViewerKind;
  ok: boolean;
  detail?: string;
}

const emitter = new vscode.EventEmitter<ViewerStatus>();

/** Fires when a webview reports that it rendered (or failed to render) a document. */
export const onViewerStatus = emitter.event;

/** Forwards a webview 'status' message; other message types are ignored. */
export function reportStatus(uri: vscode.Uri, kind: ViewerKind, message: WebviewMessage): void {
  if (message.type === 'status') {
    emitter.fire({ uri, kind, ok: message.ok, detail: message.detail });
  }
}
