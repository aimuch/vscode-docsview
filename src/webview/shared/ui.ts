// Toolbar building blocks, customizable top bar layout, and the slide-over Settings Drawer.
import {
  DEFAULT_TOOLBAR,
  normalizeToolbarConfig,
  type AiProviderId,
  type AiSettingsSnapshot,
  type CoreToolbarItemId,
  type ToolbarConfig,
  type ToolbarItemId,
} from '../../common/protocol';
import type { StringKey } from '../../common/strings';
import { config, el, getState, onMessage, post, setState, t } from './api';
import {
  buildAppearanceDrawerSections,
  getAppearance,
  invertToggle,
  languageToolbarGroup,
  mdWidthToggle,
  onAppearanceChange,
  schemeToolbarGroup,
  themeToolbarButton,
  updateAppearance,
} from './appearance';
import { onFileState } from './fileState';
import { icons, type IconName } from './icons';
import { overlayStack } from './overlayStack';

export function iconButton(icon: IconName, title: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { class: 'dv-btn dv-icon-btn', title });
  b.type = 'button';
  b.innerHTML = icons[icon];
  b.addEventListener('click', onClick);
  return b;
}

export function openExternalButton(): HTMLButtonElement {
  return iconButton('external', t('openExternalApp'), () => post({ type: 'openExternalApp' }));
}

