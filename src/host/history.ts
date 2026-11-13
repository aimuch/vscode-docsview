// Version history: a copy of a file's previous content is kept each time it is saved,
// in the extension's global storage, so it can be compared with or restored later.
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { t } from './webviewHtml';

const KEEP = 30;
const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'csv', 'tsv']);
const HISTORY_EXTENSIONS = new Set([...TEXT_EXTENSIONS, 'xlsx', 'xlsm']);

let root: vscode.Uri | undefined;

export function initHistory(storage: vscode.Uri): void {
  root = vscode.Uri.joinPath(storage, 'history');
}

function extension(uri: vscode.Uri): string {
  const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function baseName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

export function supportsHistory(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && HISTORY_EXTENSIONS.has(extension(uri));
}

function folderFor(uri: vscode.Uri): vscode.Uri {
  if (!root) {
    throw new Error('history not initialised');
  }
  const id = createHash('sha1').update(uri.toString()).digest('hex').slice(0, 16);
  return vscode.Uri.joinPath(root, id);
}

export interface Version {
  uri: vscode.Uri;
  time: number;
  size: number;
}

export async function listVersions(uri: vscode.Uri): Promise<Version[]> {
  if (!root || !supportsHistory(uri)) {
    return [];
  }
  const folder = folderFor(uri);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(folder);
  } catch {
    return [];
  }
  const versions = await Promise.all(
    entries
      .filter(([name, type]) => type === vscode.FileType.File && /^\d+\./.test(name))
      .map(async ([name]) => {
        const file = vscode.Uri.joinPath(folder, name);
        const stat = await vscode.workspace.fs.stat(file);
        return { uri: file, time: parseInt(name, 10), size: stat.size };
      }),
  );
  return versions.sort((a, b) => b.time - a.time);
}

/**
 * Keeps the current on-disk content of `uri` as a version, unless it is identical to the
 * newest one already kept. Never throws: history must not get in the way of saving.
 */
export async function snapshot(uri: vscode.Uri): Promise<void> {
  if (!root || !supportsHistory(uri)) {
    return;
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const versions = await listVersions(uri);
    if (versions[0]) {
      const latest = await vscode.workspace.fs.readFile(versions[0].uri);
      if (Buffer.from(latest).equals(Buffer.from(bytes))) {
        return;
      }
    }
    const folder = folderFor(uri);
    await vscode.workspace.fs.createDirectory(folder);
    const time = Math.max(Date.now(), (versions[0]?.time ?? 0) + 1);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, `${time}.${extension(uri)}`), bytes);
    for (const old of versions.slice(KEEP - 1)) {
      await vscode.workspace.fs.delete(old.uri);
    }
  } catch {
    // The file may not exist yet (first save) or storage may be unavailable.
  }
}

/** Snapshots Markdown/CSV files before VS Code saves them (spreadsheets snapshot in their provider). */
export function watchTextSaves(): vscode.Disposable {
  return vscode.workspace.onWillSaveTextDocument((e) => {
    if (TEXT_EXTENSIONS.has(extension(e.document.uri))) {
      e.waitUntil(snapshot(e.document.uri));
    }
  });
}

function formatTime(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatSize(size: number): string {
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}

async function restore(uri: vscode.Uri, version: Version): Promise<void> {
  if (vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString() && d.isDirty)) {
    void vscode.window.showWarningMessage(t('restoreDirty'));
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    t('restoreConfirm', formatTime(version.time)),
    { modal: true },
    t('historyRestore'),
  );
  if (choice !== t('historyRestore')) {
    return;
  }
  await snapshot(uri);
  await vscode.workspace.fs.writeFile(uri, await vscode.workspace.fs.readFile(version.uri));
  void vscode.window.showInformationMessage(t('restored', formatTime(version.time)));
}

/** Lists the kept versions of `uri` and lets the user compare, open or restore one. */
export async function showHistory(uri: vscode.Uri): Promise<void> {
  const versions = await listVersions(uri);
  if (!versions.length) {
    void vscode.window.showInformationMessage(t('historyEmpty'));
    return;
  }
  const picked = await vscode.window.showQuickPick(
    versions.map((v) => ({ label: formatTime(v.time), description: formatSize(v.size), version: v })),
    { title: t('historyTitle', baseName(uri)) },
  );
  if (!picked) {
    return;
  }
  const isText = TEXT_EXTENSIONS.has(extension(uri));
  const actions = [
    ...(isText ? [{ label: t('historyCompare'), id: 'compare' }] : []),
    { label: t('historyOpen'), id: 'open' },
    { label: t('historyRestore'), id: 'restore' },
  ];
  const action = await vscode.window.showQuickPick(actions, { title: `${baseName(uri)} · ${picked.label}` });
  switch (action?.id) {
    case 'compare':
      await vscode.commands.executeCommand(
        'vscode.diff',
        picked.version.uri,
        uri,
        `${baseName(uri)} (${picked.label}) ↔ ${baseName(uri)}`,
      );
      break;
    case 'open':
      await vscode.commands.executeCommand('vscode.open', picked.version.uri);
      break;
    case 'restore':
      await restore(uri, picked.version);
      break;
  }
}
