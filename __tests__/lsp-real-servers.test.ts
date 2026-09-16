/**
 * Real language servers end to end (skipped by default).
 *
 * Why skipped by default: CI and ordinary dev machines may not have clangd/gopls/jdt.ls
 * installed, and one jdt.ls import takes tens of seconds. Run explicitly after installing servers:
 *
 *   CODEGRAPH_LSP_E2E=1 npx vitest run __tests__/lsp-real-servers.test.ts
 *
 * A missing server skips that language (and the test name says so); "not installed" is never
 * reported as "passed". Server paths can be overridden with CODEGRAPH_LSP_E2E_<FAMILY>_COMMAND.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { resolveExecutable } from '../src/lsp/servers';

const RUN = process.env.CODEGRAPH_LSP_E2E === '1';
const FIXTURES = path.resolve(__dirname, 'fixtures');
const TOOLS = path.resolve(__dirname, '..', '.codegraph', 'lsp-tools');

interface Recipe {
  language: string;
  fixture: string;
  file: string;
  symbol: string;
  brokenFile: string | null;
  /** 需要验证跨文件重命名的语言，给出调用方文件。 */
  renameFile?: string;
  /** Server command and args for this language; null means no usable server on this machine. */
  server(): { command: string; args: string[]; env?: Record<string, string> } | null;
  /** Files that must be written after copying the fixture (clangd's compile_commands.json). */
  prepare?(root: string): void;
  timeoutMs?: number;
}

function firstExecutable(candidates: string[]): string | null {
  for (const candidate of candidates) {
    const found = resolveExecutable(candidate);
    if (found.path) return found.path;
  }
  return null;
}

function workspaceTool(relative: string): string | null {
  const candidate = path.join(TOOLS, relative);
  return fs.existsSync(candidate) ? candidate : null;
}

function jdtlsLauncher(): string | null {
  const plugins = path.join(TOOLS, 'jdtls', 'plugins');
  if (!fs.existsSync(plugins)) return null;
  const jar = fs.readdirSync(plugins).find((name) => name.startsWith('org.eclipse.equinox.launcher_') && name.endsWith('.jar'));
  return jar ? path.join(plugins, jar) : null;
}

function javaExecutable(): string | null {
  const explicit = process.env.CODEGRAPH_LSP_E2E_JAVA_COMMAND;
  if (explicit) return resolveExecutable(explicit).path;
  // jdt.ls 1.62 needs JDK 21+; JAVA_HOME may point at an older JDK (17 on this machine),
  // which makes the JVM exit immediately, so try the known-good 21 first.
  const candidates = [
    'D:/JAVA/JAVA21/bin/java.exe',
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : '',
    'java',
  ].filter(Boolean);
  return firstExecutable(candidates);
}

function compileDb(root: string): void {
  const entries = fs.readdirSync(root)
    .filter((entry) => /\.(c|cpp)$/.test(entry))
    .map((entry) => {
      const isCpp = entry.endsWith('.cpp');
      return {
        directory: root.replace(/\\/g, '/'),
        command: `${isCpp ? 'clang++' : 'clang'} ${isCpp ? '-std=c++17' : '-std=c11'} -c ${entry}`,
        file: entry,
      };
    });
  fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify(entries, null, 2));
}

