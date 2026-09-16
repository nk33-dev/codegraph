import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('请通过 npm run verify:personal-install 执行。');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-package-check-'));
const env = { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_NO_DAEMON: '1' };
const run = (args, cwd = root) => execFileSync(process.execPath, args, {
  cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
});

try {
  // 先构建，再把真实 tarball 装进独立 prefix，避免从工作区借用依赖或产物。
  const packed = JSON.parse(run([npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary]));
  const archive = path.join(temporary, packed[0].filename);
  const prefix = path.join(temporary, 'installed');
  run([npm, 'install', '--global', '--prefix', prefix, archive, '--no-audit', '--no-fund']);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const installed = path.join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', pkg.name);
  const cli = path.join(installed, 'dist/bin/codegraph.js');
  const info = JSON.parse(run([cli, 'doctor', '--json'], temporary));
  if (info.packageRoot !== installed || info.distribution !== 'personal' || !info.build?.buildId) {
    throw new Error('安装后运行来源不正确。');
  }
  if (!run([cli, 'ui', '--help'], temporary).includes('codegraph ui')) throw new Error('安装包缺少 ui 命令。');
  run([path.join(installed, 'scripts/check-ui-build.mjs'), '--root', installed], temporary);
  const project = path.join(temporary, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'main.py'), 'def target_value():\n    return 1\n');
  const probe = `
    const { CodeGraph } = require(process.argv[1]);
    (async () => {
      const graph = await CodeGraph.init(process.argv[2], { index: true });
      try {
        const result = graph.queryCode({ mode: 'definitions', query: 'target_value' });
        if (result.status !== 'ok' || result.items.length !== 1) throw new Error(JSON.stringify(result));
        const request = { operation: 'insert-before', symbol: 'target_value', file: 'main.py', content: '# packaged transaction' };
        const edit = await graph.editCode(request);
        if (edit.status !== 'preview' || !edit.operationId || !edit.previewHash) throw new Error(JSON.stringify(edit));
        const applied = await graph.editCode({ ...request, apply: true, operationId: edit.operationId, expectPreviewHash: edit.previewHash });
        if (applied.status !== 'applied' || applied.applied?.replayed) throw new Error(JSON.stringify(applied));
        const replayed = await graph.editCode({ ...request, apply: true, operationId: edit.operationId, expectPreviewHash: edit.previewHash });
        if (replayed.status !== 'applied' || !replayed.applied?.replayed) throw new Error(JSON.stringify(replayed));
      } finally { await graph.getLspManager().close(); graph.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  run(['--liftoff-only', '-e', probe, path.join(installed, 'dist/index.js'), project], temporary);
  const edited = fs.readFileSync(path.join(project, 'main.py'), 'utf8');
  if ((edited.match(/# packaged transaction/g) ?? []).length !== 1) throw new Error('事务编辑未应用一次或发生重复写入。');
  console.log(`安装验证通过：${info.build.buildId}；doctor、UI 资源、Python 图查询、事务编辑与幂等重放。`);
} finally {
  // 只删除本次 mkdtemp 创建的验证目录，用户全局安装不在这个 prefix 内。
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('codegraph-package-check-')) {
    throw new Error('拒绝清理非验证目录。');
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
