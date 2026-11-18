// Table view for CSV/TSV, JSONL and Excel workbooks.
import { extractFormulaFromAiResponse, extractTableFromAiResponse } from '../../common/aiResponseParser';
import type { AiSheetSchemaContext, Cell, CellChange, SheetModel, StructureOp, WorkbookInfo } from '../../common/protocol';
import { cellRaw, cellText, columnName, Grid, type GridSource, type Selection } from '../grid/grid';
import '../shared/base.css';
import { createAiAssistant } from '../shared/aiAssistant';
import { app, button, el, onMessage, post, showStatus, t } from '../shared/api';
import { getAppearance, highlightToggle, lockToggle, onAppearanceChange, updateAppearance } from '../shared/appearance';
import { getFileState } from '../shared/fileState';
import { createFindBar } from '../shared/find';
import { icons } from '../shared/icons';
import { bindLiveViewerStatus, overlayStack } from '../shared/overlayStack';
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
import { createJsonlInspector } from './jsonlInspector';
import {
  collectColumnUniqueValues,
  computeAutoFillChanges,
  computeColumnNumericBounds,
  computeSelectionStats,
  condFormatGradient,
  emptyView,
  hasAnyFilter,
  hasColumnFilter,
  isActive,
  numericValue,
  selectionToJson,
  selectionToMarkdownTable,
  shiftFormulaRefs,
  viewRows,
  type CondFormatKind,
  type NumFilterOp,
  type SheetView,
} from './view';

let info: WorkbookInfo | undefined;
let active = 0;
const models = new Map<number, SheetModel>();
/** Column widths survive data refreshes (the model is replaced on every reload). */
const widths = new Map<number, number[]>();
/** Sort and filter per sheet. */
const views = new Map<number, SheetView>();
/** Per-sheet, per-column conditional formatting ('none' | 'bar' | 'heat'). */
const condFormats = new Map<number, Record<number, CondFormatKind>>();
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
const fxAiBtn = el('button', { class: 'sheet-fx-ai-btn', title: `${t('aiActFormula')} (AI)` });
fxAiBtn.type = 'button';
fxAiBtn.innerHTML = icons.sparkle;
const formulaBar = el('span', { class: 'sheet-formula-wrap' }, [fxBadge, formula, fxAiBtn]);

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

