// @vitest-environment happy-dom
// Webview UI components: outline tree, sidebar, toolbar controls and appearance handling.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Appearance, WebviewConfig, WebviewMessage } from '../../src/common/protocol';

const posted: WebviewMessage[] = [];
let savedState: unknown;

type Ui = typeof import('../../src/webview/shared/ui');
type SidebarModule = typeof import('../../src/webview/shared/sidebar');
type AppearanceModule = typeof import('../../src/webview/shared/appearance');
type ZoomModule = typeof import('../../src/webview/shared/zoom');
type GridModule = typeof import('../../src/webview/grid/grid');

let ui: Ui;
let sidebar: SidebarModule;
let appearance: AppearanceModule;
let zoom: ZoomModule;
let grid: GridModule;

const initial: Appearance = {
  theme: 'editor',
  scheme: 'auto',
  invertPages: false,
  highlight: true,
  lockEdits: false,
  language: 'auto',
  mdWidth: 'fixed',
  splitPosition: 'sourceLeft',
  showNotices: true,
  loupePosition: 'follow',
  sidebarPosition: 'left',
};

beforeAll(async () => {
  // What the HTML shell and VS Code provide before any webview module runs.
  const config: WebviewConfig = { kind: 'markdown', assets: '/dist/webview', lang: 'zh', appearance: initial };
  const meta = document.createElement('meta');
  meta.name = 'docsview-config';
  meta.content = JSON.stringify(config);
  document.head.append(meta);
  document.body.innerHTML = '<div id="app"></div>';
  document.body.classList.add('vscode-light');
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (m: WebviewMessage) => posted.push(m),
    getState: () => savedState,
    setState: (s: unknown) => {
      savedState = s;
    },
  });
  ui = await import('../../src/webview/shared/ui');
  sidebar = await import('../../src/webview/shared/sidebar');
  appearance = await import('../../src/webview/shared/appearance');
  zoom = await import('../../src/webview/shared/zoom');
  grid = await import('../../src/webview/grid/grid');
});

beforeEach(() => {
  posted.length = 0;
});

function hostSends(message: unknown) {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
}

const visibleText = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('.dv-ol-row')].filter((r) => !r.hidden).map((r) => r.textContent?.trim());

// ---------------------------------------------------------------- outline

describe('Outline', () => {
  const items = [
    { level: 1, text: 'Intro', key: 'a' },
    { level: 2, text: 'Setup', key: 'b' },
    { level: 3, text: 'Install', key: 'c' },
    { level: 2, text: 'Usage', key: 'd' },
    { level: 1, text: 'Appendix', key: 'e' },
  ];

  function make() {
    const onSelect = vi.fn();
    const outline = new sidebar.Outline(onSelect);
    outline.setItems(items);
    document.body.append(outline.node);
    return { outline, onSelect };
  }

  it('indents by level and only gives parents a collapse button', () => {
    const { outline } = make();
    const rows = [...outline.node.querySelectorAll<HTMLElement>('.dv-ol-row')];
    expect(rows.map((r) => r.style.paddingLeft)).toEqual(['6px', '20px', '34px', '20px', '6px']);
    expect(rows.map((r) => !!r.querySelector('.dv-ol-chevron'))).toEqual([true, true, false, false, false]);
    expect(outline.node.querySelector('.dv-ol-count')?.textContent).toBe('5 个标题');
  });

  it('collapses and expands a branch', () => {
    const { outline } = make();
    const chevron = outline.node.querySelector<HTMLButtonElement>('.dv-ol-chevron')!;
    chevron.click();
    expect(visibleText(outline.node)).toEqual(['Intro', 'Appendix']);
    expect(chevron.getAttribute('aria-expanded')).toBe('false');
    chevron.click();
    expect(visibleText(outline.node)).toHaveLength(5);
  });

  it('filters to matches plus their ancestors, and reports no match', () => {
    const { outline, onSelect } = make();
    const filter = outline.node.querySelector<HTMLInputElement>('.dv-ol-filter')!;
    filter.value = 'inst';
    filter.dispatchEvent(new Event('input'));
    expect(visibleText(outline.node)).toEqual(['Intro', 'Setup', 'Install']);

    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onSelect).toHaveBeenCalledWith('a');

    filter.value = 'zzz';
    filter.dispatchEvent(new Event('input'));
    expect(visibleText(outline.node)).toEqual([]);
    expect(outline.node.querySelector('.dv-ol-nomatch')?.textContent).toBe('没有匹配项');

    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(filter.value).toBe('');
    expect(visibleText(outline.node)).toHaveLength(5);
  });

  it('marks the active entry and reports clicks', () => {
    const { outline, onSelect } = make();
    outline.setActive('d');
    const active = outline.node.querySelectorAll('.dv-ol-active');
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toBe('Usage');
    expect(active[0].querySelector('.dv-ol-link')?.getAttribute('aria-current')).toBe('true');

    [...outline.node.querySelectorAll<HTMLButtonElement>('.dv-ol-link')][4].click();
    expect(onSelect).toHaveBeenCalledWith('e');
  });

  it('keeps collapsed branches collapsed when the items are refreshed', () => {
    const { outline } = make();
    outline.node.querySelector<HTMLButtonElement>('.dv-ol-chevron')!.click();
    outline.setItems(items);
    expect(visibleText(outline.node)).toEqual(['Intro', 'Appendix']);
  });

  it('shows the empty text when there is nothing to list', () => {
    const outline = new sidebar.Outline(() => undefined, { emptyText: 'nothing' });
    outline.setItems([]);
    expect(outline.node.querySelector('.dv-ol-empty')?.textContent).toBe('nothing');
  });
});

