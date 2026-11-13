// Launches VS Code with an isolated, throw-away profile, loads this extension from source
// and runs test/smoke inside it.  Usage: npm run smoke
// Uses the locally installed VS Code (or VSCODE_BIN); in CI, or when none is installed, a
// stable build is downloaded with @vscode/test-electron. On Linux run it under xvfb-run.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  process.env.VSCODE_BIN,
  '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  '/usr/share/code/code',
  `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Microsoft VS Code\\Code.exe`,
].filter(Boolean);
let bin = process.env.CI ? process.env.VSCODE_BIN : candidates.find((p) => existsSync(p));
if (!bin) {
  const { downloadAndUnzipVSCode } = await import('@vscode/test-electron');
  bin = await downloadAndUnzipVSCode('stable');
}
// Headless Linux (CI): no GPU, and Electron's sandbox is unavailable on recent Ubuntu runners.
const platformArgs = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] : [];

const profile = mkdtempSync(join(tmpdir(), 'docsview-smoke-'));
const result = join(profile, 'result.json');
const run = spawnSync(
  bin,
  [
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${join(root, 'out', 'smoke.cjs')}`,
    `--user-data-dir=${join(profile, 'user')}`,
    `--extensions-dir=${join(profile, 'extensions')}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-updates',
    '--new-window',
    ...platformArgs,
    join(root, 'samples'),
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, DOCSVIEW_SAMPLES: join(root, 'samples'), DOCSVIEW_RESULT: result },
    timeout: 10 * 60 * 1000,
  },
);

if (existsSync(result)) {
  for (const r of JSON.parse(readFileSync(result, 'utf8'))) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.file}  [${r.viewType}]  ${r.detail ?? ''}`);
  }
} else {
  console.error('No result file was written: the extension host did not run the tests.');
}
// Keep the xlsx saved by the editing check, for opening in a spreadsheet app.
const savedXlsx = join(profile, 'work', 'report.xlsx');
if (existsSync(savedXlsx)) {
  mkdirSync(join(root, 'out'), { recursive: true });
  copyFileSync(savedXlsx, join(root, 'out', 'smoke-saved-report.xlsx'));
  console.log('Saved workbook copied to out/smoke-saved-report.xlsx');
}
rmSync(profile, { recursive: true, force: true });
process.exit(run.status ?? 1);
