/**
 * LSP stdio protocol layer: framing, id correlation, reverse-request replies, process exit.
 *
 * These tests bypass the manager and drive LspConnection against a child process that writes
 * frames byte by byte — chunk splits, coalescing, header casing, and UTF-8 boundaries can only
 * be verified at this layer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LspConnection, LspError, parseContentLength } from '../src/lsp/protocol';

let child: ChildProcess | null = null;
let connection: LspConnection | null = null;
let scriptPath: string | null = null;

/** Write a script to disk and run it: avoids the shell quoting hell of node -e. */
function startScript(source: string, handlers: Partial<{
  onNotification: (method: string, params: unknown) => void;
  onRequest: (method: string, params: unknown) => unknown;
}> = {}): LspConnection {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lsp-proto-'));
  scriptPath = path.join(dir, 'server.js');
  fs.writeFileSync(scriptPath, source);
  child = spawn(process.execPath, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  connection = new LspConnection(child, {
    onNotification: handlers.onNotification ?? (() => undefined),
    onRequest: handlers.onRequest ?? (() => null),
    onLog: () => undefined,
  });
  return connection;
}

afterEach(async () => {
  try { connection?.dispose(); } catch { /* ignore */ }
  try { child?.kill(); } catch { /* ignore */ }
  connection = null;
  child = null;
  if (scriptPath) {
    try { fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true }); } catch { /* ignore */ }
    scriptPath = null;
  }
});

