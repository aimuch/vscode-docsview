import * as vscode from 'vscode';
import {
  normalizeToolbarConfig,
  type Appearance,
  type HostMessage,
  type LanguageSetting,
  type LoupePosition,
  type MarkdownWidth,
  type SchemeSetting,
  type SidebarPosition,
  type SplitPosition,
  type ThemeId,
  type ToolbarConfig,
  type ViewerKind,
  type WebviewMessage,
} from '../common/protocol';
import { renderShell } from '../common/shell';
import { pickLang, translate, type Lang, type StringKey } from '../common/strings';
import { cancelWebviewAiStream, handleAiWebviewMessage, postAiSettingsToWebview } from './ai/aiController';
import { extensionOf, isDefaultEditor, setDefaultEditor } from './fileActions';
import { showHistory, supportsHistory } from './history';
import { clearViewerState, reportStatus } from './status';

// ---------------------------------------------------------------- appearance settings

const THEMES: readonly ThemeId[] = ['editor', 'github', 'paper', 'academic'];
const SCHEMES: readonly SchemeSetting[] = ['auto', 'light', 'dark'];
const LANGUAGES: readonly LanguageSetting[] = ['auto', 'zh-cn', 'en'];
const MD_WIDTHS: readonly MarkdownWidth[] = ['fixed', 'fluid'];
const SPLIT_POSITIONS: readonly SplitPosition[] = ['sourceLeft', 'previewLeft'];
const LOUPE_POSITIONS: readonly LoupePosition[] = ['follow', 'fixed'];
const SIDEBAR_POSITIONS: readonly SidebarPosition[] = ['left', 'right'];

/** Setting key for each Appearance field, relative to the "docsview" section. */
const SETTING_KEYS: Record<keyof Appearance, string> = {
  theme: 'appearance.theme',
  scheme: 'appearance.colorScheme',
  invertPages: 'appearance.invertPages',
  highlight: 'highlightRowColumn',
  lockEdits: 'table.lockEditing',
  language: 'language',
  mdWidth: 'markdown.contentWidth',
  splitPosition: 'markdown.splitPosition',
  showNotices: 'showNotices',
  loupePosition: 'image.loupePosition',
  sidebarPosition: 'sidebarPosition',
  mdFontSize: 'markdown.fontSize',
  mdLineHeight: 'markdown.lineHeight',
};

export function readAppearance(): Appearance {
  const config = vscode.workspace.getConfiguration('docsview');
  const pick = <T extends string>(key: string, allowed: readonly T[]): T => {
    const value = config.get<string>(key);
    return (allowed as readonly string[]).includes(value ?? '') ? (value as T) : allowed[0];
  };
  const clampNum = (key: string, def: number, min: number, max: number) => {
    const v = config.get<number>(key, def);
    return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def;
  };
  return {
    theme: pick(SETTING_KEYS.theme, THEMES),
    scheme: pick(SETTING_KEYS.scheme, SCHEMES),
    invertPages: config.get<boolean>(SETTING_KEYS.invertPages, false),
    highlight: config.get<boolean>(SETTING_KEYS.highlight, true),
    lockEdits: config.get<boolean>(SETTING_KEYS.lockEdits, false),
    language: pick(SETTING_KEYS.language, LANGUAGES),
    mdWidth: pick(SETTING_KEYS.mdWidth, MD_WIDTHS),
    splitPosition: pick(SETTING_KEYS.splitPosition, SPLIT_POSITIONS),
    showNotices: config.get<boolean>(SETTING_KEYS.showNotices, true),
    loupePosition: pick(SETTING_KEYS.loupePosition, LOUPE_POSITIONS),
    sidebarPosition: pick(SETTING_KEYS.sidebarPosition, SIDEBAR_POSITIONS),
    mdFontSize: clampNum(SETTING_KEYS.mdFontSize, 15, 12, 24),
    mdLineHeight: clampNum(SETTING_KEYS.mdLineHeight, 1.7, 1.3, 2.2),
  };
}

export function readToolbar(): ToolbarConfig {
  return normalizeToolbarConfig(vscode.workspace.getConfiguration('docsview').get('toolbar'));
}

/** UI language: the user's explicit choice, else VS Code's display language. */
export function lang(): Lang {
  const setting = readAppearance().language;
  return setting === 'auto' ? pickLang(vscode.env.language) : setting === 'en' ? 'en' : 'zh';
}

export function t(key: StringKey, ...args: (string | number)[]): string {
  return translate(lang(), key, ...args);
}

