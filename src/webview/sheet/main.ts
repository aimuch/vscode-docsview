// Table view for CSV/TSV and Excel workbooks.
import type { Cell, CellChange, SheetModel, StructureOp, WorkbookInfo } from '../../common/protocol';
import { cellRaw, cellText, columnName, Grid, type GridSource, type Selection } from '../grid/grid';
import '../shared/base.css';
import { app, button, el, onMessage, post, showStatus, t } from '../shared/api';
import { getAppearance, highlightToggle, lockToggle, onAppearanceChange, updateAppearance } from '../shared/appearance';
import { getFileState } from '../shared/fileState';
import { icons } from '../shared/icons';
import { readState, writeState } from '../shared/sidebar';
import {
  customToolbar,
  iconButton,
  moreMenu,
  noticeBanner,
  openExternalButton,
  openExternalMenuItem,
  segmented,
  toggleButton,
  type MenuItem,
} from '../shared/ui';
import { createZoom } from '../shared/zoom';
import './sheet.css';
import { computeSelectionStats, emptyView, isActive, viewRows, type SheetView } from './view';

let info: WorkbookInfo | undefined;
let active = 0;
const models = new Map<number, SheetModel>();
/** Column widths survive data refreshes (the model is replaced on every reload). */
const widths = new Map<number, number[]>();
/** Sort and filter per sheet. */
const views = new Map<number, SheetView>();
/** Source row of each displayed row while a sort or filter is active. */
let rowMap: number[] | undefined;
let grid: Grid | undefined;

const toSource = (r: number) => (rowMap ? (rowMap[r] ?? -1) : r);

const address = el('span', { class: 'sheet-address' });
const fxBadge = el('span', { class: 'sheet-fx', text: 'fx' });
const formula = el('input', { class: 'sheet-formula' });
formula.type = 'text';
formula.spellcheck = false;
formula.placeholder = t('formulaPlaceholder');
formula.setAttribute('aria-label', t('formulaPlaceholder'));
const formulaBar = el('span', { class: 'sheet-formula-wrap' }, [fxBadge, formula]);

const selectionStatsEl = el('div', { class: 'sheet-sel-stats' });
selectionStatsEl.hidden = true;
const summary = el('span', { class: 'dv-label' });
const notice = noticeBanner();
const gridHost = el('div', { class: 'sheet-grid' });
// Bottom bar: sheet tabs (+ add-sheet button) on the left, live selection stats & size summary on the right.
const tabs = el('div', { class: 'sheet-tab-list' });
const addSheetBtn = iconButton('plus', t('newSheet'), () => {
  if (getAppearance().lockEdits) {
    flash(t('locked'));
    return;
  }
  post({ type: 'sheetOp', op: 'add' });
});
addSheetBtn.classList.add('sheet-add-btn');
addSheetBtn.hidden = true;
const statusBar = el('div', { class: 'sheet-tabs' }, [
  tabs,
  addSheetBtn,
  el('div', { class: 'dv-spacer' }),
  selectionStatsEl,
  summary,
]);
const structureButtons: HTMLButtonElement[] = [];

function viewOf(index: number): SheetView {
  let view = views.get(index);
  if (!view) {
    views.set(index, (view = emptyView()));
  }
  return view;
}

function structure(op: StructureOp, customAt?: number) {
  const sel = grid?.selection;
  if (!sel) {
    return;
  }
  if (rowMap) {
    // Row positions on screen are not file positions while sorted or filtered.
    flash(t('structureBlocked'));
    return;
  }
  if (getAppearance().lockEdits) {
    flash(t('locked'));
    return;
  }
  const rows = op === 'insertRow' || op === 'deleteRows';
  const at = customAt ?? (rows ? sel.r0 : sel.c0);
  const count = op.startsWith('delete') ? (rows ? sel.r1 - sel.r0 : sel.c1 - sel.c0) + 1 : 1;
  post({ type: 'structure', index: active, op, at, count });
}

function textButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { class: 'dv-btn', text: label, title });
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

// Short labels keep the toolbar on one line; the full action is in the tooltip.
structureButtons.push(
  textButton(t('addRowShort'), t('addRow'), () => structure('insertRow')),
  textButton(t('addColShort'), t('addCol'), () => structure('insertCol')),
  textButton(t('delRowShort'), t('delRow'), () => structure('deleteRows')),
  textButton(t('delColShort'), t('delCol'), () => structure('deleteCols')),
);
const structureGroup = el('div', { class: 'sheet-structure' }, structureButtons);
structureGroup.hidden = true;

