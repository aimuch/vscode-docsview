// Host-side Version Diff orchestrator for Word (.docx), PowerPoint (.pptx), Excel (.xlsx/.xlsm), CSV & JSONL.
// Compares the current document against either its latest Version History snapshot or a user-selected file.
import * as vscode from 'vscode';
import { buildParagraphDiff, buildSheetsDiff, type DocumentDiffReport } from '../common/docDiff';
import { parseCsv } from './csv/csvParser';
import { listVersions } from './history';
import { JsonlSession } from './jsonl/jsonlSession';
import { parentUri, t } from './webviewHtml';

async function pickBaseBytes(
  uri: vscode.Uri,
  fromHistory: boolean | undefined,
  filters: Record<string, string[]>,
): Promise<{ label: string; bytes: Uint8Array } | undefined> {
  if (fromHistory) {
    const versions = await listVersions(uri);
    if (!versions.length) {
      void vscode.window.showInformationMessage(t('historyEmpty'));
      return undefined;
    }
    const latest = versions[0];
    const bytes = await vscode.workspace.fs.readFile(latest.uri);
    return { label: new Date(latest.time).toLocaleString(), bytes };
  }
  const picked = await vscode.window.showOpenDialog({
    defaultUri: parentUri(uri),
    canSelectMany: false,
    filters,
  });
  if (!picked?.[0]) {
    return undefined;
  }
  const bytes = await vscode.workspace.fs.readFile(picked[0]);
  const name = picked[0].path.slice(picked[0].path.lastIndexOf('/') + 1);
  return { label: name, bytes };
}

export async function compareOfficeDocument(
  uri: vscode.Uri,
  format: 'docx' | 'pptx',
  currentBytes: Uint8Array,
  fromHistory?: boolean,
): Promise<DocumentDiffReport | undefined> {
  const base = await pickBaseBytes(
    uri,
    fromHistory,
    format === 'docx' ? { Word: ['docx'] } : { PowerPoint: ['pptx'] },
  );
  if (!base) return undefined;
  const currentName = uri.path.slice(uri.path.lastIndexOf('/') + 1);
  if (format === 'docx') {
    const { inspectDocx } = await import('./office');
    const prev = inspectDocx(base.bytes).paragraphs;
    const curr = inspectDocx(currentBytes).paragraphs;
    return buildParagraphDiff(base.label, currentName, prev, curr);
  }
  const { inspectPptx } = await import('./office');
  const flatten = (bytes: Uint8Array) => {
    const info = inspectPptx(bytes);
    const lines: string[] = [];
    info.shapes.forEach((shapes, sIdx) => {
      shapes.forEach((txt, shIdx) => {
        if (txt.trim()) lines.push(`[Slide ${sIdx + 1} · #${shIdx + 1}] ${txt.trim()}`);
      });
      const note = info.notes[sIdx]?.trim();
      if (note) lines.push(`[Slide ${sIdx + 1} · Notes] ${note}`);
    });
    return lines;
  };
  return buildParagraphDiff(base.label, currentName, flatten(base.bytes), flatten(currentBytes));
}

export async function compareExcelDocument(
  uri: vscode.Uri,
  currentBytes: Uint8Array,
  fromHistory?: boolean,
): Promise<DocumentDiffReport | undefined> {
  const base = await pickBaseBytes(uri, fromHistory, { Spreadsheets: ['xlsx', 'xlsm', 'xls', 'ods'] });
  if (!base) return undefined;
  const currentName = uri.path.slice(uri.path.lastIndexOf('/') + 1);
  const { ExcelSession } = await import('./spreadsheet');
  const [prevSess, currSess] = await Promise.all([
    ExcelSession.open(base.bytes, base.label),
    ExcelSession.open(currentBytes, currentName),
  ]);
  const extract = (sess: Awaited<ReturnType<typeof ExcelSession.open>>) =>
    sess.info.sheets.map((_, idx) => {
      const m = sess.sheet(idx)!;
      return {
        name: m.name,
        rows: m.rows.map((row) =>
          row.map((c) => (c == null ? '' : typeof c === 'string' ? c : c.v)),
        ),
      };
    });
  return buildSheetsDiff(base.label, currentName, extract(prevSess), extract(currSess));
}

export async function compareDelimitedDocument(
  uri: vscode.Uri,
  kind: 'csv' | 'jsonl',
  currentText: string,
  delimiter: string,
  fromHistory?: boolean,
): Promise<DocumentDiffReport | undefined> {
  const base = await pickBaseBytes(
    uri,
    fromHistory,
    kind === 'jsonl' ? { JSONL: ['jsonl', 'ndjson'] } : { CSV: ['csv', 'tsv'] },
  );
  if (!base) return undefined;
  const currentName = uri.path.slice(uri.path.lastIndexOf('/') + 1);
  const baseText = new TextDecoder().decode(base.bytes);
  if (kind === 'jsonl') {
    const s1 = new JsonlSession(base.label);
    s1.setText(baseText);
    const s2 = new JsonlSession(currentName);
    s2.setText(currentText);
    return buildSheetsDiff(
      base.label,
      currentName,
      [{ name: currentName, rows: s1.exportRows() }],
      [{ name: currentName, rows: s2.exportRows() }],
    );
  }
  const r1 = parseCsv(baseText, delimiter).map((rec) => rec.cells);
  const r2 = parseCsv(currentText, delimiter).map((rec) => rec.cells);
  return buildSheetsDiff(
    base.label,
    currentName,
    [{ name: currentName, rows: r1 }],
    [{ name: currentName, rows: r2 }],
  );
}