// ---------------------------------------------------------------- sidebar

describe('Sidebar', () => {
  it('switches tabs, toggles open and remembers both', () => {
    savedState = undefined;
    const side = new sidebar.Sidebar('导航', [
      { id: 'outline', label: '目录' },
      { id: 'pages', label: '页面' },
    ]);
    expect(side.panel('outline').hidden).toBe(false);
    expect(side.panel('pages').hidden).toBe(true);

    const tabs = side.node.querySelectorAll<HTMLButtonElement>('.dv-side-tab');
    tabs[1].click();
    expect(side.activeTab).toBe('pages');
    expect(side.panel('pages').hidden).toBe(false);
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');

    side.toggle.click();
    expect(side.open).toBe(false);
    expect(side.toggle.getAttribute('aria-pressed')).toBe('false');
    expect(savedState).toMatchObject({ sidebar: { open: false, tab: 'pages' } });

    // A new view of the same document restores the choice.
    const again = new sidebar.Sidebar('导航', [
      { id: 'outline', label: '目录' },
      { id: 'pages', label: '页面' },
    ]);
    expect(again.open).toBe(false);
    expect(again.activeTab).toBe('pages');
  });

  it('keeps other persisted keys when writing its own', () => {
    savedState = { plain: true };
    sidebar.writeState({ sidebar: { open: true } });
    expect(savedState).toEqual({ plain: true, sidebar: { open: true } });
  });

  it('opens by default even on narrow panes when defaultOpen is true, and collapses/expands from sidebar controls', () => {
    savedState = undefined;
    const prevWidth = window.innerWidth;
    window.innerWidth = 640;
    try {
      const side = new sidebar.Sidebar('目录', undefined, { defaultOpen: true });
      expect(side.open).toBe(true);
      expect(side.expandBtn.hidden).toBe(true);
      expect(side.node.querySelector('.dv-side-title')?.textContent).toBe('目录');

      // Collapse from inside the sidebar header.
      side.node.querySelector<HTMLButtonElement>('.dv-side-collapse')!.click();
      expect(side.open).toBe(false);
      expect(side.expandBtn.hidden).toBe(false);
      expect(side.toggle.getAttribute('aria-pressed')).toBe('false');

      // Re-expand from the floating expand button.
      side.expandBtn.click();
      expect(side.open).toBe(true);
      expect(side.expandBtn.hidden).toBe(true);
      expect(side.toggle.getAttribute('aria-pressed')).toBe('true');
    } finally {
      window.innerWidth = prevWidth;
    }
  });
});

// ---------------------------------------------------------------- toolbar controls

