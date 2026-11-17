// Collapsible navigation sidebar (optionally tabbed) and the outline tree shown in it.
import { el, getState, setState, t } from './api';
import { icons } from './icons';
import { iconButton, toggleButton } from './ui';

interface PersistedState {
  sidebar?: { open: boolean; tab?: string };
  [key: string]: unknown;
}

export function readState(): PersistedState {
  return getState<PersistedState>() ?? {};
}

export function writeState(patch: Partial<PersistedState>): void {
  setState({ ...readState(), ...patch });
}

export class Sidebar {
  readonly node: HTMLElement;
  readonly toggle: HTMLButtonElement;
  /** Floating button rendered inside `.dv-main` when the sidebar is collapsed. */
  readonly expandBtn: HTMLButtonElement;
  private readonly panels = new Map<string, HTMLElement>();
  private readonly tabButtons = new Map<string, HTMLButtonElement>();
  private readonly setToggle: (on: boolean) => void;
  private tab: string;
  private tabListeners: ((tab: string) => void)[] = [];

  constructor(
    label: string,
    tabs: { id: string; label: string }[] = [{ id: 'main', label }],
    opts: { defaultOpen?: boolean } = {},
  ) {
    this.node = el('aside', { class: 'dv-side' });
    this.node.setAttribute('aria-label', label);
    const saved = readState().sidebar;
    this.tab = saved?.tab && tabs.some((x) => x.id === saved.tab) ? saved.tab : tabs[0].id;

    const collapseBtn = iconButton('sidebarCollapse', t('collapseSidebar'), () => this.setOpen(false));
    collapseBtn.classList.add('dv-side-collapse');
    collapseBtn.setAttribute('aria-label', t('collapseSidebar'));

    if (tabs.length > 1) {
      const tablist = el('div', { class: 'dv-side-tabs' });
      tablist.setAttribute('role', 'tablist');
      for (const tab of tabs) {
        const b = el('button', { class: 'dv-side-tab', text: tab.label });
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.addEventListener('click', () => this.setTab(tab.id));
        this.tabButtons.set(tab.id, b);
        tablist.append(b);
      }
      tablist.append(collapseBtn);
      this.node.append(tablist);
    } else {
      const head = el('div', { class: 'dv-side-head' }, [
        el('span', { class: 'dv-side-title', text: label }),
        collapseBtn,
      ]);
      this.node.append(head);
    }
    for (const tab of tabs) {
      const panel = el('div', { class: 'dv-side-panel' });
      panel.setAttribute('role', tabs.length > 1 ? 'tabpanel' : 'region');
      this.panels.set(tab.id, panel);
      this.node.append(panel);
    }

    this.expandBtn = iconButton('sidebarExpand', t('expandSidebar'), () => this.setOpen(true));
    this.expandBtn.classList.add('dv-side-expand');
    this.expandBtn.setAttribute('aria-label', t('expandSidebar'));

    const toggle = toggleButton('sidebar', label, (on) => this.setOpen(on));
    this.toggle = toggle.node;
    this.setToggle = toggle.set;
    // Open by default when `defaultOpen` is true (e.g. Markdown) or on a roomy pane; remember user's choice.
    const defaultOpen = opts.defaultOpen ?? window.innerWidth >= 900;
    this.setOpen(saved?.open ?? defaultOpen, false);
    this.setTab(this.tab, false);
  }

  get open(): boolean {
    return !this.node.hidden;
  }

  get activeTab(): string {
    return this.tab;
  }

  panel(id = 'main'): HTMLElement {
    return this.panels.get(id) ?? this.panels.values().next().value!;
  }

  onTabChange(listener: (tab: string) => void): void {
    this.tabListeners.push(listener);
  }

  setOpen(open: boolean, persist = true): void {
    this.node.hidden = !open;
    this.expandBtn.hidden = open;
    this.setToggle(open);
    if (persist) {
      writeState({ sidebar: { open, tab: this.tab } });
    }
  }

  setTab(id: string, persist = true): void {
    this.tab = id;
    for (const [tabId, panel] of this.panels) {
      panel.hidden = tabId !== id;
    }
    for (const [tabId, b] of this.tabButtons) {
      b.setAttribute('aria-selected', String(tabId === id));
    }
    if (persist) {
      writeState({ sidebar: { open: this.open, tab: id } });
    }
    this.tabListeners.forEach((l) => l(id));
  }

  setTabLabel(id: string, label: string): void {
    const b = this.tabButtons.get(id);
    if (b) {
      b.textContent = label;
    }
  }
}

// ---------------------------------------------------------------- outline tree

export interface OutlineItem {
  level: number;
  text: string;
  /** Identifier passed back to onSelect. */
  key: string;
}

interface Node {
  item: OutlineItem;
  row: HTMLElement;
  children: Node[];
  parent?: Node;
  collapsed: boolean;
  chevron?: HTMLButtonElement;
}

export class Outline {
  readonly node: HTMLElement;
  private readonly list: HTMLElement;
  private readonly filter: HTMLInputElement;
  private readonly count: HTMLElement;
  private nodes: Node[] = [];
  private byKey = new Map<string, Node>();
  private activeKey: string | undefined;

