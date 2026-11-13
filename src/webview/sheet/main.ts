// Table view for CSV/TSV and Excel workbooks.
import type { Cell, CellChange, SheetModel, StructureOp, WorkbookInfo } from '../../common/protocol';
import { cellRaw, cellText, columnName, Grid, type GridSource, type Selection } from '../grid/grid';
import '../shared/base.css';
import { app, button, el, onMessage, post, showStatus, t } from '../shared/api';
import { icons } from '../shared/icons';
import { highlightToggle } from '../shared/appearance';
import { readState, writeState } from '../shared/sidebar';
import { divider, iconButton, segmented, toolbar } from '../shared/ui';
import './sheet.css';

let info: WorkbookInfo | undefined;
let active = 0;
const models = new Map<number, SheetModel>();
/** Column widths survive data refreshes (the model is replaced on every reload). */
const widths = new Map<number, number[]>();
let grid: Grid | undefined;

const address = el('span', { class: 'sheet-address' });
const formula = el('span', { class: 'sheet-formula' });
const summary = el('span', { class: 'dv-label' });
const notice = el('div', { class: 'dv-notice' });
notice.hidden = true;
const gridHost = el('div', { class: 'sheet-grid' });
const tabs = el('div', { class: 'sheet-tabs' });
tabs.hidden = true;
const structureButtons: HTMLButtonElement[] = [];

function structure(op: StructureOp) {
  const sel = grid?.selection;
  if (!sel) {
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

structureButtons.push(
  textButton(`+ ${t('addRow')}`, t('addRow'), () => structure('insertRow')),
  textButton(`+ ${t('addCol')}`, t('addCol'), () => structure('insertCol')),
  textButton(`− ${t('delRow')}`, t('delRow'), () => structure('deleteRows')),
  textButton(`− ${t('delCol')}`, t('delCol'), () => structure('deleteCols')),
);
const structureGroup = el('div', { class: 'sheet-structure' }, [divider(), ...structureButtons]);
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

/** Selects the next (or previous) cell whose text contains the query, wrapping around. */
function findNext(backwards = false) {
  const model = models.get(active);
  const query = findInput.value.trim().toLowerCase();
  if (!model || !grid || !query) {
    findStatus.textContent = '';
    return;
  }
  const { rowCount, colCount } = model;
  const total = rowCount * colCount;
  const sel = grid.selection;
  const start = sel.r * colCount + sel.c;
  let matches = 0;
  let found = -1;
  for (let i = 1; i <= total; i++) {
    const pos = (start + (backwards ? -i : i) + total * 2) % total;
    const r = Math.floor(pos / colCount);
    const c = pos % colCount;
    if (cellText(model.rows[r]?.[c]).toLowerCase().includes(query)) {
      matches++;
      if (found < 0) {
        found = pos;
      }
    }
  }
  if (found < 0) {
    findStatus.textContent = t('noMatch');
    return;
  }
  findStatus.textContent = String(matches);
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

app.append(
  toolbar(
    csvView.node,
    excelView.node,
    '|',
    address,
    formula,
    findToggle,
    findBox,
    findStatus,
    highlightToggle(),
    structureGroup,
    'spacer',
    summary,
  ),
  notice,
  gridHost,
  tabs,
);
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

function sourceFor(index: number, model: SheetModel): GridSource {
  let colWidths = widths.get(index);
  // Columns were inserted or removed: old widths no longer line up, so measure again.
  if (!colWidths || colWidths.length !== model.colCount) {
    colWidths = autoWidths(model);
    widths.set(index, colWidths);
  }
  return {
    rowCount: model.rowCount,
    colCount: model.colCount,
    cell: (r, c) => model.rows[r]?.[c],
    styles: plain ? undefined : model.styles,
    colWidths,
    rowHeights: model.rowHeights,
    merges: model.merges,
    frozenRows: model.frozenRows,
    frozenCols: model.frozenCols,
    palette: !plain && model.styles?.some((s) => s.color || s.bg) ? 'light' : 'theme',
  };
}

function updateSummary() {
  const model = models.get(active);
  summary.textContent = model ? `${t('rows', model.rowCount)} × ${t('cols', model.colCount)}` : '';
}

function onSelection(sel: Selection) {
  const model = models.get(active);
  const single = sel.r0 === sel.r1 && sel.c0 === sel.c1;
  address.textContent = single
    ? `${columnName(sel.c)}${sel.r + 1}`
    : `${columnName(sel.c0)}${sel.r0 + 1}:${columnName(sel.c1)}${sel.r1 + 1}`;
  formula.textContent = cellRaw(model?.rows[sel.r]?.[sel.c]);
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

function ensureGrid(): Grid {
  if (!grid) {
    gridHost.replaceChildren();
    grid = new Grid(gridHost, {
      editable: info?.editable ?? false,
      canGrowRows: info?.canStructure ?? false,
      onEdit: (changes) => edit(changes),
      onSelection,
      onReadonlyCell: () => flash(t('cellReadonly')),
    });
  }
  return grid;
}

function edit(changes: CellChange[]) {
  // Show the new text immediately; the host answers with the authoritative cells.
  const model = models.get(active);
  if (model) {
    for (const { r, c, text } of changes) {
      setCell(model, r, c, text);
    }
    grid?.invalidate();
  }
  post({ type: 'edit', index: active, changes });
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
  ensureGrid().setData(sourceFor(index, model), keepView);
  updateSummary();
  post({ type: 'status', ok: true, detail: `${model.name}: ${model.rowCount}x${model.colCount}` });
}

function renderTabs() {
  const sheets = info?.sheets ?? [];
  tabs.hidden = sheets.length <= 1;
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
      renderTabs();
      show(active, false);
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
