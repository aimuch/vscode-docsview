// Pure formatter exporting Word / PPT / PDF review comments as a Markdown checklist (- [ ]).
import type { DocComment } from './protocol';

export function formatCommentsAsMarkdown(
  docName: string,
  comments: readonly DocComment[],
  targetLabel?: (comment: DocComment) => string,
): string {
  const title = docName.trim() || 'Document';
  const lines: string[] = [`# ${title} — Comments (${comments.length})`, ''];
  comments.forEach((c, idx) => {
    const loc = targetLabel?.(c)?.trim();
    const locPart = loc ? `[${loc}] ` : '';
    const authorPart = `**@${c.author || 'DocsView'}**`;
    const body = (c.text || '').replace(/\r?\n/g, ' ').trim();
    lines.push(`- [ ] **#${idx + 1}** ${locPart}${authorPart}: ${body}`);
    if (c.quote?.trim()) {
      lines.push(`  > ${c.quote.replace(/\r?\n/g, ' ').trim()}`);
    }
  });
  lines.push('');
  return lines.join('\n');
}
