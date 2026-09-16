/**
 * The CLI-side shared-service client (phase 3: shared index and LSP service across windows).
 *
 * Background: MCP clients already share one daemon among themselves (`daemon.ts`: one process per
 * project, one SQLite connection, one watcher); but a one-shot CLI process such as `codegraph explore`
 * used to always open its own connection and spawn its own language server — for a reindex-heavy server
 * like rust-analyzer, every window paid that cost once.
 *
 * This lets the CLI reuse a daemon that is **already running**: read the pidfile for the socket, verify
 * the process identity and version, then go through the standard MCP handshake + `tools/call` and bring
 * back the structured query's JSON as-is.
 *
 * Three hard rules:
 *   1. **Never start the daemon proactively.** With no daemon, use this process (the existing behavior),
 *      so a `codegraph explore` does not casually leave a background process behind.
 *   2. 只读调用失败后可回退到进程内查询；写调用找到活动 daemon 后只尝试一次，未确认时不重放。
 *   3. Forward structured calls only: the text explore output depends on in-session state.
 */
import * as fs from 'fs';
import * as net from 'net';
import { pathToFileURL } from 'url';
import { decodeLockInfo, getDaemonPidPath, probeDaemonIdentity } from './daemon-paths';
import { connectWithHello } from './proxy';

/** The wait limit for one shared query; impact analysis on a large repository can be slow. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The wait limit for daemon identity probing.
 *
 * `probeDaemonIdentity` waits only 1s by default: it is meant for the `codegraph daemon` listing, where a
 * missed report is better than a slowdown. The CLI is the opposite — a query already takes hundreds of
 * milliseconds to tens of seconds, and on a busy machine 1s would misjudge "the daemon is running" as "no
 * daemon", pointlessly starting another language server (exactly what this phase set out to eliminate).
 */
const PROBE_TIMEOUT_MS = 5_000;

/** Retry count and interval when a daemon was found but cannot be reached (a connection failure is usually transient contention, not "no service"). */
const ATTACH_RETRIES = 1;
const ATTACH_RETRY_DELAY_MS = 200;

/** With sharing disabled (`0`/`off`/`false`), the CLI always queries in-process. */
export function sharedServiceEnabled(): boolean {
  const raw = (process.env.CODEGRAPH_SHARED_SERVICE ?? '').trim().toLowerCase();
  return raw !== '0' && raw !== 'off' && raw !== 'false' && raw !== 'no';
}

