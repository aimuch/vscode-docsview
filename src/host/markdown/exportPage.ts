// Building blocks of the Markdown export that need no VS Code API: inlining fonts and
// images, and the standalone page template. Pure module.
import type { ThemeId } from '../../common/protocol';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Prepares the bundled Markdown stylesheet for a standalone file: woff2 fonts become data
 * URIs and the woff/ttf fallbacks are dropped (every current browser reads woff2).
 */
export function inlineFonts(css: string, readAsset: (relativePath: string) => Uint8Array | undefined): string {
  return css
    .replace(/,\s*url\(["']?\.\/assets\/[^"')]+\.(?:woff|ttf)["']?\)\s*format\(["']?(?:woff|truetype)["']?\)/g, '')
    .replace(/url\(["']?(\.\/assets\/[^"')]+\.woff2)["']?\)/g, (match, path: string) => {
      const bytes = readAsset(path);
      return bytes ? `url(data:font/woff2;base64,${Buffer.from(bytes).toString('base64')})` : match;
    });
}

/** Replaces relative <img src> paths with data URIs read through `readFile`. */
export async function inlineImages(
  html: string,
  readFile: (relativePath: string) => Promise<Uint8Array | undefined>,
): Promise<string> {
  const pattern = /(<img\b[^>]*?\ssrc=")([^"]+)(")/gi;
  const replacements = new Map<string, string>();
  for (const match of html.matchAll(pattern)) {
    const src = match[2];
    if (replacements.has(src) || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) {
      continue;
    }
    const path = src.split(/[?#]/)[0].replace(/&amp;/g, '&');
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const mime = MIME[ext];
    let decoded = path;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      // keep as written
    }
    const bytes = mime ? await readFile(decoded) : undefined;
    if (bytes && bytes.byteLength <= MAX_IMAGE_BYTES) {
      replacements.set(src, `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`);
    }
  }
  return html.replace(pattern, (whole, before: string, src: string, after: string) =>
    replacements.has(src) ? before + replacements.get(src) + after : whole,
  );
}

export interface ExportPageOptions {
  title: string;
  css: string;
  body: string;
  theme: ThemeId;
  dark: boolean;
  rtl: boolean;
  /** Open the print dialog once the page has loaded (for "save as PDF"). */
  print: boolean;
}

export function exportPage(o: ExportPageOptions): string {
  const printScript = o.print
    ? `<script>window.addEventListener('load', () => setTimeout(() => window.print(), 300));</script>`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN"${o.rtl ? ' dir="rtl"' : ''}>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="generator" content="DocsView">
<title>${escapeHtml(o.title)}</title>
<style>
${o.css}
/* Standalone page: let the document scroll and print like a normal page. */
html, body { height: auto; overflow: visible; }
body { background: var(--md-bg); }
.md-scroll { overflow: visible; }
.md-copy { display: none !important; }
@media print {
  body, .md-scroll { background: #fff; }
  .markdown-body { max-width: none; padding: 0; }
  .markdown-body pre, .markdown-body table, .markdown-body .mermaid, .markdown-body img { break-inside: avoid; }
  .markdown-body h1, .markdown-body h2, .markdown-body h3 { break-after: avoid; }
}
</style>
</head>
<body data-theme="${o.theme}" data-scheme="${o.dark ? 'dark' : 'light'}"${o.dark ? ' class="dv-dark"' : ''}>
<main class="md-scroll">
<article class="markdown-body"${o.rtl ? ' dir="rtl"' : ''}>
${o.body}
</article>
</main>
${printScript}
</body>
</html>
`;
}
