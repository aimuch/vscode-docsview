// Actions on the file behind a view: default editor association and saving converted /
// exported copies next to it.
import * as vscode from 'vscode';
import type { ImageExportFormat } from '../common/protocol';
import type { ConvertFormat } from './convert';
import { parentUri, t } from './webviewHtml';

/** Text formats that open as text unless the user makes DocsView their default. */
const VIEW_FOR_EXTENSION: Record<string, string> = {
  md: 'docsview.markdown',
  markdown: 'docsview.markdown',
  csv: 'docsview.csv',
  tsv: 'docsview.csv',
  jsonl: 'docsview.jsonl',
  ndjson: 'docsview.jsonl',
};

export function extensionOf(uri: vscode.Uri): string {
  const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

type Associations = Record<string, string> | { viewType: string; filenamePattern: string }[];

function associations(): Associations {
  return vscode.workspace.getConfiguration('workbench').get<Associations>('editorAssociations') ?? {};
}

/** Whether DocsView is the default editor for this file's extension; undefined when that is not configurable. */
export function isDefaultEditor(uri: vscode.Uri): boolean | undefined {
  const ext = extensionOf(uri);
  const viewType = VIEW_FOR_EXTENSION[ext];
  if (!viewType) {
    return undefined;
  }
  const current = associations();
  const pattern = `*.${ext}`;
  return Array.isArray(current)
    ? current.some((a) => a.filenamePattern === pattern && a.viewType === viewType)
    : current[pattern] === viewType;
}

/** Makes DocsView the default editor for this file's extension, or removes that association. */
export async function setDefaultEditor(uri: vscode.Uri, on: boolean): Promise<void> {
  const ext = extensionOf(uri);
  const viewType = VIEW_FOR_EXTENSION[ext];
  if (!viewType) {
    return;
  }
  const pattern = `*.${ext}`;
  const current = associations();
  // Older VS Code versions stored associations as an array; the object form replaces it.
  const next: Record<string, string> = Array.isArray(current)
    ? Object.fromEntries(current.map((a) => [a.filenamePattern, a.viewType]))
    : { ...current };
  if (on) {
    next[pattern] = viewType;
  } else if (next[pattern] === viewType) {
    delete next[pattern];
  }
  await vscode.workspace
    .getConfiguration('workbench')
    .update('editorAssociations', next, vscode.ConfigurationTarget.Global);
}

/** Asks where to save a converted/exported copy of `source`, defaulting to its folder. */
export async function askSaveLocation(source: vscode.Uri, ext: string, label: string): Promise<vscode.Uri | undefined> {
  const name = source.path.slice(source.path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  return vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(parentUri(source), `${name}.${ext}`),
    filters: { [label]: [ext] },
  });
}

/** Saves a converted copy and opens it with DocsView. */
export async function saveConverted(source: vscode.Uri, format: ConvertFormat, bytes: Uint8Array): Promise<void> {
  const target = await askSaveLocation(source, format, format.toUpperCase());
  if (!target) {
    return;
  }
  await vscode.workspace.fs.writeFile(target, bytes);
  if (format === 'xlsx') {
    await vscode.commands.executeCommand('vscode.openWith', target, 'docsview.excel');
  } else {
    await vscode.commands.executeCommand('vscode.openWith', target, 'docsview.csv');
  }
  void vscode.window.showInformationMessage(t('converted', target.fsPath));
}

/** Saves a converted or cropped image copy and opens it in the DocsView image inspector. */
export async function saveConvertedImage(
  source: vscode.Uri,
  format: ImageExportFormat,
  bytes: Uint8Array,
  suffix = '',
): Promise<void> {
  const base = source.path.slice(source.path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(parentUri(source), `${base}${suffix}.${format}`),
    filters: { [format.toUpperCase()]: [format] },
  });
  if (!target) {
    return;
  }
  await vscode.workspace.fs.writeFile(target, bytes);
  await vscode.commands.executeCommand('vscode.openWith', target, 'docsview.image');
  void vscode.window.showInformationMessage(t('converted', target.fsPath));
}