describe('toolbar controls', () => {
  it('segmented control presses one button and only reports real changes', () => {
    const onChange = vi.fn();
    const seg = ui.segmented('视图', [
      ['a', 'A'],
      ['b', 'B'],
    ], 'a', onChange);
    const buttons = seg.node.querySelectorAll<HTMLButtonElement>('button');
    expect([...buttons].map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    buttons[0].click();
    expect(onChange).not.toHaveBeenCalled();
    buttons[1].click();
    expect(onChange).toHaveBeenCalledWith('b');
    expect(seg.value).toBe('b');
    expect([...buttons].map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });

  it('keeps the default toolbar clean with only the Settings drawer button on the right', () => {
    const bar = ui.toolbar(ui.iconButton('plus', 'x', () => undefined));
    expect(bar.querySelector('.dv-settings-btn')).not.toBeNull();
    // Theme, scheme and language stay inside the drawer until pinned.
    expect(bar.querySelector<HTMLElement>('.dv-zone-right')?.hidden).toBe(true);
  });

  it('dismisses notice banners locally or globally via "不再提示"', () => {
    savedState = undefined;
    hostSends({ type: 'appearance', appearance: initial });
    posted.length = 0;

    const nb = ui.noticeBanner('公式不会重算');
    expect(nb.node.hidden).toBe(false);
    expect(nb.node.querySelector('.dv-notice-text')?.textContent).toBe('公式不会重算');

    // Dismiss locally with the close button.
    nb.node.querySelector<HTMLButtonElement>('.dv-notice-close')!.click();
    expect(nb.node.hidden).toBe(true);

    // Transient flash warnings still show up and can be dismissed early.
    nb.flash('已锁定编辑', 10000);
    expect(nb.node.hidden).toBe(false);
    expect(nb.node.querySelector<HTMLElement>('.dv-notice-mute')?.hidden).toBe(true);
    nb.node.querySelector<HTMLButtonElement>('.dv-notice-close')!.click();
    expect(nb.node.hidden).toBe(true);

    // Re-enabling showNotices in settings restores dismissed banners; "不再提示" turns showNotices off globally.
    hostSends({ type: 'appearance', appearance: { ...initial, showNotices: false } });
    hostSends({ type: 'appearance', appearance: { ...initial, showNotices: true } });
    expect(nb.node.hidden).toBe(false);

    nb.node.querySelector<HTMLButtonElement>('.dv-notice-mute')!.click();
    expect(nb.node.hidden).toBe(true);
    expect(posted).toContainEqual({ type: 'setAppearance', patch: { showNotices: false } });

    hostSends({ type: 'appearance', appearance: initial });
  });

  it('pager only navigates to pages that exist', () => {
    const go = vi.fn();
    const pager = zoom.createPager(go, '页码');
    pager.update(2, 5);
    const input = pager.node.querySelector('input')!;
    const [prev, next] = pager.node.querySelectorAll<HTMLButtonElement>('button');
    prev.click();
    next.click();
    expect(go.mock.calls).toEqual([[1], [3]]);
    input.value = '9';
    input.dispatchEvent(new Event('change'));
    expect(go).toHaveBeenCalledTimes(2);
    expect(input.value).toBe('2');
    expect(pager.node.textContent).toContain('/ 5');
  });

  it('zoom steps through the presets and resets', () => {
    const changes: number[] = [];
    const z = zoom.createZoom((v) => changes.push(v));
    const [out, label, inc] = z.nodes[0].querySelectorAll<HTMLButtonElement>('button');
    inc.click();
    inc.click();
    out.click();
    label.click();
    expect(changes).toEqual([1.1, 1.25, 1.1, 1]);
    expect(label.textContent).toBe('100%');
  });
});

// ---------------------------------------------------------------- appearance

describe('appearance', () => {
  const body = document.body;

  it('follows the editor theme while the scheme is "auto"', () => {
    hostSends({ type: 'appearance', appearance: initial });
    body.classList.replace('vscode-light', 'vscode-dark');
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(body.classList.contains('dv-dark')).toBe(true);
        body.classList.replace('vscode-dark', 'vscode-light');
        setTimeout(() => {
          expect(body.classList.contains('dv-dark')).toBe(false);
          resolve();
        }, 0);
      }, 0),
    );
  });

  it('applies settings pushed by the host', () => {
    hostSends({ type: 'appearance', appearance: { ...initial, theme: 'paper', scheme: 'dark', invertPages: true } });
    expect(body.dataset.theme).toBe('paper');
    expect(body.dataset.scheme).toBe('dark');
    expect(body.classList.contains('dv-dark')).toBe(true);
    expect(body.classList.contains('dv-invert-pages')).toBe(true);
    expect(appearance.effectiveDark()).toBe(true);

    hostSends({ type: 'appearance', appearance: { ...initial, scheme: 'light', invertPages: true } });
    expect(body.dataset.scheme).toBe('light');
    expect(body.classList.contains('dv-dark')).toBe(false);
    // Inverting pages only applies in a dark scheme.
    expect(body.classList.contains('dv-invert-pages')).toBe(false);
    hostSends({ type: 'appearance', appearance: initial });
    expect(body.dataset.scheme).toBeUndefined();
  });

  it('opens the slide-over Settings Drawer and syncs appearance, language and extension settings', () => {
    const tb = ui.customToolbar({
      subtitle: 'Markdown',
      slots: [
        { id: 'nav', nodes: [ui.iconButton('sidebar', '目录', () => undefined)] },
        { id: 'zoom', nodes: [ui.iconButton('plus', '放大', () => undefined)] },
      ],
    });
    document.body.append(tb.node);
    tb.node.querySelector<HTMLButtonElement>('.dv-settings-btn')!.click();

    const drawers = [...document.querySelectorAll<HTMLElement>('.dv-st-drawer')];
    const drawer = drawers[drawers.length - 1];
    expect(drawer.hidden).toBe(false);

    drawer.querySelector<HTMLButtonElement>('[role="group"][aria-label="明暗"] button[aria-pressed="false"]')!;
    [...drawer.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="明暗"] button')]
      .find((b) => b.textContent === '暗色')!
      .click();
    [...drawer.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Markdown 宽度"] button')]
      .find((b) => b.textContent === '自适应宽度')!
      .click();
    [...drawer.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="分栏布局"] button')]
      .find((b) => b.textContent === '预览在左')!
      .click();
    [...drawer.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="导航栏位置"] button')]
      .find((b) => b.textContent === '右侧')!
      .click();
    [...drawer.querySelectorAll<HTMLButtonElement>('.dv-st-choice')]
      .find((b) => b.textContent === 'English')!
      .click();
    [...drawer.querySelectorAll<HTMLButtonElement>('.dv-theme-card')][1].click();
    const invert = drawer.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    invert.checked = true;
    invert.dispatchEvent(new Event('change'));
    drawer.querySelector<HTMLButtonElement>('.dv-st-link')!.click();

    expect(body.dataset.mdWidth).toBe('fluid');
    expect(body.dataset.sidebarPos).toBe('right');
    expect(posted).toEqual([
      { type: 'setAppearance', patch: { scheme: 'dark' } },
      { type: 'setAppearance', patch: { mdWidth: 'fluid' } },
      { type: 'setAppearance', patch: { splitPosition: 'previewLeft' } },
      { type: 'setAppearance', patch: { sidebarPosition: 'right' } },
      { type: 'setAppearance', patch: { language: 'en' } },
      { type: 'setAppearance', patch: { theme: 'github' } },
      { type: 'setAppearance', patch: { invertPages: true } },
      { type: 'openSettings' },
    ]);
    expect(drawer.querySelector('.dv-theme-card[aria-checked="true"] .dv-theme-name')?.textContent).toBe('GitHub');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(drawer.hidden).toBe(true);
    tb.node.remove();
  });

  it('pins items to left/right toolbar zones, reorders them, preserves foreign slots, and resets', () => {
    // Reset to default layout with a foreign 'pager' slot included on the left.
    hostSends({
      type: 'toolbar',
      toolbar: { left: ['nav', 'pager', 'zoom'], right: [] },
    });
    posted.length = 0;

    const tb = ui.customToolbar({
      subtitle: 'Markdown',
      slots: [
        { id: 'nav', nodes: [ui.iconButton('sidebar', '目录', () => undefined)] },
        { id: 'zoom', nodes: [ui.iconButton('plus', '放大', () => undefined)] },
      ],
    });
    document.body.append(tb.node);

    const slotOrder = (zone: 'left' | 'right') =>
      [...tb.node.querySelectorAll<HTMLElement>(`.dv-zone-${zone} .dv-slot`)].map((n) => n.dataset.slot);

    expect(slotOrder('left')).toEqual(['nav', 'zoom']);
    expect(slotOrder('right')).toEqual([]);

    tb.openDrawer();
    const drawers = [...document.querySelectorAll<HTMLElement>('.dv-st-drawer')];
    const drawer = drawers[drawers.length - 1];

    // Pin 'theme' and 'scheme' from the unpinned pool onto the right side of the top bar.
    const pinRight = (slotId: string) => {
      const chip = drawer.querySelector<HTMLElement>(`.dv-tb-pool-item[data-slot-id="${slotId}"]`)!;
      const btns = chip.querySelectorAll<HTMLButtonElement>('.dv-tb-pin-btn');
      btns[1].click();
    };
    pinRight('theme');
    pinRight('scheme');
    expect(slotOrder('right')).toEqual(['theme', 'scheme']);

    // Reorder 'scheme' before 'theme' on the right side using the "Move earlier" button.
    const schemeRow = drawer.querySelector<HTMLElement>('.dv-tb-list[data-zone="right"] .dv-tb-item[data-slot-id="scheme"]')!;
    schemeRow.querySelectorAll<HTMLButtonElement>('.dv-tb-mini')[1].click();
    expect(slotOrder('right')).toEqual(['scheme', 'theme']);

    // Move 'zoom' from left to right, and verify foreign 'pager' slot is preserved in config!
    const zoomRow = drawer.querySelector<HTMLElement>('.dv-tb-list[data-zone="left"] .dv-tb-item[data-slot-id="zoom"]')!;
    zoomRow.querySelectorAll<HTMLButtonElement>('.dv-tb-mini')[0].click();
    expect(slotOrder('left')).toEqual(['nav']);
    expect(slotOrder('right')).toEqual(['scheme', 'theme', 'zoom']);
    expect(ui.getToolbarConfig().left).toContain('pager');

    // Reset back to default toolbar layout (Markdown default includes 'theme').
    drawer.querySelector<HTMLButtonElement>('.dv-tb-reset')!.click();
    expect(slotOrder('right')).toEqual([]);
    expect(slotOrder('left')).toEqual(['nav', 'zoom', 'theme']);

    tb.closeDrawer();
    tb.node.remove();
  });

  it('pins and reorders This Document actions independently and lets unpinned items run or jump to settings', () => {
    hostSends({
      type: 'toolbar',
      toolbar: { left: ['nav', 'doc:slideMode'], right: [] },
    });
    posted.length = 0;

    const ran: string[] = [];
    const tb = ui.customToolbar({
      subtitle: 'Markdown',
      slots: [
        { id: 'nav', nodes: [ui.iconButton('sidebar', '目录', () => ran.push('nav'))] },
        { id: 'ai', nodes: [ui.iconButton('sparkle', 'AI', () => ran.push('ai'))] },
      ],
      documentActions: [
        { id: 'ai', slotId: 'ai', icon: 'sparkle', label: 'AI 助手', onClick: () => ran.push('ai') },
        { id: 'slideMode', icon: 'play', label: '幻灯片演示', onClick: () => ran.push('slide') },
        { id: 'focusMode', icon: 'focus', label: '专注阅读模式', onClick: () => ran.push('focus') },
      ],
    });
    document.body.append(tb.node);

    const slotOrder = () =>
      [...tb.node.querySelectorAll<HTMLElement>('.dv-zone-left .dv-slot')].map((n) => n.dataset.slot);
    expect(slotOrder()).toEqual(['nav', 'doc:slideMode']);

    tb.openDrawer();
    const drawer = [...document.querySelectorAll<HTMLElement>('.dv-st-drawer')].pop()!;

    // 1. Toggle pinning 'focusMode' onto outer toolbar directly from "This Document" pin icon.
    const focusPin = drawer.querySelector<HTMLButtonElement>('.dv-st-action-pill[data-doc-action="focusMode"] .dv-st-action-pin')!;
    expect(focusPin.getAttribute('aria-pressed')).toBe('false');
    focusPin.click();
    expect(slotOrder()).toEqual(['nav', 'doc:slideMode', 'doc:focusMode']);

    // 2. Enter "This Document" customize mode and move 'focusMode' above 'slideMode'.
    drawer.querySelector<HTMLButtonElement>('.dv-st-head-row .dv-tb-reset')!.click();
    const focusRow = drawer.querySelector<HTMLElement>('.dv-st-doc-row[data-doc-action="focusMode"]')!;
    // Up arrow button (first .dv-tb-mini in the row)
    focusRow.querySelectorAll<HTMLButtonElement>('.dv-tb-mini')[0].click();
    expect(ui.getToolbarConfig().docActionOrder?.markdown).toEqual(['ai', 'focusMode', 'slideMode']);
    // Synced outer toolbar order puts doc:focusMode before doc:slideMode!
    expect(slotOrder()).toEqual(['nav', 'doc:focusMode', 'doc:slideMode']);

    // 3. Unpinned setting slot ('width') has a "去设置" button; unpinned action slot ('ai') has a "使用" button that invokes it.
    const widthUseBtn = drawer.querySelector<HTMLButtonElement>('.dv-tb-pool-item[data-slot-id="width"] .dv-tb-use-btn')!;
    expect(widthUseBtn.textContent).toBe('去设置');
    widthUseBtn.click();
    expect(drawer.querySelector('[data-setting-slot="width"]')?.classList.contains('dv-st-flash')).toBe(true);

    const aiUseBtn = drawer.querySelector<HTMLButtonElement>('.dv-tb-pool-item[data-slot-id="ai"] .dv-tb-use-btn')!;
    expect(aiUseBtn.textContent).toBe('使用');
    aiUseBtn.click();
    expect(ran).toEqual(['ai']);
    expect(drawer.hidden).toBe(true);

    tb.node.remove();
  });
});

