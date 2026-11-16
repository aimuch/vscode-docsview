// Table view for CSV/TSV and Excel workbooks.
import type { Cell, CellChange, SheetModel, StructureOp, WorkbookInfo } from '../../common/protocol';
import { cellRaw, cellText, columnName, Grid, type GridSource, type Selection } from '../grid/grid';
import '../shared/base.css';
import { app, button, el, onMessage, post, showStatus, t } from '../shared/api';
import { getAppearance, highlightToggle, lockToggle, onAppearanceChange, updateAppearance } from '../shared/appearance';
import { getFileState } from '../shared/fileState';
import { icons } from '../shared/icons';
import { readState, writeState } from '../shared/sidebar';
import { customToolbar, iconButton, moreMenu, segmented, toggleButton, type MenuItem } from '../shared/ui';
import './sheet.css';
import { emptyView, isActive, viewRows, type SheetView } from './view';

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
const formula = el('span', { class: 'sheet-formula' });
const summary = el('span', { class: 'dv-label' });
const notice = el('div', { class: 'dv-notice' });
notice.hidden = true;
const gridHost = el('div', { class: 'sheet-grid' });
// Bottom bar: sheet tabs on the left, size summary on the right (like a spreadsheet status bar).
const tabs = el('div', { class: 'sheet-tab-list' });
const statusBar = el('div', { class: 'sheet-tabs' }, [tabs, el('div', { class: 'dv-spacer' }), summary]);
const structureButtons: HTMLButtonElement[] = [];

function viewOf(index: number): SheetView {
  let view = views.get(index);
  if (!view) {
    views.set(index, (view = emptyView()));
  }
  return view;
}

function structure(op: StructureOp) {
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
  const at = rows ? sel.r0 : sel.c0;
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

// CSV: table here, or the text editor instead. Excel: authored styles, or plain data.
const csvView = segmented<'table' | 'text'>(
  t('view'),
  [
    ['table', t('viewTable')],
    ['text', t('viewText')],
  ],
  'table',
  (mode) => {
    if (mode === 'text') {
      post({ type: 'showSource', beside: false });
      csvView.set('table');
    }
  },
);
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

const topBar = customToolbar({
  subtitle: () => (getFileState().ext ? getFileState().ext.toUpperCase() : 'SHEET'),
  extraLeft: [filterChip],
  slots: [
    { id: 'view', nodes: [csvView.node, excelView.node] },
    { id: 'cellBar', nodes: [address, formula] },
    { id: 'find', nodes: [findToggle, findBox, findStatus] },
    { id: 'edit', label: t('lockEdits'), nodes: [lock] },
    { id: 'highlight', nodes: [highlightToggle()] },
    { id: 'structure', nodes: [structureGroup] },
    {
      id: 'actions',
      label: t('convertMenu'),
      nodes: [convertDropdown],
      visible: () => convertItems().some((i) => i.visible?.() !== false),
    },
    { id: 'history', nodes: [historyBtn], visible: () => getFileState().history },
    { id: 'rtl', nodes: [rtlToggle.node] },
  ],
  documentActions: [
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
      label: t('rtl'),
      checked: () => rtl,
      onChange: (on) => setSheetRtl(on),
    },
  ],
});

app.append(topBar.node, notice, gridHost, statusBar);
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

/** Rows that stay on top and out of sorting: frozen rows, else an optional header row. */
function fixedRows(model: SheetModel, view: SheetView): number {
  return model.frozenRows || (view.headerRow ? 1 : 0);
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
  return {
    rowCount: map ? map.length : model.rowCount,
    colCount: model.colCount,
    cell: map ? (r, c) => model.rows[map[r]]?.[c] : (r, c) => model.rows[r]?.[c],
    styles: plain ? undefined : model.styles,
    colWidths,
    rowHeights,
    merges,
    frozenRows: model.frozenRows,
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

function onSelection(sel: Selection) {
  const model = models.get(active);
  const single = sel.r0 === sel.r1 && sel.c0 === sel.c1;
  const row = (r: number) => toSource(r) + 1;
  address.textContent = single
    ? `${columnName(sel.c)}${row(sel.r)}`
    : `${columnName(sel.c0)}${row(sel.r0)}:${columnName(sel.c1)}${row(sel.r1)}`;
  formula.textContent = cellRaw(model?.rows[toSource(sel.r)]?.[sel.c]);
  formula.title = formula.textContent;
}

function showNotice() {
  notice.textContent = info?.noticeKey ? t(info.noticeKey) : '';
  notice.hidden = !info?.noticeKey;
}

let flashTimer: ReturnType<typeof setTimeout> | undefined;
function flash(message: string) {
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    showNotice();
  }, 3500);
}

function canEdit(): boolean {
  return (info?.editable ?? false) && !getAppearance().lockEdits;
}

function applyLock() {
  grid?.setEditable(canEdit());
  const locked = getAppearance().lockEdits;
  structureButtons.forEach((b) => (b.disabled = locked));
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
      onColumnMenu: (col, anchor) => openColumnMenu(col, anchor),
    });
    grid.setRtl(rtl);
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

function renderTabs() {
  const sheets = info?.sheets ?? [];
  tabs.hidden = sheets.length <= 1;
  if (tabs.hidden) {
    tabs.replaceChildren();
    return;
  }
  tabs.replaceChildren(
    ...sheets.map((sheet, i) => {
      const tab = button(sheet.name, sheet.name, () => {
        if (i !== active) {
          active = i;
          renderTabs();
          show(i, false);
          grid?.focus();
        }
      });
      tab.classList.add('sheet-tab');
      tab.classList.toggle('dv-active', i === active);
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
      csvView.node.hidden = !info.canStructure;
      excelView.node.hidden = info.canStructure;
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
      for (const { r, cells } of message.rows) {
        model.rows[r] = cells;
      }
      model.rowCount = message.rowCount;
      model.colCount = message.colCount;
      if (message.index === active && grid) {
        // Rows stay where the current sort put them until it is applied again.
        findDataEpoch++;
        grid.invalidate();
        onSelection(grid.selection);
      }
      break;
    }
    case 'error':
      grid = undefined;
      showStatus(gridHost, message.message, true);
      post({ type: 'status', ok: false, detail: message.message });
      break;
  }
});

post({ type: 'ready' });
