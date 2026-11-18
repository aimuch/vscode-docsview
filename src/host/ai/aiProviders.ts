// Multi-provider AI transport & SecretStorage manager for DocsView (`docsview.ai.*`),
// aligned 1:1 with `vscode-git-map`:
// - Built-in VS Code Language Model API (`vscode.lm`)
// - Direct OpenAI-compatible Chat Completions SSE streaming (`DeepSeek`, `Kimi`, `Doubao`, `Qwen`, `OpenAI`)
// - Local gateways (`Ollama`, `Magpie` `~/.config/magpie/gateway.json`, `CC Switch` `127.0.0.1:15721`, `OpenAI Compatible`)
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AiProviderId, AiProviderPresetInfo, AiSettingsSnapshot } from '../../common/protocol';
import { t } from '../webviewHtml';

interface AiProviderPreset {
  readonly name: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly requiresApiKey: boolean;
}

const DIRECT_PROVIDERS: readonly Exclude<AiProviderId, 'VS Code'>[] = [
  'DeepSeek',
  'Kimi',
  'Doubao',
  'Qwen',
  'OpenAI',
  'Ollama',
  'Magpie',
  'CC Switch',
  'OpenAI Compatible',
];

export const ALL_AI_PROVIDERS: readonly AiProviderId[] = ['VS Code', ...DIRECT_PROVIDERS];

const PRESETS: Record<Exclude<AiProviderId, 'VS Code'>, AiProviderPreset> = {
  DeepSeek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', requiresApiKey: true },
  Kimi: { name: 'Kimi (Moonshot AI)', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-auto', requiresApiKey: true },
  Doubao: { name: 'Doubao (Volcengine Ark)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '', requiresApiKey: true },
  Qwen: {
    name: 'Qwen (Alibaba Cloud Model Studio)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    requiresApiKey: true,
  },
  OpenAI: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', requiresApiKey: true },
  Ollama: { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: '', requiresApiKey: false },
  Magpie: { name: 'Magpie', baseUrl: 'http://127.0.0.1:3425/v1', model: '', requiresApiKey: false },
  'CC Switch': { name: 'CC Switch', baseUrl: 'http://127.0.0.1:15721/v1', model: '', requiresApiKey: false },
  'OpenAI Compatible': { name: 'OpenAI Compatible', baseUrl: '', model: '', requiresApiKey: false },
};

const SECRET_PREFIX = 'docsview.ai.apiKey.';
const STREAM_TIMEOUT_MS = 60_000;
const MODELS_DISCOVERY_TIMEOUT_MS = 2_500;

export interface DirectAiConfig {
  readonly provider: Exclude<AiProviderId, 'VS Code'>;
  readonly name: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly requiresApiKey: boolean;
}

export interface LanguageModelTarget {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly endpoint: string | null;
}

interface VsCodeLmChat {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly family?: string;
  sendRequest(
    messages: unknown[],
    options: Record<string, unknown>,
    token: vscode.CancellationToken,
  ): Thenable<{ readonly text: AsyncIterable<string> }>;
}

interface VsCodeLmApi {
  selectChatModels(selector?: { id?: string }): Thenable<VsCodeLmChat[]>;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }
}

/** Reads Magpie's local gateway address from `~/.config/magpie/gateway.json` when running. */
export function readMagpieGatewayAddress(): string | null {
  const configHome =
    typeof process.env.XDG_CONFIG_HOME === 'string' && process.env.XDG_CONFIG_HOME !== ''
      ? process.env.XDG_CONFIG_HOME
      : path.join(os.homedir(), '.config');
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configHome, 'magpie', 'gateway.json'), 'utf8')) as {
      addr?: unknown;
    } | null;
    const addr = raw && typeof raw === 'object' && typeof raw.addr === 'string' ? raw.addr.trim() : '';
    const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(addr);
    if (!match) {
      return null;
    }
    const host = match[1] === '0.0.0.0' || match[1] === '[::]' ? '127.0.0.1' : match[1];
    return `${host}:${match[2]}`;
  } catch {
    return null;
  }
}

