// Collapsible side-panel JSON Record Inspector & Editor for `.jsonl` / `.ndjson` datasets.
import type { Cell, SheetModel } from '../../common/protocol';
import { cellRaw, cellText } from '../grid/grid';
import { el, post, t } from '../shared/api';
import { iconButton, toggleButton } from '../shared/ui';

function cellToJsonValue(cell: Cell | undefined): unknown {
  if (cell == null) return null;
  if (typeof cell === 'object') {
    if (cell.n) {
      const num = Number(cell.v);
      if (Number.isFinite(num)) return num;
    }
    const raw = cell.raw ?? cell.v;
    if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    return cell.v === '' ? null : cell.v;
  }
  if (cell === '') return null;
  if (cell === 'true') return true;
  if (cell === 'false') return false;
  return cell;
}

export interface JsonlInspector {
  readonly node: HTMLElement;
  readonly toggleBtn: HTMLButtonElement;
  setVisibleForFormat(isJsonl: boolean): void;
  syncSelection(model: SheetModel | undefined, sourceRow: number, editable: boolean): void;
}

export function createJsonlInspector(onInvalidJson: (msg: string) => void): JsonlInspector {
  let open = false;
  let currentRecordIndex = 0;

  const titleEl = el('span', { class: 'jsonl-ins-title', text: t('jsonlInspector') });
  const errorEl = el('div', { class: 'jsonl-ins-error' });
  errorEl.hidden = true;

  const editor = el('textarea', { class: 'jsonl-ins-editor' });
  editor.spellcheck = false;
  editor.setAttribute('aria-label', t('jsonlInspector'));

  const commit = () => {
    const raw = editor.value.trim();
    if (!raw) return;
    try {
      JSON.parse(raw);
      errorEl.hidden = true;
    } catch {
      errorEl.textContent = t('jsonlInvalidJson');
      errorEl.hidden = false;
      onInvalidJson(t('jsonlInvalidJson'));
      return;
    }
    post({ type: 'editJsonlRecord', recordIndex: currentRecordIndex, jsonText: raw });
  };

  const applyBtn = el('button', { class: 'dv-btn dv-cm-primary', text: t('jsonlApplyJson') });
  applyBtn.type = 'button';
  applyBtn.addEventListener('click', commit);

  const setOpen = (next: boolean) => {
    open = next;
    node.hidden = !next;
    toggle.set(next);
  };

  const toggle = toggleButton('code', t('jsonlInspector'), (on) => setOpen(on));
  toggle.node.hidden = true;

  const closeBtn = iconButton('close', t('close'), () => setOpen(false));
  const node = el('aside', { class: 'jsonl-inspector' }, [
    el('div', { class: 'jsonl-ins-head' }, [titleEl, el('div', { class: 'dv-spacer' }), applyBtn, closeBtn]),
    errorEl,
    editor,
  ]);
  node.hidden = true;

  editor.addEventListener('input', () => {
    if (!errorEl.hidden) {
      try {
        JSON.parse(editor.value);
        errorEl.hidden = true;
      } catch {
        // Keep visible until fixed.
      }
    }
  });

  editor.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
    e.stopPropagation();
  });

  return {
    node,
    toggleBtn: toggle.node,
    setVisibleForFormat(isJsonl: boolean) {
      toggle.node.hidden = !isJsonl;
      if (!isJsonl && open) {
        setOpen(false);
      }
    },
    syncSelection(model: SheetModel | undefined, sourceRow: number, editable: boolean) {
      applyBtn.disabled = !editable;
      editor.readOnly = !editable;
      if (!model) {
        editor.value = '';
        return;
      }
      const header = model.rows[0] ?? [];
      const recIdx = Math.max(0, sourceRow <= 0 ? 0 : sourceRow - 1);
      currentRecordIndex = recIdx;
      titleEl.textContent = `${t('jsonlInspector')} · #${recIdx + 1}`;
      const dataRow = model.rows[recIdx + 1];
      errorEl.hidden = true;

      if (!dataRow) {
        if (document.activeElement !== editor) {
          editor.value = '{\n  \n}';
        }
        return;
      }

      if (header.length === 1 && cellText(header[0]) === '_value') {
        if (document.activeElement !== editor) {
          editor.value = JSON.stringify(cellToJsonValue(dataRow[0]), null, 2);
        }
        return;
      }
      if (header.length === 1 && cellText(header[0]) === '_raw') {
        if (document.activeElement !== editor) {
          editor.value = cellRaw(dataRow[0]);
        }
        return;
      }

      const obj: Record<string, unknown> = {};
      for (let c = 0; c < header.length; c++) {
        const key = cellText(header[c]);
        if (!key) continue;
        const cell = dataRow[c];
        const val = cellToJsonValue(cell);
        if (val !== null || (cell != null && cellText(cell) !== '')) {
          obj[key] = val;
        }
      }
      if (document.activeElement !== editor) {
        editor.value = JSON.stringify(obj, null, 2);
      }
    },
  };
}
