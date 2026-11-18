// Markdown -> HTML. Pure (no vscode imports) so the dev harness and unit tests can use it.
import katexPlugin from '@vscode/markdown-it-katex';
import hljs from 'highlight.js/lib/common';
import MarkdownIt, { type MarkdownIt as MarkdownItInstance } from 'markdown-it';
import footnote from 'markdown-it-footnote';
import type { TocEntry } from '../../common/protocol';

export interface RenderResult {
  html: string;
  toc: TocEntry[];
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** GitHub-style heading slug. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    // One dash per space (not collapsed), so anchors written for GitHub resolve here too.
    .replace(/\s/g, '-');
}

interface Env {
  toc: TocEntry[];
}

/** Splits a leading YAML front matter block off, keeping line numbers stable. */
function splitFrontMatter(text: string): { frontMatter?: string; frontMatterEndLine?: number; body: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) {
    return { body: text };
  }
  const lines = match[0].split('\n').length - 1;
  return { frontMatter: match[1], frontMatterEndLine: lines, body: '\n'.repeat(lines) + text.slice(match[0].length) };
}

function stripYamlQuotes(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function renderFrontMatterHtml(frontMatter: string, endLine: number): string {
  const lines = frontMatter.split(/\r?\n/);
  const props: { key: string; scalar?: string; list?: string[] }[] = [];
  let currentListProp: { key: string; list: string[] } | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const listMatch = /^[ \t]+-[ \t]+(.+)$/.exec(line);
    if (listMatch && currentListProp) {
      currentListProp.list.push(stripYamlQuotes(listMatch[1]));
      continue;
    }
    const kvMatch = /^([A-Za-z0-9_.\u4e00-\u9fff-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!kvMatch) {
      return `<pre class="md-frontmatter" data-line="0" data-line-end="${endLine}"><code>${escapeHtml(frontMatter)}</code></pre>`;
    }
    const key = kvMatch[1];
    const rest = kvMatch[2].trim();
    if (!rest) {
      currentListProp = { key, list: [] };
      props.push(currentListProp);
      continue;
    }
    if (rest === '|' || rest === '>' || rest.startsWith('{')) {
      return `<pre class="md-frontmatter" data-line="0" data-line-end="${endLine}"><code>${escapeHtml(frontMatter)}</code></pre>`;
    }
    currentListProp = undefined;
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const items = rest
        .slice(1, -1)
        .split(',')
        .map((s) => stripYamlQuotes(s))
        .filter(Boolean);
      props.push({ key, list: items });
    } else {
      props.push({ key, scalar: stripYamlQuotes(rest) });
    }
  }

  if (!props.length) {
    return `<pre class="md-frontmatter" data-line="0" data-line-end="${endLine}"><code>${escapeHtml(frontMatter)}</code></pre>`;
  }

  const rowsHtml = props
    .map((p) => {
      const valHtml = p.list
        ? p.list.map((it) => `<span class="md-fm-tag">${escapeHtml(it)}</span>`).join(' ')
        : escapeHtml(p.scalar ?? '');
      return `<tr><th>${escapeHtml(p.key)}</th><td>${valHtml}</td></tr>`;
    })
    .join('');

  return `<div class="md-frontmatter" data-line="0" data-line-end="${endLine}"><table class="md-fm-table"><tbody>${rowsHtml}</tbody></table></div>`;
}

const ALERT_META: Record<string, { label: string; icon: string }> = {
  note: {
    label: 'Note',
    icon: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>',
  },
  tip: {
    label: 'Tip',
    icon: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z"/></svg>',
  },
  important: {
    label: 'Important',
    icon: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>',
  },
  warning: {
    label: 'Warning',
    icon: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>',
  },
  caution: {
    label: 'Caution',
    icon: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>',
  },
};

export class MarkdownRenderer {
  private readonly md: MarkdownItInstance;

