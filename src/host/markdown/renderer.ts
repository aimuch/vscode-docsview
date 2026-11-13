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
function splitFrontMatter(text: string): { frontMatter?: string; body: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) {
    return { body: text };
  }
  const lines = match[0].split('\n').length - 1;
  return { frontMatter: match[1], body: '\n'.repeat(lines) + text.slice(match[0].length) };
}

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
      const line = token.map ? ` data-line="${token.map[0]}"` : '';
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
    const { frontMatter, body } = splitFrontMatter(text);
    const env: Env = { toc: [] };
    let html = this.md.render(body, env as never);
    if (frontMatter !== undefined) {
      html = `<pre class="md-frontmatter" data-line="0"><code>${escapeHtml(frontMatter)}</code></pre>\n${html}`;
    }
    return { html, toc: env.toc };
  }
}
