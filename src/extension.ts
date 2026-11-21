import * as vscode from 'vscode';
import { readDocumentMarkdown, registerAgentTools } from './host/agentTools';
import { initAiHost } from './host/ai/aiController';
import { clearAiApiKey, setAiApiKey } from './host/ai/aiProviders';
import { ArchivePreviewProvider } from './host/archive/provider';
import { BinaryPreviewProvider } from './host/binaryPreviewProvider';
import { CsvEditorProvider } from './host/csv/provider';
import { DatabasePreviewProvider } from './host/database/provider';
import { EpubPreviewProvider } from './host/epub/provider';
import { ExcelEditorProvider } from './host/excel/provider';
import { initHistory, listVersions, showHistory, watchTextSaves } from './host/history';
import { JsonlEditorProvider } from './host/jsonl/provider';
import { MarkdownPreviewProvider } from './host/markdown/provider';
import { cleanupMediaTempFiles, MediaPreviewProvider } from './host/media/provider';
import { OfficeEditorProvider } from './host/office/provider';
import { getViewerStates, onViewerStatus } from './host/status';
import {
  broadcastHostMessage,
  dispatchToView,
  openAiInActiveView,
  openSinglePreview,
  openSingleSource,
  openSplitPreview,
  watchViews,
} from './host/webviewHtml';

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
  getViewerStates: typeof getViewerStates;
  readDocumentMarkdown: typeof readDocumentMarkdown;
  testing: { dispatch: typeof dispatchToView; listVersions: typeof listVersions; setAiApiKey: typeof setAiApiKey };
} {
  // Keep the webview alive while its tab is in the background: re-parsing a large
  // workbook or PDF on every tab switch would be far more expensive.
  const webviewOptions = { retainContextWhenHidden: true };

  initHistory(context.globalStorageUri);
  const binary = new BinaryPreviewProvider(context);
  context.subscriptions.push(
    ...initAiHost(context, broadcastHostMessage),
    ...watchViews(),
    watchTextSaves(),
    ...registerAgentTools(activeResource),
    ...BinaryPreviewProvider.viewTypes.map((viewType) =>
      vscode.window.registerCustomEditorProvider(viewType, binary, {
        webviewOptions,
        supportsMultipleEditorsPerDocument: false,
      }),
    ),
    ...OfficeEditorProvider.viewTypes.map((viewType) =>
      vscode.window.registerCustomEditorProvider(viewType, new OfficeEditorProvider(context), {
        webviewOptions,
        supportsMultipleEditorsPerDocument: false,
      }),
    ),
    vscode.window.registerCustomEditorProvider(MarkdownPreviewProvider.viewType, new MarkdownPreviewProvider(context), {
      webviewOptions,
    }),
    vscode.window.registerCustomEditorProvider(CsvEditorProvider.viewType, new CsvEditorProvider(context), {
      webviewOptions,
    }),
    vscode.window.registerCustomEditorProvider(JsonlEditorProvider.viewType, new JsonlEditorProvider(context), {
      webviewOptions,
    }),
    vscode.window.registerCustomEditorProvider(EpubPreviewProvider.viewType, new EpubPreviewProvider(context), {
      webviewOptions,
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.window.registerCustomEditorProvider(ArchivePreviewProvider.viewType, new ArchivePreviewProvider(context), {
      webviewOptions,
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.window.registerCustomEditorProvider(ExcelEditorProvider.viewType, new ExcelEditorProvider(context), {
      webviewOptions,
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.window.registerCustomEditorProvider(DatabasePreviewProvider.viewType, new DatabasePreviewProvider(context), {
      webviewOptions,
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.window.registerCustomEditorProvider(MediaPreviewProvider.viewType, new MediaPreviewProvider(context), {
      webviewOptions,
      supportsMultipleEditorsPerDocument: false,
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('docsview.showPreview', async (uri?: vscode.Uri) => {
      const target = uri ?? activeResource();
      if (target) {
        await openSinglePreview(target);
      }
    }),
    vscode.commands.registerCommand('docsview.showPreviewToSide', async (uri?: vscode.Uri) => {
      const target = uri ?? activeResource();
      if (target) {
        await openSplitPreview(target, 'preview');
      }
    }),
    vscode.commands.registerCommand('docsview.showHistory', async (uri?: vscode.Uri) => {
      const target = uri ?? activeResource();
      if (target) {
        await showHistory(target);
      }
    }),
    vscode.commands.registerCommand('docsview.showSource', async (uri?: vscode.Uri) => {
      const target = uri ?? activeResource();
      if (target) {
        await openSingleSource(target);
      }
    }),
    vscode.commands.registerCommand('docsview.ai.openAssistant', async () => {
      if (!openAiInActiveView()) {
        const target = activeResource();
        if (target) {
          await openSinglePreview(target);
          openAiInActiveView();
        }
      }
    }),
    vscode.commands.registerCommand('docsview.ai.setApiKey', (explicitKey?: string) => setAiApiKey(explicitKey)),
    vscode.commands.registerCommand('docsview.ai.clearApiKey', () => clearAiApiKey()),
  );

  // Lets tests, agents, and other extensions observe state and read structured documents.
  return {
    onViewerStatus,
    getViewerStates,
    readDocumentMarkdown,
    testing: { dispatch: dispatchToView, listVersions, setAiApiKey },
  };
}

export function deactivate(): Promise<void> {
  return cleanupMediaTempFiles();
}