/** Per-sheet user overrides for freezing the top row and first column (`undefined` = follow workbook). */
const freezeOverrides = new Map<number, boolean>();
const freezeColOverrides = new Map<number, boolean>();
const freezeBtn = toggleButton('freeze', t('freezeHeader'), (on) => {
  freezeOverrides.set(active, on);
  show(active, true);
});
const freezeColBtn = toggleButton('freezeCol', t('freezeFirstCol'), (on) => {
  freezeColOverrides.set(active, on);
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

// ---------------------------------------------------------------- find & replace

/** Monotonic counter incremented whenever cell data or displayed row order changes. */
let findDataEpoch = 0;
let findCache: { sheet: number; epoch: number; query: string; hits: number[]; hitSet: Set<number> } | undefined;
let findMatchStatus = '';

function rebuildFindCache(): { hits: number[]; hitSet: Set<number> } | undefined {
  const model = models.get(active);
  const query = sheetFindBar.input.value.trim().toLowerCase();
  if (!model || !query) {
    findCache = undefined;
    return undefined;
  }
  if (!findCache || findCache.sheet !== active || findCache.epoch !== findDataEpoch || findCache.query !== query) {
    const hits: number[] = [];
    const { colCount } = model;
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
    findCache = { sheet: active, epoch: findDataEpoch, query, hits, hitSet: new Set(hits) };
  }
  return findCache;
}

/** Selects the next (or previous) displayed cell whose text contains the query, wrapping around. */
function findNext(backwards = false) {
  const model = models.get(active);
  const query = sheetFindBar.input.value.trim().toLowerCase();
  if (!model || !grid || !query) {
    findCache = undefined;
    findMatchStatus = '';
    sheetFindBar.refreshCount('');
    grid?.refreshHighlights();
    return;
  }
  const rowCount = rowMap ? rowMap.length : model.rowCount;
  const { colCount } = model;
  if (!rowCount || !colCount) {
    findMatchStatus = t('noMatch');
    sheetFindBar.refreshCount(findMatchStatus);
    grid.refreshHighlights();
    return;
  }
  const cache = rebuildFindCache();
  const hits = cache?.hits ?? [];
  grid.refreshHighlights();
  if (!hits.length) {
    findMatchStatus = t('noMatch');
    sheetFindBar.refreshCount(findMatchStatus);
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
  findMatchStatus = `${idx + 1}/${hits.length}`;
  sheetFindBar.refreshCount(findMatchStatus);
  grid.goTo(Math.floor(found / colCount), found % colCount);
}

const sheetFindBar = createFindBar(
  {
    onInput: (q) => {
      if (!q.trim()) {
        findCache = undefined;
        findMatchStatus = '';
        grid?.refreshHighlights();
        return;
      }
      findNext(false);
    },
    step: (backwards) => findNext(backwards),
    clear: () => {
      findCache = undefined;
      findMatchStatus = '';
      grid?.refreshHighlights();
    },
    status: () => findMatchStatus,
  },
  gridHost,
  { ariaLabel: t('findInSheet') },
);

function replaceSubstringCI(source: string, needle: string, replacement: string): string {
  if (!needle) {
    return source;
  }
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.replace(new RegExp(escaped, 'gi'), () => replacement);
}

const replaceInput = el('input', { class: 'dv-input sheet-replace-input' });
replaceInput.type = 'text';
replaceInput.placeholder = t('replaceWith');
replaceInput.setAttribute('aria-label', t('replaceWith'));

function doReplaceOne() {
  if (!canEdit()) {
    flash(t('locked'));
    return;
  }
  const model = models.get(active);
  const query = sheetFindBar.input.value.trim();
  if (!model || !grid || !query) {
    sheetFindBar.input.focus();
    return;
  }
  const sel = grid.selection;
  const srcR = toSource(sel.r);
  const curCell = srcR >= 0 ? model.rows[srcR]?.[sel.c] : undefined;
  const curText = cellText(curCell);
  if (
    curText.toLowerCase().includes(query.toLowerCase()) &&
    !(typeof curCell === 'object' && curCell?.ro)
  ) {
    const rawVal = cellRaw(curCell);
    if (rawVal.startsWith('=') && !query.startsWith('=')) {
      findNext(false);
      return;
    }
    const nextText = replaceSubstringCI(rawVal, query, replaceInput.value);
    if (nextText !== rawVal) {
      edit([{ r: sel.r, c: sel.c, text: nextText }]);
    }
  }
  findNext(false);
}

function doReplaceAll() {
  if (!canEdit()) {
    flash(t('locked'));
    return;
  }
  const model = models.get(active);
  const query = sheetFindBar.input.value.trim();
  if (!model || !grid || !query) {
    sheetFindBar.input.focus();
    return;
  }
  const cache = rebuildFindCache();
  if (!cache?.hits.length) {
    flash(t('noMatch'));
    return;
  }
  const { colCount } = model;
  const changes: CellChange[] = [];
  for (const hit of cache.hits) {
    const r = Math.floor(hit / colCount);
    const c = hit % colCount;
    const srcR = toSource(r);
    const cell = srcR >= 0 ? model.rows[srcR]?.[c] : undefined;
    if (typeof cell === 'object' && cell?.ro) {
      continue;
    }
    const rawVal = cellRaw(cell);
    if (rawVal.startsWith('=') && !query.startsWith('=')) {
      continue;
    }
    const nextText = replaceSubstringCI(rawVal, query, replaceInput.value);
    if (nextText !== rawVal) {
      changes.push({ r, c, text: nextText });
    }
  }
  if (changes.length) {
    edit(changes);
  }
  flash(t('replacedCount', changes.length));
}

const replaceOneBtn = textButton(t('replaceOne'), t('replaceOne'), doReplaceOne);
const replaceAllBtn = textButton(t('replaceAll'), t('replaceAll'), doReplaceAll);
const replaceCloseBtn = iconButton('close', t('close'), () => setReplaceBarOpen(false));
const replaceBar = el('div', { class: 'sheet-replace-bar' }, [
  el('span', { class: 'dv-label', text: t('replace') }),
  replaceInput,
  replaceOneBtn,
  replaceAllBtn,
  replaceCloseBtn,
]);
replaceBar.hidden = true;

replaceInput.addEventListener('keydown', (e) => {
  if (e.isComposing) {
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || e.altKey) {
      doReplaceAll();
    } else {
      doReplaceOne();
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    setReplaceBarOpen(false);
    grid?.focus();
  }
});

const replaceToggle = toggleButton('replace', `${t('replace')} (Ctrl/Cmd+H)`, (on) => setReplaceBarOpen(on));
replaceToggle.node.hidden = true;

function setReplaceBarOpen(on: boolean) {
  const allowed = on && Boolean(info?.editable);
  replaceBar.hidden = !allowed;
  replaceToggle.set(allowed);
  if (allowed) {
    sheetFindBar.open();
    overlayStack.push({
      id: 'sheetReplaceBar',
      isOpen: () => !replaceBar.hidden,
      close: () => setReplaceBarOpen(false),
      restoreFocus: () => gridHost,
    });
    if (sheetFindBar.input.value.trim()) {
      replaceInput.focus();
      replaceInput.select();
    }
  } else {
    overlayStack.remove('sheetReplaceBar');
  }
}

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h' && info?.editable) {
    e.preventDefault();
    setReplaceBarOpen(true);
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
  if (hasAnyFilter(view)) {
    parts.push(t('filtered', rowMap.length - Math.min(fixed, model.rows.length), Math.max(0, model.rows.length - fixed)));
  }
  if (view.sortCol !== undefined) {
    parts.push(t('sortedBy', columnName(view.sortCol), t(view.sortDir === -1 ? 'desc' : 'asc')));
  }
  filterChipText.textContent = parts.join(' · ');
}

function condMapOf(index: number): Record<number, CondFormatKind> {
  let map = condFormats.get(index);
  if (!map) {
    condFormats.set(index, (map = {}));
  }
  return map;
}

function setCondFormatForSelection(kind: CondFormatKind) {
  const sel = grid?.selection;
  if (!sel) {
    return;
  }
  const map = condMapOf(active);
  for (let c = sel.c0; c <= sel.c1; c++) {
    if (kind === 'none') {
      delete map[c];
    } else {
      map[c] = kind;
    }
  }
  show(active, true);
}

// ---------------------------------------------------------------- column menu

const columnMenu = el('div', { class: 'dv-menu sheet-col-menu' });
columnMenu.setAttribute('role', 'dialog');
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
    overlayStack.remove('sheetColumnMenu');
  }
}

