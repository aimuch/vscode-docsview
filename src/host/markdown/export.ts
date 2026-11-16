// Markdown export: the preview's rendered article (diagrams and formulas included) as one
// self-contained HTML file — styles, KaTeX fonts and local images inlined. "PDF" opens a
// copy in the system browser with the print dialog, where it can be saved as PDF.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ThemeId } from '../../common/protocol';
import { exportPage, inlineFonts, inlineImages, sanitizeExportHtml } from './exportPage';
import { askSaveLocation } from '../fileActions';
import { lang, parentUri, t } from '../webviewHtml';

export interface ExportRequest {
  format: 'html' | 'pdf';
  html: string;
  theme: ThemeId;
  dark: boolean;
  rtl: boolean;
}

/** Ensures a resolved resource URI stays inside one of the roots the webview itself can read. */
function isUnderAllowedRoot(target: vscode.Uri, allowedRoots: vscode.Uri[]): boolean {
  return allowedRoots.some((root) => {
    if (target.scheme !== root.scheme || target.authority !== root.authority) {
      return false;
    }
    const base = root.path.endsWith('/') ? root.path : `${root.path}/`;
    return target.path === root.path || target.path.startsWith(base);
  });
}

export async function exportMarkdown(extensionUri: vscode.Uri, docUri: vscode.Uri, request: ExportRequest): Promise<void> {
  const webviewDir = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const cssBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(webviewDir, 'markdown.css'));
  const fonts = new Map<string, Uint8Array>();
  for (const match of Buffer.from(cssBytes).toString('utf8').matchAll(/\.\/assets\/[^"')]+\.woff2/g)) {
    if (!fonts.has(match[0])) {
      try {
        fonts.set(match[0], await vscode.workspace.fs.readFile(vscode.Uri.joinPath(webviewDir, match[0])));
      } catch {
        // Missing font: the browser falls back to a system font.
      }
    }
  }
  const css = inlineFonts(Buffer.from(cssBytes).toString('utf8'), (path) => fonts.get(path));
  const docDir = parentUri(docUri);
  const wsRoot = vscode.workspace.getWorkspaceFolder(docUri)?.uri ?? docDir;
  const allowedRoots = [docDir, ...(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? [])];
  const sanitized = sanitizeExportHtml(request.html);
  const body = await inlineImages(sanitized, async (path) => {
    try {
      const resolved = path.startsWith('/')
        ? vscode.Uri.joinPath(wsRoot, path)
        : vscode.Uri.joinPath(docDir, path);
      if (!isUnderAllowedRoot(resolved, allowedRoots)) {
        return undefined;
      }
      return await vscode.workspace.fs.readFile(resolved);
    } catch {
      return undefined;
    }
  });
  const name = docUri.path.slice(docUri.path.lastIndexOf('/') + 1);
  const page = exportPage({
    ...request,
    title: name.replace(/\.[^.]+$/, ''),
    css,
    body,
    lang: lang(),
    print: request.format === 'pdf',
  });

  if (request.format === 'html') {
    const target = await askSaveLocation(docUri, 'html', 'HTML');
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(page, 'utf8'));
    const open = t('open');
    if ((await vscode.window.showInformationMessage(t('exportSaved', target.fsPath), open)) === open) {
      await vscode.env.openExternal(target);
    }
    return;
  }

  // PDF: print from the system browser, which renders it exactly like the preview.
  const file = vscode.Uri.file(join(tmpdir(), `docsview-${Date.now()}-${name.replace(/[^\w.-]+/g, '_')}.html`));
  await vscode.workspace.fs.writeFile(file, Buffer.from(page, 'utf8'));
  await vscode.env.openExternal(file);
  void vscode.window.showInformationMessage(t('pdfHint'));
}
