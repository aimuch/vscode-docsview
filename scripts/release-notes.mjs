// CI: release notes for a build — the commits since the previous release tag, plus how to
// install the offline package. Usage: node scripts/release-notes.mjs <version> <vsix-name>
import { execFileSync } from 'node:child_process';

const [version, vsix] = process.argv.slice(2);
if (!version || !vsix) {
  console.error('usage: node scripts/release-notes.mjs <version> <vsix-name>');
  process.exit(2);
}

// stderr is dropped: `git describe` complains when there is no earlier tag, which is expected.
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

let previous = '';
try {
  // Newest release tag reachable from HEAD, other than this build's own.
  previous = git('describe', '--tags', '--abbrev=0', '--match', 'v*', '--exclude', `v${version}`, 'HEAD');
} catch {
  // First release: no earlier tag.
}

const range = previous ? `${previous}..HEAD` : 'HEAD';
const commits = git('log', '--no-merges', '--format=- %s (%h)', range, '-n', '200');
const repo = process.env.GITHUB_REPOSITORY;

const lines = [
  `## 安装 / Install`,
  ``,
  `下载下方的 \`${vsix}\`，然后任选一种方式安装：`,
  ``,
  `- VS Code 扩展视图右上角 **…** → **从 VSIX 安装…**（Install from VSIX…），选择下载的文件`,
  `- 命令行：\`code --install-extension ${vsix}\``,
  ``,
  `离线可用，不依赖任何其他插件。`,
  ``,
  `## 更新内容 / Changes${previous ? `（自 ${previous}）` : ''}`,
  ``,
  commits || '- （无新提交）',
];
if (previous && repo) {
  lines.push('', `完整对比：https://github.com/${repo}/compare/${previous}...v${version}`);
}
console.log(lines.join('\n'));
