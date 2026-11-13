// Runs inside a real VS Code extension host (see scripts/smoke.mjs). Opens every sample
// with its DocsView editor and waits for the webview to report that it rendered, which
// exercises what unit tests cannot: contribution points, CSP, asset URLs and workers.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

interface ViewerStatus {
  uri: vscode.Uri;
  kind: string;
  ok: boolean;
  detail?: string;
}

interface Api {
  onViewerStatus: vscode.Event<ViewerStatus>;
}

const CASES: [file: string, viewType: string][] = [
  ['demo.md', 'docsview.markdown'],
  ['people.csv', 'docsview.csv'],
  ['scores.tsv', 'docsview.csv'],
  ['report.xlsx', 'docsview.excel'],
  ['legacy.xls', 'docsview.excel'],
  ['letter.docx', 'docsview.word'],
  ['legacy.doc', 'docsview.word'],
  ['paper.pdf', 'docsview.pdf'],
  ['slides.pptx', 'docsview.pptx'],
];

const TIMEOUT_MS = 45_000;

export async function run(): Promise<void> {
  const samples = process.env.DOCSVIEW_SAMPLES;
  const resultFile = process.env.DOCSVIEW_RESULT;
  if (!samples || !resultFile) {
    throw new Error('DOCSVIEW_SAMPLES and DOCSVIEW_RESULT must be set');
  }
  const results: { file: string; viewType: string; ok: boolean; detail?: string; tab?: string }[] = [];
  try {
    const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'docsview');
    if (!extension) {
      throw new Error('docsview extension is not loaded');
    }
    const api = (await extension.activate()) as Api;

    for (const [file, viewType] of CASES) {
      const uri = vscode.Uri.file(join(samples, file));
      const status = new Promise<ViewerStatus>((resolve, reject) => {
        const timer = setTimeout(() => {
          subscription.dispose();
          reject(new Error(`no render status within ${TIMEOUT_MS / 1000}s`));
        }, TIMEOUT_MS);
        const subscription = api.onViewerStatus((s) => {
          if (s.uri.toString() === uri.toString()) {
            clearTimeout(timer);
            subscription.dispose();
            resolve(s);
          }
        });
      });
      try {
        await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
        const s = await status;
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        // The Markdown sample references a local image: it only loads if the <base> URL
        // and the webview resource roots are right.
        const imagesOk = file !== 'demo.md' || /\b1\/1 images/.test(s.detail ?? '');
        results.push({
          file,
          viewType,
          ok: s.ok && imagesOk && input instanceof vscode.TabInputCustom && input.viewType === viewType,
          detail: s.detail,
          tab: input instanceof vscode.TabInputCustom ? input.viewType : typeof input,
        });
      } catch (err) {
        status.catch(() => undefined);
        results.push({ file, viewType, ok: false, detail: err instanceof Error ? err.message : String(err) });
      }
    }

    // Changing the UI language setting must reload open previews (they re-report a render).
    {
      const uri = vscode.Uri.file(join(samples, 'demo.md'));
      const waitForStatus = (step: string) =>
        new Promise<ViewerStatus>((resolve, reject) => {
          const timer = setTimeout(() => {
            subscription.dispose();
            reject(new Error(`no render status ${step}`));
          }, TIMEOUT_MS);
          const subscription = api.onViewerStatus((s) => {
            if (s.uri.toString() === uri.toString()) {
              clearTimeout(timer);
              subscription.dispose();
              resolve(s);
            }
          });
        });
      const config = vscode.workspace.getConfiguration('docsview');
      try {
        // The preview may still be open from the first pass, in which case it is only revealed.
        await vscode.commands.executeCommand('vscode.openWith', uri, 'docsview.markdown');
        await new Promise((r) => setTimeout(r, 1500));
        const again = waitForStatus('after the language change');
        // Pick the language the profile is not already showing, so the setting really changes it.
        const target = vscode.env.language.toLowerCase().startsWith('zh') ? 'en' : 'zh-cn';
        await config.update('language', target, vscode.ConfigurationTarget.Global);
        const s = await again;
        results.push({ file: 'language switch reloads demo.md', viewType: 'docsview.markdown', ok: s.ok, detail: s.detail });
      } catch (err) {
        results.push({
          file: 'language switch reloads demo.md',
          viewType: 'docsview.markdown',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      } finally {
        await config.update('language', undefined, vscode.ConfigurationTarget.Global);
      }
    }

    // Binary formats must open in DocsView by default (priority "default"), text ones must not.
    for (const [file, expectCustom] of [
      ['report.xlsx', true],
      ['paper.pdf', true],
      ['people.csv', false],
    ] as const) {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(join(samples, file)));
      await new Promise((r) => setTimeout(r, 1500));
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      const isCustom = input instanceof vscode.TabInputCustom && input.viewType.startsWith('docsview.');
      results.push({
        file: `default editor for ${file}`,
        viewType: expectCustom ? 'docsview.*' : 'text',
        ok: isCustom === expectCustom,
        detail: input instanceof vscode.TabInputCustom ? input.viewType : input?.constructor.name,
      });
    }
  } catch (err) {
    results.push({ file: '(setup)', viewType: '', ok: false, detail: err instanceof Error ? err.stack : String(err) });
  }

  writeFileSync(resultFile, JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(`${failed.length} smoke check(s) failed: ${failed.map((f) => f.file).join(', ')}`);
  }
}