function getDefaultBaseUrl(provider: Exclude<AiProviderId, 'VS Code'>): string {
  if (provider === 'Magpie') {
    const addr = readMagpieGatewayAddress();
    if (addr) {
      return `http://${addr}/v1`;
    }
  }
  return PRESETS[provider].baseUrl;
}

export function getHostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function readRawAiConfig(): { provider: AiProviderId; baseUrl: string; model: string } {
  const cfg = vscode.workspace.getConfiguration('docsview');
  const rawProvider = cfg.get<string>('ai.provider', 'VS Code');
  const provider: AiProviderId = (ALL_AI_PROVIDERS as readonly string[]).includes(rawProvider)
    ? (rawProvider as AiProviderId)
    : 'VS Code';
  const baseUrl = (cfg.get<string>('ai.baseUrl', '') ?? '').trim();
  const model = (cfg.get<string>('ai.model', '') ?? '').trim();
  return { provider, baseUrl, model };
}

export function getDirectAiConfig(): DirectAiConfig | null {
  const { provider, baseUrl, model } = readRawAiConfig();
  if (provider === 'VS Code') {
    return null;
  }
  const preset = PRESETS[provider];
  return {
    provider,
    name: preset.name,
    baseUrl: (baseUrl || getDefaultBaseUrl(provider)).replace(/\/+$/, ''),
    model: model || preset.model,
    requiresApiKey: preset.requiresApiKey,
  };
}

export function isAutoModelDiscoveryProvider(provider: AiProviderId): boolean {
  return (
    provider === 'Magpie' ||
    provider === 'CC Switch' ||
    provider === 'Ollama' ||
    provider === 'OpenAI Compatible'
  );
}

// ---------------------------------------------------------------- SecretStorage API keys

let secretStorage: vscode.SecretStorage | null = null;
const cachedProvidersWithKeys = new Set<AiProviderId>();

function secretKey(provider: AiProviderId): string {
  return `${SECRET_PREFIX}${provider}`;
}

export function initAiSecretStorage(secrets: vscode.SecretStorage): void {
  secretStorage = secrets;
  cachedProvidersWithKeys.clear();
  for (const provider of DIRECT_PROVIDERS) {
    void Promise.resolve(secrets.get(secretKey(provider))).then(
      (val) => {
        if (secretStorage === secrets && typeof val === 'string' && val !== '') {
          cachedProvidersWithKeys.add(provider);
        }
      },
      () => undefined,
    );
  }
}

export function onDidChangeAiApiKey(listener: () => void): vscode.Disposable {
  if (!secretStorage || typeof secretStorage.onDidChange !== 'function') {
    return { dispose: () => undefined };
  }
  return secretStorage.onDidChange((event) => {
    if (event && typeof event.key === 'string' && event.key.startsWith(SECRET_PREFIX)) {
      const provider = event.key.slice(SECRET_PREFIX.length) as AiProviderId;
      if ((DIRECT_PROVIDERS as readonly string[]).includes(provider) && secretStorage) {
        void Promise.resolve(secretStorage.get(event.key)).then(
          (val) => {
            if (typeof val === 'string' && val !== '') {
              cachedProvidersWithKeys.add(provider);
            } else {
              cachedProvidersWithKeys.delete(provider);
            }
            listener();
          },
          () => listener(),
        );
      } else {
        listener();
      }
    }
  });
}

export async function getApiKey(provider: AiProviderId): Promise<string | null> {
  if (!secretStorage || provider === 'VS Code') {
    return null;
  }
  const val = await secretStorage.get(secretKey(provider));
  if (typeof val === 'string' && val !== '') {
    cachedProvidersWithKeys.add(provider);
    return val;
  }
  cachedProvidersWithKeys.delete(provider);
  return null;
}