  constructor() {
    const md = new MarkdownIt({ html: true, linkify: true, breaks: false });
    md.use(footnote as never);
    // The package is CommonJS; depending on interop the plugin is the module or its default.
    const katex = (katexPlugin as unknown as { default?: unknown }).default ?? katexPlugin;
    md.use(katex as never, { throwOnError: false });

    // Fenced code: highlight.js for known languages, a placeholder div for Mermaid
    // (rendered in the webview, where a DOM is available).
    md.renderer.rules.fence = (tokens, idx) => {
      const token = tokens[idx];
      const lang = token.info.trim().split(/\s+/)[0] ?? '';
      const line = token.map ? ` data-line="${token.map[0]}" data-line-end="${token.map[1]}"` : '';
      if (lang.toLowerCase() === 'mermaid') {
        const src = escapeHtml(token.content);
        return `<div class="mermaid"${line} data-src="${src}"><pre>${src}</pre></div>\n`;
      }
      let code: string | undefined;
      if (lang && hljs.getLanguage(lang)) {
        try {
          code = hljs.highlight(token.content, { language: lang, ignoreIllegals: true }).value;
        } catch {
          code = undefined;
        }
      }
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      return `<pre${line}><code${cls}>${code ?? escapeHtml(token.content)}</code></pre>\n`;
    };

    md.core.ruler.push('docsview_annotate', (state) => {
      const env = state.env as unknown as Env;
      const used = new Map<string, number>();
      const tokens = state.tokens;
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        // Source line markers drive editor <-> preview scroll sync.
        if (token.map && token.nesting >= 0 && token.type !== 'inline') {
          token.attrSet('data-line', String(token.map[0]));
          // End line (exclusive) lets the preview edit a whole block's source in place.
          token.attrSet('data-line-end', String(token.map[1]));
        }

        if (token.type === 'heading_open') {
          const inline = tokens[i + 1];
          const text = (inline.children ?? [])
            .filter((t) => t.type === 'text' || t.type === 'code_inline')
            .map((t) => t.content)
            .join('');
          const base = slugify(text) || 'section';
          const seen = used.get(base) ?? 0;
          used.set(base, seen + 1);
          const id = seen ? `${base}-${seen}` : base;
          token.attrSet('id', id);
          env.toc.push({ level: Number(token.tag.slice(1)), text, id, line: token.map?.[0] ?? 0 });
        }

        // GitHub Alerts: "> [!NOTE]", "> [!TIP]", "> [!IMPORTANT]", "> [!WARNING]", "> [!CAUTION]".
        if (
          token.type === 'blockquote_open' &&
          tokens[i + 1]?.type === 'paragraph_open' &&
          tokens[i + 2]?.type === 'inline'
        ) {
          const inlineTok = tokens[i + 2];
          const kids = inlineTok.children ?? [];
          const firstChild = kids[0];
          const alertMatch =
            firstChild?.type === 'text'
              ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i.exec(firstChild.content)
              : null;
          if (alertMatch) {
            const kind = alertMatch[1].toLowerCase();
            const meta = ALERT_META[kind];
            // Find matching blockquote_close
            let depth = 1;
            let closeIdx = -1;
            for (let j = i + 1; j < tokens.length; j++) {
              if (tokens[j].type === 'blockquote_open') depth++;
              else if (tokens[j].type === 'blockquote_close') {
                depth--;
                if (depth === 0) {
                  closeIdx = j;
                  break;
                }
              }
            }
            if (closeIdx > i && meta) {
              token.tag = 'div';
              token.attrJoin('class', `markdown-alert markdown-alert-${kind}`);
              tokens[closeIdx].tag = 'div';

              const titleHtml = new state.Token('html_inline', '', 0);
              titleHtml.content = `${meta.icon}<span>${meta.label}</span>`;

              if (kids.length === 1) {
                tokens[i + 1].attrJoin('class', 'markdown-alert-title');
                inlineTok.children = [titleHtml];
              } else {
                // Strip [!KIND] + following softbreak/hardbreak, and prepend title <p>
                const dropCount = kids[1]?.type === 'softbreak' || kids[1]?.type === 'hardbreak' ? 2 : 1;
                kids.splice(0, dropCount);
                const pOpen = new state.Token('paragraph_open', 'p', 1);
                pOpen.attrJoin('class', 'markdown-alert-title');
                const pInline = new state.Token('inline', '', 0);
                pInline.children = [titleHtml];
                const pClose = new state.Token('paragraph_close', 'p', -1);
                tokens.splice(i + 1, 0, pOpen, pInline, pClose);
              }
            }
          }
        }

        // GitHub task lists: "- [ ] item" / "- [x] item".
        if (
          token.type === 'inline' &&
          tokens[i - 1]?.type === 'paragraph_open' &&
          tokens[i - 2]?.type === 'list_item_open'
        ) {
          const first = token.children?.[0];
          const match = first?.type === 'text' ? /^\[([ xX])\]\s+/.exec(first.content) : null;
          if (first && match) {
            first.content = first.content.slice(match[0].length);
            const box = new state.Token('html_inline', '', 0);
            box.content = `<input type="checkbox" disabled${match[1] === ' ' ? '' : ' checked'}> `;
            token.children!.unshift(box);
            tokens[i - 2].attrJoin('class', 'task-list-item');
          }
        }
      }
      return true;
    });

    this.md = md;
  }

  render(text: string): RenderResult {
    const { frontMatter, frontMatterEndLine, body } = splitFrontMatter(text);
    const env: Env = { toc: [] };
    let html = this.md.render(body, env as never);
    if (frontMatter !== undefined) {
      html = `${renderFrontMatterHtml(frontMatter, frontMatterEndLine ?? 1)}\n${html}`;
    }
    return { html, toc: env.toc };
  }
}