columnMenu.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeColumnMenu();
    grid?.focus();
  }
});

function menuRow(icon: keyof typeof icons | '', label: string, onClick: () => void, checked = false): HTMLButtonElement {
  const row = el('button', { class: 'dv-menu-item' });
  row.type = 'button';
  row.setAttribute('role', 'menuitem');
  const mark = el('span', { class: 'dv-menu-check' });
  if (checked) {
    mark.innerHTML = icons.check;
  } else if (icon) {
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
  if (!view.valueFilters) view.valueFilters = {};
  if (!view.excludedValues) view.excludedValues = {};
  if (!view.numFilters) view.numFilters = {};
  const condMap = condMapOf(active);
  const curCond: CondFormatKind = condMap[col] ?? 'none';

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
  const setColCond = (kind: CondFormatKind) => {
    if (kind === 'none') {
      delete condMap[col];
    } else {
      condMap[col] = kind;
    }
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

  // Conditional formatting options per column
  items.push(
    el('div', { class: 'dv-menu-sep' }),
    menuRow('', t('condFormatNone'), () => setColCond('none'), curCond === 'none'),
    menuRow('bars', t('condFormatBar'), () => setColCond('bar'), curCond === 'bar'),
    menuRow('', t('condFormatHeat'), () => setColCond('heat'), curCond === 'heat'),
  );

  // Numeric comparison filter
  const curNum = view.numFilters[col];
  const numOpSelect = el('select', { class: 'dv-select sheet-num-op' });
  const opOptions: [string, string][] = [
    ['', t('numFilterNone')],
    ['>', '>'],
    ['>=', '≥'],
    ['<', '<'],
    ['<=', '≤'],
    ['=', '='],
    ['between', t('numFilterBetween')],
    ['topN', t('numFilterTopN')],
  ];
  for (const [val, label] of opOptions) {
    const opt = el('option', { text: label });
    opt.value = val;
    if ((curNum?.op ?? '') === val) {
      opt.selected = true;
    }
    numOpSelect.append(opt);
  }
  const numA = el('input', { class: 'dv-input sheet-num-val' });
  numA.type = 'number';
  numA.step = 'any';
  numA.value = curNum ? String(curNum.a) : '';
  numA.placeholder = '0';
  numA.hidden = !curNum;

  const numB = el('input', { class: 'dv-input sheet-num-val' });
  numB.type = 'number';
  numB.step = 'any';
  numB.value = curNum?.b !== undefined ? String(curNum.b) : '';
  numB.placeholder = '100';
  numB.hidden = curNum?.op !== 'between';

  const applyNumFilter = () => {
    const op = numOpSelect.value as NumFilterOp | '';
    numA.hidden = !op;
    numB.hidden = op !== 'between';
    if (!op) {
      delete view.numFilters![col];
      apply(false);
      return;
    }
    const a = Number(numA.value);
    if (numA.value.trim() === '' || !Number.isFinite(a)) {
      return;
    }
    const b = op === 'between' ? Number(numB.value || numA.value) : undefined;
    view.numFilters![col] = { op, a, b: Number.isFinite(b as number) ? b : undefined };
    apply(false);
  };
  numOpSelect.addEventListener('change', applyNumFilter);
  numA.addEventListener('input', applyNumFilter);
  numB.addEventListener('input', applyNumFilter);

  items.push(
    el('div', { class: 'dv-menu-sep' }),
    el('div', { class: 'dv-menu-title sheet-col-menu-title', text: t('numFilterTitle') }),
    el('div', { class: 'sheet-num-row' }, [numOpSelect, numA, numB]),
  );

  // Substring text filter
  const filter = el('input', { class: 'dv-input sheet-col-filter' });
  filter.type = 'text';
  filter.value = view.filters[col] ?? '';
  filter.placeholder = t('filterContains');
  filter.setAttribute('aria-label', `${columnName(col)} ${t('filterContains')}`);

  // Unique values multi-select checklist
  const fixed = fixedRows(model, view);
  const uniques = collectColumnUniqueValues(model.rows, model.rows.length, fixed, col);
  const allValues = uniques.map((u) => u.value);
  const isTruncatedUniques = uniques.length >= 200;
  let useExclusionMode = view.valueFilters[col] === undefined;
  const initialExcluded = new Set<string>(view.excludedValues[col] ?? []);
  let selectedSet = new Set<string>(
    view.valueFilters[col] ?? allValues.filter((v) => !initialExcluded.has(v)),
  );

  const uniqueList = el('div', { class: 'sheet-unique-list' });
  const selectAllInput = el('input');
  selectAllInput.type = 'checkbox';

  const commitSelectedSet = () => {
    if (selectedSet.size >= allValues.length) {
      delete view.valueFilters![col];
      delete view.excludedValues![col];
    } else if (isTruncatedUniques && useExclusionMode) {
      delete view.valueFilters![col];
      view.excludedValues![col] = allValues.filter((v) => !selectedSet.has(v));
    } else {
      delete view.excludedValues![col];
      view.valueFilters![col] = Array.from(selectedSet);
    }
    selectAllInput.checked = selectedSet.size === allValues.length;
    selectAllInput.indeterminate = selectedSet.size > 0 && selectedSet.size < allValues.length;
    apply(false);
  };

  const renderUniqueChecklist = (searchQuery: string) => {
    const q = searchQuery.trim().toLowerCase();
    const visibleItems = q
      ? uniques.filter((u) => (u.value || t('blanksLabel')).toLowerCase().includes(q))
      : uniques;
    uniqueList.replaceChildren(
      ...visibleItems.slice(0, 200).map((u) => {
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = selectedSet.has(u.value);
        cb.addEventListener('change', () => {
          if (cb.checked) {
            selectedSet.add(u.value);
          } else {
            selectedSet.delete(u.value);
          }
          commitSelectedSet();
        });
        const labelText = u.value === '' ? t('blanksLabel') : u.value;
        return el('label', { class: 'dv-check sheet-unique-item' }, [
          cb,
          el('span', { class: 'sheet-unique-val', text: labelText, title: labelText }),
          el('span', { class: 'sheet-unique-cnt', text: String(u.count) }),
        ]);
      }),
    );
  };

  selectAllInput.checked = selectedSet.size === allValues.length;
  selectAllInput.indeterminate = selectedSet.size > 0 && selectedSet.size < allValues.length;
  selectAllInput.addEventListener('change', () => {
    useExclusionMode = selectAllInput.checked;
    selectedSet = selectAllInput.checked ? new Set(allValues) : new Set();
    renderUniqueChecklist(filter.value);
    commitSelectedSet();
  });

  renderUniqueChecklist(filter.value);

  let timer: ReturnType<typeof setTimeout> | undefined;
  filter.addEventListener('input', () => {
    renderUniqueChecklist(filter.value);
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
    el('div', { class: 'dv-menu-title sheet-col-menu-title', text: t('uniqueValuesTitle') }),
    filter,
    el('label', { class: 'dv-check sheet-col-check' }, [selectAllInput, el('span', { text: t('selectAll') })]),
    uniqueList,
    ...(isTruncatedUniques
      ? [el('div', { class: 'dv-menu-hint-text sheet-col-check', text: t('uniqueValuesTruncated', 200) })]
      : []),
  );

  if (!model.frozenRows) {
    const header = el('input');
    header.type = 'checkbox';
    header.checked = view.headerRow;
    header.addEventListener('change', () => {
      view.headerRow = header.checked;
      apply(false);
    });
    items.push(
      el('div', { class: 'dv-menu-sep' }),
      el('label', { class: 'dv-check sheet-col-check' }, [header, el('span', { text: t('headerRow') })]),
    );
  }
  if (hasColumnFilter(view, col)) {
    items.push(
      el('div', { class: 'dv-menu-sep' }),
      menuRow('', t('clearColumnFilter'), () => {
        delete view.filters[col];
        delete view.valueFilters![col];
        delete view.excludedValues![col];
        delete view.numFilters![col];
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
  overlayStack.push({
    id: 'sheetColumnMenu',
    isOpen: () => !columnMenu.hidden,
    close: closeColumnMenu,
    restoreFocus: () => gridHost,
  });
  const left = Math.min(anchor.left, window.innerWidth - columnMenu.offsetWidth - 8);
  const top = Math.min(anchor.bottom + 4, Math.max(8, window.innerHeight - columnMenu.offsetHeight - 8));
  columnMenu.style.left = `${Math.max(8, left)}px`;
  columnMenu.style.top = `${top}px`;
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
  const formats: ('csv' | 'tsv' | 'xlsx' | 'jsonl')[] = ['csv', 'tsv', 'xlsx', 'jsonl'];
  return formats.map((format) => ({
    label: t('convertTo', format.toUpperCase()),
    icon: 'export' as const,
    visible: () => {
      const ext = getFileState().ext;
      return ext !== format && !(format === 'xlsx' && ext === 'xlsm') && !(format === 'jsonl' && ext === 'ndjson');
    },
    onClick: () => post({ type: 'convert', index: active, format }),
  }));
}

function copySelectionMarkdown() {
  const model = models.get(active);
  const sel = grid?.selection;
  if (!model || !sel) {
    return;
  }
  const md = selectionToMarkdownTable((r, c) => {
    const srcR = toSource(r);
    return srcR >= 0 ? model.rows[srcR]?.[c] : undefined;
  }, sel.r0, sel.c0, sel.r1, sel.c1);
  if (md) {
    void navigator.clipboard?.writeText(md).then(() => flash(t('copied')));
  }
}

function copySelectionJson() {
  const model = models.get(active);
  const sel = grid?.selection;
  if (!model || !sel) {
    return;
  }
  const json = selectionToJson((r, c) => {
    const srcR = toSource(r);
    return srcR >= 0 ? model.rows[srcR]?.[c] : undefined;
  }, sel.r0, sel.c0, sel.r1, sel.c1);
  if (json) {
    void navigator.clipboard?.writeText(json).then(() => flash(t('copied')));
  }
}

const jsonlInspector = createJsonlInspector((msg) => flash(msg));
const convertDropdown = moreMenu(t('convertMenu'), convertItems(), 'export');
const condFormatDropdown = moreMenu(
  t('condFormatBar'),
  [
    { label: t('condFormatBar'), icon: 'bars', onClick: () => setCondFormatForSelection('bar') },
    { label: t('condFormatHeat'), onClick: () => setCondFormatForSelection('heat') },
    '-',
    { label: t('condFormatNone'), onClick: () => setCondFormatForSelection('none') },
  ],
  'bars',
  { compact: true },
);
const copyMdBtn = iconButton('copyMd', t('copyAsMarkdown'), copySelectionMarkdown);
const copyJsonBtn = iconButton('copy', t('copyAsJson'), copySelectionJson);
const historyBtn = iconButton('history', t('slotHistory'), () => post({ type: 'history' }));

const lock = lockToggle();
lock.hidden = true;

let sheetZoom = 1;
const zoom = createZoom((value) => {
  sheetZoom = value;
  grid?.setZoom(value);
}, gridHost);

interface SheetAiMeta {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
  r: number;
  c: number;
}

function captureSheetAiContext() {
  const model = models.get(active);
  const sel: Selection = grid?.selection ?? { r: 0, c: 0, r0: 0, c0: 0, r1: 0, c1: 0 };
  const srcRow = (r: number) => Math.max(0, toSource(r));
  const activeAddr = `${columnName(sel.c)}${srcRow(sel.r) + 1}`;
  const rangeAddr =
    sel.r0 === sel.r1 && sel.c0 === sel.c1
      ? activeAddr
      : `${columnName(sel.c0)}${srcRow(sel.r0) + 1}:${columnName(sel.c1)}${srcRow(sel.r1) + 1}`;

  const headers: string[] = [];
  const sampleRows: string[][] = [];
  if (model) {
    const colCap = Math.min(model.colCount, 40);
    for (let c = 0; c < colCap; c++) {
      headers.push(cellText(model.rows[0]?.[c]).trim());
    }
    const maxSampleR = Math.min(model.rows.length, 7);
    for (let r = 1; r < maxSampleR; r++) {
      const rowArr: string[] = [];
      let nonEmpty = false;
      for (let c = 0; c < Math.min(model.colCount, 20); c++) {
        const v = cellText(model.rows[r]?.[c]);
        if (v.trim() !== '') nonEmpty = true;
        rowArr.push(v);
      }
      if (nonEmpty) {
        sampleRows.push(rowArr);
      }
    }
  }

  const schema: AiSheetSchemaContext = {
    sheetName: model?.name ?? 'Sheet1',
    allSheets: info?.sheets.map((s) => s.name) ?? [model?.name ?? 'Sheet1'],
    headers,
    sampleRows,
    activeCell: activeAddr,
    selectionRange: rangeAddr,
    isJsonl: Boolean(info?.isJsonl),
  };

  let selectedTsv = '';
  if (model) {
    const maxR = Math.min(sel.r1, sel.r0 + 80);
    const maxC = Math.min(sel.c1, sel.c0 + 25);
    const tsvLines: string[] = [];
    for (let r = sel.r0; r <= maxR; r++) {
      const sr = toSource(r);
      if (sr < 0 || sr >= model.rows.length) continue;
      const lineCells: string[] = [];
      for (let c = sel.c0; c <= maxC; c++) {
        lineCells.push(cellRaw(model.rows[sr]?.[c]).replace(/\t|\r?\n/g, ' '));
      }
      if (lineCells.some((x) => x !== '')) {
        tsvLines.push(lineCells.join('\t'));
      }
    }
    selectedTsv = tsvLines.join('\n');
  }

  const isMulti = sel.r1 > sel.r0 || sel.c1 > sel.c0;
  return {
    selection: selectedTsv || undefined,
    badge: isMulti ? t('aiContextRange', rangeAddr) : t('aiContextCell', activeAddr),
    sheetSchema: schema,
    meta: { r0: sel.r0, c0: sel.c0, r1: sel.r1, c1: sel.c1, r: sel.r, c: sel.c } satisfies SheetAiMeta,
  };
}

let openSheetDrawerFn: (() => void) | undefined;

const ai = createAiAssistant({
  viewerKind: 'sheet',
  getFileName: () => models.get(active)?.name ?? '',
  captureContext: captureSheetAiContext,
  onOpenSettings: () => openSheetDrawerFn?.(),
  focusReturnTarget: () => gridHost,
  applyActions: [
    {
      id: 'apply-formula',
      label: () => t('aiApplyFormula'),
      primary: true,
      visible: ({ text }) =>
        canEdit() && info?.supportsFormulas !== false && Boolean(extractFormulaFromAiResponse(text)),
      onApply: ({ text, captured }) => {
        if (!canEdit()) {
          flash(t('locked'));
          return false;
        }
        const parsed = extractFormulaFromAiResponse(text);
        if (!parsed) return false;
        const m = (captured.meta as SheetAiMeta | undefined) ?? grid?.selection ?? { r: 0, c: 0 };
        edit([{ r: m.r, c: m.c, text: parsed.formula }]);
        formula.value = parsed.formula;
      },
    },
    {
      id: 'apply-formula-range',
      label: () => t('aiApplyFormulaRange'),
      visible: ({ text, captured }) => {
        if (!canEdit() || info?.supportsFormulas === false || !extractFormulaFromAiResponse(text)) {
          return false;
        }
        const m = captured.meta as SheetAiMeta | undefined;
        return Boolean(m && (m.r1 > m.r0 || m.c1 > m.c0));
      },
      onApply: ({ text, captured }) => {
        if (!canEdit()) {
          flash(t('locked'));
          return false;
        }
        const parsed = extractFormulaFromAiResponse(text);
        const m = captured.meta as SheetAiMeta | undefined;
        if (!parsed || !m) return false;
        const changes: CellChange[] = [];
        for (let r = m.r0; r <= m.r1; r++) {
          for (let c = m.c0; c <= m.c1; c++) {
            changes.push({
              r,
              c,
              text: shiftFormulaRefs(parsed.formula, r - m.r0, c - m.c0),
            });
          }
        }
        edit(changes);
      },
    },
    {
      id: 'apply-cells',
      label: () => t('aiApplyCells'),
      primary: true,
      visible: ({ text, action }) => {
        if (!canEdit()) return false;
        if (info?.supportsFormulas !== false && extractFormulaFromAiResponse(text) && action === 'formula') {
          return false;
        }
        if (action !== 'tableFill' && action !== 'translate' && action !== 'generate') {
          return false;
        }
        return extractTableFromAiResponse(text, Boolean(info?.isJsonl)).rows.length > 0;
      },
      onApply: ({ text, captured }) => {
        if (!canEdit()) {
          flash(t('locked'));
          return false;
        }
        const m = (captured.meta as SheetAiMeta | undefined) ?? grid?.selection ?? { r0: 0, c0: 0 };
        const extracted = extractTableFromAiResponse(text, Boolean(info?.isJsonl));
        if (info?.isJsonl && extracted.jsonlLines?.length) {
          // Parse JSON keys against current schema columns so fields land in matching columns!
          const model = models.get(active);
          const colNames =
            model?.rows[0]?.map((c) => cellText(c).trim()) ?? [];
          const changes: CellChange[] = [];
          const baseRow = Math.max(1, m.r0);
          extracted.jsonlLines.forEach((jl, rOffset) => {
            try {
              const obj = JSON.parse(jl) as Record<string, unknown>;
              colNames.forEach((colKey, colIdx) => {
                if (colKey in obj) {
                  const val = obj[colKey];
                  changes.push({
                    r: baseRow + rOffset,
                    c: colIdx,
                    text: val === null || val === undefined ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val),
                  });
                }
              });
            } catch {
              // ignore malformed line
            }
          });
          if (changes.length) {
            edit(changes);
          }
          return;
        }
        const changes: CellChange[] = [];
        extracted.rows.forEach((rowVals, dr) => {
          rowVals.forEach((cellVal, dc) => {
            changes.push({ r: m.r0 + dr, c: m.c0 + dc, text: cellVal });
          });
        });
        if (changes.length) {
          edit(changes);
        }
      },
    },
  ],
});

fxAiBtn.addEventListener('mousedown', (e) => {
  // Prevent premature formula.blur commit (`CR-2`) when clicking ✨ inside the formula bar!
  e.preventDefault();
});
fxAiBtn.addEventListener('click', () => {
  let initialDraft = '';
  if (formulaTarget && document.activeElement === formula) {
    const typed = formula.value.trim();
    if (typed && !typed.startsWith('=') && typed !== formulaTarget.initial) {
      initialDraft = typed;
      formula.value = formulaTarget.initial;
    }
    suppressFormulaBlurCommit = true;
    formulaTarget = undefined;
    formula.blur();
    suppressFormulaBlurCommit = false;
  }
  ai.open({
    presetAction: info?.supportsFormulas === false ? 'tableFill' : 'formula',
    initialPrompt: initialDraft || undefined,
    autoRun: Boolean(initialDraft),
  });
});

const topBar = customToolbar({
  subtitle: () => (getFileState().ext ? getFileState().ext.toUpperCase() : 'SHEET'),
  extraLeft: [filterChip],
  slots: [
    { id: 'view', nodes: [csvView.node, excelView.node, jsonlInspector.toggleBtn] },
    { id: 'zoom', nodes: zoom.nodes },
    { id: 'cellBar', nodes: [address, formulaBar] },
    { id: 'find', nodes: [...sheetFindBar.nodes, replaceToggle.node] },
    { id: 'edit', label: t('lockEdits'), nodes: [lock] },
    { id: 'highlight', nodes: [highlightToggle(), freezeBtn.node, freezeColBtn.node, condFormatDropdown] },
    { id: 'structure', nodes: [structureGroup] },
    { id: 'ai', nodes: [ai.button] },
    {
      id: 'actions',
      label: t('convertMenu'),
      nodes: [copyMdBtn, copyJsonBtn, convertDropdown],
    },
    { id: 'history', nodes: [historyBtn], visible: () => getFileState().history },
    { id: 'rtl', nodes: [rtlToggle.node] },
    { id: 'openApp', nodes: [openExternalButton()] },
  ],
  documentActions: [
    { label: t('aiAssistant'), icon: 'sparkle', onClick: () => ai.open() },
    openExternalMenuItem(),
    { label: t('copyAsMarkdown'), icon: 'copyMd', onClick: copySelectionMarkdown },
    { label: t('copyAsJson'), icon: 'copy', onClick: copySelectionJson },
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
      label: t('freezeFirstCol'),
      checked: () => effectiveFrozenCols(active, models.get(active)) > 0,
      onChange: (on) => {
        freezeColOverrides.set(active, on);
        freezeColBtn.set(on);
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

const sheetMain = el('div', { class: 'sheet-workspace' }, [gridHost, jsonlInspector.node]);
openSheetDrawerFn = () => topBar.openDrawer();
bindLiveViewerStatus(
  (mode, overlays) => post({ type: 'status', ok: true, mode, overlays }),
  () => (canEdit() ? 'edit' : 'read'),
  () => models.has(active),
);
app.append(topBar.node, replaceBar, notice.node, sheetMain, statusBar);
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

function effectiveFrozenCols(index: number, model: SheetModel | undefined): number {
  const override = freezeColOverrides.get(index);
  if (override !== undefined) {
    return override ? Math.max(1, model?.frozenCols ?? 0) : 0;
  }
  return model?.frozenCols ?? 0;
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
  const frozenC = effectiveFrozenCols(index, model);
  freezeBtn.set(frozenR > 0);
  freezeColBtn.set(frozenC > 0);

  const fixed = fixedRows(model, view);
  const condMap = condMapOf(index);
  const condBounds = new Map<number, { min: number; max: number } | undefined>();
  for (const [colKey, kind] of Object.entries(condMap)) {
    const col = Number(colKey);
    if (kind && kind !== 'none') {
      condBounds.set(col, computeColumnNumericBounds(model.rows, map, fixed, col));
    }
  }
  const cellGetter = map ? (r: number, c: number) => model.rows[map[r]]?.[c] : (r: number, c: number) => model.rows[r]?.[c];

  return {
    rowCount: map ? map.length : model.rowCount,
    colCount: model.colCount,
    cell: cellGetter,
    styles: plain ? undefined : model.styles,
    colWidths,
    rowHeights,
    merges,
    frozenRows: frozenR,
    frozenCols: frozenC,
    palette: !plain && model.styles?.some((s) => s.color || s.bg) ? 'light' : 'theme',
    rowLabel: map ? (r) => String(map[r] + 1) : undefined,
    colBadge: (c) => {
      const badges = view.sortCol === c ? (view.sortDir === -1 ? ' ↓' : ' ↑') : '';
      return badges + (hasColumnFilter(view, c) ? ' ⧩' : '');
    },
    isSearchHit: (r, c) => {
      if (!sheetFindBar.input.value.trim()) {
        return false;
      }
      const cache = rebuildFindCache();
      return Boolean(cache?.hitSet.has(r * model.colCount + c));
    },
    cellBgOverlay: condBounds.size
      ? (r, c) => {
          if (r < fixed) {
            return undefined;
          }
          const kind = condMap[c];
          if (!kind || kind === 'none') {
            return undefined;
          }
          return condFormatGradient(kind, numericValue(cellGetter(r, c)), condBounds.get(c));
        }
      : undefined,
  };
}

function updateSummary() {
  const model = models.get(active);
  if (!model) {
    summary.textContent = '';
    return;
  }
  const displayRowCount = info?.isJsonl ? Math.max(0, model.rows.length - 1) : model.rowCount;
  summary.textContent = `${t('rows', displayRowCount)} × ${t('cols', model.colCount)}`;
}

/** Cell targeted when the user started editing inside the formula bar. */
let formulaTarget: { sheet: number; r: number; c: number; initial: string } | undefined;
let suppressFormulaBlurCommit = false;

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
    suppressFormulaBlurCommit = true;
    if (formulaTarget) {
      formula.value = formulaTarget.initial;
      formulaTarget = undefined;
    }
    grid?.focus();
    suppressFormulaBlurCommit = false;
  }
  e.stopPropagation();
});

formula.addEventListener('blur', () => {
  if (!suppressFormulaBlurCommit) {
    commitFormulaBar();
  }
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
  const populatedRows = rowMap ? rowMap.length : model.rows.length;
  const rowLengthAt = (r: number) => {
    const srcR = toSource(r);
    return srcR >= 0 ? (model.rows[srcR]?.length ?? 0) : 0;
  };
  const stats = computeSelectionStats(cellAt, sel.r0, sel.c0, sel.r1, sel.c1, 200_000, populatedRows, rowLengthAt);
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
  if (info?.isJsonl) {
    jsonlInspector.syncSelection(models.get(active), toSource(sel.r), canEdit());
  }
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
    overlayStack.remove('sheetContextMenu');
  }
}

ctxPopup.addEventListener('keydown', (e) => {
  const items = [...ctxPopup.querySelectorAll<HTMLButtonElement>('.dv-menu-item:not(:disabled)')];
  const idx = items.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'Escape') {
    e.preventDefault();
    closeCtxPopup();
    grid?.focus();
  } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) {
    e.preventDefault();
    const next = (idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
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
  overlayStack.push({
    id: 'sheetContextMenu',
    isOpen: () => !ctxPopup.hidden,
    close: closeCtxPopup,
    restoreFocus: () => gridHost,
  });
  const left = Math.max(8, Math.min(x, window.innerWidth - ctxPopup.offsetWidth - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - ctxPopup.offsetHeight - 8));
  ctxPopup.style.left = `${left}px`;
  ctxPopup.style.top = `${top}px`;
  ctxPopup.style.right = 'auto';
  ctxPopup.querySelector<HTMLButtonElement>('.dv-menu-item:not(:disabled)')?.focus();
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
  if (!sel) {
    return;
  }
  const items: (HTMLElement | '-')[] = [
    ctxAction(`✨ ${t('aiAssistant')}…`, () => ai.open()),
    '-',
    ctxAction(t('copyAsMarkdown'), copySelectionMarkdown),
    ctxAction(t('copyAsJson'), copySelectionJson),
    '-',
    ctxAction(t('condFormatBar'), () => setCondFormatForSelection('bar')),
    ctxAction(t('condFormatHeat'), () => setCondFormatForSelection('heat')),
    ctxAction(t('condFormatNone'), () => setCondFormatForSelection('none')),
  ];
  if (info?.editable) {
    const locked = getAppearance().lockEdits;
    items.push(
      '-',
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
    );
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
      onAutoFill: (src, dst) => {
        if (!canEdit()) {
          flash(t('locked'));
          return;
        }
        const model = models.get(active);
        if (!model) {
          return;
        }
        if (rowMap) {
          let hasFormula = false;
          outer: for (let r = src.r0; r <= src.r1; r++) {
            const sr = toSource(r);
            for (let c = src.c0; c <= src.c1; c++) {
              if (sr >= 0 && cellRaw(model.rows[sr]?.[c]).startsWith('=')) {
                hasFormula = true;
                break outer;
              }
            }
          }
          if (hasFormula) {
            flash(t('structureBlocked'));
            return;
          }
        }
        const changes = computeAutoFillChanges(
          (r, c) => {
            const srcR = toSource(r);
            return srcR >= 0 ? cellRaw(model.rows[srcR]?.[c]) : '';
          },
          src,
          dst,
        ).filter(({ r, c }) => {
          const srcR = toSource(r);
          const cell = srcR >= 0 ? model.rows[srcR]?.[c] : undefined;
          return !(typeof cell === 'object' && cell?.ro);
        });
        if (changes.length) {
          edit(changes);
        }
      },
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
  sheetFindBar.refreshCount();
  post({
    type: 'status',
    ok: true,
    detail: `${model.name}: ${model.rowCount}x${model.colCount}`,
    mode: canEdit() ? 'edit' : 'read',
    overlays: overlayStack.getOpenIds(),
  });
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
      const isJsonl = Boolean(info.isJsonl);
      const supportsFx = info.supportsFormulas !== false;
      fxBadge.hidden = !supportsFx;
      fxAiBtn.hidden = !info.editable;
      const ph = supportsFx ? t('formulaPlaceholder') : t('cellValuePlaceholder');
      formula.placeholder = ph;
      formula.setAttribute('aria-label', ph);
      jsonlInspector.setVisibleForFormat(isJsonl);
      csvView.node.hidden = !isCsv;
      excelView.node.hidden = isCsv;
      structureGroup.hidden = !info.canStructure;
      lock.hidden = !info.editable;
      replaceToggle.node.hidden = !info.editable;
      if (!info.editable) {
        setReplaceBarOpen(false);
      }
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
        const hasCond = Object.keys(condMapOf(active)).length > 0;
        if (hasCond) {
          show(active, true);
        } else {
          grid.invalidate();
        }
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
        const hasCond = Object.keys(condMapOf(active)).length > 0;
        if (sizeChanged || hasCond) {
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