export function openExternalMenuItem(): MenuItem {
  return {
    id: 'openApp',
    slotId: 'openApp',
    icon: 'external',
    label: t('openExternalApp'),
    onClick: () => post({ type: 'openExternalApp' }),
  };
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

export interface NoticeBanner {
  node: HTMLElement;
  /** Sets or clears the standing informational message (hidden when dismissed or disabled). */
  setInfo(text: string): void;
  /** Shows a temporary warning for `ms`, even if the standing banner was dismissed. */
  flash(text: string, ms?: number): void;
}

/**
 * Dismissible informational banner (`.dv-notice`): clicking `×` hides it for the current
 * document; clicking "Don't show again" turns off `docsview.showNotices` globally.
 */
export function noticeBanner(initialInfo = ''): NoticeBanner {
  let infoText = initialInfo;
  let flashText = '';
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let dismissed = getState<{ noticeDismissed?: boolean }>()?.noticeDismissed === true;
  let lastGlobalShow = getAppearance().showNotices;

  const textEl = el('span', { class: 'dv-notice-text' });
  const muteBtn = el('button', { class: 'dv-notice-mute', text: t('dontShowAgain') });
  muteBtn.type = 'button';
  const closeBtn = iconButton('close', t('close'), () => {
    if (flashText) {
      clearTimeout(flashTimer);
      flashText = '';
    } else {
      dismissed = true;
      setState({ ...(getState<Record<string, unknown>>() ?? {}), noticeDismissed: true });
    }
    sync();
  });
  closeBtn.classList.add('dv-notice-close');

  const node = el('div', { class: 'dv-notice' }, [textEl, muteBtn, closeBtn]);

  function sync() {
    if (flashText) {
      textEl.textContent = flashText;
      muteBtn.hidden = true;
      node.hidden = false;
    } else if (infoText && !dismissed && getAppearance().showNotices) {
      textEl.textContent = infoText;
      muteBtn.hidden = false;
      node.hidden = false;
    } else {
      node.hidden = true;
    }
  }

  muteBtn.addEventListener('click', () => {
    updateAppearance({ showNotices: false });
  });

  onAppearanceChange((a) => {
    if (!lastGlobalShow && a.showNotices) {
      // Re-enabling notices in Settings brings back previously dismissed banners too.
      dismissed = false;
      setState({ ...(getState<Record<string, unknown>>() ?? {}), noticeDismissed: false });
    }
    lastGlobalShow = a.showNotices;
    sync();
  });

  sync();

  return {
    node,
    setInfo(text: string) {
      infoText = text;
      sync();
    },
    flash(text: string, ms = 3500) {
      flashText = text;
      clearTimeout(flashTimer);
      sync();
      flashTimer = setTimeout(() => {
        flashText = '';
        sync();
      }, ms);
    },
  };
}

// ---------------------------------------------------------------- dropdown action menu

export interface MenuItem {
  /** Stable identifier for reordering in "This Document" and registering a `doc:<id>` toolbar slot. */
  id?: string;
  /** Links this action to an existing core toolbar slot (e.g. `'ai'`, `'history'`, `'openApp'`) instead of creating a duplicate slot. */
  slotId?: ToolbarItemId;
  /** Optional custom toolbar widget node used when this action is pinned to the outer top toolbar. */
  toolbarNode?: HTMLElement;
  label: string | (() => string);
  hint?: string;
  /** Optional icon shown on action buttons in the drawer. */
  icon?: IconName;
  /** Shows a check mark when true. */
  checked?: () => boolean;
  /** Hidden when this returns false. */
  visible?: () => boolean;
  onClick: () => void;
}

let moreMenuSeq = 0;

/** A compact button with a drop-down menu of actions. Items are re-evaluated on every open. */
export function moreMenu(
  label: string,
  items: (MenuItem | '-')[],
  icon: IconName = 'more',
  opts: { compact?: boolean } = {},
): HTMLElement {
  const overlayId = `moreMenu-${++moreMenuSeq}`;
  const button = el('button', {
    class: opts.compact ? 'dv-btn dv-more-btn dv-more-compact' : 'dv-btn dv-more-btn',
    title: label,
  });
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const iconHolder = el('span', { class: 'dv-more-icon' });
  iconHolder.innerHTML = icons[icon];
  if (opts.compact) {
    const caret = el('span', { class: 'dv-more-caret' });
    caret.innerHTML = icons.chevronDown;
    button.append(iconHolder, caret);
  } else {
    button.append(iconHolder, el('span', { text: label }));
  }

  const menu = el('div', { class: 'dv-menu dv-more-menu' });
  menu.setAttribute('role', 'menu');
  menu.hidden = true;

  const onOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node) && !button.contains(e.target as Node)) {
      close();
    }
  };

  const close = () => {
    if (!menu.hidden) {
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onOutside);
      overlayStack.remove(overlayId);
    }
  };

  const build = () => {
    const visible = items.filter((item) => item === '-' || item.visible?.() !== false);
    const cleaned = visible.filter(
      (item, i) => item !== '-' || (i > 0 && i < visible.length - 1 && visible[i - 1] !== '-'),
    );
    menu.replaceChildren(
      ...cleaned.map((item) => {
        if (item === '-') {
          return el('div', { class: 'dv-menu-sep' });
        }
        const row = el('button', { class: 'dv-menu-item' });
        row.type = 'button';
        const checked = item.checked?.() ?? false;
        row.setAttribute('role', item.checked ? 'menuitemcheckbox' : 'menuitem');
        if (item.checked) {
          row.setAttribute('aria-checked', String(checked));
        }
        const mark = el('span', { class: 'dv-menu-check' });
        if (checked) {
          mark.innerHTML = icons.check;
        }
        row.append(
          mark,
          el('span', { class: 'dv-menu-label', text: typeof item.label === 'function' ? item.label() : item.label }),
        );
        if (item.hint) {
          row.append(el('span', { class: 'dv-menu-hint-text', text: item.hint }));
        }
        row.addEventListener('click', () => {
          close();
          item.onClick();
        });
        return row;
      }),
    );
  };

  button.addEventListener('click', () => {
    if (!menu.hidden) {
      close();
      return;
    }
    build();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onOutside);
    overlayStack.push({
      id: overlayId,
      isOpen: () => !menu.hidden,
      close,
      restoreFocus: () => button,
    });
    const rect = button.getBoundingClientRect();
    const mw = menu.offsetWidth || 270;
    const mh = menu.offsetHeight || 220;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, rect.right - mw))}px`;
    menu.style.right = 'auto';
    menu.style.top = `${Math.max(8, Math.min(window.innerHeight - mh - 8, rect.bottom + 6))}px`;
    menu.querySelector<HTMLElement>('.dv-menu-item')?.focus();
  });
  menu.addEventListener('keydown', (e) => {
    const rows = [...menu.querySelectorAll<HTMLElement>('.dv-menu-item')];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      close();
      button.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (index + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows[next]?.focus();
    }
  });
  document.body.append(menu);
  return button;
}

// ---------------------------------------------------------------- toolbar layout state

const SLOT_LABELS: Record<CoreToolbarItemId, StringKey> = {
  nav: 'slotNav',
  view: 'slotView',
  pager: 'slotPager',
  zoom: 'slotZoom',
  width: 'slotWidth',
  transform: 'slotTransform',
  bbox: 'slotBbox',
  cellBar: 'slotCellBar',
  find: 'slotFind',
  edit: 'slotEdit',
  comments: 'slotComments',
  openApp: 'slotOpenApp',
  highlight: 'slotHighlight',
  structure: 'slotStructure',
  ai: 'slotAi',
  actions: 'slotActions',
  history: 'slotHistory',
  rtl: 'slotRtl',
  theme: 'slotTheme',
  scheme: 'slotScheme',
  invertPages: 'slotInvert',
  language: 'slotLanguage',
};

let currentToolbar: ToolbarConfig = normalizeToolbarConfig(config.toolbar);
const toolbarListeners = new Set<(cfg: ToolbarConfig) => void>();

export function getToolbarConfig(): ToolbarConfig {
  return currentToolbar;
}

export function setToolbarConfig(next: ToolbarConfig, notifyHost = true): void {
  currentToolbar = normalizeToolbarConfig(next);
  toolbarListeners.forEach((l) => l(currentToolbar));
  if (notifyHost) {
    post({ type: 'setToolbar', toolbar: currentToolbar });
  }
}

onMessage((message) => {
  if (message.type === 'toolbar') {
    currentToolbar = normalizeToolbarConfig(message.toolbar);
    toolbarListeners.forEach((l) => l(currentToolbar));
  }
});

// ---------------------------------------------------------------- shared AI settings state

let currentAiSettings: AiSettingsSnapshot | undefined;
let currentAiModels: string[] = [];
const aiSettingsListeners = new Set<() => void>();

export function getAiSettings(): { settings: AiSettingsSnapshot | undefined; models: readonly string[] } {
  return { settings: currentAiSettings, models: currentAiModels };
}

export function onAiSettingsChange(listener: () => void): () => void {
  aiSettingsListeners.add(listener);
  return () => aiSettingsListeners.delete(listener);
}

onMessage((message) => {
  if (message.type === 'aiSettings') {
    currentAiSettings = message.settings;
    if (message.models !== undefined) {
      currentAiModels = message.models;
    }
    aiSettingsListeners.forEach((l) => l());
  }
});

/**
 * Merges a viewer's local ordering (`desired` subset of `supported`) back into `globalList`,
 * keeping slots that belong to other formats anchored next to their neighbours.
 */
function mergeZone(
  globalList: readonly ToolbarItemId[],
  supported: ReadonlySet<ToolbarItemId>,
  desired: readonly ToolbarItemId[],
): ToolbarItemId[] {
  const desiredSet = new Set(desired);
  const beforeMap = new Map<ToolbarItemId, ToolbarItemId[]>();
  let pendingForeign: ToolbarItemId[] = [];
  for (const id of globalList) {
    if (!supported.has(id)) {
      pendingForeign.push(id);
    } else if (desiredSet.has(id)) {
      if (pendingForeign.length) {
        beforeMap.set(id, pendingForeign);
        pendingForeign = [];
      }
    }
  }
  const out: ToolbarItemId[] = [];
  for (const id of desired) {
    const before = beforeMap.get(id);
    if (before) {
      out.push(...before);
    }
    out.push(id);
  }
  if (pendingForeign.length) {
    out.push(...pendingForeign);
  }
  return out;
}

// ---------------------------------------------------------------- customizable toolbar & Settings Drawer

export interface ToolbarSlot {
  id: ToolbarItemId;
  label?: string;
  nodes: HTMLElement[];
  /** Optional runtime predicate (e.g. hide CSV row/col buttons on Excel). */
  visible?: () => boolean;
}

export interface DrawerOption {
  /** Optional linked toolbar slot ID so "Configure" in Unpinned items can jump straight to this option. */
  slotId?: ToolbarItemId;
  label: string | (() => string);
  checked: () => boolean;
  visible?: () => boolean;
  onChange: (checked: boolean) => void;
}

export interface CustomToolbarOptions {
  slots: ToolbarSlot[];
  /** Extra status/indicator elements always shown after the left slots (e.g. active filter chip). */
  extraLeft?: HTMLElement[];
  /** Action buttons shown under "This Document" in the Settings Drawer. */
  documentActions?: MenuItem[];
  /** Checkboxes shown under "This Document" in the Settings Drawer. */
  documentOptions?: DrawerOption[];
  /** Subtitle shown in the drawer header (format or file name). */
  subtitle?: string | (() => string);
}

export interface CustomToolbar {
  node: HTMLElement;
  /** Re-evaluates slot visibility and refreshes the drawer if open. */
  refresh(): void;
  openDrawer(): void;
  closeDrawer(): void;
  dispose(): void;
}

const PAGED_KINDS = new Set(['docx', 'pdf', 'text']);

export function customToolbar(opts: CustomToolbarOptions): CustomToolbar {
  const slotMap = new Map<ToolbarItemId, { spec: ToolbarSlot; wrap: HTMLElement }>();
  const slotActionHandlers = new Map<ToolbarItemId, () => void>();
  const register = (spec: ToolbarSlot) => {
    if (slotMap.has(spec.id)) {
      return;
    }
    const wrap = el('div', { class: 'dv-slot' }, spec.nodes);
    wrap.dataset.slot = spec.id;
    slotMap.set(spec.id, { spec, wrap });
  };

  for (const s of opts.slots) {
    register(s);
  }

  // Resolve each "This Document" action to its toolbar slot so every document feature
  // can be toggled outside on the top toolbar and reordered independently.
  const resolveMenuLabel = (item: MenuItem): string =>
    typeof item.label === 'function' ? item.label() : item.label;
  const actionKeyOf = (item: MenuItem, idx: number): string => item.id ?? item.slotId ?? `idx-${idx}`;
  const actionSlotOf = (item: MenuItem): ToolbarItemId | undefined =>
    item.slotId ?? (item.id ? (`doc:${item.id}` as ToolbarItemId) : undefined);

  for (const item of opts.documentActions ?? []) {
    const slotId = actionSlotOf(item);
    if (!slotId) {
      continue;
    }
    if (!slotActionHandlers.has(slotId)) {
      slotActionHandlers.set(slotId, item.onClick);
    }
    if (!slotMap.has(slotId)) {
      const label = resolveMenuLabel(item);
      const node = item.toolbarNode ?? iconButton(item.icon ?? 'more', label, item.onClick);
      register({
        id: slotId,
        label,
        nodes: [node],
        visible: item.visible,
      });
    }
  }

  // Automatically register shared appearance/language slots supported by this viewer.
  if (config.kind === 'markdown' || config.kind === 'epub') {
    register({ id: 'width', nodes: [mdWidthToggle()] });
    register({ id: 'theme', nodes: [themeToolbarButton()] });
  }
  if (PAGED_KINDS.has(config.kind)) {
    register({ id: 'invertPages', nodes: [invertToggle()] });
  }
  register({ id: 'scheme', nodes: [schemeToolbarGroup()] });
  register({ id: 'language', nodes: [languageToolbarGroup()] });

  const supportedIds = new Set<ToolbarItemId>(slotMap.keys());
  const leftZone = el('div', { class: 'dv-zone dv-zone-left' });
  const rightZone = el('div', { class: 'dv-zone dv-zone-right' });

  const gearBtn = iconButton('gear', t('settings'), () => {
    if (drawerOpen) {
      closeDrawer();
    } else {
      openDrawer();
    }
  });
  gearBtn.classList.add('dv-settings-btn');
  gearBtn.setAttribute('aria-haspopup', 'dialog');
  gearBtn.setAttribute('aria-expanded', 'false');

  const rightSep = divider();
  const overflowPop = el('div', { class: 'dv-menu dv-overflow-popover' });
  overflowPop.setAttribute('role', 'dialog');
  overflowPop.setAttribute('aria-label', t('moreTools'));
  overflowPop.hidden = true;

  const closeOverflow = () => {
    if (!overflowPop.hidden) {
      overflowPop.hidden = true;
      overflowBtn.setAttribute('aria-expanded', 'false');
      overflowBtn.classList.remove('dv-active');
      document.removeEventListener('mousedown', onOverflowOutside);
      overlayStack.remove('toolbarOverflow');
    }
  };
  const onOverflowOutside = (e: MouseEvent) => {
    const target = e.target as Element | null;
    if (target?.closest?.('.dv-more-menu')) {
      return;
    }
    if (!overflowPop.contains(target) && !overflowBtn.contains(target)) {
      closeOverflow();
    }
  };

  const openOverflow = () => {
    if (!overflowPop.isConnected) {
      document.body.append(overflowPop);
    }
    overflowPop.hidden = false;
    overflowBtn.setAttribute('aria-expanded', 'true');
    overflowBtn.classList.add('dv-active');
    document.addEventListener('mousedown', onOverflowOutside);
    overlayStack.push({
      id: 'toolbarOverflow',
      isOpen: () => !overflowPop.hidden,
      close: closeOverflow,
      restoreFocus: () => overflowBtn,
    });
    const rect = overflowBtn.getBoundingClientRect();
    overflowPop.style.top = `${Math.min(window.innerHeight - 160, rect.bottom + 6)}px`;
    overflowPop.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    overflowPop.querySelector<HTMLElement>('button:not([disabled])')?.focus();
  };

  const overflowBtn = iconButton('chevronsRight', t('moreTools'), () => {
    if (!overflowPop.hidden) {
      closeOverflow();
      return;
    }
    openOverflow();
  });
  overflowBtn.classList.add('dv-overflow-btn');
  overflowBtn.setAttribute('aria-haspopup', 'dialog');
  overflowBtn.setAttribute('aria-expanded', 'false');
  overflowBtn.hidden = true;

  const bar = el('div', { class: 'dv-toolbar' }, [
    leftZone,
    ...(opts.extraLeft ?? []),
    spacer(),
    rightZone,
    overflowBtn,
    rightSep,
    gearBtn,
  ]);

  function slotVisible(entry: { spec: ToolbarSlot; wrap: HTMLElement }): boolean {
    if (entry.spec.visible && !entry.spec.visible()) {
      return false;
    }
    return entry.spec.nodes.some((n) => !n.hidden);
  }

  function fillZone(zoneEl: HTMLElement, ids: readonly ToolbarItemId[]): number {
    const children: HTMLElement[] = [];
    let count = 0;
    for (const id of ids) {
      const entry = slotMap.get(id);
      if (!entry || !slotVisible(entry)) {
        continue;
      }
      if (count > 0) {
        children.push(divider());
      }
      children.push(entry.wrap);
      count++;
    }
    zoneEl.replaceChildren(...children);
    zoneEl.hidden = count === 0;
    return count;
  }

  function fitOverflow(): void {
    if (!bar.isConnected || bar.clientWidth <= 0) {
      return;
    }
    if (bar.scrollWidth <= bar.clientWidth + 2) {
      return;
    }
    overflowBtn.hidden = false;
    const moved: HTMLElement[] = [];
    const popFrom = (zoneEl: HTMLElement, minKeep: number): HTMLElement | undefined => {
      const slotsInZone = zoneEl.querySelectorAll<HTMLElement>(':scope > .dv-slot');
      if (slotsInZone.length <= minKeep) {
        return undefined;
      }
      const last = slotsInZone[slotsInZone.length - 1];
      const prev = last.previousElementSibling;
      last.remove();
      if (prev?.classList.contains('dv-divider')) {
        prev.remove();
      }
      zoneEl.hidden = zoneEl.childElementCount === 0;
      return last;
    };

    let guard = 32;
    while (bar.scrollWidth > bar.clientWidth + 2 && guard-- > 0) {
      const popped = popFrom(leftZone, 1) ?? popFrom(rightZone, 0);
      if (!popped) {
        break;
      }
      moved.unshift(popped);
    }
    if (!moved.length) {
      overflowBtn.hidden = true;
      return;
    }
    rightSep.hidden = false;
    overflowPop.replaceChildren(...moved);
  }

  function reconcileBar(): void {
    closeOverflow();
    overflowPop.replaceChildren();
    overflowBtn.hidden = true;
    fillZone(leftZone, currentToolbar.left);
    const rightCount = fillZone(rightZone, currentToolbar.right);
    rightSep.hidden = rightCount === 0;
    fitOverflow();
  }

  let lastObservedW = 0;
  const ro =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          const w = bar.clientWidth;
          if (w > 0 && Math.abs(w - lastObservedW) >= 4) {
            lastObservedW = w;
            if (overflowPop.hidden) {
              reconcileBar();
            }
          }
        })
      : undefined;
  ro?.observe(bar);

  // Dynamic child widgets (e.g. collapsible Find capsule) notify the bar on size/visibility changes.
  bar.addEventListener('dv:slot-change', (ev) => {
    reconcileBar();
    const wantVisible = (ev as CustomEvent<{ ensureVisible?: boolean }>).detail?.ensureVisible;
    const target = ev.target as Node | null;
    if (wantVisible && target && overflowPop.contains(target) && overflowPop.hidden) {
      openOverflow();
    }
  });
  overflowPop.addEventListener('dv:slot-change', (ev) => {
    const wantVisible = (ev as CustomEvent<{ ensureVisible?: boolean }>).detail?.ensureVisible;
    if (wantVisible && overflowPop.hidden) {
      openOverflow();
    } else if (!wantVisible) {
      reconcileBar();
    }
  });

  // -------------------------------------------------------------- Settings Drawer (Git Map style)

  const backdrop = el('div', { class: 'dv-st-backdrop' });
  backdrop.hidden = true;

  const drawer = el('aside', { class: 'dv-st-drawer' });
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.setAttribute('aria-label', t('settings'));
  drawer.hidden = true;

  const subtitleEl = el('span', { class: 'dv-st-subtitle' });
  const closeBtn = iconButton('close', t('close'), () => {
    closeDrawer();
    gearBtn.focus();
  });
  closeBtn.classList.add('dv-st-close');

  const headerEl = el('div', { class: 'dv-st-header' }, [
    el('h2', { class: 'dv-st-title', text: t('settings') }),
    subtitleEl,
    closeBtn,
  ]);
  const contentEl = el('div', { class: 'dv-st-content' });
  const openExtLink = el('button', { class: 'dv-st-link', text: t('openExtSettings') });
  openExtLink.type = 'button';
  openExtLink.addEventListener('click', () => post({ type: 'openSettings' }));
  const footerEl = el('div', { class: 'dv-st-footer' }, [
    el('span', { class: 'dv-st-hint', text: t('appearanceHint') }),
    openExtLink,
  ]);

  drawer.append(headerEl, contentEl, footerEl);

  let drawerOpen = false;
  let draggingId: ToolbarItemId | undefined;

  const onKeyDown = (e: KeyboardEvent) => {
    if (!drawerOpen) {
      return;
    }
    if (e.key === 'Tab') {
      const focusables = [
        ...drawer.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((n) => !n.hidden && !n.closest('[hidden]'));
      if (!focusables.length) {
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (!activeEl || !drawer.contains(activeEl)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  backdrop.addEventListener('mousedown', () => closeDrawer());

  let docCustomizeMode = false;
  let draggingDocKey: string | undefined;

  function slotTitle(id: ToolbarItemId): string {
    const custom = slotMap.get(id)?.spec.label;
    if (custom) {
      return custom;
    }
    const key = SLOT_LABELS[id as CoreToolbarItemId];
    return key ? t(key) : id;
  }

  function isSlotPinned(id: ToolbarItemId): boolean {
    return currentToolbar.left.includes(id) || currentToolbar.right.includes(id);
  }

  function localZones(): { left: ToolbarItemId[]; right: ToolbarItemId[]; hidden: ToolbarItemId[] } {
    const left = currentToolbar.left.filter((id) => supportedIds.has(id));
    const right = currentToolbar.right.filter((id) => supportedIds.has(id));
    const pinned = new Set<ToolbarItemId>([...left, ...right]);
    const hidden = [...supportedIds].filter((id) => !pinned.has(id));
    return { left, right, hidden };
  }

  function applyLocalZones(
    nextLeft: ToolbarItemId[],
    nextRight: ToolbarItemId[],
    nextDocOrder: Record<string, string[]> | undefined = currentToolbar.docActionOrder,
  ): void {
    const next: ToolbarConfig = {
      left: mergeZone(currentToolbar.left, supportedIds, nextLeft),
      right: mergeZone(currentToolbar.right, supportedIds, nextRight),
    };
    if (nextDocOrder && Object.keys(nextDocOrder).length) {
      next.docActionOrder = nextDocOrder;
    }
    setToolbarConfig(next);
  }

  function moveItem(
    id: ToolbarItemId,
    targetZone: 'left' | 'right' | 'hidden',
    targetIndex?: number,
  ): void {
    const { left, right } = localZones();
    const nextLeft = left.filter((x) => x !== id);
    const nextRight = right.filter((x) => x !== id);
    if (targetZone === 'left') {
      const idx = targetIndex === undefined ? nextLeft.length : Math.max(0, Math.min(nextLeft.length, targetIndex));
      nextLeft.splice(idx, 0, id);
    } else if (targetZone === 'right') {
      const idx = targetIndex === undefined ? nextRight.length : Math.max(0, Math.min(nextRight.length, targetIndex));
      nextRight.splice(idx, 0, id);
    }
    applyLocalZones(nextLeft, nextRight);
  }

  function shiftInZone(zone: 'left' | 'right', id: ToolbarItemId, delta: -1 | 1): void {
    const { left, right } = localZones();
    const list = zone === 'left' ? [...left] : [...right];
    const idx = list.indexOf(id);
    const swap = idx + delta;
    if (idx < 0 || swap < 0 || swap >= list.length) {
      return;
    }
    [list[idx], list[swap]] = [list[swap], list[idx]];
    if (zone === 'left') {
      applyLocalZones(list, right);
    } else {
      applyLocalZones(left, list);
    }
  }

  function buildZoneList(zone: 'left' | 'right', items: ToolbarItemId[]): HTMLElement {
    const listEl = el('div', { class: 'dv-tb-list' });
    listEl.dataset.zone = zone;

    listEl.addEventListener('dragover', (e) => {
      if (!draggingId) {
        return;
      }
      e.preventDefault();
      listEl.classList.add('dv-tb-dragover');
    });
    listEl.addEventListener('dragleave', (e) => {
      if (!listEl.contains(e.relatedTarget as Node | null)) {
        listEl.classList.remove('dv-tb-dragover');
      }
    });
    listEl.addEventListener('drop', (e) => {
      e.preventDefault();
      listEl.classList.remove('dv-tb-dragover');
      if (!draggingId) {
        return;
      }
      const id = draggingId;
      draggingId = undefined;
      moveItem(id, zone);
    });

    if (!items.length) {
      listEl.append(el('div', { class: 'dv-tb-empty', text: t('toolbarEmptyZone') }));
      return listEl;
    }

    items.forEach((id, index) => {
      const row = el('div', { class: 'dv-tb-item' });
      row.dataset.slotId = id;
      row.draggable = true;

      const handle = el('span', { class: 'dv-tb-grip' });
      handle.innerHTML = icons.grip;
      const name = el('span', { class: 'dv-tb-name', text: slotTitle(id) });

      const switchZoneBtn = iconButton(
        zone === 'left' ? 'right' : 'left',
        t(zone === 'left' ? 'toRight' : 'toLeft'),
        () => moveItem(id, zone === 'left' ? 'right' : 'left'),
      );
      switchZoneBtn.classList.add('dv-tb-mini');

      const upBtn = iconButton('up', t('moveUp'), () => shiftInZone(zone, id, -1));
      upBtn.classList.add('dv-tb-mini');
      upBtn.disabled = index === 0;

      const downBtn = iconButton('down', t('moveDown'), () => shiftInZone(zone, id, 1));
      downBtn.classList.add('dv-tb-mini');
      downBtn.disabled = index === items.length - 1;

      const hideBtn = iconButton('close', t('removeFromBar'), () => moveItem(id, 'hidden'));
      hideBtn.classList.add('dv-tb-mini');

      row.append(handle, name, el('span', { class: 'dv-tb-btns' }, [switchZoneBtn, upBtn, downBtn, hideBtn]));

      row.addEventListener('dragstart', (e) => {
        draggingId = id;
        row.classList.add('dv-tb-dragging');
        e.dataTransfer?.setData('text/plain', id);
      });
      row.addEventListener('dragend', () => {
        draggingId = undefined;
        row.classList.remove('dv-tb-dragging');
      });
      row.addEventListener('dragover', (e) => {
        if (!draggingId || draggingId === id) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        const rect = row.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        row.classList.toggle('dv-drop-before', before);
        row.classList.toggle('dv-drop-after', !before);
      });
      row.addEventListener('dragleave', () => {
        row.classList.remove('dv-drop-before', 'dv-drop-after');
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = row.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        row.classList.remove('dv-drop-before', 'dv-drop-after');
        listEl.classList.remove('dv-tb-dragover');
        if (!draggingId || draggingId === id) {
          return;
        }
        const dragged = draggingId;
        draggingId = undefined;
        // Adjust target index when moving downward within the same zone.
        const currentInZone = items.indexOf(dragged);
        let targetIdx = before ? index : index + 1;
        if (currentInZone >= 0 && currentInZone < targetIdx) {
          targetIdx--;
        }
        moveItem(dragged, zone, targetIdx);
      });

      listEl.append(row);
    });

    return listEl;
  }

  const SETTING_SLOTS = new Set<ToolbarItemId>([
    'theme',
    'width',
    'scheme',
    'invertPages',
    'language',
    'rtl',
    'highlight',
    'edit',
  ]);

  function focusDrawerSetting(slotId: ToolbarItemId): boolean {
    const target = contentEl.querySelector<HTMLElement>(`[data-setting-slot="${slotId}"]`);
    if (!target) {
      return false;
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('dv-st-flash');
    void target.offsetWidth;
    target.classList.add('dv-st-flash');
    setTimeout(() => target.classList.remove('dv-st-flash'), 1500);
    return true;
  }

  function invokeSlotDirectly(slotId: ToolbarItemId): void {
    const handler = slotActionHandlers.get(slotId);
    if (handler) {
      closeDrawer();
      handler();
      return;
    }
    const entry = slotMap.get(slotId);
    if (!entry) {
      return;
    }
    closeDrawer();
    const btn = entry.spec.nodes
      .flatMap((n) => (n instanceof HTMLButtonElement ? [n] : [...n.querySelectorAll<HTMLButtonElement>('button')]))
      .find((b) => !b.hidden && !b.disabled);
    btn?.click();
  }

  function buildToolbarSection(): HTMLElement {
    const { left, right, hidden } = localZones();
    const resetBtn = el('button', { class: 'dv-st-action-btn dv-tb-reset', text: t('toolbarReset') });
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', () => {
      setToolbarConfig({ left: [...DEFAULT_TOOLBAR.left], right: [...DEFAULT_TOOLBAR.right] });
    });

    const head = el('div', { class: 'dv-st-head-row' }, [
      el('h3', { class: 'dv-st-heading', text: t('toolbarSection') }),
      resetBtn,
    ]);

    const zonesGrid = el('div', { class: 'dv-tb-zones' }, [
      el('div', { class: 'dv-tb-col' }, [
        el('div', { class: 'dv-tb-col-title', text: t('toolbarLeft') }),
        buildZoneList('left', left),
      ]),
      el('div', { class: 'dv-tb-col' }, [
        el('div', { class: 'dv-tb-col-title', text: t('toolbarRight') }),
        buildZoneList('right', right),
        el('div', { class: 'dv-st-muted dv-tb-pin-note', text: t('settingsPinnedHint') }),
      ]),
    ]);

    const children: HTMLElement[] = [head, zonesGrid];

    // Avoid duplicating doc:* actions already shown with pin controls inside "This Document".
    const poolIds = hidden.filter((id) => !id.startsWith('doc:'));
    if (poolIds.length) {
      const pool = el('div', { class: 'dv-tb-pool' });
      const DIRECT_BTN_SLOTS = new Set<ToolbarItemId>(['nav', 'find', 'comments']);
      for (const id of poolIds) {
        const chip = el('div', { class: 'dv-tb-pool-item' });
        chip.dataset.slotId = id;
        chip.draggable = true;
        chip.addEventListener('dragstart', (e) => {
          draggingId = id;
          e.dataTransfer?.setData('text/plain', id);
        });
        chip.addEventListener('dragend', () => {
          draggingId = undefined;
        });

        const isSettingSlot = SETTING_SLOTS.has(id);
        const canDirectRun = slotActionHandlers.has(id) || DIRECT_BTN_SLOTS.has(id);
        const btns: HTMLElement[] = [];
        if (isSettingSlot || canDirectRun) {
          const useBtn = el('button', {
            class: 'dv-tb-use-btn',
            text: isSettingSlot ? t('toolbarGoSetting') : t('toolbarUseNow'),
            title: isSettingSlot ? t('toolbarGoSetting') : t('toolbarUseNow'),
          });
          useBtn.type = 'button';
          useBtn.addEventListener('click', () => {
            if (isSettingSlot && focusDrawerSetting(id)) {
              return;
            }
            if (canDirectRun) {
              invokeSlotDirectly(id);
            }
          });
          btns.push(useBtn);
        }

        const addLeft = el('button', { class: 'dv-tb-pin-btn', text: t('pinLeft'), title: t('toLeft') });
        addLeft.type = 'button';
        addLeft.addEventListener('click', () => moveItem(id, 'left'));

        const addRight = el('button', { class: 'dv-tb-pin-btn', text: t('pinRight'), title: t('toRight') });
        addRight.type = 'button';
        addRight.addEventListener('click', () => moveItem(id, 'right'));
        btns.push(addLeft, addRight);

        chip.append(
          el('span', { class: 'dv-tb-name', text: slotTitle(id) }),
          el('span', { class: 'dv-tb-btns' }, btns),
        );
        pool.append(chip);
      }
      children.push(
        el('div', { class: 'dv-tb-col-title', text: t('toolbarHidden') }),
        el('div', { class: 'dv-st-muted dv-tb-hidden-hint', text: t('toolbarHiddenHint') }),
        pool,
      );
    }

    return el('section', { class: 'dv-st-section' }, children);
  }

  function orderedDocumentActions(): { key: string; slotId?: ToolbarItemId; item: MenuItem }[] {
    const raw = (opts.documentActions ?? [])
      .map((item, idx) => ({ key: actionKeyOf(item, idx), slotId: actionSlotOf(item), item }))
      .filter((entry) => entry.item.visible?.() !== false);
    const saved = currentToolbar.docActionOrder?.[config.kind];
    if (!saved?.length) {
      return raw;
    }
    const rank = new Map(saved.map((k, i) => [k, i]));
    return [...raw].sort((a, b) => {
      const ra = rank.has(a.key) ? rank.get(a.key)! : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.key) ? rank.get(b.key)! : Number.MAX_SAFE_INTEGER;
      return ra - rb;
    });
  }

  function saveDocActionOrder(nextKeys: string[], syncPinnedSlots = true): void {
    const nextMap: Record<string, string[]> = { ...(currentToolbar.docActionOrder ?? {}), [config.kind]: nextKeys };
    let { left, right } = localZones();
    if (syncPinnedSlots) {
      // Keep pinned document-action slots in the same relative order inside their outer toolbar zone.
      const keyToSlot = new Map<string, ToolbarItemId>();
      (opts.documentActions ?? []).forEach((item, idx) => {
        const s = actionSlotOf(item);
        if (s) {
          keyToSlot.set(actionKeyOf(item, idx), s);
        }
      });
      const desiredSlots = nextKeys.map((k) => keyToSlot.get(k)).filter((s): s is ToolbarItemId => Boolean(s));
      const desiredSet = new Set<ToolbarItemId>(desiredSlots);
      const reorderZone = (zone: ToolbarItemId[]): ToolbarItemId[] => {
        const inZone = desiredSlots.filter((s) => zone.includes(s));
        let cursor = 0;
        return zone.map((id) => (desiredSet.has(id) ? (inZone[cursor++] ?? id) : id));
      };
      left = reorderZone(left);
      right = reorderZone(right);
    }
    applyLocalZones(left, right, nextMap);
  }

  function inferOptionSlotId(opt: DrawerOption, labelText: string): ToolbarItemId | undefined {
    if (opt.slotId) {
      return opt.slotId;
    }
    if (labelText === t('rtl')) return 'rtl';
    if (labelText === t('highlightRowCol')) return 'highlight';
    if (labelText === t('editMode') || labelText === t('lockEdits')) return 'edit';
    return undefined;
  }

  function buildDocumentSection(): HTMLElement | undefined {
    const visibleEntries = orderedDocumentActions();
    const visibleOptions = (opts.documentOptions ?? []).filter((o) => o.visible?.() !== false);
    if (!visibleEntries.length && !visibleOptions.length) {
      return undefined;
    }

    const headChildren: HTMLElement[] = [el('h3', { class: 'dv-st-heading', text: t('thisDocument') })];
    if (visibleEntries.length) {
      const manageBtn = el('button', {
        class: docCustomizeMode ? 'dv-st-action-btn dv-tb-reset dv-active' : 'dv-st-action-btn dv-tb-reset',
        text: docCustomizeMode ? t('docCustomizeDone') : t('docCustomize'),
      });
      manageBtn.type = 'button';
      manageBtn.addEventListener('click', () => {
        docCustomizeMode = !docCustomizeMode;
        renderDrawer();
      });
      headChildren.push(manageBtn);
    }
    const children: HTMLElement[] = [el('div', { class: 'dv-st-head-row' }, headChildren)];

    if (visibleEntries.length && !docCustomizeMode) {
      const actionGrid = el(
        'div',
        { class: 'dv-st-actions' },
        visibleEntries.map(({ key, slotId, item }) => {
          const btn = el('button', { class: 'dv-st-action-btn' });
          btn.type = 'button';
          if (item.icon) {
            const ic = el('span', { class: 'dv-st-action-icon' });
            ic.innerHTML = icons[item.icon];
            btn.append(ic);
          }
          btn.append(el('span', { text: resolveMenuLabel(item) }));
          if (item.hint) {
            btn.append(el('span', { class: 'dv-st-muted', text: `(${item.hint})` }));
          }
          btn.addEventListener('click', () => {
            closeDrawer();
            item.onClick();
          });

          if (!slotId || !supportedIds.has(slotId)) {
            return btn;
          }
          const pinned = isSlotPinned(slotId);
          const pinBtn = el('button', {
            class: pinned ? 'dv-st-action-pin dv-pinned' : 'dv-st-action-pin',
            title: pinned ? t('docUnpinOutside') : t('docPinOutside'),
          });
          pinBtn.type = 'button';
          pinBtn.setAttribute('aria-pressed', String(pinned));
          pinBtn.setAttribute('aria-label', pinned ? t('docUnpinOutside') : t('docPinOutside'));
          pinBtn.innerHTML = icons.pin;
          pinBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            moveItem(slotId, pinned ? 'hidden' : 'left');
          });
          const pill = el('span', { class: 'dv-st-action-pill' }, [btn, pinBtn]);
          pill.dataset.docAction = key;
          return pill;
        }),
      );
      children.push(actionGrid);
    } else if (visibleEntries.length && docCustomizeMode) {
      children.push(el('div', { class: 'dv-st-muted dv-tb-hidden-hint', text: t('docOrderHint') }));
      const list = el('div', { class: 'dv-tb-list dv-st-doc-list' });
      const keys = visibleEntries.map((e) => e.key);

      const moveDocKey = (fromKey: string, toIdx: number) => {
        const next = keys.filter((k) => k !== fromKey);
        const clamped = Math.max(0, Math.min(next.length, toIdx));
        next.splice(clamped, 0, fromKey);
        saveDocActionOrder(next);
      };

      visibleEntries.forEach(({ key, slotId, item }, index) => {
        const row = el('div', { class: 'dv-tb-item dv-st-doc-row' });
        row.dataset.docAction = key;
        row.draggable = true;

        const grip = el('span', { class: 'dv-tb-grip' });
        grip.innerHTML = icons.grip;

        const labelWrap = el('span', { class: 'dv-tb-name' });
        if (item.icon) {
          const ic = el('span', { class: 'dv-st-action-icon' });
          ic.innerHTML = icons[item.icon];
          labelWrap.append(ic);
        }
        labelWrap.append(el('span', { text: resolveMenuLabel(item) }));

        const controls: HTMLElement[] = [];
        if (slotId && supportedIds.has(slotId)) {
          const pinned = isSlotPinned(slotId);
          const pinToggle = el('button', {
            class: pinned ? 'dv-tb-pin-btn dv-pinned' : 'dv-tb-pin-btn',
            title: pinned ? t('docUnpinOutside') : t('docPinOutside'),
          });
          pinToggle.type = 'button';
          pinToggle.setAttribute('aria-pressed', String(pinned));
          pinToggle.innerHTML = icons.pin;
          pinToggle.addEventListener('click', () => moveItem(slotId, pinned ? 'hidden' : 'left'));
          controls.push(pinToggle);
        }

        const upBtn = iconButton('up', t('moveUp'), () => moveDocKey(key, index - 1));
        upBtn.classList.add('dv-tb-mini');
        upBtn.disabled = index === 0;

        const downBtn = iconButton('down', t('moveDown'), () => moveDocKey(key, index + 1));
        downBtn.classList.add('dv-tb-mini');
        downBtn.disabled = index === visibleEntries.length - 1;

        controls.push(upBtn, downBtn);
        row.append(grip, labelWrap, el('span', { class: 'dv-tb-btns' }, controls));

        row.addEventListener('dragstart', (e) => {
          draggingDocKey = key;
          row.classList.add('dv-tb-dragging');
          e.dataTransfer?.setData('text/plain', key);
        });
        row.addEventListener('dragend', () => {
          draggingDocKey = undefined;
          row.classList.remove('dv-tb-dragging');
        });
        row.addEventListener('dragover', (e) => {
          if (!draggingDocKey || draggingDocKey === key) return;
          e.preventDefault();
          const rect = row.getBoundingClientRect();
          const before = e.clientY < rect.top + rect.height / 2;
          row.classList.toggle('dv-drop-before', before);
          row.classList.toggle('dv-drop-after', !before);
        });
        row.addEventListener('dragleave', () => {
          row.classList.remove('dv-drop-before', 'dv-drop-after');
        });
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          const rect = row.getBoundingClientRect();
          const before = e.clientY < rect.top + rect.height / 2;
          row.classList.remove('dv-drop-before', 'dv-drop-after');
          if (!draggingDocKey || draggingDocKey === key) return;
          const dragged = draggingDocKey;
          draggingDocKey = undefined;
          const curIdx = keys.indexOf(dragged);
          let targetIdx = before ? index : index + 1;
          if (curIdx >= 0 && curIdx < targetIdx) targetIdx--;
          moveDocKey(dragged, targetIdx);
        });

        list.append(row);
      });
      children.push(list);
    }

    if (visibleOptions.length) {
      const optList = el(
        'div',
        { class: 'dv-st-options' },
        visibleOptions.map((opt) => {
          const box = el('input');
          box.type = 'checkbox';
          box.checked = opt.checked();
          box.addEventListener('change', () => {
            opt.onChange(box.checked);
            reconcileBar();
          });
          const labelText = typeof opt.label === 'function' ? opt.label() : opt.label;
          const row = el('label', { class: 'dv-check' }, [box, el('span', { text: labelText })]);
          const inferredSlot = inferOptionSlotId(opt, labelText);
          if (inferredSlot) {
            row.dataset.settingSlot = inferredSlot;
          }
          return row;
        }),
      );
      children.push(optList);
    }

    return el('section', { class: 'dv-st-section' }, children);
  }

  let aiDatalistSeq = 0;

  function buildAiProviderSection(): HTMLElement {
    const snap = currentAiSettings;
    const provider: AiProviderId = snap?.provider ?? 'VS Code';
    const presets = snap?.presets ?? [
      { id: 'VS Code' as const, name: 'VS Code (Copilot / LM API)', defaultBaseUrl: '', defaultModel: '', requiresApiKey: false },
      { id: 'DeepSeek' as const, name: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-chat', requiresApiKey: true },
      { id: 'Kimi' as const, name: 'Kimi (Moonshot AI)', defaultBaseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-auto', requiresApiKey: true },
      { id: 'Doubao' as const, name: 'Doubao (Volcengine Ark)', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: '', requiresApiKey: true },
      { id: 'Qwen' as const, name: 'Qwen (Alibaba Cloud Model Studio)', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus', requiresApiKey: true },
      { id: 'OpenAI' as const, name: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', requiresApiKey: true },
      { id: 'Ollama' as const, name: 'Ollama', defaultBaseUrl: 'http://localhost:11434/v1', defaultModel: '', requiresApiKey: false },
      { id: 'Magpie' as const, name: 'Magpie', defaultBaseUrl: 'http://127.0.0.1:3425/v1', defaultModel: '', requiresApiKey: false },
      { id: 'CC Switch' as const, name: 'CC Switch', defaultBaseUrl: 'http://127.0.0.1:15721/v1', defaultModel: '', requiresApiKey: false },
      { id: 'OpenAI Compatible' as const, name: 'OpenAI Compatible', defaultBaseUrl: '', defaultModel: '', requiresApiKey: false },
    ];
    const activePreset = presets.find((p) => p.id === provider) ?? presets[0];

    const providerSelect = el('select', { class: 'dv-select dv-ai-select' });
    providerSelect.setAttribute('aria-label', t('aiProviderLabel'));
    for (const p of presets) {
      const opt = el('option', { text: p.name });
      opt.value = p.id;
      opt.selected = p.id === provider;
      providerSelect.append(opt);
    }
    providerSelect.addEventListener('change', () => {
      post({ type: 'aiUpdateSettings', provider: providerSelect.value as AiProviderId });
    });

    const listId = `dv-ai-models-${++aiDatalistSeq}`;
    const datalist = el('datalist');
    datalist.id = listId;
    for (const m of currentAiModels) {
      const opt = el('option');
      opt.value = m;
      datalist.append(opt);
    }

    const modelInput = el('input', { class: 'dv-ai-field-input' });
    modelInput.type = 'text';
    modelInput.placeholder = activePreset.defaultModel || t('aiModelAutoPlaceholder');
    modelInput.value = snap?.model ?? '';
    modelInput.setAttribute('list', listId);
    modelInput.setAttribute('aria-label', t('aiModelLabel'));
    const commitModel = () => {
      if (modelInput.value.trim() !== (snap?.model ?? '')) {
        post({ type: 'aiUpdateSettings', model: modelInput.value.trim() });
      }
    };
    modelInput.addEventListener('change', commitModel);
    modelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitModel();
      }
    });

    const discoverBtn = iconButton('refresh', t('aiDiscoverModels'), () => {
      post({ type: 'aiGetSettings', discoverModels: true });
    });

    const rows: HTMLElement[] = [
      el('h3', { class: 'dv-st-heading', text: t('aiProviderSection') }),
      el('div', { class: 'dv-st-row' }, [
        el('span', { class: 'dv-st-label', text: t('aiProviderLabel') }),
        providerSelect,
      ]),
      el('div', { class: 'dv-st-row' }, [
        el('span', { class: 'dv-st-label', text: t('aiModelLabel') }),
        el('div', { class: 'dv-ai-inline-row' }, [modelInput, datalist, discoverBtn]),
      ]),
    ];

    if (provider !== 'VS Code') {
      const baseInput = el('input', { class: 'dv-ai-field-input' });
      baseInput.type = 'url';
      baseInput.placeholder = activePreset.defaultBaseUrl || 'https://api.example.com/v1';
      baseInput.value = snap?.baseUrl ?? '';
      baseInput.setAttribute('aria-label', t('aiBaseUrlLabel'));
      const commitBase = () => {
        if (baseInput.value.trim() !== (snap?.baseUrl ?? '')) {
          post({ type: 'aiUpdateSettings', baseUrl: baseInput.value.trim() });
        }
      };
      baseInput.addEventListener('change', commitBase);
      baseInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitBase();
        }
      });
      rows.push(
        el('div', { class: 'dv-st-row' }, [
          el('span', { class: 'dv-st-label', text: t('aiBaseUrlLabel') }),
          baseInput,
        ]),
      );

      const hasKey = Boolean(snap?.hasApiKey);
      const badge = el('span', {
        class: hasKey ? 'dv-ai-key-badge dv-ai-key-ok' : 'dv-ai-key-badge',
        text: hasKey ? t('aiApiKeySet') : t('aiApiKeyMissing'),
      });
      const setKeyBtn = el('button', { class: 'dv-st-action-btn', text: t('aiSetApiKey') });
      setKeyBtn.type = 'button';
      setKeyBtn.addEventListener('click', () => post({ type: 'aiManageKey', op: 'set' }));

      const keyBtns: HTMLElement[] = [badge, setKeyBtn];
      if (hasKey) {
        const clearKeyBtn = el('button', { class: 'dv-st-action-btn', text: t('aiClearApiKey') });
        clearKeyBtn.type = 'button';
        clearKeyBtn.addEventListener('click', () => post({ type: 'aiManageKey', op: 'clear' }));
        keyBtns.push(clearKeyBtn);
      }
      rows.push(el('div', { class: 'dv-ai-key-row' }, keyBtns));
    }

    return el('section', { class: 'dv-st-section' }, rows);
  }

  function renderDrawer(): void {
    const sub = typeof opts.subtitle === 'function' ? opts.subtitle() : (opts.subtitle ?? config.kind.toUpperCase());
    subtitleEl.textContent = sub;
    const scrollTop = contentEl.scrollTop;
    // Capture stable focus locator before replacing drawer children so keyboard users never lose focus.
    const activeEl = document.activeElement instanceof HTMLElement && contentEl.contains(document.activeElement)
      ? document.activeElement
      : undefined;
    let restoreSelector: string | undefined;
    let restoreBtnIdx = -1;
    if (activeEl) {
      const slotRow = activeEl.closest<HTMLElement>('[data-slot-id]');
      const docRow = activeEl.closest<HTMLElement>('[data-doc-action]');
      if (slotRow) {
        const zone = slotRow.closest<HTMLElement>('[data-zone]')?.dataset.zone;
        const containerSel = zone
          ? `.dv-tb-list[data-zone="${zone}"] [data-slot-id="${slotRow.dataset.slotId}"]`
          : `[data-slot-id="${slotRow.dataset.slotId}"]`;
        restoreSelector = containerSel;
        restoreBtnIdx = [...slotRow.querySelectorAll('button')].indexOf(activeEl as HTMLButtonElement);
      } else if (docRow) {
        restoreSelector = `[data-doc-action="${docRow.dataset.docAction}"]`;
        restoreBtnIdx = [...docRow.querySelectorAll('button')].indexOf(activeEl as HTMLButtonElement);
      }
    }

    const docSection = buildDocumentSection();
    contentEl.replaceChildren(
      ...(docSection ? [docSection] : []),
      ...buildAppearanceDrawerSections(),
      buildAiProviderSection(),
      buildToolbarSection(),
    );
    contentEl.scrollTop = scrollTop;

    if (restoreSelector && restoreBtnIdx >= 0) {
      const container = contentEl.querySelector<HTMLElement>(restoreSelector);
      const btns = container?.querySelectorAll<HTMLButtonElement>('button');
      const target = btns?.[restoreBtnIdx] ?? btns?.[0];
      if (target && !target.disabled) {
        target.focus();
      }
    }
  }

  function ensureDrawerMounted(): void {
    if (!backdrop.isConnected) {
      document.body.append(backdrop, drawer);
    }
  }

  function openDrawer(): void {
    ensureDrawerMounted();
    renderDrawer();
    drawerOpen = true;
    backdrop.hidden = false;
    drawer.hidden = false;
    // Trigger CSS slide-in transition on next frame.
    requestAnimationFrame(() => drawer.classList.add('dv-st-open'));
    gearBtn.setAttribute('aria-expanded', 'true');
    gearBtn.classList.add('dv-active');
    window.addEventListener('keydown', onKeyDown, true);
    overlayStack.push({
      id: 'settingsDrawer',
      isOpen: () => drawerOpen,
      close: closeDrawer,
      restoreFocus: () => gearBtn,
    });
    closeBtn.focus();
  }

  function closeDrawer(): void {
    if (!drawerOpen) {
      return;
    }
    drawerOpen = false;
    drawer.classList.remove('dv-st-open');
    backdrop.hidden = true;
    drawer.hidden = true;
    gearBtn.setAttribute('aria-expanded', 'false');
    gearBtn.classList.remove('dv-active');
    window.removeEventListener('keydown', onKeyDown, true);
    overlayStack.remove('settingsDrawer');
  }

  function refresh(): void {
    reconcileBar();
    if (drawerOpen) {
      renderDrawer();
    }
  }

  const unsubAi = onAiSettingsChange(() => {
    if (drawerOpen) {
      const activeTag = document.activeElement?.tagName;
      if (activeTag !== 'INPUT' && activeTag !== 'SELECT') {
        renderDrawer();
      }
    }
  });
  toolbarListeners.add(refresh);
  onFileState(refresh);
  onAppearanceChange(() => {
    if (drawerOpen) {
      renderDrawer();
    }
  });

  function dispose(): void {
    closeOverflow();
    closeDrawer();
    ro?.disconnect();
    unsubAi();
    toolbarListeners.delete(refresh);
    overflowPop.remove();
    backdrop.remove();
    drawer.remove();
  }

  reconcileBar();

  return {
    node: bar,
    refresh,
    openDrawer,
    closeDrawer,
    dispose,
  };
}

/** Legacy positional toolbar helper: puts `nodes` on the left and the Settings gear on the right. */
export function toolbar(...nodes: (HTMLElement | 'spacer' | '|')[]): HTMLElement {
  const leftNodes: HTMLElement[] = [];
  for (const n of nodes) {
    if (n === 'spacer') {
      continue;
    }
    leftNodes.push(n === '|' ? divider() : n);
  }
  return customToolbar({
    slots: leftNodes.length ? [{ id: 'view', nodes: leftNodes }] : [],
  }).node;
}
