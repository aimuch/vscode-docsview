// Toolbar building blocks shared by every viewer. The appearance controls (theme,
// light/dark, language) are appended to every toolbar automatically.
import { el } from './api';
import { appearanceControls } from './appearance';
import { icons, type IconName } from './icons';

export function iconButton(icon: IconName, title: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { class: 'dv-btn dv-icon-btn', title });
  b.type = 'button';
  b.innerHTML = icons[icon];
  b.addEventListener('click', onClick);
  return b;
}

/** A toggle button (aria-pressed) with an icon. */
export function toggleButton(icon: IconName, title: string, onChange: (on: boolean) => void): {
  node: HTMLButtonElement;
  set(on: boolean): void;
} {
  const b = iconButton(icon, title, () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    set(on);
    onChange(on);
  });
  const set = (on: boolean) => {
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('dv-active', on);
  };
  set(false);
  return { node: b, set };
}

export interface Segmented<T extends string> {
  node: HTMLElement;
  value: T;
  set(value: T): void;
}

/** Group of mutually exclusive buttons. Items are [value, label] or [value, icon, title]. */
export function segmented<T extends string>(
  label: string,
  items: ([T, string] | [T, IconName, string])[],
  initial: T,
  onChange: (value: T) => void,
): Segmented<T> {
  const node = el('div', { class: 'dv-seg' });
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', label);
  const buttons = new Map<T, HTMLButtonElement>();
  for (const item of items) {
    const [value] = item;
    const b = el('button', { class: 'dv-seg-btn' });
    b.type = 'button';
    if (item.length === 3) {
      b.innerHTML = icons[item[1]];
      b.title = item[2];
      b.setAttribute('aria-label', item[2]);
      b.classList.add('dv-seg-icon');
    } else {
      b.textContent = item[1];
    }
    b.addEventListener('click', () => {
      if (value !== seg.value) {
        seg.set(value);
        onChange(value);
      }
    });
    buttons.set(value, b);
    node.append(b);
  }
  const seg: Segmented<T> = {
    node,
    value: initial,
    set(value: T) {
      seg.value = value;
      for (const [v, b] of buttons) {
        b.setAttribute('aria-pressed', String(v === value));
      }
    },
  };
  seg.set(initial);
  return seg;
}

export function divider(): HTMLElement {
  return el('div', { class: 'dv-divider' });
}

export function spacer(): HTMLElement {
  return el('div', { class: 'dv-spacer' });
}

/** Viewer-specific controls on the left, shared appearance controls on the right. */
export function toolbar(...nodes: (HTMLElement | 'spacer' | '|')[]): HTMLElement {
  const bar = el(
    'div',
    { class: 'dv-toolbar' },
    nodes.map((n) => (n === 'spacer' ? spacer() : n === '|' ? divider() : n)),
  );
  if (!nodes.includes('spacer')) {
    bar.append(spacer());
  }
  bar.append(...appearanceControls());
  return bar;
}
