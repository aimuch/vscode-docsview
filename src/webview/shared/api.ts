import type { HostMessage, WebviewConfig, WebviewMessage } from '../../common/protocol';
import { translate, type StringKey } from '../../common/strings';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

export const config: WebviewConfig = JSON.parse(
  document.querySelector<HTMLMetaElement>('meta[name="docsview-config"]')!.content,
);

export function t(key: StringKey, ...args: (string | number)[]): string {
  return translate(config.lang, key, ...args);
}

export function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}

export function onMessage(handler: (message: HostMessage) => void): void {
  window.addEventListener('message', (event) => {
    const data = event.data as HostMessage | undefined;
    if (data && typeof data === 'object' && typeof data.type === 'string') {
      handler(data);
    }
  });
}

export function getState<T>(): T | undefined {
  return vscode.getState() as T | undefined;
}

export function setState<T>(state: T): void {
  vscode.setState(state);
}

/** Effective scheme (the user's light/dark choice, else VS Code's theme); set by appearance.ts. */
export function isDark(): boolean {
  return document.body.classList.contains('dv-dark');
}

/** Calls back whenever the effective light/dark scheme may have changed. */
export function onThemeChange(handler: () => void): void {
  new MutationObserver(handler).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

export const app = document.getElementById('app')!;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; title?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) {
    node.className = props.class;
  }
  if (props.text !== undefined) {
    node.textContent = props.text;
  }
  if (props.title) {
    node.title = props.title;
    node.setAttribute('aria-label', props.title);
  }
  node.append(...children);
  return node;
}

export function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { class: 'dv-btn', text: label, title });
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** Full-pane status text (loading / error). */
export function showStatus(container: HTMLElement, message: string, isError = false): void {
  container.replaceChildren(el('div', { class: isError ? 'dv-status dv-error' : 'dv-status', text: message }));
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Copies bytes received from the host into a standalone ArrayBuffer (libraries may detach
 * or retain it). Accepts the shapes binary data can take after crossing postMessage: a
 * typed array, an ArrayBuffer, or a JSON-encoded Node Buffer / index-keyed object.
 */
export function toArrayBuffer(bytes: unknown): ArrayBuffer {
  let source: ArrayLike<number>;
  if (bytes instanceof ArrayBuffer) {
    source = new Uint8Array(bytes);
  } else if (ArrayBuffer.isView(bytes)) {
    source = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } else if (bytes && typeof bytes === 'object' && Array.isArray((bytes as { data?: unknown }).data)) {
    source = (bytes as { data: number[] }).data;
  } else if (bytes && typeof bytes === 'object') {
    source = Object.values(bytes as Record<string, number>);
  } else {
    source = [];
  }
  if (!source.length) {
    throw new Error('The file is empty or could not be transferred.');
  }
  const copy = new Uint8Array(source.length);
  copy.set(source);
  return copy.buffer;
}
