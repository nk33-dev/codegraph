import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseNpmPackOutput } from './lib/npm-pack-output.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('请通过 npm run verify:personal-install 执行。');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-package-check-'));
const env = { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_NO_DAEMON: '1' };
const run = (args, cwd = root) => execFileSync(process.execPath, args, {
  cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
});

/**
 * 用已安装的包走一遍真实 MCP 握手：客户端拿到的工具表面必须完整可用。
 * Anthropic API 拒绝顶层 anyOf/oneOf/allOf，带上它的工具会被 Claude Code 静默丢弃，
 * 所以这里检查的是安装产物实际返回的 tools/list，而不是源码里的定义。
 */
function checkMcpSurface(cli, cwd) {
  const requested = '2025-06-18';
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: requested, capabilities: {}, clientInfo: { name: 'verify-personal-install', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';
  const served = spawnSync(process.execPath, [cli, 'serve', '--mcp'], {
    cwd, env, input, encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  const replies = new Map();
  for (const line of (served.stdout ?? '').split(/\r?\n/)) {
    try { const message = JSON.parse(line); if (message.id !== undefined) replies.set(message.id, message.result); } catch { /* 非 JSON-RPC 行 */ }
  }
  if (replies.get(1)?.protocolVersion !== requested) throw new Error(`MCP 握手没有协商到客户端请求的协议版本 ${requested}。`);
  const listed = replies.get(2)?.tools;
  if (!Array.isArray(listed)) throw new Error('安装包的 MCP 服务没有返回 tools/list。');
  for (const name of ['codegraph_explore', 'codegraph_edit']) {
    const tool = listed.find((entry) => entry.name === name);
    if (!tool) throw new Error(`默认 MCP 表面缺少 ${name}。`);
    if (tool._meta?.['anthropic/alwaysLoad'] !== true) throw new Error(`${name} 没有 anthropic/alwaysLoad，Claude Code 会把它延迟加载。`);
  }
  for (const tool of listed) {
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (key in tool.inputSchema) throw new Error(`${tool.name} 的 inputSchema 顶层含 ${key}，Anthropic API 会拒绝它。`);
    }
  }
}

/**
 * 比较两个路径是否指向同一处，解析符号链接后再比。
 *
 * macOS 上 `os.tmpdir()` 给的是 `/var/folders/...`，而 `/var` 是指向
 * `/private/var` 的符号链接；Node 默认对主模块做 realpath，所以子进程里
 * `__dirname` 推出的是 `/private/var/...`，脚本手里拼出来的却是 `/var/...`。
 * 裸字符串比较必然不等，只有 macOS 会因此误报（升级路径 src/bin/codegraph.ts
 * 早就用 fs.realpathSync 做同一类身份比较，这里漏了）。
 */
const samePath = (a, b) => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    // 路径不存在时 realpath 的结果没有意义，退回解析后的字符串比较。
    return path.resolve(a) === path.resolve(b);
  }
};

try {
  // 先构建，再把真实 tarball 装进独立 prefix，避免从工作区借用依赖或产物。
  const packed = parseNpmPackOutput(run([npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary]));
  const archive = path.join(temporary, packed[0].filename);
  const prefix = path.join(temporary, 'installed');
  run([npm, 'install', '--global', '--prefix', prefix, archive, '--no-audit', '--no-fund']);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const installed = path.join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', pkg.name);
  const cli = path.join(installed, 'dist/bin/codegraph.js');
  const info = JSON.parse(run([cli, 'doctor', '--json'], temporary));
  // 分开报错：三合一断言在 macOS 上只说「来源不正确」，看不出错的是路径比较
  // 还是 distribution/buildId。
  if (!samePath(info.packageRoot, installed)) {
    throw new Error(`安装后运行来源不正确：doctor 报 packageRoot=${info.packageRoot}，期望 ${installed}。`);
  }
  if (info.distribution !== 'personal' || !info.build?.buildId) {
    throw new Error(`安装后运行来源不正确：distribution=${info.distribution}，buildId=${info.build?.buildId ?? 'null'}。`);
  }
  if (!run([cli, 'ui', '--help'], temporary).includes('codegraph ui')) throw new Error('安装包缺少 ui 命令。');
  checkMcpSurface(cli, temporary);
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
  console.log(`安装验证通过：${info.build.buildId}；doctor、UI 资源、MCP 工具表面与协议协商、Python 图查询、事务编辑与幂等重放。`);
} finally {
  // 只删除本次 mkdtemp 创建的验证目录，用户全局安装不在这个 prefix 内。
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('codegraph-package-check-')) {
    throw new Error('拒绝清理非验证目录。');
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
