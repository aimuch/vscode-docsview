// Build script: extension host bundle (node/cjs) + webview bundles (browser/esm with
// code splitting) + static assets that libraries load at runtime (pdf.js worker etc.).
// `--dev` additionally builds the browser harness server and the smoke test into out/.
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');
const dev = args.has('--dev');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
  legalComments: 'none',
};

const extension = {
  ...common,
  entryPoints: [join(root, 'src/extension.ts')],
  outfile: join(root, 'dist/extension.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
};

const viewers = ['markdown', 'sheet', 'docx', 'pdf', 'pptx', 'text'];

const webview = {
  ...common,
  entryPoints: Object.fromEntries(viewers.map((v) => [v, join(root, `src/webview/${v}/main.ts`)])),
  outdir: join(root, 'dist/webview'),
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  loader: {
    '.woff': 'file',
    '.woff2': 'file',
    '.ttf': 'file',
    '.svg': 'dataurl',
    '.png': 'dataurl',
    '.gif': 'dataurl',
    '.cur': 'dataurl',
  },
};

const devServer = {
  ...common,
  entryPoints: [join(root, 'dev/server.ts')],
  outfile: join(root, 'out/dev-server.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  minify: false,
};

const smoke = {
  ...common,
  entryPoints: [join(root, 'test/smoke/index.ts')],
  outfile: join(root, 'out/smoke.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  minify: false,
};

/** Files pdf.js fetches at runtime; they cannot be bundled. */
function copyPdfAssets() {
  const src = join(root, 'node_modules/pdfjs-dist');
  const dest = join(root, 'dist/webview/pdfjs');
  mkdirSync(dest, { recursive: true });
  cpSync(join(src, 'build/pdf.worker.min.mjs'), join(dest, 'pdf.worker.min.mjs'));
  for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    if (existsSync(join(src, dir))) {
      cpSync(join(src, dir), join(dest, dir), { recursive: true });
    }
  }
}

async function main() {
  if (!watch) {
    rmSync(join(root, 'dist'), { recursive: true, force: true });
  }
  const configs = [extension, webview, ...(dev ? [devServer, smoke] : [])];
  if (watch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    copyPdfAssets();
    await Promise.all(contexts.map((c) => c.watch()));
  } else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
    copyPdfAssets();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
