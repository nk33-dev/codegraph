import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 安装已构建的 tarball 时没有 src，不在用户机器上重复编译。
if (fs.existsSync(path.join(root, 'src', 'index.ts'))) {
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('请通过 npm install、npm ci 或 npm pack 执行构建。');
  const env = { ...process.env, npm_config_global: 'false', npm_config_prefix: root };
  // 部分 npm 版本会把全局安装设置传进 Git 的准备目录，导致开发依赖未落在源码旁。
  // 仅在本地编译器缺失时补齐依赖；禁用生命周期，避免递归执行 prepare。
  if (!fs.existsSync(path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'))) {
    const dependencies = spawnSync(process.execPath, [npm, 'ci', '--global=false', '--prefix', root,
      '--include=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: root, env, stdio: 'inherit', windowsHide: true });
    if (dependencies.error) throw dependencies.error;
    if (dependencies.status !== 0) process.exit(dependencies.status ?? 1);
  }
  const result = spawnSync(process.execPath, [npm, 'run', 'build'], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else if (!fs.existsSync(path.join(root, 'dist', 'bin', 'codegraph.js'))) {
  throw new Error('安装包缺少 CLI 产物，请重新构建后打包。');
}