const RECIPES: Recipe[] = [
  {
    language: 'python',
    fixture: 'lsp-python',
    file: 'helpers.py',
    symbol: 'target_value',
    brokenFile: 'broken.py',
    renameFile: 'main.py',
    server: () => {
      const command = process.env.CODEGRAPH_LSP_E2E_PYTHON_COMMAND
        ?? firstExecutable(['pyright-langserver'])
        ?? workspaceTool('python/node_modules/.bin/pyright-langserver' + (process.platform === 'win32' ? '.cmd' : ''));
      return command ? { command, args: ['--stdio'] } : null;
    },
  },
  {
    language: 'rust',
    fixture: 'lsp-rust',
    file: 'src/lib.rs',
    symbol: 'target_value',
    brokenFile: 'src/lib.rs',
    server: () => {
      const command = process.env.CODEGRAPH_LSP_E2E_RUST_COMMAND ?? firstExecutable(['rust-analyzer']);
      return command ? { command, args: [] } : null;
    },
    timeoutMs: 300_000,
  },
  {
    language: 'typescript',
    fixture: 'lsp-typescript',
    file: 'a.ts',
    symbol: 'targetFn',
    brokenFile: 'broken.ts',
    server: () => {
      const command = process.env.CODEGRAPH_LSP_E2E_TYPESCRIPT_COMMAND
        ?? firstExecutable(['typescript-language-server', 'vtsls']);
      if (!command) return null;
      return { command, args: [command.includes('vtsls') ? '--stdio' : '--stdio'] };
    },
    timeoutMs: 300_000,
  },
  {
    language: 'javascript',
    fixture: 'lsp-typescript',
    file: 'legacy.js',
    symbol: 'jsTarget',
    brokenFile: null,
    server: () => {
      const command = process.env.CODEGRAPH_LSP_E2E_TYPESCRIPT_COMMAND
        ?? firstExecutable(['typescript-language-server', 'vtsls']);
      return command ? { command, args: ['--stdio'] } : null;
    },
    timeoutMs: 300_000,
  },
  {
    language: 'c',
    fixture: 'lsp-c',
    file: 'main.c',
    symbol: 'util_add',
    brokenFile: 'broken.c',
    prepare: compileDb,
    server: () => {
      const command = process.env.CODEGRAPH_LSP_E2E_CPP_COMMAND
        ?? firstExecutable(['clangd', workspaceTool('clangd/clangd_22.1.6/bin/clangd.exe') ?? ''])
        ?? workspaceTool('clangd/clangd_22.1.6/bin/clangd.exe');
      return command ? { command, args: ['--background-index'] } : null;
    },
    timeoutMs: 300_000,
  },
  {
    language: 'cpp',
    fixture: 'lsp-cpp',
    file: 'main.cpp',
    symbol: 'util_add',
    brokenFile: 'broken.cpp',
    prepare: compileDb,
    server: () => {
      const command = process.env.CODEGRAPH_LSP_E2E_CPP_COMMAND
        ?? firstExecutable(['clangd', workspaceTool('clangd/clangd_22.1.6/bin/clangd.exe') ?? ''])
        ?? workspaceTool('clangd/clangd_22.1.6/bin/clangd.exe');
      return command ? { command, args: ['--background-index'] } : null;
    },
    timeoutMs: 300_000,
  },
  {
    language: 'go',
    fixture: 'lsp-go',
    file: 'main.go',
    symbol: 'Add',
    brokenFile: 'broken.go',
    server: () => {
      const command = process.env.CODEGRAPH_LSP_E2E_GO_COMMAND
        ?? firstExecutable(['gopls', workspaceTool('go/bin/gopls.exe') ?? ''])
        ?? workspaceTool('go/bin/gopls.exe');
      return command ? { command, args: ['serve'] } : null;
    },
    timeoutMs: 300_000,
  },
  {
    language: 'java',
    fixture: 'lsp-java',
    file: 'App.java',
    symbol: 'add',
    brokenFile: 'Broken.java',
    server: () => {
      const explicit = process.env.CODEGRAPH_LSP_E2E_JAVA_COMMAND;
      const launcher = jdtlsLauncher();
      const configWin = path.join(TOOLS, 'jdtls', process.platform === 'win32' ? 'config_win' : 'config_linux');
      if (explicit) return { command: explicit, args: [] };
      if (!launcher || !fs.existsSync(configWin)) return null;
      const java = javaExecutable();
      if (!java) return null;
      return {
        command: java,
        args: [
          '-Declipse.application=org.eclipse.jdt.ls.core.id1',
          '-Dosgi.bundles.defaultStartLevel=4',
          '-Declipse.product=org.eclipse.jdt.ls.core.product',
          '-Dfile.encoding=UTF-8',
          '-Xmx1G',
          '-jar', launcher,
          '-configuration', configWin,
        ],
        env: process.env.JAVA_HOME ? { JAVA_HOME: process.env.JAVA_HOME } : undefined,
      };
    },
    timeoutMs: 300_000,
  },
];