export async function getEffectiveApiKey(provider: Exclude<AiProviderId, 'VS Code'>): Promise<string | null> {
  const stored = await getApiKey(provider);
  if (stored !== null) {
    return stored;
  }
  if (provider === 'Magpie') return 'magpie';
  if (provider === 'CC Switch') return 'cc-switch';
  if (provider === 'Ollama') return 'ollama';
  return null;
}

export function getAiProviderPresets(): AiProviderPresetInfo[] {
  return [
    { id: 'VS Code', name: 'VS Code (Copilot / LM API)', defaultBaseUrl: '', defaultModel: '', requiresApiKey: false },
    ...DIRECT_PROVIDERS.map((id) => ({
      id,
      name: PRESETS[id].name,
      defaultBaseUrl: getDefaultBaseUrl(id),
      defaultModel: PRESETS[id].model,
      requiresApiKey: PRESETS[id].requiresApiKey,
    })),
  ];
}

export async function loadAiSettingsSnapshot(): Promise<AiSettingsSnapshot> {
  const { provider, baseUrl, model } = readRawAiConfig();
  const hasApiKey = provider !== 'VS Code' && (await getApiKey(provider)) !== null;
  return {
    provider,
    baseUrl,
    model,
    hasApiKey,
    presets: getAiProviderPresets(),
  };
}

export async function setAiApiKey(explicitKey?: string): Promise<boolean> {
  const direct = getDirectAiConfig();
  if (!direct) {
    void vscode.window.showInformationMessage(
      'Choose a direct AI provider in "docsview.ai.provider" (or Settings → AI Assistant) first — VS Code built-in models do not require an API key.',
    );
    return false;
  }
  if (!secretStorage) {
    return false;
  }
  const value =
    typeof explicitKey === 'string'
      ? explicitKey
      : await vscode.window.showInputBox({
          title: 'DocsView: Set AI API Key',
          prompt: `API key for ${direct.name} (stored securely in VS Code SecretStorage; sent only to ${getHostLabel(direct.baseUrl) || direct.name}).`,
          password: true,
          ignoreFocusOut: true,
          validateInput: (input) => (input.trim() === '' ? 'API key cannot be empty.' : null),
        });
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }
  await secretStorage.store(secretKey(direct.provider), value.trim());
  cachedProvidersWithKeys.add(direct.provider);
  if (typeof explicitKey !== 'string') {
    void vscode.window.showInformationMessage(`Saved API key for ${direct.name}.`);
  }
  return true;
}

export async function clearAiApiKey(): Promise<void> {
  if (!secretStorage) {
    return;
  }
  const direct = getDirectAiConfig();
  if (direct && (await getApiKey(direct.provider)) !== null) {
    await secretStorage.delete(secretKey(direct.provider));
    cachedProvidersWithKeys.delete(direct.provider);
    void vscode.window.showInformationMessage(`Cleared API key for ${direct.name}.`);
    return;
  }
  const stored: { provider: Exclude<AiProviderId, 'VS Code'>; name: string }[] = [];
  for (const p of DIRECT_PROVIDERS) {
    if ((await getApiKey(p)) !== null) {
      stored.push({ provider: p, name: PRESETS[p].name });
    }
  }
  if (stored.length === 0) {
    void vscode.window.showInformationMessage('No AI API keys are stored in DocsView.');
    return;
  }
  if (stored.length === 1) {
    await secretStorage.delete(secretKey(stored[0].provider));
    cachedProvidersWithKeys.delete(stored[0].provider);
    void vscode.window.showInformationMessage(`Cleared API key for ${stored[0].name}.`);
    return;
  }
  const items = [
    ...stored.map((s) => ({ label: s.name, providers: [s.provider] })),
    { label: 'All Stored AI API Keys', providers: stored.map((s) => s.provider) },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select AI API key to clear',
    ignoreFocusOut: true,
  });
  if (!picked) {
    return;
  }
  for (const p of picked.providers) {
    await secretStorage.delete(secretKey(p));
    cachedProvidersWithKeys.delete(p);
  }
  void vscode.window.showInformationMessage(`Cleared ${picked.label}.`);
}

