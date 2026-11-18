// Pure Office (.docx / .pptx) -> Markdown (.md) converters using `@xmldom/xmldom` & `fflate`.
// Zero extra dependencies; preserves headings, inline bold/italic/code/links, lists, GFM tables,
// slide structure and speaker notes.
import { DOMParser, type Element as XElement, type Node as XNode } from '@xmldom/xmldom';
import { strFromU8, unzipSync } from 'fflate';
import { inspectPptx } from './pptxPatcher';

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function createParser(): DOMParser {
  return new DOMParser({ locator: false, onError: () => undefined });
}

function childElements(parent: XElement, localName?: string): XElement[] {
  const out: XElement[] = [];
  for (let n: XNode | null = parent.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) {
      const el = n as XElement;
      if (!localName || el.localName === localName) {
        out.push(el);
      }
    }
  }
  return out;
}

function hasValOn(el: XElement | undefined): boolean {
  if (!el) return false;
  const val = (el.getAttribute('w:val') ?? el.getAttribute('val') ?? 'true').toLowerCase();
  return val !== '0' && val !== 'false' && val !== 'none';
}

function convertDocxRun(run: XElement): string {
  const rPr = childElements(run, 'rPr')[0];
  let text = '';
  for (let n = run.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue;
    const c = n as XElement;
    if (c.localName === 't') {
      text += c.textContent ?? '';
    } else if (c.localName === 'tab') {
      text += '\t';
    } else if (c.localName === 'br' || c.localName === 'cr') {
      text += '\n';
    }
  }
  if (!text) return '';
  if (!rPr) return text;
  const bold = hasValOn(childElements(rPr, 'b')[0]);
  const italic = hasValOn(childElements(rPr, 'i')[0]);
  const strike = hasValOn(childElements(rPr, 'strike')[0]);
  const rFont = childElements(rPr, 'rFonts')[0];
  const asciiFont = (rFont?.getAttribute('w:ascii') ?? rFont?.getAttribute('ascii') ?? '').toLowerCase();
  const isMono = /consolas|courier|menlo|monaco|mono/.test(asciiFont);

  const trimmed = text.trim();
  if (!trimmed) return text;
  const lead = text.slice(0, text.indexOf(trimmed));
  const trail = text.slice(lead.length + trimmed.length);
  let core = trimmed;
  if (isMono && !core.includes('\n')) {
    core = `\`${core}\``;
  } else {
    if (bold && italic) core = `***${core}***`;
    else if (bold) core = `**${core}**`;
    else if (italic) core = `*${core}*`;
    if (strike) core = `~~${core}~~`;
  }
  return `${lead}${core}${trail}`;
}

function convertDocxParagraph(p: XElement, rels: Map<string, string>): string {
  const pPr = childElements(p, 'pPr')[0];
  const pStyle = pPr ? childElements(pPr, 'pStyle')[0] : undefined;
  const styleVal = pStyle?.getAttribute('w:val') ?? pStyle?.getAttribute('val') ?? '';
  const numPr = pPr ? childElements(pPr, 'numPr')[0] : undefined;

  let line = '';
  for (const child of childElements(p)) {
    if (child.localName === 'r') {
      line += convertDocxRun(child);
    } else if (child.localName === 'hyperlink') {
      const rId = child.getAttributeNS(REL_NS, 'id') ?? child.getAttribute('r:id') ?? '';
      const anchor = child.getAttribute('w:anchor') ?? child.getAttribute('anchor') ?? '';
      const inner = childElements(child, 'r').map(convertDocxRun).join('').trim();
      const target = (rId ? rels.get(rId) : undefined) ?? (anchor ? `#${anchor}` : '');
      line += inner ? (target ? `[${inner}](${target})` : inner) : target;
    }
  }

  const clean = line.replace(/[ \t]+\n/g, '\n').trim();
  if (!clean) return '';

  const headingMatch = /^(?:Heading|标题)\s*([1-6])$/i.exec(styleVal);
  if (headingMatch) {
    return `${'#'.repeat(Number(headingMatch[1]))} ${clean.replace(/\n+/g, ' ')}`;
  }
  if (/^Title$/i.test(styleVal)) {
    return `# ${clean.replace(/\n+/g, ' ')}`;
  }
  if (/^Subtitle$/i.test(styleVal)) {
    return `## ${clean.replace(/\n+/g, ' ')}`;
  }
  if (/Quote|BlockText/i.test(styleVal)) {
    return clean
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n');
  }
  if (numPr) {
    const ilvlEl = childElements(numPr, 'ilvl')[0];
    const lvl = Math.max(0, Math.min(5, Number(ilvlEl?.getAttribute('w:val') ?? ilvlEl?.getAttribute('val') ?? 0)));
    return `${'  '.repeat(lvl)}- ${clean.replace(/\n+/g, ' ')}`;
  }
  return clean;
}

