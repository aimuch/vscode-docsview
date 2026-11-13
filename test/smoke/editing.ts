// Smoke checks for what the toolbar and grid ask the extension to do: switching to the
// text editor, and editing, undoing and saving CSV and xlsx files. Messages are delivered
// through the extension's test hook exactly as the webview would post them.
import ExcelJS from 'exceljs';
import { unzipSync } from 'fflate';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ViewerKind, WebviewMessage } from '../../src/common/protocol';

export interface ViewerStatus {
  uri: vscode.Uri;
  kind: string;
  ok: boolean;
  detail?: string;
}

export interface Api {
  onViewerStatus: vscode.Event<ViewerStatus>;
  testing: { dispatch(uri: vscode.Uri, message: WebviewMessage, kind?: ViewerKind): number };
}

export interface Result {
  file: string;
  viewType: string;
  ok: boolean;
  detail?: string;
}

const TIMEOUT_MS = 45_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, test: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

function tabs(uri: vscode.Uri): { text: vscode.Tab[]; custom: vscode.Tab[] } {
  const key = uri.toString();
  const all = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
  return {
    text: all.filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === key),
    custom: all.filter((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.toString() === key),
  };
}

/** Opens `uri` with a DocsView editor and waits until its webview has rendered. */
async function open(api: Api, uri: vscode.Uri, viewType: string): Promise<ViewerStatus> {
  const status = new Promise<ViewerStatus>((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`${viewType}: no render status`));
    }, TIMEOUT_MS);
    const subscription = api.onViewerStatus((s) => {
      if (s.uri.toString() === uri.toString()) {
        clearTimeout(timer);
        subscription.dispose();
        resolve(s);
      }
    });
  });
  await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
  return status;
}

function send(api: Api, uri: vscode.Uri, message: WebviewMessage, kind: ViewerKind): void {
  if (!api.testing.dispatch(uri, message, kind)) {
    throw new Error(`no open ${kind} view for ${uri.fsPath}`);
  }
}