/** Wait for enough notifications; a fixed sleep is not enough when the whole suite runs concurrently (the fake server is a child process). */
async function waitForNotifications(received: unknown[], count: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (received.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Shared frame-writing snippet: the fake server uses it to emit real LSP frames. */
const FRAME_HELPER = `
function frame(text) { return Buffer.from('Content-Length: ' + Buffer.byteLength(text) + '\\r\\n\\r\\n' + text); }
function frameWithHeader(text, header) { return Buffer.from(header + '\\r\\n\\r\\n' + text); }
`;

describe('LSP framing', () => {
  it('parses the Content-Length header case-insensitively and returns null when missing', () => {
    expect(parseContentLength('Content-Length: 42')).toBe(42);
    expect(parseContentLength('content-length: 7')).toBe(7);
    expect(parseContentLength('Content-Type: application/vscode-jsonrpc')).toBeNull();
    expect(parseContentLength('Content-Length: abc')).toBeNull();
  });

  it('multiple messages in one frame, cross-chunk splits, extra headers, and multi-byte UTF-8 all round-trip', async () => {
    const received: Array<{ method: string; params: any }> = [];
    startScript(`
${FRAME_HELPER}
const first = '{"jsonrpc":"2.0","method":"a","params":{"text":"中文😀"}}';
const second = '{"jsonrpc":"2.0","method":"b","params":{"n":2}}';
const third = '{"jsonrpc":"2.0","method":"c","params":{"n":3}}';
const fourth = '{"jsonrpc":"2.0","method":"d","params":{"n":4}}';
// two frames in one chunk (including a multi-byte body)
process.stdout.write(Buffer.concat([frame(first), frame(second)]));
// header and body separated, then the body cut in half
const split = frame(third);
process.stdout.write(split.slice(0, 10));
setTimeout(() => {
  process.stdout.write(split.slice(10, 20));
  setTimeout(() => {
    process.stdout.write(split.slice(20));
    // differently cased header plus an extra Content-Type header
    process.stdout.write(frameWithHeader(fourth, 'content-LENGTH: ' + Buffer.byteLength(fourth) + '\\r\\nContent-Type: application/vscode-jsonrpc; charset=utf-8'));
  }, 20);
}, 20);
setTimeout(() => process.exit(0), 200);
`, { onNotification: (method, params) => { received.push({ method, params: params as any }); } });

    await waitForNotifications(received, 4);
    expect(received.map((entry) => entry.method)).toEqual(['a', 'b', 'c', 'd']);
    expect(received[0]!.params.text).toBe('中文😀');
  });

  it('a malformed JSON frame is skipped and later valid frames still process', async () => {
    const received: string[] = [];
    startScript(`
${FRAME_HELPER}
process.stdout.write(frame('{"jsonrpc":"2.0","method":"broken"'));
process.stdout.write(frame('{"jsonrpc":"2.0","method":"ok"}'));
setTimeout(() => process.exit(0), 100);
`, { onNotification: (method) => { received.push(method); } });

    await waitForNotifications(received, 1);
    expect(received).toEqual(['ok']);
  });
});

describe('LSP JSON-RPC', () => {
  it('异步 EPIPE 拒绝未完成请求，关闭后迟到的错误也不会崩溃', async () => {
    const conn = startScript('process.stdin.resume();');
    const pending = conn.request('textDocument/definition', {}, 5000);
    const rejection = expect(pending).rejects.toMatchObject({ kind: 'write' });
    expect(() => conn.child.stdin!.emit('error', new Error('write EPIPE'))).not.toThrow();
    await rejection;
    expect(conn.isClosed).toBe(true);
    conn.dispose();
    expect(() => conn.child.stdin!.emit('error', new Error('late EPIPE'))).not.toThrow();
  });
  it('requests and responses correlate by id and a timeout rejects only that call', async () => {
    const conn = startScript(`
${FRAME_HELPER}
let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const sep = buffer.indexOf('\\r\\n\\r\\n');
    if (sep < 0) return;
    const length = Number(/content-length:\\s*(\\d+)/i.exec(buffer.slice(0, sep).toString())[1]);
    if (buffer.length < sep + 4 + length) return;
    const message = JSON.parse(buffer.slice(sep + 4, sep + 4 + length).toString());
    buffer = buffer.slice(sep + 4 + length);
    if (message.method === 'echo') process.stdout.write(frame(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echo: message.params.value } })));
    if (message.method === 'never') { /* deliberately no reply */ }
  }
});
`);

    await expect(conn.request('echo', { value: 7 }, 2000)).resolves.toEqual({ echo: 7 });
    await expect(conn.request('never', {}, 120)).rejects.toMatchObject({ name: 'LspError', kind: 'timeout' });
    // the connection stays usable after the timeout
    await expect(conn.request('echo', { value: 8 }, 2000)).resolves.toEqual({ echo: 8 });
  });

  it('answers server reverse requests and returns the result to the server', async () => {
    const probes: unknown[] = [];
    const conn = startScript(`
${FRAME_HELPER}
let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const sep = buffer.indexOf('\\r\\n\\r\\n');
    if (sep < 0) return;
    const length = Number(/content-length:\\s*(\\d+)/i.exec(buffer.slice(0, sep).toString())[1]);
    if (buffer.length < sep + 4 + length) return;
    const message = JSON.parse(buffer.slice(sep + 4, sep + 4 + length).toString());
    buffer = buffer.slice(sep + 4 + length);
    if (message.id !== undefined) {
      // the client's reply to the reverse request, echoed back for our assertions.
      process.stdout.write(frame(JSON.stringify({ jsonrpc: '2.0', method: 'probe', params: { id: message.id, result: message.result, error: message.error ?? null } })));
    } else if (message.method === 'kick') {
      process.stdout.write(frame(JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'workspace/configuration', params: { items: [{}, {}] } })));
    }
  }
});
`, {
      onRequest: (method, params) => (method === 'workspace/configuration' && Array.isArray((params as any).items)
        ? (params as any).items.map(() => null)
        : 'unexpected'),
      onNotification: (method, params) => { if (method === 'probe') probes.push(params); },
    });

    conn.notify('kick', {});
    const deadline = Date.now() + 3000;
    while (probes.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(probes[0]).toEqual({ id: 77, result: [null, null], error: null });
  });

  it('on process exit, in-flight requests fail with kind=exit', async () => {
    const conn = startScript(`
${FRAME_HELPER}
setTimeout(() => process.exit(3), 60);
`);
    await expect(conn.request('anything', {}, 5000)).rejects.toMatchObject({ name: 'LspError', kind: 'exit' });
    expect(conn.closedReason).toContain('exited');
  });

  it('after the connection closes, further requests fail immediately instead of hanging', async () => {
    const conn = startScript(`setTimeout(() => process.exit(0), 30);`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(conn.request('x', {}, 5000)).rejects.toBeInstanceOf(LspError);
  });
});
