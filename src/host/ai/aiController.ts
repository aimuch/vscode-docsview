// Host-side AI request lifecycle, per-provider privacy consent, and webview message bridge.
import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from '../../common/protocol';
import { lang, t } from '../webviewHtml';
import { buildAiPrompt } from './aiPrompts';
import {
  clearAiApiKey,
  fetchProviderModels,
  initAiSecretStorage,
  loadAiSettingsSnapshot,
  onDidChangeAiApiKey,
  resolveAvailableModels,
  runAiTarget,
  setAiApiKey,
  type LanguageModelTarget,
} from './aiProviders';

const CONSENT_STATE_KEY = 'docsview.ai.consentedTargets';
const STREAM_THROTTLE_MS = 75;

let globalStateRef: vscode.Memento | null = null;

interface ActiveAiStream {
  requestId: number;
  cts: vscode.CancellationTokenSource;
}

const activeStreams = new WeakMap<vscode.Webview, ActiveAiStream>();

export function initAiHost(
  context: vscode.ExtensionContext,
  broadcastToAllViews: (msg: HostMessage) => void,
): vscode.Disposable[] {
  globalStateRef = context.globalState;
  initAiSecretStorage(context.secrets);

  const pushSettingsToAll = async (discover = false) => {
    const settings = await loadAiSettingsSnapshot();
    const models = discover ? (await fetchProviderModels()).models : undefined;
    broadcastToAllViews({ type: 'aiSettings', settings, models });
  };

  return [
    onDidChangeAiApiKey(() => {
      void pushSettingsToAll(false);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('docsview.ai')) {
        void pushSettingsToAll(true);
      }
    }),
  ];
}

export function cancelWebviewAiStream(webview: vscode.Webview, requestId?: number): void {
  const current = activeStreams.get(webview);
  if (!current) {
    return;
  }
  if (requestId === undefined || current.requestId === requestId) {
    activeStreams.delete(webview);
    current.cts.cancel();
    current.cts.dispose();
  }
}