async function check(results: Result[], name: string, viewType: string, body: () => Promise<string>) {
  try {
    results.push({ file: name, viewType, ok: true, detail: await body() });
  } catch (err) {
    results.push({ file: name, viewType, ok: false, detail: err instanceof Error ? err.message : String(err) });
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
}

export async function runEditingChecks(api: Api, samples: string, work: string, results: Result[]): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  // ------------------------------------------------------------ preview / split / source

  await check(results, 'markdown: split, preview, source buttons', 'docsview.markdown', async () => {
    const uri = vscode.Uri.file(join(samples, 'demo.md'));
    await open(api, uri, 'docsview.markdown');

    send(api, uri, { type: 'showSource', beside: true }, 'markdown');
    await waitFor('text editor beside the preview', () => {
      const { text, custom } = tabs(uri);
      return text.length === 1 && custom.length === 1 && text[0].group !== custom[0].group;
    });

    send(api, uri, { type: 'closeSource' }, 'markdown');
    await waitFor('text editor closed, preview kept', () => {
      const { text, custom } = tabs(uri);
      return text.length === 0 && custom.length === 1;
    });

    send(api, uri, { type: 'showSource', beside: false }, 'markdown');
    await waitFor('text editor in the preview group', () => {
      const { text, custom } = tabs(uri);
      const active = vscode.window.tabGroups.activeTabGroup.activeTab;
      return text.length === 1 && custom.length === 1 && text[0].group === custom[0].group && active === text[0];
    });

    // From the text editor, the title-bar buttons bring the preview back.
    const previewActive = () => {
      const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return active instanceof vscode.TabInputCustom && active.uri.toString() === uri.toString();
    };
    await vscode.commands.executeCommand('docsview.showPreview');
    await waitFor('"open preview" switches back to the preview', previewActive);

    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    await vscode.commands.executeCommand('docsview.showPreviewToSide');
    await waitFor('"open preview to the side" shows the preview', previewActive);
    return 'split opens beside, preview closes it, source opens in place, title-bar buttons switch back';
  });

  await check(results, 'csv: text button', 'docsview.csv', async () => {
    const uri = vscode.Uri.file(join(samples, 'people.csv'));
    await open(api, uri, 'docsview.csv');
    send(api, uri, { type: 'showSource', beside: false }, 'sheet');
    await waitFor('csv text editor active', () => {
      const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return active instanceof vscode.TabInputText && active.uri.toString() === uri.toString();
    });
    return 'opens the text editor';
  });

  // ------------------------------------------------------------ CSV edit / undo / save / reopen

  await check(results, 'csv: edit, undo, insert row, save, reopen', 'docsview.csv', async () => {
    const path = join(work, 'people.csv');
    copyFileSync(join(samples, 'people.csv'), path);
    const uri = vscode.Uri.file(path);
    await open(api, uri, 'docsview.csv');
    const doc = await vscode.workspace.openTextDocument(uri);
    const original = doc.getText();

    send(api, uri, { type: 'edit', index: 0, changes: [{ r: 1, c: 1, text: '研发,一部' }] }, 'sheet');
    await waitFor('cell edit applied to the document', () => doc.isDirty && doc.getText() !== original);
    const edited = doc.getText();
    if (!edited.split('\n')[1].startsWith('张伟,"研发,一部",北京')) {
      throw new Error(`unexpected row after edit: ${edited.split('\n')[1]}`);
    }
    if (edited.split('\n').slice(2).join('\n') !== original.split('\n').slice(2).join('\n')) {
      throw new Error('edit touched other rows');
    }

    await vscode.commands.executeCommand('undo');
    await waitFor('undo restores the text', () => doc.getText() === original);

    send(api, uri, { type: 'edit', index: 0, changes: [{ r: 1, c: 1, text: '研发,一部' }] }, 'sheet');
    await waitFor('edit re-applied', () => doc.getText() === edited);
    send(api, uri, { type: 'structure', index: 0, op: 'insertRow', at: 3, count: 1 }, 'sheet');
    await waitFor('row inserted', () => doc.getText().split('\n').length === edited.split('\n').length + 1);

    await vscode.commands.executeCommand('workbench.action.files.save');
    await waitFor('saved', () => !doc.isDirty);
    const onDisk = readFileSync(path, 'utf8');
    if (onDisk !== doc.getText()) {
      throw new Error('file on disk differs from the document');
    }

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const reopened = await open(api, uri, 'docsview.csv');
    if (!reopened.ok || !/: 8x6$/.test(reopened.detail ?? '')) {
      throw new Error(`reopened sheet: ${reopened.detail}`);
    }
    return `saved ${onDisk.split('\n').length - 1} lines; reopened as ${reopened.detail}`;
  });

  // ------------------------------------------------------------ xlsx edit / undo / save / reopen

  await check(results, 'xlsx: edit, undo, save, reopen', 'docsview.excel', async () => {
    const path = join(work, 'report.xlsx');
    copyFileSync(join(samples, 'report.xlsx'), path);
    const uri = vscode.Uri.file(path);
    await open(api, uri, 'docsview.excel');
    const dirty = () => tabs(uri).custom[0]?.isDirty === true;

    send(api, uri, { type: 'edit', index: 0, changes: [{ r: 2, c: 2, text: '99' }] }, 'sheet');
    await waitFor('editor marked dirty', dirty);
    await vscode.commands.executeCommand('undo');
    await waitFor('undo clears the dirty state', () => !dirty());

    send(
      api,
      uri,
      {
        type: 'edit',
        index: 0,
        changes: [
          { r: 2, c: 2, text: '20' }, // C3: quantity, feeds the D3 formula
          { r: 4, c: 0, text: '机械键盘 Pro' }, // A5: text
          { r: 12, c: 1, text: '0.5' }, // B13: percentage-formatted number
        ],
      },
      'sheet',
    );
    await waitFor('editor marked dirty', dirty);
    await vscode.commands.executeCommand('workbench.action.files.save');
    await waitFor('saved', () => !dirty());

    const saved = readFileSync(path);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer);
    const ws = wb.getWorksheet('销售报表')!;
    const problems: string[] = [];
    if (ws.getCell('C3').value !== 20) problems.push(`C3=${JSON.stringify(ws.getCell('C3').value)}`);
    if (ws.getCell('A5').value !== '机械键盘 Pro') problems.push(`A5=${JSON.stringify(ws.getCell('A5').value)}`);
    if (ws.getCell('B13').value !== 0.5 || ws.getCell('B13').numFmt !== '0.00%') problems.push('B13 value/format');
    if ((ws.getCell('D3').value as { formula?: string })?.formula !== 'B3*C3') problems.push('D3 formula lost');
    if (!ws.getCell('A1').font?.bold || !ws.getCell('A1').isMerged) problems.push('A1 style/merge lost');
    if (wb.worksheets.length !== 3) problems.push(`sheets=${wb.worksheets.length}`);

    // Everything except the edited sheet and the recalculation bookkeeping is byte-identical.
    const before = unzipSync(new Uint8Array(readFileSync(join(samples, 'report.xlsx'))));
    const after = unzipSync(new Uint8Array(saved));
    const allowed = new Set(['xl/worksheets/sheet1.xml', 'xl/workbook.xml', 'xl/calcChain.xml', '[Content_Types].xml']);
    for (const name of Object.keys(before)) {
      if (!allowed.has(name) && (!after[name] || !Buffer.from(before[name]).equals(Buffer.from(after[name])))) {
        problems.push(`changed: ${name}`);
      }
    }
    if (problems.length) {
      throw new Error(problems.join('; '));
    }

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const reopened = await open(api, uri, 'docsview.excel');
    if (!reopened.ok) {
      throw new Error(`reopen: ${reopened.detail}`);
    }
    return `values, formats, formula, merge and untouched parts verified; reopened as ${reopened.detail}`;
  });
}
