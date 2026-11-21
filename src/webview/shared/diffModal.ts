// Accessible modal viewer for Version Diff reports (Word/PPTX paragraphs & Excel/CSV/JSONL cells).
import type { DocumentDiffReport } from '../../common/docDiff';
import { diffInlineText } from '../../common/textDiff';
import { el, t } from './api';
import { openAccessibleModal } from './modal';

export function openDiffModal(report: DocumentDiffReport): void {
  const summaryEl = el('div', {
    class: 'dv-st-muted',
    text: `${report.baseLabel}  →  ${report.currentLabel}   (${t('diffSummary', report.addedCount, report.removedCount, report.changedCount)})`,
  });
  summaryEl.style.wordBreak = 'break-word';

  const bodyNodes: HTMLElement[] = [summaryEl];
  const totalDiffs = report.addedCount + report.removedCount + report.changedCount;

  if (totalDiffs === 0) {
    bodyNodes.push(el('div', { class: 'dv-status', text: t('diffNoChanges') }));
  } else if (report.kind === 'cells' && report.cells?.length) {
    const tbody = el('tbody');
    // Limit synchronous inline diffing to first 500 rows for smooth rendering; show plain cells beyond that.
    for (let idx = 0; idx < report.cells.length; idx++) {
      const c = report.cells[idx];
      const beforeTd = el('td');
      const afterTd = el('td');
      if (idx < 500 && c.before.length + c.after.length < 400) {
        const inline = diffInlineText(c.before, c.after);
        for (const sp of inline) {
          if (sp.kind === 'del') {
            beforeTd.append(el('del', { class: 'dv-diff-del', text: sp.text }));
          } else if (sp.kind === 'add') {
            afterTd.append(el('ins', { class: 'dv-diff-ins', text: sp.text }));
          } else {
            beforeTd.append(document.createTextNode(sp.text));
            afterTd.append(document.createTextNode(sp.text));
          }
        }
      } else {
        beforeTd.textContent = c.before;
        afterTd.textContent = c.after;
      }
      tbody.append(
        el('tr', {}, [
          el('td', { text: c.sheet }),
          el('td', { text: c.addr }),
          beforeTd,
          afterTd,
        ]),
      );
    }
    const table = el('table', { class: 'dv-diff-table' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: t('sheetName') }),
          el('th', { text: '#' }),
          el('th', { text: report.baseLabel }),
          el('th', { text: report.currentLabel }),
        ]),
      ]),
      tbody,
    ]);
    bodyNodes.push(table);
    if (report.truncated) {
      bodyNodes.push(
        el('div', {
          class: 'dv-st-muted',
          text: `Showing first ${report.cells.length.toLocaleString()} cell differences (truncated).`,
        }),
      );
    }
  } else if (report.kind === 'paragraphs' && report.lines?.length) {
    const lines = report.lines;
    const include = new Set<number>();
    lines.forEach((line, idx) => {
      if (line.kind !== 'same') {
        include.add(idx);
        if (idx > 0) include.add(idx - 1);
        if (idx + 1 < lines.length) include.add(idx + 1);
      }
    });
    const list = el('div', { class: 'dv-diff-lines' });
    let prevIncluded = -1;
    for (let idx = 0; idx < lines.length; idx++) {
      if (!include.has(idx)) continue;
      if (prevIncluded >= 0 && idx > prevIncluded + 1) {
        list.append(el('div', { class: 'dv-st-muted', text: '···' }));
      }
      prevIncluded = idx;
      const line = lines[idx];
      const cls =
        line.kind === 'add'
          ? 'dv-diff-line dv-diff-line-add'
          : line.kind === 'del'
            ? 'dv-diff-line dv-diff-line-del'
            : 'dv-diff-line dv-diff-line-same';
      const prefix = line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  ';
      list.append(el('div', { class: cls, text: `${prefix}${line.text}` }));
    }
    bodyNodes.push(list);
  }

  openAccessibleModal({
    id: 'docDiffModal',
    title: t('diffTitle'),
    width: 'min(780px, 92vw)',
    body: bodyNodes,
  });
}
