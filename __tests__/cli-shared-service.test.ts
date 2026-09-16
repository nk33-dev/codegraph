/**
 * Phase three: multi-window (cross-process) sharing of the index and LSP service.
 *
 * The scenario matches what users actually hit: one window already runs an MCP service (the
 * daemon holds the index connection and the language server), while `codegraph explore
 * --backend lsp` in another window is a **one-shot process**. It used to spawn its own language
 * server; now it reuses the daemon's.
 *
 * Observation method (no internal counters):
 *   - the fake language server appends every request to a log, so the `initialize` count equals
 *     the number of processes actually started;
 *   - `routing.servedBy` / `routing.daemonPid` in the result say who produced it;
 *   - asking the daemon for `status` again should show the same pid and accumulated request
 *     count in its LSP block.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { once } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { CodeGraph } from '../src';
import { createFakeProject, type FakeProject } from './lsp-test-utils';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const FILE_CONTENT = 'export class Widget {\n  render() { return 1; }\n}\n';

let project: FakeProject;
let realRoot: string;
let server: ChildProcessWithoutNullStreams | null = null;

function readLockPid(root: string): number | null {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(root, '.codegraph', 'daemon.pid'), 'utf8'));
    return typeof info.pid === 'number' ? info.pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor<T>(predicate: () => T | undefined | null | false, timeoutMs: number, label: string): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value as T;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Start a real MCP client (proxy process); it brings up the daemon. */
async function startMcpClient(): Promise<{ child: ChildProcessWithoutNullStreams; request: (method: string, params: object) => Promise<any> }> {
  const child = spawn(process.execPath, [BIN, 'serve', '--mcp', '--path', realRoot], {
    cwd: realRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_WASM_RELAUNCHED: '1' },
  }) as ChildProcessWithoutNullStreams;
  child.on('error', () => { /* ignore */ });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  let id = 0;
  const request = (method: string, params: object) => new Promise<any>((resolve, reject) => {
    const requestId = ++id;
    const cleanup = () => { clearTimeout(timer); lines.off('line', receive); child.off('exit', exited); };
    const exited = () => { cleanup(); reject(new Error('the MCP client exited before responding')); };
    const receive = (line: string) => {
      try {
        const message = JSON.parse(line);
        if (message.id !== requestId) return;
        cleanup();
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      } catch (error) { cleanup(); reject(error); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`MCP ${method} timed out`)); }, 60_000);
    lines.on('line', receive);
    child.once('exit', exited);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  });
  return { child, request };
}

function exploreCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [BIN, 'explore', ...args, '-p', project.root], {
    encoding: 'utf-8',
    timeout: 90_000,
    env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_WASM_RELAUNCHED: '1', ...env },
    windowsHide: true,
  });
}

function editCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [BIN, 'edit', ...args, '-p', project.root], {
    encoding: 'utf-8',
    timeout: 90_000,
    env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_WASM_RELAUNCHED: '1', ...env },
    windowsHide: true,
  });
}

beforeEach(async () => {
  project = createFakeProject({ 'a.ts': FILE_CONTENT });
  realRoot = fs.realpathSync(project.root);
  const cg = CodeGraph.initSync(project.root);
  await cg.indexAll();
  cg.close();
  server = null;
}, 60_000);