// ---------------------------------------------------------------- open views

interface View {
  kind: ViewerKind;
  panel: vscode.WebviewPanel;
  webview: vscode.Webview;
  uri: vscode.Uri | undefined;
  /** The document can also be shown in a text editor (Markdown, CSV). */
  tracksSource: boolean;
  /** Language the current HTML was rendered in. */
  lang: Lang;
  render(): void;
}

const views = new Set<View>();

/** Directory of a document, used as an extra resource root / base URL. */
export function parentUri(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(uri, '..');
}

/** Custom editor viewType for text-backed formats (Markdown, CSV/TSV, JSONL/NDJSON, SVG). */
export function previewViewTypeFor(uri: vscode.Uri): string | undefined {
  const path = uri.path.toLowerCase();
  if (path.endsWith('.md') || path.endsWith('.markdown')) {
    return 'docsview.markdown';
  }
  if (path.endsWith('.csv') || path.endsWith('.tsv')) {
    return 'docsview.csv';
  }
  if (path.endsWith('.jsonl') || path.endsWith('.ndjson')) {
    return 'docsview.jsonl';
  }
  if (path.endsWith('.svg')) {
    return 'docsview.image';
  }
  return undefined;
}

function findUriTabs(uri: vscode.Uri, viewType?: string) {
  const key = uri.toString();
  const textTabs: { tab: vscode.Tab; group: vscode.TabGroup }[] = [];
  const customTabs: { tab: vscode.Tab; group: vscode.TabGroup; viewType: string }[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === key) {
        textTabs.push({ tab, group });
      } else if (
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.uri.toString() === key &&
        (!viewType || tab.input.viewType === viewType)
      ) {
        customTabs.push({ tab, group, viewType: tab.input.viewType });
      }
    }
  }
  return { textTabs, customTabs };
}

/**
 * True only when a text editor tab for `view.uri` is open in a DIFFERENT editor group
 * from the preview panel (i.e. genuinely side-by-side split, not stacked in the same group).
 */
function hasSplitSourceTab(view: View): boolean {
  if (!view.uri) {
    return false;
  }
  const { textTabs, customTabs } = findUriTabs(view.uri);
  const panelCol = view.panel.viewColumn ?? customTabs[0]?.group.viewColumn;
  if (panelCol === undefined) {
    return false;
  }
  return textTabs.some((t) => t.group.viewColumn !== panelCol);
}

/** Opens single-pane preview in the active group (collapsing split if already split). */
export async function openSinglePreview(uri: vscode.Uri): Promise<void> {
  const viewType = previewViewTypeFor(uri);
  if (!viewType) {
    return;
  }
  const { textTabs, customTabs } = findUriTabs(uri, viewType);
  const activeCol = vscode.window.tabGroups.activeTabGroup.viewColumn;
  const splitCustom = customTabs.find((c) => c.group.viewColumn !== activeCol);
  if (splitCustom) {
    await vscode.commands.executeCommand('vscode.openWith', uri, viewType, splitCustom.group.viewColumn);
    const otherTexts = textTabs.filter((t) => t.group.viewColumn !== splitCustom.group.viewColumn).map((t) => t.tab);
    if (otherTexts.length) {
      await vscode.window.tabGroups.close(otherTexts);
    }
    return;
  }
  await vscode.commands.executeCommand('vscode.openWith', uri, viewType, vscode.ViewColumn.Active);
}

/**
 * Opens or rearranges side-by-side split view so Source and Preview always occupy the
 * configured left/right sides (`docsview.markdown.splitPosition`), regardless of whether
 * split was triggered from the editor title bar or from inside the preview toolbar.
 */
