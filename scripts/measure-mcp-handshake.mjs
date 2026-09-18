#!/usr/bin/env node
/**
 * 测量 `serve --mcp` 握手到 `tools/list` 应答的时延（P2 问题 11 的「启动耗时」口径）。
 *
 * 为什么需要它：always-load 与 deferred 的差别不是「工具列表要等多久」，而是那几 KB
 * 常驻定义是否在首轮就进上下文。这个脚本负责前半句——把 `initialize` 与 `tools/list`
 * 各自相对进程启动的毫秒数打出来，读数是模型可见固定成本的实测依据，不是估算。
 *
 * 用法：
 *   node scripts/measure-mcp-handshake.mjs [--path <repo>] [--runs N] [--no-daemon]
 *
 *   --path <repo>  目标项目（默认当前目录）；需要已有 `.codegraph/`，否则 tools/list 仍会
 *                  应答（静态表面），但 `initialize` 的说明会换成「无默认项目」那一段。
 *   --runs N       重复次数，默认 2（每个 arm 至少两次，避免单次噪声当结论）。
 *   --no-daemon    给子进程设 `CODEGRAPH_NO_DAEMON=1`，测 in-process 冷启动，且不留下 daemon。
 *                  不加则走默认路径（已有共享 daemon 时是代理路径）。
 *
 * 每个 arm 输出一行 JSON：`initMs`、`toolsListMs`、`tools`、`toolsChars`、`toolsBytes`。
 * 字符数用 `JSON.stringify(...).length`，字节数用 UTF-8 编码长度——两者不相等时差额来自
 * 非 ASCII 字符，别把字节数当字符数报。
 *
 * 前置：`dist/` 必须是最新构建（`node node_modules/typescript/bin/tsc` 或 `npm run build`）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);

function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
const target = path.resolve(argValue('--path') ?? process.cwd());
const runs = Number(argValue('--runs') ?? 2);
const noDaemon = argv.includes('--no-daemon');
const bin = path.join(root, 'dist', 'bin', 'codegraph.js');

if (!existsSync(bin)) {
  console.error(`missing ${bin} — run "node node_modules/typescript/bin/tsc" (or "npm run build") first`);
  process.exit(1);
}
if (!Number.isFinite(runs) || runs < 1) {
  console.error('--runs must be a positive integer');
  process.exit(1);
}

/** 一次冷启动握手；resolve 成一行读数。 */
function measure(label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'serve', '--mcp', '--path', target], {
      cwd: root,
      env: noDaemon ? { ...process.env, CODEGRAPH_NO_DAEMON: '1' } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const startedAt = Date.now();
    let initMs = null;
    let settled = false;
    let buffer = '';

    const finish = (row) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(row);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`timed out after 60s waiting for tools/list (${label})`));
    }, 60_000);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && initMs === null) initMs = Date.now() - startedAt;
        if (msg.id === 3) {
          const tools = msg.result?.tools ?? [];
          const serialized = JSON.stringify(tools);
          finish({
            label,
            initMs,
            toolsListMs: Date.now() - startedAt,
            tools: tools.length,
            toolsChars: serialized.length,
            toolsBytes: Buffer.byteLength(serialized),
          });
        }
      }
    });
    child.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));

    const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'measure-mcp-handshake', version: '1' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  });
}

const mode = noDaemon ? 'in-process (CODEGRAPH_NO_DAEMON=1)' : 'default (daemon/proxy path)';
console.error(`# target=${target}\n# mode=${mode}\n# runs=${runs}`);

const rows = [];
for (let i = 1; i <= runs; i++) {
  try {
    const row = await measure(`${mode} run ${i}`);
    rows.push(row);
    console.log(JSON.stringify(row));
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
    break;
  }
}

if (rows.length > 1) {
  // initialize 没被观测到时是 null（tools/list 先到）；中位数只用有值的样本。
  const median = (pick) => {
    const values = rows.map(pick).filter((v) => typeof v === 'number').sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length / 2)] : null;
  };
  console.error(`# median: initMs=${median((r) => r.initMs)} toolsListMs=${median((r) => r.toolsListMs)}`);
}