export function sharedServiceTimeoutMs(): number {
  const raw = Number(process.env.CODEGRAPH_SHARED_SERVICE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TIMEOUT_MS;
}

export interface SharedDaemonInfo {
  pid: number;
  socketPath: string;
}

/**
 * The daemon info for this project; null when there is none, it is dead, or the identity does not match.
 * Identity is verified with `probeDaemonIdentity` (reading the pidfile is not enough: the OS reuses PIDs).
 */
export async function findSharedDaemon(projectRoot: string): Promise<SharedDaemonInfo | null> {
  let raw: string;
  try {
    raw = fs.readFileSync(getDaemonPidPath(projectRoot), 'utf8');
  } catch {
    return null;
  }
  const info = decodeLockInfo(raw);
  if (!info || !info.socketPath) return null;
  if (!(await probeDaemonIdentity(info, PROBE_TIMEOUT_MS))) return null;
  return { pid: info.pid, socketPath: info.socketPath };
}

type JsonRpc = Record<string, unknown>;

/**
 * A minimal JSON-RPC line-protocol client: it serves exactly one purpose, "hello + one tools/call".
 * Server-to-client requests (such as `roots/list`) always get an empty answer, so the daemon never waits.
 */
class LineClient {
  private buffer = '';
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private closed: Error | null = null;

  constructor(private readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (error: Error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('the shared daemon closed the connection')));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: JsonRpc;
      try {
        message = JSON.parse(line) as JsonRpc;
      } catch {
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: JsonRpc): void {
    // Server-to-client request: it must be answered, or some implementations keep waiting.
    if (typeof message.method === 'string' && message.id !== undefined) {
      const result = message.method === 'roots/list' ? { roots: [] } : {};
      this.write({ jsonrpc: '2.0', id: message.id, result });
      return;
    }
    const id = typeof message.id === 'number' ? message.id : null;
    if (id === null) return; // notification, nothing to do
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    if (message.error !== undefined) {
      waiter.reject(new Error(JSON.stringify(message.error)));
      return;
    }
    waiter.resolve(message.result);
  }

  private write(message: JsonRpc): void {
    if (this.closed) return;
    try {
      this.socket.write(JSON.stringify(message) + '\n');
    } catch {
      /* the close path fails everything uniformly */
    }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the shared daemon did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }
}

export interface SharedToolResult {
  /** The tool result returned by the daemon (`{ content, structuredContent, isError }`). */
  result: Record<string, unknown>;
  daemonPid: number;
}

export type SharedAtMostOnceResult =
  | { state: 'unavailable' }
  | { state: 'completed'; call: SharedToolResult }
  | { state: 'uncertain'; daemonPid: number };

/**
 * 写操作只尝试一次：发现活动 daemon 后若拿不到确认，调用方不得在本进程重放。
 * 连接失败时无法可靠判断 tools/call 是否已经送达，因此也按 uncertain 处理。
 */
export async function callViaSharedDaemonAtMostOnce(
  projectRoot: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = sharedServiceTimeoutMs(),
): Promise<SharedAtMostOnceResult> {
  const daemon = await findSharedDaemon(projectRoot);
  if (!daemon) return { state: 'unavailable' };
  const result = await callOnce(projectRoot, daemon, toolName, args, timeoutMs);
  return result
    ? { state: 'completed', call: { result, daemonPid: daemon.pid } }
    : { state: 'uncertain', daemonPid: daemon.pid };
}

/**
 * Run one MCP tool call through an already-running daemon; returns null when no daemon is available or
 * the call fails. The caller is responsible for falling back to the in-process implementation.
 *
 * When a daemon is known to exist but the handshake fails, retry once: that kind of failure is almost
 * always transient contention (the daemon just accepted, the machine is busy). If the first failure were
 * taken as "no service", the caller would start an extra language server — exactly the waste this phase
 * set out to eliminate. With **no** daemon there is **no retry**: the pidfile does not even exist, so
 * waiting again would only add latency to every command.
 */
export async function callViaSharedDaemon(
  projectRoot: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = sharedServiceTimeoutMs(),
): Promise<SharedToolResult | null> {
  const daemon = await findSharedDaemon(projectRoot);
  if (!daemon) return null;

  for (let attempt = 0; ; attempt += 1) {
    const call = await callOnce(projectRoot, daemon, toolName, args, timeoutMs);
    if (call) return { result: call, daemonPid: daemon.pid };
    if (attempt >= ATTACH_RETRIES) return null;
    await new Promise((resolve) => setTimeout(resolve, ATTACH_RETRY_DELAY_MS));
  }
}

/** Connect once and make the call; any failure returns null (including protocol errors and timeouts). */
async function callOnce(
  projectRoot: string,
  daemon: SharedDaemonInfo,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const socket = await connectWithHello(daemon.socketPath).catch(() => null);
  // 'version-mismatch' also counts as "unavailable": running the same protocol across versions is far riskier than falling back to this process.
  if (!socket || socket === 'version-mismatch' || socket.destroyed) {
    if (socket && socket !== 'version-mismatch') socket.destroy();
    return null;
  }

  const client = new LineClient(socket);
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codegraph-cli', version: '1' },
      rootUri: pathToFileURL(projectRoot).href,
    }, Math.min(timeoutMs, 30_000));
    client.notify('initialized', {});
    const result = await client.request('tools/call', { name: toolName, arguments: args }, timeoutMs);
    if (!result || typeof result !== 'object') return null;
    return result as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    try {
      socket.destroy();
    } catch {
      /* already gone */
    }
  }
}