export async function openSplitPreview(uri: vscode.Uri, focus: 'preview' | 'source' = 'preview'): Promise<void> {
  const viewType = previewViewTypeFor(uri);
  if (!viewType) {
    await vscode.commands.executeCommand('vscode.openWith', uri, 'default', vscode.ViewColumn.Beside);
    return;
  }
  const wantSourceLeft = readAppearance().splitPosition === 'sourceLeft';
  const { textTabs, customTabs } = findUriTabs(uri, viewType);
  const customEntry = customTabs[0];
  const splitTextEntry = customEntry
    ? textTabs.find((t) => t.group.viewColumn !== customEntry.group.viewColumn)
    : undefined;

  if (customEntry && splitTextEntry) {
    const customCol = customEntry.group.viewColumn;
    const textCol = splitTextEntry.group.viewColumn;
    if ((textCol < customCol) !== wantSourceLeft) {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default', customCol);
      await vscode.commands.executeCommand('vscode.openWith', uri, viewType, customCol);
      await vscode.commands.executeCommand(
        wantSourceLeft ? 'workbench.action.moveEditorToRightGroup' : 'workbench.action.moveEditorToLeftGroup',
      );
      const after = findUriTabs(uri, viewType);
      const newCustomCol = after.customTabs[0]?.group.viewColumn;
      if (newCustomCol !== undefined) {
        const dupTexts = after.textTabs.filter((t) => t.group.viewColumn === newCustomCol).map((t) => t.tab);
        if (dupTexts.length) {
          await vscode.window.tabGroups.close(dupTexts);
        }
      }
    }
  } else if (!customEntry) {
    const baseCol = textTabs[0]?.group.viewColumn ?? vscode.window.tabGroups.activeTabGroup.viewColumn;
    if (wantSourceLeft) {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default', baseCol);
      await vscode.commands.executeCommand('vscode.openWith', uri, viewType, vscode.ViewColumn.Beside);
    } else {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default', vscode.ViewColumn.Beside);
      await vscode.commands.executeCommand('vscode.openWith', uri, viewType, baseCol);
      const after = findUriTabs(uri, viewType);
      const dupTexts = after.textTabs.filter((t) => t.group.viewColumn === baseCol).map((t) => t.tab);
      if (dupTexts.length) {
        await vscode.window.tabGroups.close(dupTexts);
      }
    }
  } else {
    const baseCol = customEntry.group.viewColumn;
    if (!wantSourceLeft) {
      await vscode.commands.executeCommand('vscode.openWith', uri, viewType, baseCol);
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default', vscode.ViewColumn.Beside);
      const after = findUriTabs(uri, viewType);
      const dupTexts = after.textTabs.filter((t) => t.group.viewColumn === baseCol).map((t) => t.tab);
      if (dupTexts.length) {
        await vscode.window.tabGroups.close(dupTexts);
      }
    } else {
      if (!textTabs.some((t) => t.group.viewColumn === baseCol)) {
        await vscode.commands.executeCommand('vscode.openWith', uri, 'default', baseCol);
      }
      await vscode.commands.executeCommand('vscode.openWith', uri, viewType, baseCol);
      await vscode.commands.executeCommand('workbench.action.moveEditorToRightGroup');
      const after = findUriTabs(uri, viewType);
      const newCustomCol = after.customTabs[0]?.group.viewColumn;
      if (newCustomCol !== undefined && newCustomCol !== baseCol) {
        const dupTexts = after.textTabs.filter((t) => t.group.viewColumn === newCustomCol).map((t) => t.tab);
        if (dupTexts.length) {
          await vscode.window.tabGroups.close(dupTexts);
        }
      }
    }
  }

  // Ensure focus lands on the requested pane after layout arrangement.
  const finalTabs = findUriTabs(uri, viewType);
  if (focus === 'preview' && finalTabs.customTabs[0]) {
    await vscode.commands.executeCommand('vscode.openWith', uri, viewType, finalTabs.customTabs[0].group.viewColumn);
  } else if (focus === 'source') {
    const targetText =
      finalTabs.textTabs.find((t) => t.group.viewColumn !== finalTabs.customTabs[0]?.group.viewColumn) ??
      finalTabs.textTabs[0];
    if (targetText) {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default', targetText.group.viewColumn);
    }
  }
}

/** Switches to the source text editor (closing the split preview pane if currently split). */
export async function openSingleSource(uri: vscode.Uri): Promise<void> {
  const viewType = previewViewTypeFor(uri);
  const { textTabs, customTabs } = findUriTabs(uri, viewType);
  const customEntry = customTabs[0];
  const splitTextEntry = customEntry
    ? textTabs.find((t) => t.group.viewColumn !== customEntry.group.viewColumn)
    : undefined;
  if (customEntry && splitTextEntry) {
    await vscode.commands.executeCommand('vscode.openWith', uri, 'default', splitTextEntry.group.viewColumn);
    await vscode.window.tabGroups.close(customEntry.tab);
    return;
  }
  await vscode.commands.executeCommand('vscode.openWith', uri, 'default', vscode.ViewColumn.Active);
}

function postFileState(view: View): void {
  if (!view.uri) {
    return;
  }
  const message: HostMessage = {
    type: 'fileState',
    isDefault: isDefaultEditor(view.uri),
    ext: extensionOf(view.uri),
    history: supportsHistory(view.uri),
  };
  void view.webview.postMessage(message);
}