function isLocalEndpoint(endpoint: string | null): boolean {
  if (!endpoint) {
    return false;
  }
  const host = endpoint.split(':')[0].toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

async function ensureTargetConsent(target: LanguageModelTarget, fileName: string): Promise<boolean> {
  if (isLocalEndpoint(target.endpoint)) {
    return true;
  }
  const consentKey = `${target.vendor}::${target.endpoint ?? 'vscode-lm'}`;
  const stored = globalStateRef?.get<string[]>(CONSENT_STATE_KEY, []) ?? [];
  if (stored.includes(consentKey)) {
    return true;
  }

  const destLabel = target.endpoint ? `${target.vendor} (${target.endpoint})` : target.vendor;
  const onceItem: vscode.QuickPickItem & { id: 'once' | 'always' } = {
    id: 'once',
    label: t('aiConsentOnce'),
  };
  const alwaysItem: vscode.QuickPickItem & { id: 'once' | 'always' } = {
    id: 'always',
    label: t('aiConsentAlways', target.vendor),
  };

  const picked = await vscode.window.showQuickPick([alwaysItem, onceItem], {
    title: t('aiConsentTitle'),
    placeHolder: t('aiConsentPrompt', fileName || 'document', destLabel, target.name),
    ignoreFocusOut: true,
  });
  if (!picked) {
    return false;
  }
  if (picked.id === 'always' && globalStateRef) {
    const next = [...new Set([...stored, consentKey])];
    await globalStateRef.update(CONSENT_STATE_KEY, next);
  }
  return true;
}

export async function postAiSettingsToWebview(webview: vscode.Webview, discoverModels = false): Promise<void> {
  const settings = await loadAiSettingsSnapshot();
  const discovered = discoverModels ? (await fetchProviderModels()).models : undefined;
  const msg: HostMessage = { type: 'aiSettings', settings, models: discovered };
  void webview.postMessage(msg);
}

export function handleAiWebviewMessage(webview: vscode.Webview, uri: vscode.Uri, message: WebviewMessage): boolean {
  switch (message.type) {
    case 'aiGetSettings': {
      void postAiSettingsToWebview(webview, Boolean(message.discoverModels));
      return true;
    }

    case 'aiUpdateSettings': {
      void (async () => {
        const cfg = vscode.workspace.getConfiguration('docsview');
        if (message.provider !== undefined) {
          await cfg.update('ai.provider', message.provider, vscode.ConfigurationTarget.Global);
          if (message.baseUrl === undefined) {
            await cfg.update('ai.baseUrl', '', vscode.ConfigurationTarget.Global);
          }
          if (message.model === undefined) {
            await cfg.update('ai.model', '', vscode.ConfigurationTarget.Global);
          }
        }
        if (message.baseUrl !== undefined) {
          await cfg.update('ai.baseUrl', message.baseUrl.trim(), vscode.ConfigurationTarget.Global);
        }
        if (message.model !== undefined) {
          await cfg.update('ai.model', message.model.trim(), vscode.ConfigurationTarget.Global);
        }
        await postAiSettingsToWebview(webview, true);
      })();
      return true;
    }

    case 'aiManageKey': {
      void (async () => {
        if (message.op === 'set') {
          await setAiApiKey();
        } else {
          await clearAiApiKey();
        }
        await postAiSettingsToWebview(webview, true);
      })();
      return true;
    }

    case 'aiCancel': {
      cancelWebviewAiStream(webview, message.requestId);
      return true;
    }

    case 'aiRun': {
      const { requestId, context } = message;
      cancelWebviewAiStream(webview);
      const cts = new vscode.CancellationTokenSource();
      const entry: ActiveAiStream = { requestId, cts };
      activeStreams.set(webview, entry);

      void (async () => {
        let resolved = await resolveAvailableModels();
        if (resolved.needsApiKey && !cts.token.isCancellationRequested) {
          const saved = await setAiApiKey();
          if (saved) {
            await postAiSettingsToWebview(webview, false);
            resolved = await resolveAvailableModels();
          }
        }
        if (cts.token.isCancellationRequested) {
          return;
        }
        if (resolved.error || resolved.models.length === 0) {
          void webview.postMessage({
            type: 'aiStream',
            requestId,
            text: '',
            done: true,
            error: resolved.error ?? t('aiUnavailable'),
          } satisfies HostMessage);
          return;
        }

        const target = resolved.models[0];
        const fileName = context.fileName || uri.path.slice(uri.path.lastIndexOf('/') + 1);
        const allowed = await ensureTargetConsent(target, fileName);
        if (!allowed || cts.token.isCancellationRequested) {
          void webview.postMessage({
            type: 'aiStream',
            requestId,
            text: '',
            model: target.name,
            done: true,
          } satisfies HostMessage);
          return;
        }

        const prompt = buildAiPrompt({ ...context, fileName }, lang());
        let accumulated = '';
        let flushTimer: ReturnType<typeof setTimeout> | null = null;

        const flush = (done: boolean, error?: string) => {
          if (flushTimer !== null) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
          void webview.postMessage({
            type: 'aiStream',
            requestId,
            text: accumulated,
            model: `${target.vendor} · ${target.name}`,
            done,
            error,
          } satisfies HostMessage);
        };

        const err = await runAiTarget(
          target,
          prompt,
          (delta) => {
            accumulated += delta;
            if (flushTimer === null) {
              flushTimer = setTimeout(() => {
                flushTimer = null;
                if (!cts.token.isCancellationRequested) {
                  void webview.postMessage({
                    type: 'aiStream',
                    requestId,
                    text: accumulated,
                    model: `${target.vendor} · ${target.name}`,
                    done: false,
                  } satisfies HostMessage);
                }
              }, STREAM_THROTTLE_MS);
            }
          },
          cts.token,
          { history: context.history, imageDataUrl: context.imageDataUrl },
        );

        if (activeStreams.get(webview) === entry) {
          activeStreams.delete(webview);
        }
        if (!cts.token.isCancellationRequested) {
          flush(true, err ?? undefined);
        } else {
          flush(true);
        }
        cts.dispose();
      })();
      return true;
    }

    default:
      return false;
  }
}
