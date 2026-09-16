import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch { return null; }
};
const hash = createHash('sha256');
// 用实际产物识别构建，避免相同版本号的个人版与官方版共享错误的服务。
function fingerprint(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) fingerprint(file);
    else if (entry.name !== 'build-info.json') {
      hash.update(path.relative(root, file).replaceAll('\\', '/'));
      hash.update(fs.readFileSync(file));
    }
  }
}
fingerprint(path.join(root, 'dist'));
hash.update(JSON.stringify(pkg));
const info = {
  schemaVersion: 1,
  distribution: pkg.codegraphDistribution?.channel ?? 'upstream',
  repository: pkg.codegraphDistribution?.repository ?? null,
  branch: git('branch', '--show-current'),
  commit: git('rev-parse', 'HEAD'),
  dirty: (git('status', '--porcelain', '--untracked-files=normal') ?? '') !== '',
  buildId: hash.digest('hex').slice(0, 24),
};
fs.writeFileSync(path.join(root, 'dist', 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log(`[build-info] ${info.distribution} ${info.buildId}`);
