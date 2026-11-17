// Build script: extension host bundle (node/cjs) + webview bundles (browser/esm with
// code splitting) + static assets that libraries load at runtime (pdf.js worker etc.).
// `--dev` additionally builds the browser harness server and the smoke test into out/.
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

// Heavy format parsers live in standalone CJS chunks loaded on demand, keeping dist/extension.js tiny.
const lazyHostMap = new Map([
  [join(root, 'src/host/markdown/renderer.ts'), './host/markdown-renderer.cjs'],
  [join(root, 'src/host/spreadsheet.ts'), './host/spreadsheet.cjs'],
  [join(root, 'src/host/office.ts'), './host/office.cjs'],
  [join(root, 'src/host/doc/docExtractor.ts'), './host/doc-extractor.cjs'],
]);

const externalLazyHostPlugin = {
  name: 'external-lazy-host',
  setup(build) {
    build.onResolve({ filter: /^\./ }, (a) => {
      if (a.kind !== 'dynamic-import') {
        return null;
      }
      const target = lazyHostMap.get(resolve(a.resolveDir, `${a.path}.ts`));
      return target ? { path: target, external: true } : null;
    });
  },
};

const extension = {
  ...common,
  entryPoints: [join(root, 'src/extension.ts')],
  outfile: join(root, 'dist/extension.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  // Emit CJS require() for lazy host chunks so resolution is deterministic inside Electron's extension host.
  supported: { 'dynamic-import': false },
  plugins: [externalLazyHostPlugin],
};

const hostChunks = [...lazyHostMap.entries()].map(([entry, outRel]) => ({
  ...common,
  entryPoints: [entry],
  outfile: join(root, 'dist', outRel),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
}));

const viewers = ['markdown', 'sheet', 'docx', 'pdf', 'pptx', 'text', 'image'];

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
  const configs = [extension, ...hostChunks, webview, ...(dev ? [devServer, smoke] : [])];
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
