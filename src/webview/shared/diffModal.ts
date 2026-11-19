// Shared read-only Version Diff modal for Word (.docx), PowerPoint (.pptx), Excel (.xlsx), CSV & JSONL.
import type { DocumentDiffReport } from '../../common/docDiff';
import { diffInlineText } from '../../common/textDiff';
import { el, t } from './api';
import { overlayStack } from './overlayStack';
import { iconButton } from './ui';

export function openDiffModal(report: DocumentDiffReport): void {
  const backdrop = el('div', { class: 'dv-modal-backdrop' });
  const close = () => {
    overlayStack.remove('docDiffModal');
    backdrop.remove();
  };

  const summaryEl = el('div', {
    class: 'dv-label',
    text: `${report.baseLabel}  →  ${report.currentLabel}   (${t('diffSummary', report.addedCount, report.removedCount, report.changedCount)})`,
  });

  const body = el('div', { class: 'dv-modal-body' });

  if (report.kind === 'cells') {
    const cells = report.cells ?? [];
    if (!cells.length) {
      body.append(el('div', { class: 'dv-status', text: t('diffNoChanges') }));
    } else {
      const rows = cells.map((c) => {
        const diffCell = el('td');
        for (const span of diffInlineText(c.before, c.after)) {
          if (span.kind === 'del') diffCell.append(el('del', { class: 'dv-diff-del', text: span.text }));
          else if (span.kind === 'add') diffCell.append(el('ins', { class: 'dv-diff-ins', text: span.text }));
          else diffCell.append(document.createTextNode(span.text));
        }
        return el('tr', {}, [
          el('td', { text: c.sheet }),
          el('td', { text: c.addr }),
          el('td', { text: c.before || '—' }),
          diffCell,
        ]);
      });
      body.append(
        el('table', { class: 'dv-diff-table' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'Sheet' }),
              el('th', { text: 'Cell' }),
              el('th', { text: report.baseLabel }),
              el('th', { text: report.currentLabel }),
            ]),
          ]),
          el('tbody', {}, rows),
        ]),
      );
    }
  } else {
    const lines = (report.lines ?? []).filter((l) => l.kind !== 'same');
    if (!lines.length) {
      body.append(el('div', { class: 'dv-status', text: t('diffNoChanges') }));
    } else {
      for (const l of report.lines ?? []) {
        if (l.kind === 'same') {
          continue;
        }
        const prefix = l.kind === 'add' ? `+ [${l.newIndex ?? ''}] ` : `- [${l.oldIndex ?? ''}] `;
        body.append(
          el('div', {
            class: l.kind === 'add' ? 'dv-diff-line dv-diff-line-add' : 'dv-diff-line dv-diff-line-del',
            text: `${prefix}${l.text}`,
          }),
        );
      }
    }
  }

  const modal = el('div', { class: 'dv-modal' }, [
    el('div', { class: 'dv-modal-head' }, [
      el('span', { class: 'dv-modal-title', text: t('diffTitle') }),
      el('div', { class: 'dv-spacer' }),
      iconButton('close', t('close'), close),
    ]),
    summaryEl,
    body,
  ]);

  backdrop.append(modal);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.body.append(backdrop);

  overlayStack.push({
    id: 'docDiffModal',
    isOpen: () => backdrop.isConnected,
    close,
  });
}