function postViewState(view: View): void {
  if (view.tracksSource && view.uri) {
    const message: HostMessage = { type: 'viewState', split: hasSplitSourceTab(view) };
    void view.webview.postMessage(message);
  }
}

/**
 * Sets up a panel's webview (options + HTML) and keeps it registered so appearance and
 * language changes reach it for as long as the panel lives.
 */
export function configureWebview(
  panel: vscode.WebviewPanel,
  extensionUri: vscode.Uri,
  kind: ViewerKind,
  opts: { documentUri?: vscode.Uri; allowLocalFiles?: boolean; tracksSource?: boolean } = {},
): void {
  const { webview } = panel;
  const dist = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const roots = [dist];
  let baseHref: string | undefined;
  if (opts.allowLocalFiles && opts.documentUri) {
    const dir = parentUri(opts.documentUri);
    roots.push(dir, ...(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? []));
    baseHref = webview.asWebviewUri(dir).toString() + '/';
  }
  webview.options = { enableScripts: true, localResourceRoots: roots };

  const view: View = {
    kind,
    panel,
    webview,
    uri: opts.documentUri,
    tracksSource: opts.tracksSource ?? false,
    lang: lang(),
    render() {
      view.lang = lang();
      webview.html = renderShell({
        config: {
          kind,
          assets: webview.asWebviewUri(dist).toString(),
          lang: view.lang,
          appearance: readAppearance(),
          toolbar: readToolbar(),
        },
        cspSource: webview.cspSource,
        baseHref,
      });
    },
  };
  views.add(view);
  const viewStateSub = panel.onDidChangeViewState(() => postViewState(view));
  panel.onDidDispose(() => {
    viewStateSub.dispose();
    cancelWebviewAiStream(webview);
    views.delete(view);
    if (![...views].some((v) => v.uri?.toString() === opts.documentUri?.toString())) {
      clearViewerState(opts.documentUri);
    }
  });
  view.render();
}

export function broadcastHostMessage(message: HostMessage): void {
  views.forEach((view) => void view.webview.postMessage(message));
}

export function openAiInActiveView(): boolean {
  const active = [...views].find((v) => v.panel.active) ?? [...views].find((v) => v.panel.visible);
  if (!active) {
    return false;
  }
  void active.webview.postMessage({ type: 'aiOpen' } satisfies HostMessage);
  return true;
}

/** Keeps every open view in sync with settings and with the editor layout. Call once on activation. */
export function watchViews(): vscode.Disposable[] {
  return [
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('docsview.toolbar')) {
        const message: HostMessage = { type: 'toolbar', toolbar: readToolbar() };
        views.forEach((view) => void view.webview.postMessage(message));
      }
      if (e.affectsConfiguration('docsview.markdown.splitPosition')) {
        for (const view of views) {
          if (view.tracksSource && view.uri && hasSplitSourceTab(view)) {
            void openSplitPreview(view.uri, 'preview');
          }
        }
      }
      if (
        !e.affectsConfiguration('docsview.appearance') &&
        !e.affectsConfiguration('docsview.language') &&
        !e.affectsConfiguration('docsview.highlightRowColumn') &&
        !e.affectsConfiguration('docsview.table.lockEditing') &&
        !e.affectsConfiguration('docsview.markdown.contentWidth') &&
        !e.affectsConfiguration('docsview.markdown.splitPosition') &&
        !e.affectsConfiguration('docsview.showNotices') &&
        !e.affectsConfiguration('docsview.image.loupePosition') &&
        !e.affectsConfiguration('docsview.sidebarPosition')
      ) {
        return;
      }
      const message: HostMessage = { type: 'appearance', appearance: readAppearance() };
      const current = lang();
      for (const view of views) {
        if (view.lang !== current) {
          // Every label is built when the page loads, so a language change reloads the page.
          view.render();
        } else {
          void view.webview.postMessage(message);
        }
      }
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => views.forEach(postViewState)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('workbench.editorAssociations')) {
        views.forEach(postFileState);
      }
    }),
  ];
}

const handlers = new WeakMap<vscode.Webview, Set<(message: WebviewMessage) => void>>();

/**
 * Subscribes to a webview's messages. Providers use this instead of
 * webview.onDidReceiveMessage so tests can deliver the same messages (see dispatchToView).
 */
