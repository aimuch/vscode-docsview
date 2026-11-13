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

const initial: Appearance = { theme: 'editor', scheme: 'auto', invertPages: false, language: 'auto' };

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
    hostSends({ type: 'appearance', appearance: { theme: 'paper', scheme: 'dark', invertPages: true, language: 'auto' } });
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
