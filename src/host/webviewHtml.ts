import * as vscode from 'vscode';
import type {
  Appearance,
  HostMessage,
  LanguageSetting,
  SchemeSetting,
  ThemeId,
  ViewerKind,
  WebviewMessage,
} from '../common/protocol';
import { renderShell } from '../common/shell';
import { pickLang, translate, type Lang, type StringKey } from '../common/strings';
import { reportStatus } from './status';

// ---------------------------------------------------------------- appearance settings

const THEMES: readonly ThemeId[] = ['editor', 'github', 'paper', 'academic'];
const SCHEMES: readonly SchemeSetting[] = ['auto', 'light', 'dark'];
const LANGUAGES: readonly LanguageSetting[] = ['auto', 'zh-cn', 'en'];

/** Setting key for each Appearance field, relative to the "docsview" section. */
const SETTING_KEYS: Record<keyof Appearance, string> = {
  theme: 'appearance.theme',
  scheme: 'appearance.colorScheme',
  invertPages: 'appearance.invertPages',
  language: 'language',
};

export function readAppearance(): Appearance {
  const config = vscode.workspace.getConfiguration('docsview');
  const pick = <T extends string>(key: string, allowed: readonly T[]): T => {
    const value = config.get<string>(key);
    return (allowed as readonly string[]).includes(value ?? '') ? (value as T) : allowed[0];
  };
  return {
    theme: pick(SETTING_KEYS.theme, THEMES),
    scheme: pick(SETTING_KEYS.scheme, SCHEMES),
    invertPages: config.get<boolean>(SETTING_KEYS.invertPages, false),
    language: pick(SETTING_KEYS.language, LANGUAGES),
  };
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

function hasSourceTab(uri: vscode.Uri): boolean {
  const key = uri.toString();
  return vscode.window.tabGroups.all.some((group) =>
    group.tabs.some((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === key),
  );
}

function postViewState(view: View): void {
  if (view.tracksSource && view.uri) {
    const message: HostMessage = { type: 'viewState', split: hasSourceTab(view.uri) };
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
        },
        cspSource: webview.cspSource,
        baseHref,
      });
    },
  };
  views.add(view);
  panel.onDidDispose(() => views.delete(view));
  view.render();
}

/** Keeps every open view in sync with settings and with the editor layout. Call once on activation. */
export function watchViews(): vscode.Disposable[] {
  return [
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('docsview.appearance') && !e.affectsConfiguration('docsview.language')) {
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
  ];
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
  switch (message.type) {
    case 'ready':
      for (const view of views) {
        if (view.webview === webview) {
          postViewState(view);
        }
      }
      break;
    case 'setAppearance': {
      const config = vscode.workspace.getConfiguration('docsview');
      for (const key of Object.keys(message.patch) as (keyof Appearance)[]) {
        if (key in SETTING_KEYS) {
          void config.update(SETTING_KEYS[key], message.patch[key], vscode.ConfigurationTarget.Global);
        }
      }
      break;
    }
    case 'showSource':
      void vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        'default',
        message.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
      );
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