// CSV: table here, split beside text editor, or text editor instead. Excel: authored styles, or plain data.
const csvView = segmented<'table' | 'split' | 'text'>(
  t('view'),
  [
    ['table', t('viewTable')],
    ['split', t('viewSplit')],
    ['text', t('viewText')],
  ],
  'table',
  (mode) => {
    if (mode === 'table') {
      post({ type: 'closeSource' });
    } else {
      post({ type: 'showSource', beside: mode === 'split' });
      if (mode === 'text') {
        csvView.set('table');
      }
    }
  },
);

/** Per-sheet user override for freezing the top row (`undefined` = follow workbook's own `frozenRows`). */
const freezeOverrides = new Map<number, boolean>();
const freezeBtn = toggleButton('freeze', t('freezeHeader'), (on) => {
  freezeOverrides.set(active, on);
  show(active, true);
});
let plain = readState().plain === true;
const excelView = segmented<'styled' | 'plain'>(
  t('view'),
  [
    ['styled', t('viewStyled')],
    ['plain', t('viewPlain')],
  ],
  plain ? 'plain' : 'styled',
  (mode) => {
    plain = mode === 'plain';
    writeState({ plain });
    show(active, true);
  },
);
csvView.node.hidden = true;
excelView.node.hidden = true;

// ---------------------------------------------------------------- find

const findInput = el('input');
findInput.type = 'search';
findInput.placeholder = t('find');
findInput.setAttribute('aria-label', t('findInSheet'));
const findStatus = el('span', { class: 'dv-label' });
const findIcon = el('span', { class: 'sheet-find-icon' });
findIcon.innerHTML = icons.search;
const findBox = el('label', { class: 'dv-search sheet-find' }, [findIcon, findInput]);
findBox.hidden = true;
const findToggle = iconButton('search', t('findInSheet'), () => {
  findBox.hidden = !findBox.hidden;
  findToggle.setAttribute('aria-pressed', String(!findBox.hidden));
  if (!findBox.hidden) {
    findInput.focus();
    findInput.select();
  }
});

/** Monotonic counter incremented whenever cell data or displayed row order changes. */
let findDataEpoch = 0;
let findCache: { sheet: number; epoch: number; query: string; hits: number[] } | undefined;

/** Selects the next (or previous) displayed cell whose text contains the query, wrapping around. */
function findNext(backwards = false) {
  const model = models.get(active);
  const query = findInput.value.trim().toLowerCase();
  if (!model || !grid || !query) {
    findStatus.textContent = '';
    return;
  }
  const rowCount = rowMap ? rowMap.length : model.rowCount;
  const { colCount } = model;
  if (!rowCount || !colCount) {
    findStatus.textContent = t('noMatch');
    return;
  }
  if (!findCache || findCache.sheet !== active || findCache.epoch !== findDataEpoch || findCache.query !== query) {
    const hits: number[] = [];
    const maxDisplayRow = rowMap ? rowMap.length : Math.min(model.rowCount, model.rows.length);
    for (let r = 0; r < maxDisplayRow; r++) {
      const row = model.rows[toSource(r)];
      if (!row?.length) {
        continue;
      }
      const maxCol = Math.min(colCount, row.length);
      for (let c = 0; c < maxCol; c++) {
        const cell = row[c];
        if (cell != null && cellText(cell).toLowerCase().includes(query)) {
          hits.push(r * colCount + c);
        }
      }
    }
    findCache = { sheet: active, epoch: findDataEpoch, query, hits };
  }
  const { hits } = findCache;
  if (!hits.length) {
    findStatus.textContent = t('noMatch');
    return;
  }
  const sel = grid.selection;
  const cur = sel.r * colCount + sel.c;
  // Binary search for the next hit strictly after (or before) `cur`, wrapping around.
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hits[mid] <= (backwards ? cur - 1 : cur)) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const idx = backwards ? (lo - 1 + hits.length) % hits.length : lo % hits.length;
  const found = hits[idx];
  findStatus.textContent = `${idx + 1}/${hits.length}`;
  grid.goTo(Math.floor(found / colCount), found % colCount);
}

findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    findNext(e.shiftKey);
  } else if (e.key === 'Escape') {
    findBox.hidden = true;
    findToggle.setAttribute('aria-pressed', 'false');
    grid?.focus();
  }
});
findInput.addEventListener('input', () => (findStatus.textContent = ''));
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    findBox.hidden = false;
    findToggle.setAttribute('aria-pressed', 'true');
    findInput.focus();
    findInput.select();
  }
});

// ---------------------------------------------------------------- sort & filter status

const filterChipText = el('span');
const filterChipIcon = el('span', { class: 'sheet-chip-icon' });
filterChipIcon.innerHTML = icons.filter;
const filterClear = el('button', { class: 'sheet-chip-clear', text: t('clear') });
filterClear.type = 'button';
filterClear.addEventListener('click', () => {
  views.set(active, { ...emptyView(), headerRow: viewOf(active).headerRow });
  show(active, true);
});
const filterChip = el('span', { class: 'sheet-chip' }, [filterChipIcon, filterChipText, filterClear]);
filterChip.hidden = true;

