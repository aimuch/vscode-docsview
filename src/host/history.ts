// Version history: a copy of a file's previous content is kept each time it is saved,
// in the extension's global storage, so it can be compared with or restored later.
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { t } from './webviewHtml';

const KEEP = 30;
/** Skip snapshotting individual files past 25 MB so saving a huge file stays fast. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Cap total history storage across all files; oldest snapshots are pruned first. */
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const ORPHAN_TTL_MS = 7 * 24 * 3600 * 1000;
const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'csv', 'tsv', 'jsonl', 'ndjson', 'svg']);
const HISTORY_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  'xlsx',
  'xlsm',
  'docx',
  'pptx',
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'ico',
  'avif',
]);

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

async function pruneGlobalStorage(): Promise<void> {
  if (!root) {
    return;
  }
  try {
    const folders = await vscode.workspace.fs.readDirectory(root);
    const allVersions: { uri: vscode.Uri; folder: vscode.Uri; time: number; size: number }[] = [];
    let totalBytes = 0;
    const now = Date.now();

    for (const [dirName, type] of folders) {
      if (type !== vscode.FileType.Directory) {
        continue;
      }
      const folder = vscode.Uri.joinPath(root, dirName);
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(folder);
      } catch {
        continue;
      }
      // Remove stale history folders whose source file was deleted/renamed over a week ago.
      if (entries.some(([n]) => n === 'meta.json')) {
        try {
          const meta = JSON.parse(
            Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder, 'meta.json'))).toString('utf8'),
          ) as { uri?: string; updatedAt?: number };
          if (meta.uri && meta.updatedAt && now - meta.updatedAt > ORPHAN_TTL_MS) {
            try {
              await vscode.workspace.fs.stat(vscode.Uri.parse(meta.uri));
            } catch {
              await vscode.workspace.fs.delete(folder, { recursive: true });
              continue;
            }
          }
        } catch {
          // Ignore malformed metadata.
        }
      }
      for (const [name, ftype] of entries) {
        if (ftype === vscode.FileType.File && /^\d+\./.test(name)) {
          const file = vscode.Uri.joinPath(folder, name);
          try {
            const stat = await vscode.workspace.fs.stat(file);
            totalBytes += stat.size;
            allVersions.push({ uri: file, folder, time: parseInt(name, 10), size: stat.size });
          } catch {
            // File disappeared concurrently.
          }
        }
      }
    }

    if (totalBytes <= MAX_TOTAL_BYTES) {
      return;
    }
    allVersions.sort((a, b) => a.time - b.time);
    for (const item of allVersions) {
      if (totalBytes <= MAX_TOTAL_BYTES) {
        break;
      }
      try {
        await vscode.workspace.fs.delete(item.uri);
        totalBytes -= item.size;
      } catch {
        // Ignore concurrent deletion.
      }
    }
  } catch {
    // Best-effort background cleanup.
  }
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
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_FILE_BYTES) {
      return;
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    const versions = await listVersions(uri);
    if (versions[0] && versions[0].size === bytes.byteLength) {
      const latest = await vscode.workspace.fs.readFile(versions[0].uri);
      if (Buffer.from(latest).equals(Buffer.from(bytes))) {
        return;
      }
    }
    const folder = folderFor(uri);
    await vscode.workspace.fs.createDirectory(folder);
    const time = Math.max(Date.now(), (versions[0]?.time ?? 0) + 1);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, `${time}.${extension(uri)}`), bytes);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(folder, 'meta.json'),
      Buffer.from(JSON.stringify({ uri: uri.toString(), updatedAt: time }), 'utf8'),
    );
    for (const old of versions.slice(KEEP - 1)) {
      await vscode.workspace.fs.delete(old.uri);
    }
    void pruneGlobalStorage();
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
  const key = uri.toString();
  const textDirty = vscode.workspace.textDocuments.some((d) => d.uri.toString() === key && d.isDirty);
  const customDirty = vscode.window.tabGroups.all.some((g) =>
    g.tabs.some(
      (tab) => tab.isDirty && tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === key,
    ),
  );
  if (textDirty || customDirty) {
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
