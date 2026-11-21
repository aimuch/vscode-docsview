// Zero-dependency Group-By & Pivot Summary engine for CSV, Excel, JSONL, SQLite & Parquet.
import type { Cell } from '../../common/protocol';
import { el, t } from '../shared/api';
import { openAccessibleModal } from '../shared/modal';
import { numericValue } from './view';

export type PivotAgg = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface PivotRow {
  group: string;
  count: number;
  value: number;
}

const cellStr = (c: Cell | undefined): string => (c == null ? '' : typeof c === 'string' ? c : c.v).trim();

/** Pure Group-By aggregation across `rows[fixedRows..]`. */
export function computePivotSummary(
  rows: readonly Cell[][],
  fixedRows: number,
  groupCol: number,
  valCol: number,
  agg: PivotAgg,
): { rows: PivotRow[]; grandTotal: number; totalCount: number } {
  const buckets = new Map<string, { count: number; numCount: number; sum: number; min: number; max: number }>();
  let totalCount = 0;

  for (let r = Math.max(0, fixedRows); r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;
    const key = cellStr(row[groupCol]) || '(Blanks)';
    let b = buckets.get(key);
    if (!b) {
      b = { count: 0, numCount: 0, sum: 0, min: Infinity, max: -Infinity };
      buckets.set(key, b);
    }
    b.count++;
    totalCount++;
    const n = numericValue(row[valCol]);
    if (n !== undefined && Number.isFinite(n)) {
      b.numCount++;
      b.sum += n;
      if (n < b.min) b.min = n;
      if (n > b.max) b.max = n;
    }
  }

  const out: PivotRow[] = [];
  for (const [group, b] of buckets.entries()) {
    let value = b.count;
    if (agg === 'sum') value = b.sum;
    else if (agg === 'avg') value = b.numCount > 0 ? b.sum / b.numCount : 0;
    else if (agg === 'min') value = b.numCount > 0 ? b.min : 0;
    else if (agg === 'max') value = b.numCount > 0 ? b.max : 0;
    out.push({ group, count: b.count, value });
  }
  out.sort((a, b) => b.value - a.value || a.group.localeCompare(b.group));

  let grandTotal = 0;
  if (agg === 'count') grandTotal = totalCount;
  else if (agg === 'sum') grandTotal = out.reduce((s, r) => s + r.value, 0);
  else if (agg === 'avg') grandTotal = out.length ? out.reduce((s, r) => s + r.value, 0) / out.length : 0;
  else if (agg === 'min') grandTotal = out.length ? Math.min(...out.map((r) => r.value)) : 0;
  else if (agg === 'max') grandTotal = out.length ? Math.max(...out.map((r) => r.value)) : 0;

  return { rows: out, grandTotal, totalCount };
}