function updateFilterChip(model: SheetModel) {
  const view = viewOf(active);
  filterChip.hidden = !rowMap;
  if (!rowMap) {
    return;
  }
  const fixed = fixedRows(model, view);
  const parts: string[] = [];
  if (Object.values(view.filters).some((q) => q.trim())) {
    parts.push(t('filtered', rowMap.length - Math.min(fixed, model.rows.length), Math.max(0, model.rows.length - fixed)));
  }
  if (view.sortCol !== undefined) {
    parts.push(t('sortedBy', columnName(view.sortCol), t(view.sortDir === -1 ? 'desc' : 'asc')));
  }
  filterChipText.textContent = parts.join(' · ');
}

// ---------------------------------------------------------------- column menu

const columnMenu = el('div', { class: 'dv-menu sheet-col-menu' });
columnMenu.setAttribute('role', 'menu');
columnMenu.hidden = true;
document.body.append(columnMenu);

function onColumnMenuOutside(e: MouseEvent) {
  if (!columnMenu.contains(e.target as Node)) {
    closeColumnMenu();
  }
}

function closeColumnMenu() {
  if (!columnMenu.hidden) {
    columnMenu.hidden = true;
    document.removeEventListener('mousedown', onColumnMenuOutside);
  }
}

columnMenu.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeColumnMenu();
    grid?.focus();
  }
});

function menuRow(icon: keyof typeof icons | '', label: string, onClick: () => void): HTMLButtonElement {
  const row = el('button', { class: 'dv-menu-item' });
  row.type = 'button';
  row.setAttribute('role', 'menuitem');
  const mark = el('span', { class: 'dv-menu-check' });
  if (icon) {
    mark.innerHTML = icons[icon];
  }
  row.append(mark, el('span', { class: 'dv-menu-label', text: label }));
  row.addEventListener('click', onClick);
  return row;
}

