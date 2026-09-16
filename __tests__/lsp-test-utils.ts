/**
 * Fixture helpers shared by the LSP tests.
 *
 * Not a test file (the name does not match `*.test.ts`); imported by lsp-*.test.ts to create a
 * temp project, point `.codegraph/lsp.json` at the fake language server, and read the fake
 * server's event log.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearLspConfigCache } from '../src/lsp/config';

/** Path to the fake language server script. */
export const FAKE_SERVER = path.resolve(__dirname, 'fixtures/fake-lsp-server.js');

export interface FakeProjectOptions {
  /** Extra flags passed to the fake server (--pull-diagnostics and friends). */
  serverArgs?: string[];
  /** Overrides for the typescript family entry in lsp.json. */
  server?: Record<string, unknown>;
  /** Top-level config overrides (idleTimeoutMs / requestTimeoutMs / disabled ...). */
  config?: Record<string, unknown>;
}

export interface FakeProject {
  root: string;
  logPath: string;
  /** Rewrite `.codegraph/lsp.json` (used to trigger the restart-on-config-change path). */
  writeConfig(options?: FakeProjectOptions): void;
  /** Command and args for invoking the fake server directly with node. */
  serverCommand(): { command: string; args: string[] };
  readLog(): Array<Record<string, any>>;
  events(method: string): Array<Record<string, any>>;
  waitForLog(predicate: (entries: Array<Record<string, any>>) => boolean, timeoutMs?: number): Promise<Array<Record<string, any>>>;
  logPathFor(): string;
  cleanup(): void;
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

/**
 * Create a temp project: files plus `.codegraph/lsp.json` (with the typescript family pointing
 * at the fake server). Tests must call `cleanup()` when done.
 */
export function createFakeProject(files: Record<string, string> = {}, options: FakeProjectOptions = {}): FakeProject {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lsp-fake-'));
  const logPath = path.join(root, 'fake-lsp.log');
  writeFiles(root, files);

  const api: FakeProject = {
    root,
    logPath,
    serverCommand() {
      const args = [FAKE_SERVER, '--log', logPath, ...(options.serverArgs ?? [])];
      return { command: process.execPath, args };
    },
    writeConfig(overrides = {}) {
      const merged: FakeProjectOptions = {
        serverArgs: overrides.serverArgs ?? options.serverArgs,
        server: overrides.server ?? options.server,
        config: overrides.config ?? options.config,
      };
      const command = process.execPath;
      const args = [FAKE_SERVER, '--log', logPath, ...(merged.serverArgs ?? [])];
      const config = {
        idleTimeoutMs: 0,
        warmupTimeoutMs: 2000,
        ...(merged.config ?? {}),
        servers: {
          typescript: { command, args, ...(merged.server ?? {}) },
          ...((merged.config as { servers?: object } | undefined)?.servers ?? {}),
        },
      };
      fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
      fs.writeFileSync(path.join(root, '.codegraph', 'lsp.json'), JSON.stringify(config, null, 2));
      clearLspConfigCache();
    },
    readLog() {
      try {
        return fs.readFileSync(logPath, 'utf-8')
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    events(method: string) {
      return api.readLog().filter((entry) => entry.event === 'request' && entry.method === method);
    },
    async waitForLog(predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const entries = api.readLog();
        if (predicate(entries)) return entries;
        if (Date.now() > deadline) return entries;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    logPathFor() {
      return logPath;
    },
    cleanup() {
      clearLspConfigCache();
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* On Windows handles are occasionally not released; leave the temp directory to the OS */
      }
    },
  };

  api.writeConfig();
  return api;
}

/** Poll until the predicate holds (the fake server responds asynchronously). */
export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}
