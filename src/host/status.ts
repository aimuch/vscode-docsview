import * as vscode from 'vscode';
import type { ViewerKind, WebviewMessage } from '../common/protocol';

export interface ViewerStatus {
  uri: vscode.Uri;
  kind: ViewerKind;
  ok: boolean;
  detail?: string;
  mode?: string;
  overlays?: string[];
}

export interface ViewerStateSnapshot {
  uri: string;
  kind: ViewerKind;
  ok: boolean;
  detail?: string;
  mode: string;
  overlays: string[];
  updatedAt: number;
}

const emitter = new vscode.EventEmitter<ViewerStatus>();
const latestStates = new Map<string, ViewerStateSnapshot>();

/** Fires when a webview reports that it rendered (or failed to render) a document, or changed mode/overlays. */
export const onViewerStatus = emitter.event;

/** Forwards a webview 'status' message and updates the inspectable viewer state table (AX). */
export function reportStatus(uri: vscode.Uri, kind: ViewerKind, message: WebviewMessage): void {
  if (message.type !== 'status') {
    return;
  }
  const key = uri.toString();
  const prev = latestStates.get(key);
  const snapshot: ViewerStateSnapshot = {
    uri: key,
    kind,
    ok: message.ok,
    detail: message.detail ?? prev?.detail,
    mode: message.mode ?? prev?.mode ?? 'default',
    overlays: message.overlays ?? prev?.overlays ?? [],
    updatedAt: Date.now(),
  };
  latestStates.set(key, snapshot);
  emitter.fire({
    uri,
    kind,
    ok: message.ok,
    detail: message.detail,
    mode: snapshot.mode,
    overlays: snapshot.overlays,
  });
}

export function clearViewerState(uri: vscode.Uri | undefined): void {
  if (uri) {
    latestStates.delete(uri.toString());
  }
}

export function getViewerStates(uri?: vscode.Uri): ViewerStateSnapshot[] {
  if (uri) {
    const found = latestStates.get(uri.toString());
    return found ? [found] : [];
  }
  return [...latestStates.values()];
}
