// CI: stamps package.json with a unique version for this build, keeping the major and
// minor from the file and using the workflow run number as the patch, e.g. 0.1.0 -> 0.1.42.
// Every pushed build then has its own version, so VS Code treats it as an update.
// Usage: node scripts/ci-version.mjs <run-number>   (prints the version; also writes
// "version=<v>" to $GITHUB_OUTPUT when running in GitHub Actions)
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = Number(process.argv[2]);
if (!Number.isInteger(run) || run < 0) {
  console.error('usage: node scripts/ci-version.mjs <run-number>');
  process.exit(2);
}

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const pkg = JSON.parse(readFileSync(file, 'utf8'));
const [major, minor] = String(pkg.version).split('.');
pkg.version = `${Number(major)}.${Number(minor)}.${run}`;
writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');

console.log(pkg.version);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${pkg.version}\n`);
}
