import * as vscode from 'vscode';
import { BinaryPreviewProvider } from './host/binaryPreviewProvider';
import { CsvEditorProvider } from './host/csv/provider';
import { ExcelEditorProvider } from './host/excel/provider';
import { MarkdownPreviewProvider } from './host/markdown/provider';
import { initHistory, listVersions, showHistory, watchTextSaves } from './host/history';
import { onViewerStatus } from './host/status';
import { dispatchToView, watchViews } from './host/webviewHtml';

/** Text formats: opened as text by default, with our preview available on demand. */
function previewViewType(uri: vscode.Uri): string | undefined {
  const path = uri.path.toLowerCase();
  if (path.endsWith('.md') || path.endsWith('.markdown')) {
    return MarkdownPreviewProvider.viewType;
  }
  if (path.endsWith('.csv') || path.endsWith('.tsv')) {
    return CsvEditorProvider.viewType;
  }
  return undefined;
}

/** Resource of the active tab, whether it is a text editor or one of our custom editors. */
function activeResource(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
    return input.uri;
  }
  return vscode.window.activeTextEditor?.document.uri;
}

export function activate(context: vscode.ExtensionContext): {
  onViewerStatus: typeof onViewerStatus;
  testing: { dispatch: typeof dispatchToView; listVersions: typeof listVersions };
} {
  // Keep the webview alive while its tab is in the background: re-parsing a large
  // workbook or PDF on every tab switch would be far more expensive.
  const webviewOptions = { retainContextWhenHidden: true };

  initHistory(context.globalStorageUri);
  const binary = new BinaryPreviewProvider(context);
  context.subscriptions.push(
    ...watchViews(),
    watchTextSaves(),
    ...BinaryPreviewProvider.viewTypes.map((viewType) =>
      vscode.window.registerCustomEditorProvider(viewType, binary, {
        webviewOptions,
        supportsMultipleEditorsPerDocument: true,
      }),
    ),
    vscode.window.registerCustomEditorProvider(MarkdownPreviewProvider.viewType, new MarkdownPreviewProvider(context), {
      webviewOptions,
    }),
    vscode.window.registerCustomEditorProvider(CsvEditorProvider.viewType, new CsvEditorProvider(context), {
      webviewOptions,
    }),
    vscode.window.registerCustomEditorProvider(ExcelEditorProvider.viewType, new ExcelEditorProvider(context), {
      webviewOptions,
      supportsMultipleEditorsPerDocument: false,
    }),
  );

  const open = (column: vscode.ViewColumn) => async (uri?: vscode.Uri) => {
    const target = uri ?? activeResource();
    const viewType = target && previewViewType(target);
    if (target && viewType) {
      await vscode.commands.executeCommand('vscode.openWith', target, viewType, column);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('docsview.showPreview', open(vscode.ViewColumn.Active)),
    vscode.commands.registerCommand('docsview.showPreviewToSide', open(vscode.ViewColumn.Beside)),
    vscode.commands.registerCommand('docsview.showHistory', async (uri?: vscode.Uri) => {
      const target = uri ?? activeResource();
      if (target) {
        await showHistory(target);
      }
    }),
    vscode.commands.registerCommand('docsview.showSource', async (uri?: vscode.Uri) => {
      const target = uri ?? activeResource();
      if (target) {
        await vscode.commands.executeCommand('vscode.openWith', target, 'default');
      }
    }),
  );

  // Lets tests (and other tooling) observe when a document has actually rendered.
  return { onViewerStatus, testing: { dispatch: dispatchToView, listVersions } };
}

export function deactivate(): void {
  // Nothing to clean up: everything is registered on context.subscriptions.
}
