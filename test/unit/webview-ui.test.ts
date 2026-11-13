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

const initial: Appearance = { theme: 'editor', scheme: 'auto', invertPages: false, highlight: true, language: 'auto' };

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

  it('every toolbar ends with the theme, light/dark and language controls', () => {
    const bar = ui.toolbar(ui.iconButton('plus', 'x', () => undefined));
    expect(bar.querySelector('.dv-theme-btn')).not.toBeNull();
    const groups = [...bar.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(['明暗', '界面语言']);
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

  it('asks the host to save what the user picks in the toolbar and menu', () => {
    const bar = ui.toolbar();
    document.body.append(bar);
    bar.querySelector<HTMLButtonElement>('[role="group"][aria-label="明暗"] button[aria-label="暗色"]')!.click();
    [...bar.querySelectorAll<HTMLButtonElement>('[aria-label="界面语言"] button')].find((b) => b.textContent === 'EN')!.click();

    bar.querySelector<HTMLButtonElement>('.dv-theme-btn')!.click();
    const menu = document.querySelector<HTMLElement>('.dv-menu')!;
    expect(menu.hidden).toBe(false);
    [...menu.querySelectorAll<HTMLButtonElement>('.dv-theme-card')][1].click();
    const invert = menu.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    invert.checked = true;
    invert.dispatchEvent(new Event('change'));

    expect(posted).toEqual([
      { type: 'setAppearance', patch: { scheme: 'dark' } },
      { type: 'setAppearance', patch: { language: 'en' } },
      { type: 'setAppearance', patch: { theme: 'github' } },
      { type: 'setAppearance', patch: { invertPages: true } },
    ]);
    // The UI reflects the choice straight away, before the host answers.
    expect(menu.querySelector('.dv-theme-card[aria-checked="true"] .dv-theme-name')?.textContent).toBe('GitHub');
    expect(bar.querySelector('.dv-theme-label')?.textContent).toBe('主题：GitHub');

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(menu.hidden).toBe(true);
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