function openColumnMenu(col: number, anchor: DOMRect) {
  const model = models.get(active);
  if (!model) {
    return;
  }
  const view = viewOf(active);
  const apply = (close = true) => {
    if (close) {
      closeColumnMenu();
    }
    show(active, true);
  };
  const sort = (dir: 1 | -1) => {
    view.sortCol = col;
    view.sortDir = dir;
    apply();
  };
  const items: HTMLElement[] = [
    menuRow('sortUp', t('sortAsc'), () => sort(1)),
    menuRow('sortDown', t('sortDesc'), () => sort(-1)),
  ];
  if (view.sortCol === col) {
    items.push(
      menuRow('', t('clearSort'), () => {
        view.sortCol = undefined;
        view.sortDir = undefined;
        apply();
      }),
    );
  }
  const filter = el('input', { class: 'dv-input sheet-col-filter' });
  filter.type = 'text';
  filter.value = view.filters[col] ?? '';
  filter.setAttribute('aria-label', `${columnName(col)} ${t('filterContains')}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  filter.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      view.filters[col] = filter.value;
      apply(false);
    }, 200);
  });
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      view.filters[col] = filter.value;
      apply();
    }
  });
  items.push(
    el('div', { class: 'dv-menu-sep' }),
    el('div', { class: 'dv-menu-title sheet-col-menu-title', text: t('filterContains') }),
    filter,
  );
  if (!model.frozenRows) {
    const header = el('input');
    header.type = 'checkbox';
    header.checked = view.headerRow;
    header.addEventListener('change', () => {
      view.headerRow = header.checked;
      apply(false);
    });
    items.push(el('label', { class: 'dv-check sheet-col-check' }, [header, el('span', { text: t('headerRow') })]));
  }
  if (view.filters[col]) {
    items.push(
      el('div', { class: 'dv-menu-sep' }),
      menuRow('', t('clearColumnFilter'), () => {
        delete view.filters[col];
        apply();
      }),
    );
  }
  columnMenu.replaceChildren(...items);
  columnMenu.setAttribute('aria-label', t('columnMenu', columnName(col)));
  if (columnMenu.hidden) {
    columnMenu.hidden = false;
    document.addEventListener('mousedown', onColumnMenuOutside);
  }
  const left = Math.min(anchor.left, window.innerWidth - columnMenu.offsetWidth - 8);
  columnMenu.style.left = `${Math.max(8, left)}px`;
  columnMenu.style.top = `${anchor.bottom + 4}px`;
  columnMenu.style.right = 'auto';
  filter.focus();
}

// ---------------------------------------------------------------- drawer options, convert & right-to-left

let rtl = readState().rtl === true;
const rtlToggle = toggleButton('rtl', t('rtl'), (on) => setSheetRtl(on));
rtlToggle.set(rtl);

function setSheetRtl(on: boolean) {
  rtl = on;
  rtlToggle.set(on);
  writeState({ rtl });
  grid?.setRtl(on);
}

function convertItems(): MenuItem[] {
  const formats: ('csv' | 'tsv' | 'xlsx')[] = ['csv', 'tsv', 'xlsx'];
  return formats.map((format) => ({
    label: t('convertTo', format.toUpperCase()),
    icon: 'export' as const,
    // Not to its own format; a workbook converts its current sheet to CSV/TSV.
    visible: () => {
      const ext = getFileState().ext;
      return ext !== format && !(format === 'xlsx' && ext === 'xlsm');
    },
    onClick: () => post({ type: 'convert', index: active, format }),
  }));
}

const convertDropdown = moreMenu(t('convertMenu'), convertItems(), 'export');
const historyBtn = iconButton('history', t('slotHistory'), () => post({ type: 'history' }));

const lock = lockToggle();
lock.hidden = true;

let sheetZoom = 1;
const zoom = createZoom((value) => {
  sheetZoom = value;
  grid?.setZoom(value);
}, gridHost);

const topBar = customToolbar({
  subtitle: () => (getFileState().ext ? getFileState().ext.toUpperCase() : 'SHEET'),
  extraLeft: [filterChip],
  slots: [
    { id: 'view', nodes: [csvView.node, excelView.node] },
    { id: 'zoom', nodes: zoom.nodes },
    { id: 'cellBar', nodes: [address, formulaBar] },
    { id: 'find', nodes: [findToggle, findBox, findStatus] },
    { id: 'edit', label: t('lockEdits'), nodes: [lock] },
    { id: 'highlight', nodes: [highlightToggle(), freezeBtn.node] },
    { id: 'structure', nodes: [structureGroup] },
    {
      id: 'actions',
      label: t('convertMenu'),
      nodes: [convertDropdown],
      visible: () => convertItems().some((i) => i.visible?.() !== false),
    },
    { id: 'history', nodes: [historyBtn], visible: () => getFileState().history },
    { id: 'rtl', nodes: [rtlToggle.node] },
    { id: 'openApp', nodes: [openExternalButton()] },
  ],
  documentActions: [
    openExternalMenuItem(),
    ...convertItems(),
    { label: t('history'), icon: 'history', visible: () => getFileState().history, onClick: () => post({ type: 'history' }) },
  ],
  documentOptions: [
    {
      label: () => t('setDefault', getFileState().ext || 'csv'),
      visible: () => getFileState().isDefault !== undefined,
      checked: () => getFileState().isDefault === true,
      onChange: (on) => post({ type: 'setDefault', on }),
    },
    {
      label: t('lockEdits'),
      visible: () => Boolean(info?.editable),
      checked: () => getAppearance().lockEdits,
      onChange: (on) => updateAppearance({ lockEdits: on }),
    },
    {
      label: t('highlightRowCol'),
      checked: () => getAppearance().highlight,
      onChange: (on) => updateAppearance({ highlight: on }),
    },
    {
      label: t('freezeHeader'),
      checked: () => effectiveFrozenRows(active, models.get(active)) > 0,
      onChange: (on) => {
        freezeOverrides.set(active, on);
        freezeBtn.set(on);
        show(active, true);
      },
    },
    {
      label: t('rtl'),
      checked: () => rtl,
      onChange: (on) => setSheetRtl(on),
    },
  ],
});

app.append(topBar.node, notice.node, gridHost, statusBar);
showStatus(gridHost, t('loading'));

// ---------------------------------------------------------------- helpers

/** Rough text width: CJK glyphs are about twice as wide as Latin ones. */
function displayWidth(text: string): number {
  let w = 0;
  for (let i = 0; i < text.length && w < 60; i++) {
    w += text.charCodeAt(i) > 0x2e7f ? 2 : 1;
  }
  return w;
}

function autoWidths(model: SheetModel): number[] {
  const result: number[] = [];
  const sample = Math.min(model.rows.length, 200);
  for (let c = 0; c < model.colCount; c++) {
    const preset = model.colWidths?.[c];
    if (preset != null) {
      result.push(preset);
      continue;
    }
    if (model.colWidths) {
      // Workbook with explicit widths elsewhere: unspecified columns use the default.
      result.push(72);
      continue;
    }
    let max = 4;
    for (let r = 0; r < sample; r++) {
      max = Math.max(max, displayWidth(cellText(model.rows[r]?.[c])));
    }
    result.push(Math.min(360, Math.max(56, Math.round(max * 7.4 + 18))));
  }
  return result;
}

function effectiveFrozenRows(index: number, model: SheetModel | undefined): number {
  const override = freezeOverrides.get(index);
  if (override !== undefined) {
    return override ? Math.max(1, model?.frozenRows ?? 0) : 0;
  }
  return model?.frozenRows ?? 0;
}

/** Rows that stay on top and out of sorting: frozen rows, else an optional header row. */
function fixedRows(model: SheetModel, view: SheetView): number {
  return effectiveFrozenRows(active, model) || (view.headerRow ? 1 : 0);
}

function sourceFor(index: number, model: SheetModel): GridSource {
  let colWidths = widths.get(index);
  // Columns were inserted or removed: old widths no longer line up, so measure again.
  if (!colWidths || colWidths.length !== model.colCount) {
    colWidths = autoWidths(model);
    widths.set(index, colWidths);
  }
  const view = viewOf(index);
  rowMap = isActive(view) ? viewRows(model.rows, model.rows.length, fixedRows(model, view), view) : undefined;
  const map = rowMap;
  let rowHeights = model.rowHeights;
  let merges = model.merges;
  if (map) {
    // Heights follow their rows; merges only survive inside the fixed header rows.
    const fixed = fixedRows(model, view);
    rowHeights = model.rowHeights
      ? Object.fromEntries(map.map((r, i) => [i, model.rowHeights![r]]).filter(([, h]) => h !== undefined))
      : undefined;
    merges = model.merges?.filter((m) => m.r + m.rs <= fixed);
  }
  const frozenR = effectiveFrozenRows(index, model);
  freezeBtn.set(frozenR > 0);
  return {
    rowCount: map ? map.length : model.rowCount,
    colCount: model.colCount,
    cell: map ? (r, c) => model.rows[map[r]]?.[c] : (r, c) => model.rows[r]?.[c],
    styles: plain ? undefined : model.styles,
    colWidths,
    rowHeights,
    merges,
    frozenRows: frozenR,
    frozenCols: model.frozenCols,
    palette: !plain && model.styles?.some((s) => s.color || s.bg) ? 'light' : 'theme',
    rowLabel: map ? (r) => String(map[r] + 1) : undefined,
    colBadge: (c) => {
      const badges = view.sortCol === c ? (view.sortDir === -1 ? ' ↓' : ' ↑') : '';
      return badges + (view.filters[c]?.trim() ? ' ⧩' : '');
    },
  };
}

function updateSummary() {
  const model = models.get(active);
  summary.textContent = model ? `${t('rows', model.rowCount)} × ${t('cols', model.colCount)}` : '';
}

/** Cell targeted when the user started editing inside the formula bar. */
let formulaTarget: { sheet: number; r: number; c: number; initial: string } | undefined;

function syncFormulaFromSelection(sel: Selection) {
  const model = models.get(active);
  const srcR = toSource(sel.r);
  const raw = srcR >= 0 ? cellRaw(model?.rows[srcR]?.[sel.c]) : '';
  if (document.activeElement !== formula) {
    formula.value = raw;
    formula.title = raw;
  }
}

function commitFormulaBar() {
  if (!formulaTarget || formulaTarget.sheet !== active) {
    formulaTarget = undefined;
    return;
  }
  const { r, c, initial } = formulaTarget;
  formulaTarget = undefined;
  if (!canEdit()) {
    return;
  }
  const value = formula.value;
  if (value !== initial) {
    edit([{ r, c, text: value }]);
  }
}

formula.addEventListener('focus', () => {
  if (!canEdit()) {
    if (info?.editable) {
      flash(t('locked'));
    } else if (info?.noticeKey) {
      flash(t(info.noticeKey));
    }
    formula.blur();
    grid?.focus();
    return;
  }
  const sel = grid?.selection;
  if (!sel) {
    return;
  }
  const model = models.get(active);
  const srcR = toSource(sel.r);
  const cell = srcR >= 0 ? model?.rows[srcR]?.[sel.c] : undefined;
  if (typeof cell === 'object' && cell?.ro) {
    flash(t('cellReadonly'));
    formula.blur();
    grid?.focus();
    return;
  }
  formulaTarget = { sheet: active, r: sel.r, c: sel.c, initial: formula.value };
});

formula.addEventListener('keydown', (e) => {
  if (e.isComposing) {
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const target = formulaTarget;
    commitFormulaBar();
    if (target && grid) {
      grid.goTo(target.r + 1, target.c);
      grid.focus();
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (formulaTarget) {
      formula.value = formulaTarget.initial;
      formulaTarget = undefined;
    }
    grid?.focus();
  }
  e.stopPropagation();
});

formula.addEventListener('blur', () => {
  commitFormulaBar();
});

function formatStatNum(n: number): string {
  const rounded = Math.abs(n - Math.round(n)) < 1e-9 ? Math.round(n) : Number(n.toFixed(4));
  return rounded.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function updateSelectionStats(sel: Selection) {
  const model = models.get(active);
  if (!model) {
    selectionStatsEl.hidden = true;
    return;
  }
  const cellAt = (r: number, c: number) => {
    const srcR = toSource(r);
    return srcR >= 0 ? model.rows[srcR]?.[c] : undefined;
  };
  const stats = computeSelectionStats(cellAt, sel.r0, sel.c0, sel.r1, sel.c1);
  if (!stats) {
    selectionStatsEl.hidden = true;
    selectionStatsEl.replaceChildren();
    return;
  }
  const makePill = (label: string, rawVal: string, displayVal: string) => {
    const btn = el('button', {
      class: 'sheet-stat-pill',
      text: `${label}: ${displayVal}`,
      title: `${t('copy')}: ${rawVal}`,
    });
    btn.type = 'button';
    btn.addEventListener('click', () => {
      void navigator.clipboard?.writeText(rawVal).then(() => flash(t('imgCopied', rawVal)));
    });
    return btn;
  };
  const pills: HTMLElement[] = [makePill(t('statCount'), String(stats.count), String(stats.count))];
  if (stats.numCount > 0) {
    pills.push(
      makePill(t('statSum'), String(Number(stats.sum.toFixed(6))), formatStatNum(stats.sum)),
      makePill(t('statAvg'), String(Number(stats.avg.toFixed(6))), formatStatNum(stats.avg)),
    );
    if (stats.numCount >= 2) {
      pills.push(
        makePill(t('statMin'), String(Number(stats.min.toFixed(6))), formatStatNum(stats.min)),
        makePill(t('statMax'), String(Number(stats.max.toFixed(6))), formatStatNum(stats.max)),
      );
    }
  }
  selectionStatsEl.replaceChildren(...pills);
  selectionStatsEl.hidden = false;
}

function autoFitColumn(col: number) {
  const model = models.get(active);
  if (!model || !grid) {
    return;
  }
  const limit = Math.min(model.rows.length, 600);
  let maxChars = Math.max(3, columnName(col).length + 2);
  for (let r = 0; r < limit; r++) {
    maxChars = Math.max(maxChars, displayWidth(cellText(model.rows[r]?.[col])));
  }
  const fitted = Math.min(480, Math.max(48, Math.round(maxChars * 7.6 + 20)));
  const savedWidths = widths.get(active);
  if (savedWidths && col < savedWidths.length) {
    savedWidths[col] = fitted;
  }
  grid.setColumnWidth(col, fitted);
}

function onSelection(sel: Selection) {
  if (formulaTarget && document.activeElement === formula) {
    commitFormulaBar();
  }
  const single = sel.r0 === sel.r1 && sel.c0 === sel.c1;
  const row = (r: number) => toSource(r) + 1;
  address.textContent = single
    ? `${columnName(sel.c)}${row(sel.r)}`
    : `${columnName(sel.c0)}${row(sel.r0)}:${columnName(sel.c1)}${row(sel.r1)}`;
  syncFormulaFromSelection(sel);
  updateSelectionStats(sel);
}

// ---------------------------------------------------------------- context menu (grid & sheet tabs)

const ctxPopup = el('div', { class: 'dv-menu dv-more-menu sheet-ctx-menu' });
ctxPopup.setAttribute('role', 'menu');
ctxPopup.hidden = true;
document.body.append(ctxPopup);

function onCtxOutside(e: MouseEvent) {
  if (!ctxPopup.contains(e.target as Node)) {
    closeCtxPopup();
  }
}

function closeCtxPopup() {
  if (!ctxPopup.hidden) {
    ctxPopup.hidden = true;
    document.removeEventListener('mousedown', onCtxOutside);
  }
}

ctxPopup.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeCtxPopup();
    grid?.focus();
  }
});

function showCtxPopup(x: number, y: number, rows: (HTMLElement | '-')[]) {
  const cleaned = rows.filter((r, i) => r !== '-' || (i > 0 && i < rows.length - 1 && rows[i - 1] !== '-'));
  if (!cleaned.length) {
    return;
  }
  ctxPopup.replaceChildren(
    ...cleaned.map((r) => (r === '-' ? el('div', { class: 'dv-menu-sep' }) : r)),
  );
  ctxPopup.hidden = false;
  document.addEventListener('mousedown', onCtxOutside);
  const left = Math.max(8, Math.min(x, window.innerWidth - ctxPopup.offsetWidth - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - ctxPopup.offsetHeight - 8));
  ctxPopup.style.left = `${left}px`;
  ctxPopup.style.top = `${top}px`;
  ctxPopup.style.right = 'auto';
}

function ctxAction(label: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = el('button', { class: 'dv-menu-item' });
  b.type = 'button';
  b.disabled = disabled;
  b.setAttribute('role', 'menuitem');
  b.append(el('span', { class: 'dv-menu-label', text: label }));
  b.addEventListener('click', () => {
    closeCtxPopup();
    onClick();
  });
  return b;
}

function openGridContextMenu(x: number, y: number) {
  const sel = grid?.selection;
  if (!sel || !info?.editable) {
    return;
  }
  const locked = getAppearance().lockEdits;
  const items: (HTMLElement | '-')[] = [
    ctxAction(
      t('clearCell'),
      () => {
        if (locked) {
          flash(t('locked'));
          return;
        }
        const changes: CellChange[] = [];
        for (let r = sel.r0; r <= sel.r1; r++) {
          for (let c = sel.c0; c <= sel.c1; c++) {
            changes.push({ r, c, text: '' });
          }
        }
        edit(changes);
      },
      locked,
    ),
  ];
  if (info.canStructure) {
    items.push(
      '-',
      ctxAction(t('insertRowAbove'), () => structure('insertRow', sel.r0), locked),
      ctxAction(t('insertRowBelow'), () => structure('insertRow', sel.r1 + 1), locked),
      ctxAction(t('delRow'), () => structure('deleteRows'), locked),
      '-',
      ctxAction(t('insertColLeft'), () => structure('insertCol', sel.c0), locked),
      ctxAction(t('insertColRight'), () => structure('insertCol', sel.c1 + 1), locked),
      ctxAction(t('delCol'), () => structure('deleteCols'), locked),
    );
  }
  showCtxPopup(x, y, items);
}

function showNotice() {
  notice.setInfo(info?.noticeKey ? t(info.noticeKey) : '');
}

function flash(message: string) {
  notice.flash(message, 3500);
}

function canEdit(): boolean {
  return (info?.editable ?? false) && !getAppearance().lockEdits;
}

function applyLock() {
  const editableNow = canEdit();
  grid?.setEditable(editableNow);
  formula.readOnly = !editableNow;
  const locked = getAppearance().lockEdits;
  structureButtons.forEach((b) => (b.disabled = locked));
  addSheetBtn.disabled = locked;
}

onAppearanceChange(applyLock);

function ensureGrid(): Grid {
  if (!grid) {
    gridHost.replaceChildren();
    grid = new Grid(gridHost, {
      editable: canEdit(),
      canGrowRows: info?.canStructure ?? false,
      onEdit: (changes) => edit(changes),
      onSelection,
      onEditorInput: (val) => {
        if (document.activeElement !== formula) {
          formula.value = val;
        }
      },
      onReadonlyCell: () => flash(t('cellReadonly')),
      onBlockedEdit: () => {
        if (info?.editable) {
          flash(t('locked'));
        }
      },
      onPasteTruncated: () => {
        if (rowMap && info?.canStructure) {
          flash(t('structureBlocked'));
        }
      },
      onColumnResize: (col, w) => {
        const cur = widths.get(active);
        if (cur && col < cur.length) {
          cur[col] = w;
        }
      },
      onColumnAutoFit: (col) => autoFitColumn(col),
      onColumnMenu: (col, anchor) => openColumnMenu(col, anchor),
      onContextMenu: (_area, _r, _c, x, y) => openGridContextMenu(x, y),
    });
    grid.setRtl(rtl);
    grid.setZoom(sheetZoom);
  }
  return grid;
}

function edit(changes: CellChange[]) {
  // Displayed rows → file rows. Rows past the end only exist in an unsorted, unfiltered view.
  const mapped = changes
    .map((change) => ({ ...change, r: toSource(change.r) }))
    .filter((change) => change.r >= 0);
  if (!mapped.length) {
    return;
  }
  // Show the new text immediately; the host answers with the authoritative cells.
  const model = models.get(active);
  if (model) {
    for (const { r, c, text } of mapped) {
      setCell(model, r, c, text);
    }
    findDataEpoch++;
    grid?.invalidate();
  }
  post({ type: 'edit', index: active, changes: mapped });
}

function setCell(model: SheetModel, r: number, c: number, cell: Cell) {
  while (model.rows.length <= r) {
    model.rows.push([]);
  }
  const row = model.rows[r];
  while (row.length <= c) {
    row.push(null);
  }
  const previous = row[c];
  // An optimistic string update keeps the existing style until the host responds.
  row[c] =
    typeof cell === 'string' && typeof previous === 'object' && previous?.s !== undefined
      ? { v: cell, s: previous.s }
      : cell;
}

function show(index: number, keepView: boolean) {
  const model = models.get(index);
  if (!model) {
    post({ type: 'getSheet', index });
    return;
  }
  findDataEpoch++;
  const g = ensureGrid();
  const src = sourceFor(index, model);
  g.setCanGrowRows((info?.canStructure ?? false) && !rowMap);
  g.setData(src, keepView);
  updateSummary();
  updateFilterChip(model);
  post({ type: 'status', ok: true, detail: `${model.name}: ${model.rowCount}x${model.colCount}` });
}

function startTabRename(tabBtn: HTMLButtonElement, index: number, currentName: string) {
  if (!info?.canManageSheets) {
    return;
  }
  if (getAppearance().lockEdits) {
    flash(t('locked'));
    return;
  }
  const input = el('input', { class: 'dv-input sheet-tab-rename' });
  input.type = 'text';
  input.value = currentName;
  input.maxLength = 31;
  let done = false;
  const finish = (commit: boolean) => {
    if (done) {
      return;
    }
    done = true;
    const next = input.value.trim();
    renderTabs();
    if (commit && next && next !== currentName) {
      post({ type: 'sheetOp', op: 'rename', index, name: next });
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) {
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  tabBtn.replaceWith(input);
  input.focus();
  input.select();
}

function renderTabs() {
  const sheets = info?.sheets ?? [];
  const manageable = Boolean(info?.canManageSheets);
  addSheetBtn.hidden = !manageable;
  tabs.hidden = sheets.length <= 1 && !manageable;
  if (tabs.hidden) {
    tabs.replaceChildren();
    return;
  }
  tabs.replaceChildren(
    ...sheets.map((sheet, i) => {
      const tip = manageable ? `${sheet.name} (${t('sheetTabHint')})` : sheet.name;
      const tab = button(sheet.name, tip, () => {
        if (i !== active) {
          active = i;
          renderTabs();
          show(i, false);
          grid?.focus();
        }
      });
      tab.classList.add('sheet-tab');
      tab.classList.toggle('dv-active', i === active);
      if (manageable) {
        tab.addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
          startTabRename(tab, i, sheet.name);
        });
        tab.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const locked = getAppearance().lockEdits;
          const rect = tab.getBoundingClientRect();
          showCtxPopup(rect.left, rect.top - 108, [
            ctxAction(t('renameSheet'), () => startTabRename(tab, i, sheet.name), locked),
            ctxAction(
              t('deleteSheet'),
              () => post({ type: 'sheetOp', op: 'delete', index: i }),
              locked || sheets.length <= 1,
            ),
            '-',
            ctxAction(t('newSheet'), () => post({ type: 'sheetOp', op: 'add' }), locked),
          ]);
        });
      }
      return tab;
    }),
  );
}

// ---------------------------------------------------------------- messages

onMessage((message) => {
  switch (message.type) {
    case 'workbook': {
      info = message.info;
      active = Math.min(message.active, Math.max(0, info.sheets.length - 1));
      models.clear();
      showNotice();
      const isCsv = Boolean(info.hasSource);
      csvView.node.hidden = !isCsv;
      excelView.node.hidden = isCsv;
      structureGroup.hidden = !info.canStructure;
      lock.hidden = !info.editable;
      topBar.refresh();
      renderTabs();
      show(active, false);
      applyLock();
      break;
    }
    case 'sheet': {
      const known = models.has(message.index);
      models.set(message.index, message.model);
      if (message.index === active) {
        show(active, known);
      }
      break;
    }
    case 'cells': {
      const model = models.get(message.index);
      if (!model) {
        break;
      }
      for (const { r, c, cell } of message.cells) {
        while (model.rows.length <= r) {
          model.rows.push([]);
        }
        const row = model.rows[r];
        while (row.length <= c) {
          row.push(null);
        }
        row[c] = cell;
      }
      if (message.index === active && grid) {
        findDataEpoch++;
        grid.invalidate();
        onSelection(grid.selection);
      }
      break;
    }
    case 'rows': {
      const model = models.get(message.index);
      if (!model) {
        break;
      }
      const sizeChanged = model.rowCount !== message.rowCount || model.colCount !== message.colCount;
      for (const { r, cells } of message.rows) {
        model.rows[r] = cells;
      }
      if (message.rowCount < model.rows.length) {
        model.rows.length = message.rowCount;
      }
      model.rowCount = message.rowCount;
      model.colCount = message.colCount;
      if (message.index === active && grid) {
        if (sizeChanged) {
          show(active, true);
        } else {
          // Rows stay where the current sort put them until it is applied again.
          findDataEpoch++;
          grid.invalidate();
        }
        onSelection(grid.selection);
      }
      break;
    }
    case 'viewState':
      csvView.set(message.split ? 'split' : 'table');
      break;
    case 'error':
      grid = undefined;
      showStatus(gridHost, message.message, true);
      post({ type: 'status', ok: false, detail: message.message });
      break;
  }
});

post({ type: 'ready' });
