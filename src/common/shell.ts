import type { WebviewConfig } from './protocol';

export interface ShellOptions {
  config: WebviewConfig;
  /** Value for the CSP source list; omit to emit no CSP (dev harness). */
  cspSource?: string;
  /** Base for relative URLs inside the rendered document (Markdown images). */
  baseHref?: string;
  bodyClass?: string;
  /** Raw HTML appended to <head> (dev harness only). */
  extraHead?: string;
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** HTML document shared by the real webviews and the browser dev harness. */
export function renderShell(opts: ShellOptions): string {
  const { config, cspSource: src } = opts;
  const csp = src
    ? [
        `default-src 'none'`,
        `img-src ${src} https: data: blob:`,
        `media-src ${src} https: data: blob:`,
        `style-src ${src} 'unsafe-inline'`,
        `font-src ${src} data: blob:`,
        // No 'unsafe-inline': scripts embedded in previewed documents never run.
        `script-src ${src} 'wasm-unsafe-eval'`,
        `connect-src ${src} data: blob:`,
        `worker-src ${src} blob:`,
      ].join('; ')
    : undefined;

  return `<!DOCTYPE html>
<html lang="${config.lang}">
<head>
<meta charset="UTF-8">
${csp ? `<meta http-equiv="Content-Security-Policy" content="${attr(csp)}">` : ''}
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="docsview-config" content="${attr(JSON.stringify(config))}">
${opts.baseHref ? `<base href="${attr(opts.baseHref)}">` : ''}
<link rel="stylesheet" href="${attr(config.assets)}/${config.kind}.css">
${opts.extraHead ?? ''}
</head>
<body class="${attr(opts.bodyClass ?? '')}" data-kind="${config.kind}">
<div id="app"></div>
<script type="module" src="${attr(config.assets)}/${config.kind}.js"></script>
</body>
</html>`;
}
