// Pure response parsers shared by host tests and webview "Apply" actions:
// extracts Excel formulas (`=SUMIFS(...)`) and 2D tabular / JSONL payloads from AI streams.

/** Extracts an `=...` spreadsheet formula + explanation from an AI response. */
export function extractFormulaFromAiResponse(raw: string): { formula: string; explanation: string } | undefined {
  const cleaned = raw.trim();
  if (!cleaned) {
    return undefined;
  }

  const fenceMatch = /```(?:excel|formula|text|plaintext)?\s*\r?\n?([\s\S]*?)```/i.exec(cleaned);
  if (fenceMatch) {
    const innerLine = fenceMatch[1]
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^`+|`+$/g, ''))
      .find((l) => l.startsWith('='));
    if (innerLine) {
      const rest = (cleaned.slice(0, fenceMatch.index) + '\n' + cleaned.slice(fenceMatch.index + fenceMatch[0].length)).trim();
      return { formula: innerLine, explanation: rest };
    }
  }

  const lines = cleaned.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const candidate = lines[i].trim().replace(/^`+|`+$/g, '');
    if (candidate.startsWith('=') && candidate.length > 1) {
      const explanation = [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n').trim();
      return { formula: candidate, explanation };
    }
    const inlineMatch = /`(=[A-Za-z_][A-Za-z0-9_.]*\([^`\r\n]*\))`/.exec(lines[i]);
    if (inlineMatch) {
      return { formula: inlineMatch[1], explanation: cleaned };
    }
  }
  return undefined;
}

function parseMarkdownPipeTable(lines: string[]): string[][] | undefined {
  const pipeLines = lines.map((l) => l.trim()).filter((l) => l.startsWith('|') && l.endsWith('|'));
  if (pipeLines.length === 0) {
    return undefined;
  }
  const rows: string[][] = [];
  for (const line of pipeLines) {
    const inner = line.slice(1, -1);
    const cells = inner.split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) {
      continue;
    }
    rows.push(cells);
  }
  return rows.length > 0 ? rows : undefined;
}

/** Extracts 2D cell values (TSV / Markdown pipe table) or JSONL lines from an AI response. */
export function extractTableFromAiResponse(
  raw: string,
  isJsonl = false,
): { rows: string[][]; jsonlLines?: string[] } {
  const fenceMatch = /```(?:tsv|csv|jsonl|ndjson|json|markdown|md|text)?\s*\r?\n([\s\S]*?)```/i.exec(raw);
  const body = (fenceMatch ? fenceMatch[1] : raw).trim();
  if (!body) {
    return { rows: [] };
  }

  const rawLines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (isJsonl) {
    const jsonlLines: string[] = [];
    const rows: string[][] = [];
    for (const line of rawLines) {
      const trimmed = line.trim();
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        jsonlLines.push(JSON.stringify(parsed));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          rows.push(
            Object.values(parsed as Record<string, unknown>).map((v) =>
              v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v),
            ),
          );
        } else {
          rows.push([String(parsed)]);
        }
      } catch {
        // Ignore non-JSON commentary lines.
      }
    }
    return { rows, jsonlLines };
  }

  if (rawLines.some((l) => l.includes('\t'))) {
    return { rows: rawLines.map((l) => l.split('\t')) };
  }
  const mdRows = parseMarkdownPipeTable(rawLines);
  if (mdRows) {
    return { rows: mdRows };
  }
  return { rows: rawLines.map((l) => [l]) };
}
