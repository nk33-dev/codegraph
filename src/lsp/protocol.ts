/**
 * LSP over stdio — frame parsing and JSON-RPC correlation.
 *
 * Language servers frame messages as `Content-Length: <bytes>\r\n\r\n<json>`, and Node streams
 * hand over arbitrarily split chunks: one chunk may hold several messages, one message may span
 * several chunks, and UTF-8 multi-byte characters get split too. So accumulation and splitting
 * happen purely at the Buffer level, and a complete body is decoded as UTF-8 only afterwards —
 * never counting by string length.
 *
 * It must also answer server-initiated requests (registerCapability, configuration,
 * workDoneProgress/create, etc.): staying silent leaves many servers waiting forever
 * (rust-analyzer, clangd and jdt.ls all send them), which shows up as "queries always time out".
 */
import type { ChildProcess } from 'child_process';

/** Accumulated headers beyond this length mean the peer is not LSP or the frame is corrupt: fail instead of eating memory forever. */
const MAX_HEADER_BYTES = 64 * 1024;
/** Per-frame body cap, guarding against a corrupt Content-Length. */
const MAX_BODY_BYTES = 128 * 1024 * 1024;
const HEADER_SEPARATOR = Buffer.from('\r\n\r\n', 'ascii');

/** Failure class: callers use it to decide whether to retry, restart, or mark the server unavailable. */
export type LspFailureKind = 'timeout' | 'protocol' | 'exit' | 'write' | 'unsupported';

export class LspError extends Error {
  constructor(
    message: string,
    readonly kind: LspFailureKind,
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = 'LspError';
  }
}

