import { describe, expect, it } from 'vitest';
import { MarkdownRenderer, slugify } from '../../src/host/markdown/renderer';

const renderer = new MarkdownRenderer();

describe('MarkdownRenderer', () => {
  it('annotates blocks with their source line', () => {
    const { html } = renderer.render('# Title\n\nFirst paragraph.\n\n- item one\n- item two\n\n```js\nlet a = 1;\n```\n');
    expect(html).toContain('<h1 data-line="0" data-line-end="1"');
    expect(html).toContain('<p data-line="2" data-line-end="3">First paragraph.</p>');
    // A list's range includes the blank line after it; block edits keep that line.
    expect(html).toContain('<ul data-line="4" data-line-end="7">');
    expect(html).toContain('<li data-line="4" data-line-end="5">');
    expect(html).toContain('<li data-line="5" data-line-end="7">');
    expect(html).toContain('<pre data-line="7" data-line-end="10"><code class="language-js">');
  });

  it('keeps line numbers correct after front matter and renders property table or fallback', () => {
    const { html } = renderer.render('---\ntitle: "Hello World"\ntags: [ai, docs]\n---\n\n# Heading\n');
    expect(html).toContain('<div class="md-frontmatter" data-line="0" data-line-end="4"><table class="md-fm-table">');
    expect(html).toContain('<th>title</th><td>Hello World</td>');
    expect(html).toContain('<span class="md-fm-tag">ai</span>');
    expect(html).toContain('<span class="md-fm-tag">docs</span>');
    expect(html).toContain('<h1 data-line="5"');

    // Complex multiline YAML falls back cleanly to <pre class="md-frontmatter">
    const { html: fallback } = renderer.render('---\nsummary: |\n  line 1\n  line 2\n---\n\n# Next\n');
    expect(fallback).toContain('<pre class="md-frontmatter" data-line="0" data-line-end="5"><code>');
    expect(fallback).toContain('<h1 data-line="6"');
  });

  it('builds a table of contents with unique GitHub-style ids', () => {
    const { toc, html } = renderer.render('# Hello World\n\n## 中文 标题\n\n## Hello World\n\n### `code` & more!\n');
    expect(toc).toEqual([
      { level: 1, text: 'Hello World', id: 'hello-world', line: 0 },
      { level: 2, text: '中文 标题', id: '中文-标题', line: 2 },
      { level: 2, text: 'Hello World', id: 'hello-world-1', line: 4 },
      { level: 3, text: 'code & more!', id: 'code--more', line: 6 },
    ]);
    expect(html).toContain('id="hello-world-1"');
  });

  it('highlights known languages and escapes unknown ones', () => {
    const { html } = renderer.render('```ts\nconst a: number = 1;\n```\n\n```nope\n<b>&</b>\n```\n');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('&lt;b&gt;&amp;&lt;/b&gt;');
  });

  it('emits a placeholder for mermaid diagrams', () => {
    const { html } = renderer.render('```mermaid\ngraph LR\n  A["x"] --> B\n```\n');
    expect(html).toContain(
      '<div class="mermaid" data-line="0" data-line-end="4" data-src="graph LR\n  A[&quot;x&quot;] --&gt; B\n">',
    );
    expect(html).not.toContain('hljs');
  });

  it('renders task lists, tables, footnotes and math', () => {
    const { html } = renderer.render(
      '- [x] done\n- [ ] todo\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nNote[^1] and $x^2$.\n\n[^1]: The note.\n',
    );
    expect(html).toContain('class="task-list-item"');
    expect(html).toContain('<input type="checkbox" disabled checked> done');
    expect(html).toContain('<input type="checkbox" disabled> todo');
    expect(html).toContain('<table');
    expect(html).toContain('class="footnotes"');
    expect(html).toContain('class="katex"');
  });

  it('renders GitHub-style alerts while preserving source line annotations and regular blockquotes', () => {
    const md = [
      '> [!NOTE]',
      '> Pay attention to this detail.',
      '',
      '> [!WARNING]',
      '> Breaking change ahead.',
      '',
      '> Plain blockquote line.',
      '',
    ].join('\n');
    const { html } = renderer.render(md);
    expect(html).toContain('<div data-line="0" data-line-end="2" class="markdown-alert markdown-alert-note">');
    expect(html).toContain('class="markdown-alert-title"');
    expect(html).toContain('<span>Note</span></p>');
    expect(html).toContain('Pay attention to this detail.');
    expect(html).toContain('<div data-line="3" data-line-end="5" class="markdown-alert markdown-alert-warning">');
    expect(html).toContain('<span>Warning</span></p>');
    expect(html).toContain('<blockquote data-line="6" data-line-end="7">');
  });
});

describe('slugify', () => {
  it('lowercases, strips punctuation and joins words with dashes', () => {
    expect(slugify('  Getting Started!  ')).toBe('getting-started');
    expect(slugify('API v2.0 (beta)')).toBe('api-v20-beta');
    expect(slugify('数学公式')).toBe('数学公式');
  });
});