  constructor(
    private readonly onSelect: (key: string) => void,
    private readonly opts: { emptyText?: string; countText?: (n: number) => string; showFilter?: boolean } = {},
  ) {
    this.count = el('span', { class: 'dv-ol-count' });
    this.filter = el('input', { class: 'dv-input dv-ol-filter' });
    this.filter.type = 'text';
    this.filter.placeholder = t('filterHeadings');
    this.filter.setAttribute('aria-label', t('filterHeadings'));
    this.filter.addEventListener('input', () => this.applyFilter());
    this.filter.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.filter.value = '';
        this.applyFilter();
      } else if (e.key === 'Enter') {
        // Jump to the first visible match.
        const first = this.nodes.find((n) => !n.row.hidden);
        if (first) {
          this.onSelect(first.item.key);
        }
      }
    });
    const search = el('label', { class: 'dv-ol-search' });
    search.innerHTML = icons.search;
    search.append(this.filter);
    this.list = el('div', { class: 'dv-ol-list' });
    const head = el('div', { class: 'dv-ol-head' }, [this.count]);
    this.node = el('div', { class: 'dv-ol' }, opts.showFilter === false ? [head, this.list] : [head, search, this.list]);
  }

  setItems(items: OutlineItem[]): void {
    const collapsedBefore = new Set(this.nodes.filter((n) => n.collapsed).map((n) => n.item.key));
    this.nodes = [];
    this.byKey.clear();
    const stack: Node[] = [];
    const min = items.length ? Math.min(...items.map((i) => i.level)) : 1;
    for (const item of items) {
      while (stack.length && stack[stack.length - 1].item.level >= item.level) {
        stack.pop();
      }
      const node: Node = { item, row: el('div'), children: [], parent: stack[stack.length - 1], collapsed: false };
      node.parent?.children.push(node);
      stack.push(node);
      this.nodes.push(node);
      this.byKey.set(item.key, node);
    }
    for (const node of this.nodes) {
      const depth = node.item.level - min;
      const row = el('div', { class: 'dv-ol-row' });
      row.style.paddingLeft = `${6 + depth * 14}px`;
      if (node.children.length) {
        const chevron = el('button', { class: 'dv-ol-chevron', title: node.item.text });
        chevron.type = 'button';
        chevron.addEventListener('click', () => this.setCollapsed(node, !node.collapsed));
        node.chevron = chevron;
        row.append(chevron);
      } else {
        row.append(el('span', { class: 'dv-ol-spacer' }));
      }
      const link = el('button', { class: 'dv-ol-link', text: node.item.text, title: node.item.text });
      link.type = 'button';
      if (depth === 0) {
        link.classList.add('dv-ol-top');
      }
      link.addEventListener('click', () => this.onSelect(node.item.key));
      row.append(link);
      node.row = row;
      node.collapsed = collapsedBefore.has(node.item.key);
    }
    this.list.replaceChildren(...this.nodes.map((n) => n.row));
    if (!items.length) {
      this.list.append(el('div', { class: 'dv-ol-empty', text: this.opts.emptyText ?? t('tocEmpty') }));
    }
    this.count.textContent = (this.opts.countText ?? ((n: number) => t('headingCount', n)))(items.length);
    this.nodes.forEach((n) => this.paintChevron(n));
    this.applyFilter();
    if (this.activeKey) {
      this.setActive(this.activeKey);
    }
  }

  get size(): number {
    return this.nodes.length;
  }

  setActive(key: string | undefined): void {
    this.activeKey = key;
    for (const node of this.nodes) {
      const on = node.item.key === key;
      node.row.classList.toggle('dv-ol-active', on);
      if (on) {
        node.row.querySelector('.dv-ol-link')?.setAttribute('aria-current', 'true');
      } else {
        node.row.querySelector('.dv-ol-link')?.removeAttribute('aria-current');
      }
    }
    const active = key ? this.byKey.get(key) : undefined;
    if (active && !active.row.hidden) {
      const list = this.list.getBoundingClientRect();
      const row = active.row.getBoundingClientRect();
      if (row.top < list.top || row.bottom > list.bottom) {
        active.row.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  private paintChevron(node: Node): void {
    if (node.chevron) {
      node.chevron.innerHTML = node.collapsed ? icons.chevronRight : icons.chevronDown;
      node.chevron.setAttribute('aria-expanded', String(!node.collapsed));
    }
  }

  private setCollapsed(node: Node, collapsed: boolean): void {
    node.collapsed = collapsed;
    this.paintChevron(node);
    this.applyFilter();
  }

  private applyFilter(): void {
    const query = this.filter.value.trim().toLowerCase();
    let visible = 0;
    for (const node of this.nodes) {
      let show: boolean;
      if (query) {
        // While filtering, show matches with their ancestors so the context is clear.
        show = this.matches(node, query);
      } else {
        show = true;
        for (let p = node.parent; p; p = p.parent) {
          if (p.collapsed) {
            show = false;
            break;
          }
        }
      }
      node.row.hidden = !show;
      if (show) {
        visible++;
      }
    }
    this.list.querySelector('.dv-ol-nomatch')?.remove();
    if (query && !visible && this.nodes.length) {
      this.list.append(el('div', { class: 'dv-ol-empty dv-ol-nomatch', text: t('noMatch') }));
    }
  }

  private matches(node: Node, query: string): boolean {
    if (node.item.text.toLowerCase().includes(query)) {
      return true;
    }
    return node.children.some((c) => this.matches(c, query));
  }
}
