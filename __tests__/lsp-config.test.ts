/**
 * `.codegraph/lsp.json` and environment-variable overrides.
 *
 * The focus is graceful degradation: a bad config must never make a query throw,
 * it may only warn and skip that entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearLspConfigCache, getLspConfigPath, loadLspConfig } from '../src/lsp/config';

let root: string;

function writeConfig(content: unknown): void {
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
  const file = path.join(root, '.codegraph', 'lsp.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  // Advance mtime explicitly so a rewrite within the same second does not hit the cache.
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(file, future, future);
  clearLspConfigCache();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lsp-config-'));
  clearLspConfigCache();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CODEGRAPH_LSP_')) delete process.env[key];
  }
});

afterEach(() => {
  clearLspConfigCache();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CODEGRAPH_LSP_')) delete process.env[key];
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.restoreAllMocks();
});

describe('LSP project config', () => {
  it('支持 Python 配置和环境变量覆盖', () => {
    writeConfig({ servers: { python: { command: 'pylsp' } } });
    expect(loadLspConfig(root).servers.python?.command).toBe('pylsp');
    process.env.CODEGRAPH_LSP_PYTHON_COMMAND = 'pyright-langserver';
    process.env.CODEGRAPH_LSP_PYTHON_ARGS = '["--stdio"]';
    expect(loadLspConfig(root).servers.python).toMatchObject({ command: 'pyright-langserver', args: ['--stdio'] });
  });
  it('with no config file, defaults apply and the path lives under .codegraph', () => {
    expect(getLspConfigPath(root)).toBe(path.join(root, '.codegraph', 'lsp.json'));
    const config = loadLspConfig(root);
    expect(config.servers).toEqual({});
    expect(config.disabled).toEqual([]);
    expect(config.idleTimeoutMs).toBe(300_000);
    expect(config.requestTimeoutMs).toBe(20_000);
    expect(config.warmupTimeoutMs).toBe(15_000);
  });

  it('parses servers, the disabled list, and timeouts', () => {
    writeConfig({
      idleTimeoutMs: 1000,
      requestTimeoutMs: 2000,
      warmupTimeoutMs: 0,
      disabled: ['java'],
      servers: {
        rust: { command: 'rust-analyzer', args: ['--no-config'] },
        cpp: {
          command: '/usr/bin/clangd',
          args: ['--background-index'],
          cwd: 'build',
          env: { FOO: 'bar' },
          initializationOptions: { checkOnSave: false },
        },
      },
    });

    const config = loadLspConfig(root);
    expect(config.idleTimeoutMs).toBe(1000);
    expect(config.requestTimeoutMs).toBe(2000);
    expect(config.warmupTimeoutMs).toBe(0);
    expect(config.disabled).toEqual(['java']);
    expect(config.servers.rust).toMatchObject({ command: 'rust-analyzer', args: ['--no-config'] });
    expect(config.servers.cpp).toMatchObject({
      command: '/usr/bin/clangd',
      args: ['--background-index'],
      cwd: 'build',
      env: { FOO: 'bar' },
      initializationOptions: { checkOnSave: false },
    });
  });

  it('invalid JSON, unknown language families, and bad fields degrade per entry only', () => {
    writeConfig('{ this is not json');
    expect(loadLspConfig(root).servers).toEqual({});

    writeConfig({
      idleTimeoutMs: -5,
      disabled: ['nope', 'rust'],
      servers: {
        nope: { command: 'x' },
        rust: { command: '' },
        go: { command: 'gopls', args: 'not-an-array' },
        typescript: { command: 'typescript-language-server', args: ['--stdio'] },
      },
    });

    const config = loadLspConfig(root);
    expect(config.servers.nope).toBeUndefined();
    expect(config.servers.rust).toBeUndefined();
    // Wrong args type → drop args, but the command itself stays usable
    expect(config.servers.go).toEqual({ command: 'gopls' });
    expect(config.servers.typescript).toEqual({ command: 'typescript-language-server', args: ['--stdio'] });
    expect(config.disabled).toEqual(['rust']);
    expect(config.idleTimeoutMs).toBe(300_000); // negative values are ignored
  });

  it('env vars override commands, args, the disabled list, and timeouts', () => {
    writeConfig({ servers: { rust: { command: 'rust-analyzer' } } });
    process.env.CODEGRAPH_LSP_RUST_COMMAND = '/custom/rust-analyzer';
    process.env.CODEGRAPH_LSP_RUST_ARGS = JSON.stringify(['--a', '--b']);
    process.env.CODEGRAPH_LSP_GO_COMMAND = 'gopls';
    process.env.CODEGRAPH_LSP_DISABLED = 'java, go';
    process.env.CODEGRAPH_LSP_IDLE_TIMEOUT_MS = '1234';
    process.env.CODEGRAPH_LSP_WARMUP_TIMEOUT_MS = '0';
    clearLspConfigCache();

    const config = loadLspConfig(root);
    expect(config.servers.rust).toEqual({ command: '/custom/rust-analyzer', args: ['--a', '--b'] });
    expect(config.servers.go).toEqual({ command: 'gopls' });
    expect(config.disabled.sort()).toEqual(['go', 'java']);
    expect(config.idleTimeoutMs).toBe(1234);
    expect(config.warmupTimeoutMs).toBe(0);
  });

  it('invalid env values are ignored and the file values are kept', () => {
    writeConfig({ servers: { rust: { command: 'rust-analyzer', args: ['--keep'] } } });
    process.env.CODEGRAPH_LSP_RUST_ARGS = 'not json';
    process.env.CODEGRAPH_LSP_REQUEST_TIMEOUT_MS = 'abc';
    clearLspConfigCache();

    const config = loadLspConfig(root);
    expect(config.servers.rust).toEqual({ command: 'rust-analyzer', args: ['--keep'] });
    expect(config.requestTimeoutMs).toBe(20_000);
  });

  it('config changes invalidate by mtime and deleting the file restores defaults', () => {
    writeConfig({ idleTimeoutMs: 500 });
    expect(loadLspConfig(root).idleTimeoutMs).toBe(500);

    writeConfig({ idleTimeoutMs: 900 });
    expect(loadLspConfig(root).idleTimeoutMs).toBe(900);

    fs.rmSync(path.join(root, '.codegraph', 'lsp.json'));
    expect(loadLspConfig(root).idleTimeoutMs).toBe(300_000);
  });

  it('空闲退出默认值来自资源档位，显式环境变量与文件值优先', () => {
    const backup = process.env.CODEGRAPH_RESOURCE_PROFILE;
    try {
      process.env.CODEGRAPH_RESOURCE_PROFILE = 'battery';
      expect(loadLspConfig(root).idleTimeoutMs).toBe(90_000);

      process.env.CODEGRAPH_RESOURCE_PROFILE = 'performance';
      expect(loadLspConfig(root).idleTimeoutMs).toBe(600_000);

      // 显式环境变量覆盖档位默认值
      process.env.CODEGRAPH_LSP_IDLE_TIMEOUT_MS = '1234';
      expect(loadLspConfig(root).idleTimeoutMs).toBe(1234);

      // 文件里显式的 idleTimeoutMs 覆盖档位默认值
      delete process.env.CODEGRAPH_LSP_IDLE_TIMEOUT_MS;
      writeConfig({ idleTimeoutMs: 777 });
      expect(loadLspConfig(root).idleTimeoutMs).toBe(777);
    } finally {
      if (backup === undefined) delete process.env.CODEGRAPH_RESOURCE_PROFILE;
      else process.env.CODEGRAPH_RESOURCE_PROFILE = backup;
    }
  });
});