// ---------------------------------------------------------------- Model discovery & SSE transport

function parseJsonSafe(text: string): Record<string, unknown> | null {
  try {
    const val = JSON.parse(text) as unknown;
    return val && typeof val === 'object' ? (val as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  const json = parseJsonSafe(text);
  if (json && json.error && typeof json.error === 'object' && 'message' in json.error && typeof json.error.message === 'string') {
    return json.error.message;
  }
  if (json && typeof json.message === 'string') {
    return json.message;
  }
  return text.trim() ? text.trim().slice(0, 400) : response.statusText;
}

function getVsCodeLmApi(): { lm: VsCodeLmApi; userMessage: (text: string) => unknown } | null {
  const api = vscode as unknown as {
    lm?: VsCodeLmApi;
    LanguageModelChatMessage?: ((...args: never[]) => unknown) & { User?: (text: string) => unknown };
  };
  const msgCtor = api.LanguageModelChatMessage;
  if (
    !api.lm ||
    typeof api.lm.selectChatModels !== 'function' ||
    typeof msgCtor !== 'function' ||
    typeof msgCtor.User !== 'function'
  ) {
    return null;
  }
  const userFn = msgCtor.User;
  return {
    lm: api.lm,
    userMessage: (text: string) => userFn.call(msgCtor, text),
  };
}

export async function fetchProviderModels(
  configOverride?: DirectAiConfig | null,
): Promise<{ models: string[]; reachable: boolean; error: string | null }> {
  const direct = configOverride !== undefined ? configOverride : getDirectAiConfig();
  if (!direct) {
    const vsLm = getVsCodeLmApi();
    if (!vsLm) {
      return { models: [], reachable: false, error: null };
    }
    try {
      const chats = await vsLm.lm.selectChatModels();
      const ids = [...new Set(chats.map((c) => c.id).filter(Boolean))];
      return { models: ids, reachable: true, error: null };
    } catch {
      return { models: [], reachable: false, error: null };
    }
  }

  if (!direct.baseUrl) {
    return { models: [], reachable: false, error: `Set "docsview.ai.baseUrl" for ${direct.name}.` };
  }
  if (!/^https?:\/\//i.test(direct.baseUrl)) {
    return { models: [], reachable: false, error: 'Base URL must start with https:// or http://.' };
  }
  if (direct.requiresApiKey && (await getApiKey(direct.provider)) === null) {
    return { models: [], reachable: false, error: `Set the API key for ${direct.name} first.` };
  }
  if (typeof fetch !== 'function') {
    return { models: [], reachable: false, error: 'Fetch API is unavailable in this VS Code runtime.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODELS_DISCOVERY_TIMEOUT_MS);
  unrefTimer(timer);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const apiKey = await getEffectiveApiKey(direct.provider);
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(`${direct.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 404 || response.status === 405) {
        return { models: [], reachable: true, error: null };
      }
      return { models: [], reachable: true, error: `HTTP ${response.status}: ${await readErrorMessage(response)}` };
    }
    const json = parseJsonSafe(await response.text());
    const rawList = Array.isArray(json?.data)
      ? (json.data as unknown[])
      : Array.isArray(json?.models)
        ? (json.models as unknown[])
        : [];
    const seen = new Set<string>();
    const models: string[] = [];
    for (const item of rawList) {
      const id =
        typeof item === 'string'
          ? item.trim()
          : item && typeof item === 'object'
            ? typeof (item as { id?: unknown }).id === 'string'
              ? ((item as { id: string }).id).trim()
              : typeof (item as { name?: unknown }).name === 'string'
                ? ((item as { name: string }).name).trim()
                : ''
            : '';
      if (id && !seen.has(id)) {
        seen.add(id);
        models.push(id);
      }
    }
    return { models, reachable: true, error: null };
  } catch (err) {
    return {
      models: [],
      reachable: false,
      error: `Unable to reach ${getHostLabel(direct.baseUrl)}: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveAvailableModels(): Promise<{
  models: LanguageModelTarget[];
  error: string | null;
  needsApiKey: boolean;
}> {
  const direct = getDirectAiConfig();
  if (direct) {
    const endpoint = getHostLabel(direct.baseUrl);
    if (!direct.baseUrl) {
      return { models: [], error: `Set the Base URL for ${direct.name} in Settings → AI Assistant.`, needsApiKey: false };
    }
    if (!/^https?:\/\//i.test(direct.baseUrl)) {
      return { models: [], error: 'Base URL must start with https:// or http://.', needsApiKey: false };
    }
    if (direct.requiresApiKey && (await getApiKey(direct.provider)) === null) {
      return { models: [], error: `API key required for ${direct.name}.`, needsApiKey: true };
    }
    if (!direct.model && isAutoModelDiscoveryProvider(direct.provider)) {
      const discovered = await fetchProviderModels(direct);
      if (discovered.models.length > 0) {
        return {
          models: discovered.models.map((id) => ({ id, name: id, vendor: direct.name, endpoint })),
          error: null,
          needsApiKey: false,
        };
      }
      if (direct.provider === 'CC Switch' && discovered.reachable && !discovered.error) {
        return {
          models: [{ id: 'default', name: 'default', vendor: direct.name, endpoint }],
          error: null,
          needsApiKey: false,
        };
      }
      if (discovered.error) {
        return { models: [], error: discovered.error, needsApiKey: false };
      }
    }
    if (!direct.model) {
      return { models: [], error: `Specify a model name for ${direct.name} in Settings → AI Assistant.`, needsApiKey: false };
    }
    return {
      models: [{ id: direct.model, name: direct.model, vendor: direct.name, endpoint }],
      error: null,
      needsApiKey: false,
    };
  }

  const vsLm = getVsCodeLmApi();
  if (!vsLm) {
    return { models: [], error: t('aiUnavailable'), needsApiKey: false };
  }
  try {
    const chats = await vsLm.lm.selectChatModels();
    if (!chats.length) {
      return { models: [], error: t('aiUnavailable'), needsApiKey: false };
    }
    const preferred = readRawAiConfig().model.toLowerCase();
    const sorted = preferred
      ? [
          ...chats.filter(
            (c) =>
              c.id.toLowerCase() === preferred ||
              c.name.toLowerCase().includes(preferred) ||
              (c.family ?? '').toLowerCase().includes(preferred),
          ),
          ...chats.filter(
            (c) =>
              c.id.toLowerCase() !== preferred &&
              !c.name.toLowerCase().includes(preferred) &&
              !(c.family ?? '').toLowerCase().includes(preferred),
          ),
        ]
      : chats;
    return {
      models: sorted.map((m) => ({ id: m.id, name: m.name, vendor: m.vendor, endpoint: null })),
      error: null,
      needsApiKey: false,
    };
  } catch (err) {
    return { models: [], error: err instanceof Error ? err.message : String(err), needsApiKey: false };
  }
}

export async function streamChatCompletion(
  baseUrl: string,
  model: string,
  apiKey: string | null,
  prompt: string,
  onText: (delta: string) => void,
  token: vscode.CancellationToken,
): Promise<string | null> {
  if (typeof fetch !== 'function') {
    return 'Fetch API is unavailable in this VS Code runtime.';
  }
  const controller = new AbortController();
  const sub = token.onCancellationRequested(() => controller.abort());
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const resetTimeout = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, STREAM_TIMEOUT_MS);
    unrefTimer(timer);
  };
  resetTimeout();

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    resetTimeout();
    if (!response.ok || !response.body) {
      return `API error (${response.status}): ${await readErrorMessage(response)}`;
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('application/json')) {
      const json = parseJsonSafe(await response.text());
      if (json?.error && typeof json.error === 'object') {
        const msg = (json.error as { message?: unknown }).message;
        return `API error: ${typeof msg === 'string' ? msg : JSON.stringify(json.error)}`;
      }
      const choices = Array.isArray(json?.choices) ? (json.choices as Record<string, unknown>[]) : [];
      const content =
        choices[0]?.message && typeof (choices[0].message as { content?: unknown }).content === 'string'
          ? ((choices[0].message as { content: string }).content)
          : '';
      if (!content) {
        return 'Model returned an empty response.';
      }
      onText(content);
      return null;
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    let done = false;
    let receivedText = false;

    const processLine = (rawLine: string): string | null => {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) {
        return null;
      }
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        done = true;
        return null;
      }
      const event = parseJsonSafe(data);
      if (!event) {
        return null;
      }
      if (event.error && typeof event.error === 'object') {
        const msg = (event.error as { message?: unknown }).message;
        return `API error: ${typeof msg === 'string' ? msg : JSON.stringify(event.error)}`;
      }
      const choices = Array.isArray(event.choices) ? (event.choices as Record<string, unknown>[]) : [];
      const first = choices[0];
      const deltaObj = first?.delta as { content?: unknown } | undefined;
      const msgObj = first?.message as { content?: unknown } | undefined;
      const chunkText =
        typeof deltaObj?.content === 'string'
          ? deltaObj.content
          : typeof msgObj?.content === 'string'
            ? msgObj.content
            : '';
      if (chunkText) {
        receivedText = true;
        onText(chunkText);
      }
      return null;
    };

    while (!done) {
      const chunk = await reader.read();
      resetTimeout();
      if (chunk.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const err = processLine(line);
        if (err) return err;
        if (done) break;
      }
    }
    if (!done && buffer.trim()) {
      const err = processLine(buffer);
      if (err) return err;
    }
    await reader.cancel().catch(() => undefined);
    if (!receivedText && !token.isCancellationRequested) {
      return 'Model returned an empty response.';
    }
    return null;
  } catch (err) {
    if (token.isCancellationRequested) {
      return null;
    }
    if (timedOut) {
      return `API request to ${getHostLabel(baseUrl)} timed out.`;
    }
    return `Unable to reach ${getHostLabel(baseUrl)}: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (timer !== null) clearTimeout(timer);
    sub.dispose();
  }
}

export async function runAiTarget(
  target: LanguageModelTarget,
  prompt: string,
  onText: (delta: string) => void,
  token: vscode.CancellationToken,
): Promise<string | null> {
  const direct = getDirectAiConfig();
  if (direct) {
    if (direct.requiresApiKey && (await getApiKey(direct.provider)) === null) {
      return `API key not configured for ${direct.name}.`;
    }
    const apiKey = await getEffectiveApiKey(direct.provider);
    return streamChatCompletion(direct.baseUrl, target.id, apiKey, prompt, onText, token);
  }

  const vsLm = getVsCodeLmApi();
  if (!vsLm) {
    return t('aiUnavailable');
  }
  try {
    const models = await vsLm.lm.selectChatModels({ id: target.id });
    const model = models[0] ?? (await vsLm.lm.selectChatModels())[0];
    if (!model) {
      return t('aiUnavailable');
    }
    const response = await model.sendRequest(
      [vsLm.userMessage(prompt)],
      { justification: 'DocsView AI Assistant processes user-selected document excerpts and spreadsheet formulas.' },
      token,
    );
    for await (const chunk of response.text) {
      if (token.isCancellationRequested) {
        break;
      }
      onText(chunk);
    }
    return null;
  } catch (err) {
    if (token.isCancellationRequested) {
      return null;
    }
    return err instanceof Error ? err.message : String(err);
  }
}