export interface LspConnectionHandlers {
  /** Server notifications (textDocument/publishDiagnostics, $/progress, window/logMessage…). */
  onNotification: (method: string, params: unknown) => void;
  /** Server-initiated request; the return value is sent back to the server as the result. */
  onRequest: (method: string, params: unknown) => unknown;
  /** stderr and server log messages, feeding the diagnostic ring buffer. */
  onLog: (line: string) => void;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

/** Parse a `Content-Length` header (case-insensitive); null when missing or invalid. */
export function parseContentLength(header: string): number | null {
  for (const line of header.split('\r\n')) {
    const match = /^content-length\s*:\s*(\d+)\s*$/i.exec(line.trim());
    if (match) {
      const value = Number(match[1]);
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
  }
  return null;
}

export class LspConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;
  private closeReason: string | null = null;
  private readonly onData: (chunk: Buffer) => void;

  constructor(
    readonly child: ChildProcess,
    private readonly handlers: LspConnectionHandlers,
  ) {
    const stdout = child.stdout;
    if (!stdout) throw new LspError('language server stdout is not piped', 'protocol');
    this.onData = (chunk: Buffer) => this.ingest(chunk);
    stdout.on('data', this.onData);
    stdout.on('error', (err) => this.handlers.onLog(`stdout error: ${err.message}`));
    // EPIPE 通常在 write 返回后异步触发，try/catch 捕获不到；关闭连接并拒绝待处理请求。
    // dispose 后仍保留监听，吸收进程退出期间迟到的管道错误。
    child.stdin?.on('error', (err) => this.finish(`language server stdin error: ${err.message}`, 'write'));
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      for (const line of text.split('\n')) if (line.trim()) this.handlers.onLog(line.trimEnd());
    });
    child.on('error', (err) => this.finish(`language server process error: ${err.message}`));
    child.on('exit', (code, signal) => {
      this.finish(`language server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Why the connection ended (process exit / explicit close); null while it is still open. */
  get closedReason(): string | null {
    return this.closeReason;
  }

  /**
   * Send a request and await the response. On timeout only this call is rejected, without killing
   * the process: ids increase monotonically and are never reused, so late responses are safely
   * discarded.
   */
  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(new LspError(this.closeReason ?? 'language server connection is closed', 'exit'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new LspError(`LSP request ${method} timed out after ${timeoutMs}ms`, 'timeout'));
          }, timeoutMs)
        : null;
      timer?.unref?.();
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.settle(id, err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Send a notification (no response expected); silently dropped on a closed connection so callers need not handle the race. */
  notify(method: string, params: unknown): void {
    if (this.closed) return;
    try {
      this.write({ jsonrpc: '2.0', method, params });
    } catch (err) {
      this.handlers.onLog(`failed to send ${method}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Close stdin so the server reads EOF and exits on its own (what most LSP implementations do). */
  endInput(): void {
    try { this.child.stdin?.end(); } catch { /* already closed */ }
  }

  /** Drop the connection state without touching the process (the manager owns kill/reap). */
  dispose(): void {
    this.child.stdout?.off('data', this.onData);
    this.finish('language server connection closed');
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed) throw new LspError(this.closeReason ?? 'connection closed', 'exit');
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) throw new LspError('language server stdin is not writable', 'write');
    const payload = Buffer.from(JSON.stringify(message), 'utf-8');
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii');
    stdin.write(Buffer.concat([header, payload]));
  }

  private settle(id: number, error: Error | null, value?: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve(value);
  }

  private finish(reason: string, kind: LspFailureKind = reason.includes('exited') ? 'exit' : 'protocol'): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const id of [...this.pending.keys()]) {
      this.settle(id, new LspError(reason, kind));
    }
    this.buffer = Buffer.alloc(0);
  }

  private ingest(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (!this.closed && this.readFrame()) { /* keep consuming further frames in the buffer */ }
  }

  /** Try to take and process one frame from the buffer; returns false when the frame is incomplete. */
  private readFrame(): boolean {
    const separator = this.buffer.indexOf(HEADER_SEPARATOR);
    if (separator < 0) {
      if (this.buffer.length > MAX_HEADER_BYTES) this.finish('language server sent an invalid frame header');
      return false;
    }
    const header = this.buffer.subarray(0, separator).toString('ascii');
    const length = parseContentLength(header);
    if (length === null) {
      // Cannot locate the body length: drop this header block so later valid frames are not stuck behind it.
      this.handlers.onLog('ignoring LSP frame without a valid Content-Length header');
      this.buffer = this.buffer.subarray(separator + HEADER_SEPARATOR.length);
      return true;
    }
    if (length > MAX_BODY_BYTES) {
      this.finish(`language server announced an oversized frame (${length} bytes)`);
      return false;
    }
    const bodyStart = separator + HEADER_SEPARATOR.length;
    if (this.buffer.length < bodyStart + length) return false;
    const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf-8');
    this.buffer = this.buffer.subarray(bodyStart + length);
    this.dispatch(body);
    return true;
  }

  private dispatch(body: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      message = parsed as Record<string, unknown>;
    } catch (err) {
      this.handlers.onLog(`ignoring malformed LSP message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const id = message.id;
    const method = message.method;
    if (typeof method === 'string' && id !== undefined && id !== null) {
      this.handleServerRequest(id, method, message.params);
      return;
    }
    if (id !== undefined && id !== null && ('result' in message || 'error' in message)) {
      this.handleResponse(id, message);
      return;
    }
    if (typeof method === 'string') {
      try {
        this.handlers.onNotification(method, message.params);
      } catch (err) {
        this.handlers.onLog(`notification ${method} handler failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    this.handlers.onLog('ignoring LSP message with neither method nor id');
  }

  private handleResponse(id: unknown, message: Record<string, unknown>): void {
    if (typeof id !== 'number') return;
    const error = message.error as { code?: unknown; message?: unknown; data?: unknown } | undefined;
    if (error && typeof error === 'object') {
      const code = typeof error.code === 'number' ? error.code : null;
      const detail = typeof error.message === 'string' ? error.message : JSON.stringify(error);
      const data = error.data === undefined ? '' : ` ${JSON.stringify(error.data)}`;
      this.settle(id, new LspError(`LSP error ${code ?? '?'}: ${detail}${data}`, 'protocol', code));
      return;
    }
    this.settle(id, null, message.result ?? null);
  }

  private handleServerRequest(id: unknown, method: string, params: unknown): void {
    let result: unknown;
    try {
      result = this.handlers.onRequest(method, params);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.handlers.onLog(`server request ${method} failed: ${text}`);
      this.sendSafely({ jsonrpc: '2.0', id, error: { code: -32603, message: text } });
      return;
    }
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      void (result as Promise<unknown>).then(
        (value) => this.sendSafely({ jsonrpc: '2.0', id, result: value ?? null }),
        (err: unknown) => this.sendSafely({
          jsonrpc: '2.0', id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        }),
      );
      return;
    }
    this.sendSafely({ jsonrpc: '2.0', id, result: result ?? null });
  }

  private sendSafely(message: Record<string, unknown>): void {
    try {
      this.write(message);
    } catch (err) {
      this.handlers.onLog(`failed to answer server request: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