// ---------------------------------------------------------------- grid helpers

describe('grid helpers', () => {
  it('names columns like a spreadsheet', () => {
    expect([0, 25, 26, 27, 701, 702].map(grid.columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });

  it('parses tab-separated clipboard text, including quoted cells', () => {
    expect(grid.parseClipboard('a\tb\r\nc\td\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(grid.parseClipboard('"x\ty"\t"line1\nline2"\t"say ""hi"""')).toEqual([['x\ty', 'line1\nline2', 'say "hi"']]);
    expect(grid.parseClipboard('single')).toEqual([['single']]);
  });
});

// ---------------------------------------------------------------- row / column highlight

describe("row and column highlight", () => {
  it("marks the hovered cell, its row and its column, counting colspans", async () => {
    const { TableHighlighter } = await import("../../src/webview/markdown/tableHighlight");
    const host = document.createElement("div");
    host.innerHTML = `<table>
      <tr><th>A</th><th>B</th><th>C</th></tr>
      <tr><td colspan="2">wide</td><td>c1</td></tr>
      <tr><td>a2</td><td>b2</td><td>c2</td></tr>
    </table>`;
    document.body.append(host);
    const cells = [...host.querySelectorAll<HTMLTableCellElement>("th, td")];
    const byText = (t: string) => cells.find((c) => c.textContent === t)!;
    const marked = (cls: string) => cells.filter((c) => c.classList.contains(cls)).map((c) => c.textContent);

    const h = new TableHighlighter();
    h.highlight(byText("b2"));
    expect(marked("md-hl-col")).toEqual(["B", "wide", "b2"]);
    expect(byText("b2").parentElement!.classList.contains("md-hl-row")).toBe(true);
    expect(marked("md-hl-cell")).toEqual(["b2"]);

    h.highlight(byText("wide"));
    expect(marked("md-hl-col")).toEqual(["A", "B", "wide", "a2", "b2"]);
    expect(byText("b2").parentElement!.classList.contains("md-hl-row")).toBe(false);

    h.clear();
    expect(host.querySelectorAll(".md-hl-row, .md-hl-col, .md-hl-cell")).toHaveLength(0);
    host.remove();
  });

  it("follows the mouse only while the switch is on", async () => {
    const { attachTableHighlight } = await import("../../src/webview/markdown/tableHighlight");
    const host = document.createElement("div");
    host.innerHTML = "<table><tr><td>x</td><td>y</td></tr></table>";
    document.body.append(host);
    let on = true;
    attachTableHighlight(host, () => on);
    const y = host.querySelectorAll("td")[1];
    y.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(y.classList.contains("md-hl-cell")).toBe(true);
    host.dispatchEvent(new MouseEvent("mouseleave"));
    expect(y.classList.contains("md-hl-cell")).toBe(false);
    on = false;
    y.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(y.classList.contains("md-hl-cell")).toBe(false);
    host.remove();
  });

  it("marks every grid cell in the selected rows and columns, merged cells included", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const g = new grid.Grid(parent, { editable: false, onEdit: () => undefined });
    g.setData({
      rowCount: 4,
      colCount: 4,
      cell: (r, c) => `${r},${c}`,
      colWidths: [80, 80, 80, 80],
      merges: [{ r: 3, c: 0, rs: 1, cs: 3 }],
    });
    g.goTo(1, 1);
    await new Promise((r) => setTimeout(r, 200));
    // The grid only creates cells near the viewport (zero-sized here), so check every cell it did create:
    // crossed exactly when it is in row 1, in column 1, or is the merged cell spanning column 1.
    const rendered = [...parent.querySelectorAll<HTMLElement>(".grid-cell")];
    expect(rendered.length).toBeGreaterThan(8);
    for (const node of rendered) {
      const [r, c] = node.textContent!.split(",").map(Number);
      const expected = r === 1 || c === 1 || (r === 3 && c === 0);
      expect([node.textContent, node.classList.contains("grid-cross")]).toEqual([node.textContent, expected]);
    }
    expect(rendered.find((n) => n.textContent === "3,0")?.classList.contains("grid-cross")).toBe(true);
    expect(parent.querySelector(".grid-active")?.textContent).toBe("1,1");
    parent.remove();
  });

  it("toolbar switch toggles the setting and the body class", () => {
    hostSends({ type: "appearance", appearance: initial });
    expect(document.body.classList.contains("dv-highlight")).toBe(true);
    const toggle = appearance.highlightToggle();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    toggle.click();
    expect(posted).toContainEqual({ type: "setAppearance", patch: { highlight: false } });
    expect(document.body.classList.contains("dv-highlight")).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });
});

// ---------------------------------------------------------------- find, more menu, lock

describe("preview find", () => {
  it("counts matches across text nodes, skips UI text and steps with wrap-around", async () => {
    const { PreviewFind } = await import("../../src/webview/markdown/find");
    const scroller = document.createElement("div");
    const root = document.createElement("article");
    root.innerHTML =
      "<p>DocsView shows <b>docsview</b> files.</p><pre><code>docsView()</code><button class=\"md-copy\">DocsView</button></pre><p hidden>DocsView</p>";
    scroller.append(root);
    document.body.append(scroller);
    const find = new PreviewFind(root, scroller);
    find.search("docsview");
    expect(find.total).toBe(3);
    expect(find.current).toBe(1);
    find.next();
    find.next();
    expect(find.current).toBe(3);
    find.next();
    expect(find.current).toBe(1);
    find.next(true);
    expect(find.current).toBe(3);
    // After a re-render the search runs again and keeps its place when it can.
    root.innerHTML = "<p>docsview docsview</p>";
    find.refresh();
    expect([find.current, find.total]).toEqual([2, 2]);
    find.clear();
    expect(find.total).toBe(0);
    scroller.remove();
  });

  it("supports includeHidden + onReveal for multi-slide search and skips comment pills", async () => {
    const { PreviewFind } = await import("../../src/webview/shared/find");
    const scroller = document.createElement("div");
    const root = document.createElement("div");
    root.innerHTML =
      '<div class="slide" data-slide="0"><p>Slide alpha <span class="docx-cm-pill">alpha</span></p></div>' +
      '<div class="slide" data-slide="1" hidden><p>Hidden alpha match</p></div>';
    scroller.append(root);
    document.body.append(scroller);

    const revealed: string[] = [];
    const find = new PreviewFind(root, scroller, {
      includeHidden: true,
      onReveal: (range) => {
        const slide = range.startContainer.parentElement?.closest<HTMLElement>(".slide");
        if (slide) {
          slide.hidden = false;
          revealed.push(slide.dataset.slide!);
        }
      },
    });
    find.search("alpha");
    // Comment pill text is skipped; both visible slide 0 and hidden slide 1 match!
    expect(find.total).toBe(2);
    expect(revealed).toEqual(["0"]);
    find.next();
    expect(revealed).toEqual(["0", "1"]);
    scroller.remove();
  });

  it("renders a collapsible 28px Find capsule that expands on click, steps matches and closes on Escape", async () => {
    const { PreviewFind, createFindWidget } = await import("../../src/webview/shared/find");
    const scroller = document.createElement("div");
    scroller.tabIndex = -1;
    const root = document.createElement("div");
    root.innerHTML = "<p>beta one</p><p>beta two</p>";
    scroller.append(root);
    const find = new PreviewFind(root, scroller);
    const widget = createFindWidget(find, scroller);
    const host = document.createElement("div");
    host.append(...widget.nodes);
    document.body.append(host, scroller);

    const [toggleBtn, barWrap] = widget.nodes as [HTMLButtonElement, HTMLElement];
    expect(toggleBtn.hidden).toBe(false);
    expect(barWrap.hidden).toBe(true);

    toggleBtn.click();
    expect(toggleBtn.hidden).toBe(true);
    expect(barWrap.hidden).toBe(false);

    widget.input.value = "beta";
    widget.input.dispatchEvent(new Event("input"));
    expect(barWrap.querySelector(".dv-find-count")?.textContent).toBe("1/2");

    widget.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(barWrap.querySelector(".dv-find-count")?.textContent).toBe("2/2");

    widget.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(barWrap.hidden).toBe(true);
    expect(toggleBtn.hidden).toBe(false);
    expect(find.total).toBe(0);

    host.remove();
    scroller.remove();
  });
});

describe("more menu", () => {
  it("shows visible items, check marks, and runs the action", () => {
    const clicked: string[] = [];
    let on = false;
    const button = ui.moreMenu("更多", [
      { label: () => `default ${on}`, checked: () => on, onClick: () => (on = !on) },
      "-",
      { label: "hidden", visible: () => false, onClick: () => clicked.push("hidden") },
      "-",
      { label: "export", hint: "html", onClick: () => clicked.push("export") },
    ]);
    document.body.append(button);
    button.click();
    const menu = [...document.querySelectorAll<HTMLElement>(".dv-more-menu")].pop()!;
    expect(menu.hidden).toBe(false);
    const labels = [...menu.querySelectorAll(".dv-menu-label")].map((n) => n.textContent);
    expect(labels).toEqual(["default false", "export"]);
    // Hidden items do not leave doubled separators behind.
    expect(menu.querySelectorAll(".dv-menu-sep")).toHaveLength(1);
    expect(menu.querySelector("[role=menuitemcheckbox]")?.getAttribute("aria-checked")).toBe("false");
    (menu.querySelectorAll<HTMLButtonElement>(".dv-menu-item")[1]).click();
    expect(clicked).toEqual(["export"]);
    expect(menu.hidden).toBe(true);
    button.click();
    (menu.querySelectorAll<HTMLButtonElement>(".dv-menu-item")[0]).click();
    button.click();
    expect(menu.querySelector(".dv-menu-label")?.textContent).toBe("default true");
    expect(menu.querySelector("[role=menuitemcheckbox]")?.getAttribute("aria-checked")).toBe("true");
  });
});

describe("grid lock and column menu", () => {
  it("blocks edits while locked and reports the attempt", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const blocked: number[] = [];
    const edits: unknown[] = [];
    const menus: number[] = [];
    const g = new grid.Grid(parent, {
      editable: true,
      onEdit: (c) => edits.push(c),
      onBlockedEdit: () => blocked.push(1),
      onColumnMenu: (col) => menus.push(col),
    });
    g.setData({ rowCount: 3, colCount: 3, cell: (r, c) => `${r},${c}`, colWidths: [80, 80, 80], rowLabel: (r) => `#${r + 7}`, colBadge: (c) => (c === 1 ? " ↑" : "") });
    g.goTo(1, 1);
    await new Promise((r) => setTimeout(r, 200));
    g.setEditable(false);
    expect(g.editable).toBe(false);
    const viewport = parent.querySelector<HTMLElement>(".grid-viewport")!;
    viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
    viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(blocked).toEqual([1]);
    expect(edits).toEqual([]);
    expect(parent.querySelector("textarea")).toBeNull();
    // Original row numbers and the sort badge are shown in the headers.
    expect([...parent.querySelectorAll(".grid-row-header")].map((n) => n.textContent)).toContain("#8");
    const header = [...parent.querySelectorAll<HTMLElement>(".grid-col-header")].find((n) => n.textContent?.startsWith("B"))!;
    expect(header.textContent).toBe("B ↑");
    header.querySelector<HTMLButtonElement>(".grid-col-menu")!.click();
    expect(menus).toEqual([1]);
    parent.remove();
  });

  it("reports truncated paste when row growth is disabled (e.g. sorted/filtered CSV)", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const edits: unknown[] = [];
    let truncated = 0;
    const g = new grid.Grid(parent, {
      editable: true,
      canGrowRows: false,
      onEdit: (c) => edits.push(c),
      onPasteTruncated: () => truncated++,
    });
    g.setData({ rowCount: 2, colCount: 2, cell: () => "", colWidths: [80, 80] });
    g.goTo(1, 0);
    const viewport = parent.querySelector<HTMLElement>(".grid-viewport")!;
    const evt = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(evt, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? "r1\nr2\n" : "") },
    });
    viewport.dispatchEvent(evt);
    expect(edits).toEqual([[{ r: 1, c: 0, text: "r1" }]]);
    expect(truncated).toBe(1);
    parent.remove();
  });
});