function convertDocxTable(tbl: XElement, rels: Map<string, string>): string {
  const rows = childElements(tbl, 'tr').map((tr) =>
    childElements(tr, 'tc').map((tc) =>
      childElements(tc, 'p')
        .map((p) => convertDocxParagraph(p, rels).replace(/^(?:#+\s+|-\s+)/, ''))
        .filter(Boolean)
        .join('<br>')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, '<br>'),
    ),
  );
  if (!rows.length) return '';
  const colCount = Math.max(1, ...rows.map((r) => r.length));
  const padRow = (r: string[]) => Array.from({ length: colCount }, (_, i) => r[i] ?? '');
  const head = padRow(rows[0]);
  const sep = Array.from({ length: colCount }, () => '---');
  const body = rows.slice(1).map((r) => `| ${padRow(r).join(' | ')} |`);
  return [`| ${head.join(' | ')} |`, `| ${sep.join(' | ')} |`, ...body].join('\n');
}

export function docxToMarkdown(bytes: Uint8Array): string {
  const files = unzipSync(bytes, {
    filter: (f) => f.name === 'word/document.xml' || f.name === 'word/_rels/document.xml.rels',
  });
  const docXml = files['word/document.xml'];
  if (!docXml) {
    throw new Error('Not a valid .docx archive (word/document.xml missing).');
  }
  const parser = createParser();
  const rels = new Map<string, string>();
  const relsBytes = files['word/_rels/document.xml.rels'];
  if (relsBytes) {
    const rDoc = parser.parseFromString(strFromU8(relsBytes), 'text/xml');
    const relNodes = rDoc.getElementsByTagName('Relationship');
    for (let i = 0; i < relNodes.length; i++) {
      const r = relNodes.item(i)!;
      const id = r.getAttribute('Id') ?? '';
      const target = r.getAttribute('Target') ?? '';
      if (id && target && /^(?:https?:|mailto:)/i.test(target)) {
        rels.set(id, target);
      }
    }
  }

  const doc = parser.parseFromString(strFromU8(docXml), 'text/xml');
  const body = doc.getElementsByTagNameNS('*', 'body').item(0) as XElement | null;
  if (!body) return '';

  const blocks: string[] = [];
  for (const child of childElements(body)) {
    if (child.localName === 'p') {
      const md = convertDocxParagraph(child, rels);
      if (md) {
        const prev = blocks[blocks.length - 1];
        if (prev && /^\s*-\s/.test(prev) && /^\s*-\s/.test(md)) {
          blocks[blocks.length - 1] = `${prev}\n${md}`;
        } else {
          blocks.push(md);
        }
      }
    } else if (child.localName === 'tbl') {
      const tblMd = convertDocxTable(child, rels);
      if (tblMd) blocks.push(tblMd);
    }
  }
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

export function pptxToMarkdown(bytes: Uint8Array, deckTitle?: string): string {
  const info = inspectPptx(bytes);
  const sections: string[] = [];
  if (deckTitle) {
    sections.push(`# ${deckTitle.replace(/\.pptx$/i, '')}`);
  }
  info.shapes.forEach((slideShapes, idx) => {
    const nonEmpty = slideShapes.map((s) => s.trim()).filter(Boolean);
    const note = (info.notes[idx] ?? '').trim();
    const firstLines = nonEmpty[0]?.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) ?? [];
    const heading = firstLines[0] ? `## Slide ${idx + 1}: ${firstLines[0]}` : `## Slide ${idx + 1}`;
    const bodyParts: string[] = [heading];

    if (firstLines.length > 1) {
      bodyParts.push(firstLines.slice(1).map((l) => `- ${l}`).join('\n'));
    }
    for (const shape of nonEmpty.slice(1)) {
      const lines = shape.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length > 1) {
        bodyParts.push(lines.map((l) => `- ${l}`).join('\n'));
      } else if (lines.length === 1) {
        bodyParts.push(lines[0]);
      }
    }
    if (note) {
      bodyParts.push(
        note
          .split(/\r?\n/)
          .map((l, i) => (i === 0 ? `> **Notes:** ${l}` : `> ${l}`))
          .join('\n'),
      );
    }
    sections.push(bodyParts.join('\n\n'));
  });
  return sections.length ? `${sections.join('\n\n---\n\n')}\n` : '';
}
