// Launches the locally installed VS Code with an isolated, throw-away profile, loads this
// extension from source and runs test/smoke inside it.  Usage: npm run smoke
// Set VSCODE_BIN to the Electron binary if VS Code is not in the default location.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const bin = candidates.find((p) => existsSync(p));
if (!bin) {
  console.error('VS Code not found. Set VSCODE_BIN to its executable.');
  process.exit(2);
}

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
rmSync(profile, { recursive: true, force: true });
process.exit(run.status ?? 1);
