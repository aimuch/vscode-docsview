// Building blocks of the Markdown export that need no VS Code API: inlining fonts and
// images, HTML sanitisation, and the standalone page template. Pure module.
import { randomBytes } from 'node:crypto';
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

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const DANGEROUS_PAIRED = /<(script|iframe|frameset|object|applet)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const DANGEROUS_TAGS = /<\/?(?:script|iframe|frame|frameset|object|embed|applet|base|meta|link|form)\b[^>]*>/gi;
const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function decodeEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16) || 0))
    .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10) || 0))
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n');
}

function isUnsafeUrl(attrName: string, value: string): boolean {
  const normalized = decodeEntities(value).replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  if (normalized.startsWith('javascript:') || normalized.startsWith('vbscript:')) {
    return true;
  }
  if (normalized.startsWith('data:')) {
    if (attrName === 'src') {
      return !/^data:(?:image|audio|video)\//i.test(normalized);
    }
    return true;
  }
  return false;
}

/**
 * Strips executable markup (scripts, active embeds, event handlers and javascript:/data:
 * navigation URLs) from rendered Markdown HTML before writing a standalone file.
 */
export function sanitizeExportHtml(html: string): string {
  let prev = '';
  let clean = html;
  while (clean !== prev) {
    prev = clean;
    clean = clean.replace(DANGEROUS_PAIRED, '').replace(DANGEROUS_TAGS, '');
  }
  return clean.replace(/<([a-zA-Z][\w:-]*)(\s[^>]*?)?(\/?)>/g, (whole, tag: string, attrs: string | undefined, selfClose: string) => {
    if (!attrs) {
      return whole;
    }
    const kept: string[] = [];
    for (const m of attrs.matchAll(ATTR_RE)) {
      const name = m[1];
      const lower = name.toLowerCase();
      if (lower.startsWith('on') || lower === 'srcdoc') {
        continue;
      }
      const val = m[2] ?? m[3] ?? m[4];
      if (val !== undefined && (lower === 'href' || lower === 'src' || lower === 'xlink:href' || lower === 'action' || lower === 'formaction')) {
        if (isUnsafeUrl(lower, val)) {
          continue;
        }
      }
      if (m[2] !== undefined) {
        kept.push(`${name}="${m[2]}"`);
      } else if (m[3] !== undefined) {
        kept.push(`${name}='${m[3]}'`);
      } else if (m[4] !== undefined) {
        kept.push(`${name}=${m[4]}`);
      } else {
        kept.push(name);
      }
    }
    return `<${tag}${kept.length ? ' ' + kept.join(' ') : ''}${selfClose}>`;
  });
}

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
  lang?: 'en' | 'zh';
  /** Open the print dialog once the page has loaded (for "save as PDF"). */
  print: boolean;
}

export function exportPage(o: ExportPageOptions): string {
  const nonce = o.print ? randomBytes(12).toString('base64') : undefined;
  const csp = [
    `default-src 'none'`,
    `img-src data: https: http:`,
    `media-src data: https: http:`,
    `style-src 'unsafe-inline'`,
    `font-src data:`,
    ...(nonce ? [`script-src 'nonce-${nonce}'`] : []),
  ].join('; ');
  const printScript = nonce
    ? `<script nonce="${nonce}">window.addEventListener('load', () => setTimeout(() => window.print(), 300));</script>`
    : '';
  const htmlLang = o.lang === 'en' ? 'en' : 'zh-CN';
  const safeCss = o.css.replace(/<\/style/gi, '<\\/style');
  const safeBody = sanitizeExportHtml(o.body);
  return `<!DOCTYPE html>
<html lang="${htmlLang}"${o.rtl ? ' dir="rtl"' : ''}>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="generator" content="DocsView">
<title>${escapeHtml(o.title)}</title>
<style>
${safeCss}
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
<body data-theme="${escapeHtml(o.theme)}" data-scheme="${o.dark ? 'dark' : 'light'}"${o.dark ? ' class="dv-dark"' : ''}>
<main class="md-scroll">
<article class="markdown-body"${o.rtl ? ' dir="rtl"' : ''}>
${safeBody}
</article>
</main>
${printScript}
</body>
</html>
`;
}