/** Each test creates and removes its own temp project and leaves no directory behind on failure. */
const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch {
      /* On Windows, cargo/jdt.ls child processes may still hold handles */
    }
  }
});

describe.skipIf(!RUN)('real language servers end to end', () => {
  for (const recipe of RECIPES) {
    it(`${recipe.language}: definitions / references / symbols / diagnostics`, async (context) => {
      const server = recipe.server();
      if (!server) {
        console.warn(`[lsp-e2e] skipping ${recipe.language}: no language server found on this machine`);
        context.skip();
        return;
      }

      const root = fs.mkdtempSync(path.join(os.tmpdir(), `cg-lsp-e2e-${recipe.language}-`));
      roots.push(root);
      fs.cpSync(path.join(FIXTURES, recipe.fixture), root, { recursive: true });
      recipe.prepare?.(root);

      const cg = CodeGraph.initSync(root);
      await cg.indexAll();
      fs.writeFileSync(path.join(root, '.codegraph', 'lsp.json'), JSON.stringify({
        idleTimeoutMs: 0,
        servers: { [recipe.language === 'javascript' ? 'typescript' : recipe.language === 'c' || recipe.language === 'cpp' ? 'cpp' : recipe.language]: server },
      }, null, 2));

      try {
        const request = { backend: 'lsp' as const };
        const definitions = await cg.queryCodeWithBackend({ ...request, mode: 'definitions', query: recipe.symbol });
        expect(definitions.status, JSON.stringify(definitions.warnings)).toBe('ok');
        expect((definitions.items[0] as { name?: string }).name).toBeTruthy();

        const references = await cg.queryCodeWithBackend({ ...request, mode: 'references', query: recipe.symbol });
        expect(references.status, JSON.stringify(references.warnings)).toBe('ok');
        expect(references.page.total).toBeGreaterThan(0);

        const symbols = await cg.queryCodeWithBackend({ ...request, mode: 'symbols', query: recipe.file, file: recipe.file });
        expect(symbols.status, JSON.stringify(symbols.warnings)).toBe('ok');
        expect(symbols.items.length).toBeGreaterThan(0);

        if (recipe.brokenFile) {
          const diagnostics = await cg.queryCodeWithBackend({
            ...request, mode: 'diagnostics', query: recipe.brokenFile, file: recipe.brokenFile,
          });
          expect(diagnostics.status, JSON.stringify(diagnostics.warnings)).toBe('ok');
          const severities = (diagnostics.items as Array<{ severity: string }>).map((item) => item.severity);
          expect(severities).toContain('error');
        }
        if (recipe.renameFile) {
          const preview = await cg.editCode({ operation: 'rename', symbol: recipe.symbol, file: recipe.file, newName: 'renamed_value' });
          expect(preview.status, JSON.stringify(preview.warnings)).toBe('preview');
          expect(preview.files.map((file) => file.filePath)).toContain(recipe.renameFile);
          const applied = await cg.editCode({ operation: 'rename', symbol: recipe.symbol, file: recipe.file,
            newName: 'renamed_value', apply: true, expectPreviewHash: preview.previewHash! });
          expect(applied.status, JSON.stringify(applied.warnings)).toBe('applied');
          expect(fs.readFileSync(path.join(root, recipe.renameFile), 'utf8')).toContain('renamed_value(2)');
          const query = await cg.queryCodeWithBackend({ backend: 'auto', mode: 'definitions', query: 'renamed_value', file: recipe.file });
          expect(query.status, JSON.stringify(query.warnings)).toBe('ok');
          expect(query.routing.resolved).toBe('lsp');
        }
      } finally {
        await cg.getLspManager().close().catch(() => undefined);
        cg.close();
      }
    }, recipe.timeoutMs ?? 120_000);
  }
});
