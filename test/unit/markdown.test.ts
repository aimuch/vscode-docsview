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

  it('keeps line numbers correct after front matter', () => {
    const { html } = renderer.render('---\ntitle: x\n---\n\n# Heading\n');
    expect(html).toContain('<pre class="md-frontmatter" data-line="0"><code>title: x</code></pre>');
    expect(html).toContain('<h1 data-line="4"');
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
});

describe('slugify', () => {
  it('lowercases, strips punctuation and joins words with dashes', () => {
    expect(slugify('  Getting Started!  ')).toBe('getting-started');
    expect(slugify('API v2.0 (beta)')).toBe('api-v20-beta');
    expect(slugify('数学公式')).toBe('数学公式');
  });
});