export function onWebviewMessage(
  webview: vscode.Webview,
  handler: (message: WebviewMessage) => void,
): vscode.Disposable {
  let set = handlers.get(webview);
  if (!set) {
    handlers.set(webview, (set = new Set()));
  }
  set.add(handler);
  const subscription = webview.onDidReceiveMessage(handler);
  return {
    dispose() {
      subscription.dispose();
      set.delete(handler);
    },
  };
}

/**
 * Test hook: delivers a message as if the open view of `uri` had posted it (a toolbar
 * click, a cell edit…). Returns the number of views that received it.
 */
export function dispatchToView(uri: vscode.Uri, message: WebviewMessage, kind?: ViewerKind): number {
  let count = 0;
  for (const view of views) {
    if (view.uri?.toString() === uri.toString() && (!kind || view.kind === kind)) {
      handlers.get(view.webview)?.forEach((handler) => handler(message));
      count++;
    }
  }
  return count;
}

/**
 * Handles the messages every viewer can send (render status, appearance changes,
 * switching to the text editor). Providers call this for each message before their own handling.
 */
export function handleCommonMessage(
  webview: vscode.Webview,
  uri: vscode.Uri,
  kind: ViewerKind,
  message: WebviewMessage,
): void {
  reportStatus(uri, kind, message);
  if (handleAiWebviewMessage(webview, uri, message)) {
    return;
  }
  switch (message.type) {
    case 'ready':
      for (const view of views) {
        if (view.webview === webview) {
          postViewState(view);
          postFileState(view);
        }
      }
      void postAiSettingsToWebview(webview, false);
      break;
    case 'setDefault': {
      void setDefaultEditor(uri, message.on);
      break;
    }
    case 'history': {
      void showHistory(uri);
      break;
    }
    case 'setAppearance': {
      const config = vscode.workspace.getConfiguration('docsview');
      for (const key of Object.keys(message.patch) as (keyof Appearance)[]) {
        if (key in SETTING_KEYS) {
          void config.update(SETTING_KEYS[key], message.patch[key], vscode.ConfigurationTarget.Global);
        }
      }
      break;
    }
    case 'setToolbar': {
      void vscode.workspace
        .getConfiguration('docsview')
        .update('toolbar', normalizeToolbarConfig(message.toolbar), vscode.ConfigurationTarget.Global);
      break;
    }
    case 'openSettings': {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'docsview');
      break;
    }
    case 'openExternalApp': {
      void vscode.env.openExternal(uri);
      break;
    }
    case 'openLink': {
      if (kind !== 'markdown' && /^(?:https?:|mailto:)/i.test(message.href.trim())) {
        void vscode.env.openExternal(vscode.Uri.parse(message.href.trim()));
      }
      break;
    }
    case 'showSource':
      if (message.beside) {
        void openSplitPreview(uri, 'source');
      } else {
        void openSingleSource(uri);
      }
      break;
    case 'closeSource': {
      const key = uri.toString();
      const tabs = vscode.window.tabGroups.all.flatMap((group) =>
        group.tabs.filter((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === key),
      );
      if (tabs.length) {
        void vscode.window.tabGroups.close(tabs);
      }
      break;
    }
    case 'saveTextExport': {
      const base = uri.path.slice(uri.path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
      const ext = message.ext.replace(/^\./, '');
      void vscode.window
        .showSaveDialog({
          defaultUri: vscode.Uri.joinPath(parentUri(uri), `${base}${message.suffix ?? ''}.${ext}`),
          filters: { [ext.toUpperCase()]: [ext] },
        })
        .then(async (target) => {
          if (!target) return;
          await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(message.content));
          await vscode.commands.executeCommand('vscode.open', target);
          void vscode.window.showInformationMessage(t('exportSaved', target.fsPath));
        });
      break;
    }
    case 'saveBytesExport': {
      const base = uri.path.slice(uri.path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
      const ext = message.ext.replace(/^\./, '');
      void vscode.window
        .showSaveDialog({
          defaultUri: vscode.Uri.joinPath(parentUri(uri), `${base}${message.suffix ?? ''}.${ext}`),
          filters: { [ext.toUpperCase()]: [ext] },
        })
        .then(async (target) => {
          if (!target) return;
          const clean =
            message.bytes.constructor === Uint8Array ? message.bytes : new Uint8Array(message.bytes);
          await vscode.workspace.fs.writeFile(target, clean);
          void vscode.window.showInformationMessage(t('exportSaved', target.fsPath));
        });
      break;
    }
  }
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => fn(...args), ms);
  };
}