function fmtVal(n: number): string {
  const rounded = Math.abs(n - Math.round(n)) < 1e-9 ? Math.round(n) : Number(n.toFixed(4));
  return rounded.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function openPivotModal(
  rows: readonly Cell[][],
  headers: readonly string[],
  fixedRows: number,
  initialGroupCol = 0,
): void {
  let groupCol = Math.max(0, Math.min(headers.length - 1, initialGroupCol));
  let valCol = Math.min(headers.length - 1, groupCol === 0 && headers.length > 1 ? 1 : 0);
  let agg: PivotAgg = 'sum';

  const groupSelect = el('select', { class: 'dv-select' });
  const valSelect = el('select', { class: 'dv-select' });
  const aggSelect = el('select', { class: 'dv-select' });

  headers.forEach((h, idx) => {
    const label = h || `Col ${idx + 1}`;
    const o1 = el('option', { text: label });
    o1.value = String(idx);
    o1.selected = idx === groupCol;
    groupSelect.append(o1);

    const o2 = el('option', { text: label });
    o2.value = String(idx);
    o2.selected = idx === valCol;
    valSelect.append(o2);
  });

  const aggs: [PivotAgg, string][] = [
    ['count', t('statCount')],
    ['sum', t('statSum')],
    ['avg', t('statAvg')],
    ['min', t('statMin')],
    ['max', t('statMax')],
  ];
  for (const [id, label] of aggs) {
    const opt = el('option', { text: label });
    opt.value = id;
    opt.selected = id === agg;
    aggSelect.append(opt);
  }

  const tableHost = el('div');
  let lastMarkdown = '';

  const render = () => {
    const res = computePivotSummary(rows, fixedRows, groupCol, valCol, agg);
    const gHeader = headers[groupCol] || `Col ${groupCol + 1}`;
    const vHeader = `${aggs.find((a) => a[0] === agg)?.[1] ?? agg} (${headers[valCol] || `Col ${valCol + 1}`})`;

    const trs = res.rows.slice(0, 500).map((r) =>
      el('tr', {}, [
        el('td', { text: r.group === '(Blanks)' ? t('blanksLabel') : r.group }),
        el('td', { text: String(r.count) }),
        el('td', { text: fmtVal(r.value) }),
      ]),
    );
    trs.push(
      el('tr', { class: 'sheet-pivot-total' }, [
        el('td', { text: t('statSum') }),
        el('td', { text: String(res.totalCount) }),
        el('td', { text: fmtVal(res.grandTotal) }),
      ]),
    );

    const table = el('table', { class: 'dv-diff-table' }, [
      el('thead', {}, [
        el('tr', {}, [el('th', { text: gHeader }), el('th', { text: t('statCount') }), el('th', { text: vHeader })]),
      ]),
      el('tbody', {}, trs),
    ]);
    const children: HTMLElement[] = [table];
    if (res.rows.length > 500) {
      children.push(
        el('div', {
          class: 'dv-st-muted',
          text: `Showing top 500 of ${res.rows.length.toLocaleString()} groups.`,
        }),
      );
    }
    tableHost.replaceChildren(...children);

    lastMarkdown = [
      `| ${gHeader} | ${t('statCount')} | ${vHeader} |`,
      `| --- | ---: | ---: |`,
      ...res.rows.map((r) => `| ${r.group.replace(/\|/g, '\\|')} | ${r.count} | ${fmtVal(r.value)} |`),
      `| **${t('statSum')}** | **${res.totalCount}** | **${fmtVal(res.grandTotal)}** |`,
    ].join('\n');
  };

  groupSelect.addEventListener('change', () => {
    groupCol = Number(groupSelect.value);
    render();
  });
  valSelect.addEventListener('change', () => {
    valCol = Number(valSelect.value);
    render();
  });
  aggSelect.addEventListener('change', () => {
    agg = aggSelect.value as PivotAgg;
    render();
  });

  const copyMdBtn = el('button', { class: 'dv-btn dv-btn-primary', text: t('sheetPivotCopyMd') });
  copyMdBtn.type = 'button';
  copyMdBtn.addEventListener('click', () => {
    void navigator.clipboard?.writeText(lastMarkdown);
    copyMdBtn.textContent = t('copied');
    setTimeout(() => (copyMdBtn.textContent = t('sheetPivotCopyMd')), 1200);
  });

  const controls = el('div', { class: 'sheet-pivot-controls' }, [
    el('label', { class: 'sheet-pivot-field' }, [el('span', { text: t('sheetPivotGroupCol') }), groupSelect]),
    el('label', { class: 'sheet-pivot-field' }, [el('span', { text: t('sheetPivotValCol') }), valSelect]),
    el('label', { class: 'sheet-pivot-field' }, [el('span', { text: t('sheetPivotAgg') }), aggSelect]),
  ]);

  render();
  openAccessibleModal({
    id: 'sheetPivotModal',
    title: t('sheetPivot'),
    width: 'min(720px, 94vw)',
    body: [controls, tableHost],
    footer: [copyMdBtn],
    initialFocus: groupSelect,
  });
}