afterEach(async () => {
  if (server && !server.killed) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  // The daemon is detached, so it must be killed by the pid it recorded or it leaks into later tests.
  const daemonPid = readLockPid(realRoot);
  if (daemonPid && daemonPid !== process.pid && isAlive(daemonPid)) {
    try { process.kill(daemonPid, 'SIGKILL'); } catch { /* race */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  project?.cleanup();
  server = null;
});

describe('CLI reuses the daemon language server (multi-window sharing)', () => {
  it('the daemon runs structured queries and the language server starts only once', async () => {
    const client = await startMcpClient();
    server = client.child;
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'shared-service-test', version: '1' },
      });
      const daemonPid = await waitFor(() => readLockPid(realRoot), 30_000, 'the daemon pidfile');

      const first = exploreCli(['a.ts', '--mode', 'symbols', '--backend', 'lsp']);
      expect(first.status, first.stderr).toBe(0);
      const firstJson = JSON.parse(first.stdout);
      expect(firstJson).toMatchObject({
        backend: 'lsp',
        status: 'ok',
        routing: { requested: 'lsp', resolved: 'lsp', servedBy: 'shared-daemon', daemonPid },
      });
      expect(firstJson.items.length).toBeGreaterThan(0);

      const second = exploreCli(['Widget', '--mode', 'definitions', '--backend', 'lsp']);
      expect(second.status, second.stderr).toBe(0);
      expect(JSON.parse(second.stdout).routing).toMatchObject({ servedBy: 'shared-daemon', daemonPid });

      // One process start = one initialize; both CLI queries land on the daemon's single server.
      await waitFor(() => project.events('initialize').length >= 1, 30_000, 'the fake server to start');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(project.events('initialize')).toHaveLength(1);

      // The daemon itself also sees this server's request count and pid.
      const status = await client.request('tools/call', {
        name: 'codegraph_explore',
        arguments: { mode: 'status', backend: 'lsp', query: 'status' },
      });
      const typescript = status.structuredContent.lsp.servers.find((entry: any) => entry.family === 'typescript');
      expect(typescript).toMatchObject({ state: 'ready' });
      expect(typescript.requestCount).toBeGreaterThanOrEqual(2);
      expect(typescript.pid).toEqual(expect.any(Number));
    } finally {
      if (client.child.exitCode === null && client.child.signalCode === null) {
        const stopped = once(client.child, 'exit');
        client.child.kill();
        await stopped;
      }
    }
  }, 180_000);

  it('CODEGRAPH_SHARED_SERVICE=0 falls back to this process, which starts its own server', async () => {
    const client = await startMcpClient();
    server = client.child;
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'shared-service-off-test', version: '1' },
      });
      await waitFor(() => readLockPid(realRoot), 30_000, 'the daemon pidfile');

      const result = exploreCli(['a.ts', '--mode', 'symbols', '--backend', 'lsp'], { CODEGRAPH_SHARED_SERVICE: '0' });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).routing).toMatchObject({ servedBy: 'in-process', daemonPid: null });

      // This process starts its own server and finishes the query (the daemon's was never started).
      const events = await waitFor(() => {
        const found = project.events('textDocument/documentSymbol');
        return found.length >= 1 ? found : null;
      }, 30_000, 'the CLI to query its own language server');
      expect(events.length).toBeGreaterThanOrEqual(1);
      const status = await client.request('tools/call', {
        name: 'codegraph_explore',
        arguments: { mode: 'status', backend: 'lsp', query: 'status' },
      });
      const typescript = status.structuredContent.lsp.servers.find((entry: any) => entry.family === 'typescript');
      expect(typescript).toMatchObject({ state: 'stopped', pid: null, requestCount: 0 });
    } finally {
      if (client.child.exitCode === null && client.child.signalCode === null) {
        const stopped = once(client.child, 'exit');
        client.child.kill();
        await stopped;
      }
    }
  }, 180_000);

  it('with no daemon it does not start one: it falls back in-process and labels that honestly', async () => {
    const result = exploreCli(['a.ts', '--mode', 'symbols', '--backend', 'lsp']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).routing).toMatchObject({ servedBy: 'in-process', daemonPid: null });
    // No daemon means no `.codegraph/daemon.pid`
    expect(readLockPid(realRoot)).toBeNull();
  }, 120_000);

  it('does not replay an edit locally when a live daemon fails to confirm it', async () => {
    const client = await startMcpClient();
    server = client.child;
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'shared-edit-test', version: '1' },
      });
      await waitFor(() => readLockPid(realRoot), 30_000, 'the daemon pidfile');

      const result = editCli([
        'render', '--operation', 'insert-after', '--file', 'a.ts', '--content', 'export const added = true;', '--apply',
      ], { CODEGRAPH_SHARED_SERVICE_TIMEOUT_MS: '1' });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('did not confirm the edit');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const content = fs.readFileSync(path.join(project.root, 'a.ts'), 'utf-8');
      expect(content.match(/export const added = true;/g)?.length ?? 0).toBeLessThanOrEqual(1);
    } finally {
      if (client.child.exitCode === null && client.child.signalCode === null) {
        const stopped = once(client.child, 'exit');
        client.child.kill();
        await stopped;
      }
    }
  }, 120_000);
});
