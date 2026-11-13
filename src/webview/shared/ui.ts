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

// ---------------------------------------------------------------- "More" menu

export interface MenuItem {
  label: string | (() => string);
  hint?: string;
  /** Shows a check mark when true. */
  checked?: () => boolean;
  /** Hidden when this returns false. */
  visible?: () => boolean;
  onClick: () => void;
}

/** A "More" button with a drop-down of less frequent actions. Items are re-evaluated on every open. */
export function moreMenu(label: string, items: (MenuItem | "-")[]): HTMLElement {
  const button = el("button", { class: "dv-btn dv-more-btn", title: label });
  button.type = "button";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  const iconHolder = el("span", { class: "dv-more-icon" });
  iconHolder.innerHTML = icons.more;
  button.append(iconHolder, el("span", { text: label }));

  const menu = el("div", { class: "dv-menu dv-more-menu" });
  menu.setAttribute("role", "menu");
  menu.hidden = true;

  const close = () => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };

  const build = () => {
    const visible = items.filter((item) => item === "-" || item.visible?.() !== false);
    // No separators at the ends or next to each other once hidden items are gone.
    const cleaned = visible.filter(
      (item, i) => item !== "-" || (i > 0 && i < visible.length - 1 && visible[i - 1] !== "-"),
    );
    menu.replaceChildren(
      ...cleaned.map((item) => {
        if (item === "-") {
          return el("div", { class: "dv-menu-sep" });
        }
        const row = el("button", { class: "dv-menu-item" });
        row.type = "button";
        const checked = item.checked?.() ?? false;
        row.setAttribute("role", item.checked ? "menuitemcheckbox" : "menuitem");
        if (item.checked) {
          row.setAttribute("aria-checked", String(checked));
        }
        const mark = el("span", { class: "dv-menu-check" });
        if (checked) {
          mark.innerHTML = icons.check;
        }
        row.append(mark, el("span", { class: "dv-menu-label", text: typeof item.label === "function" ? item.label() : item.label }));
        if (item.hint) {
          row.append(el("span", { class: "dv-menu-hint-text", text: item.hint }));
        }
        row.addEventListener("click", () => {
          close();
          item.onClick();
        });
        return row;
      }),
    );
  };

  button.addEventListener("click", () => {
    if (!menu.hidden) {
      close();
      return;
    }
    build();
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    const rect = button.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    menu.querySelector<HTMLElement>(".dv-menu-item")?.focus();
  });
  menu.addEventListener("keydown", (e) => {
    const rows = [...menu.querySelectorAll<HTMLElement>(".dv-menu-item")];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      close();
      button.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (index + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      rows[next]?.focus();
    }
  });
  document.addEventListener("mousedown", (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node) && !button.contains(e.target as Node)) {
      close();
    }
  });
  document.body.append(menu);
  return button;
}
