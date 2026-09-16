/**
 * LSP pure functions: position-encoding conversion, symbol-kind mapping, URI normalization,
 * executable discovery, and spawn plans.
 *
 * These underpin result correctness: a wrong byte-to-UTF-16 column conversion makes LSP
 * requests land off target, and picking the wrong executable on Windows (an extension-less
 * npm shim or a .ps1) fails the launch outright.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { byteColumnToUtf16Column, lspSymbolKindToNodeKind } from '../src/lsp/code-query-lsp';
import {
  LANGUAGES_BY_FAMILY,
  LSP_FAMILIES,
  buildSpawnPlan,
  familyForLanguage,
  languageIdFor,
  resolveExecutable,
} from '../src/lsp/servers';
import { normalizeDriveLetter, pathToUri, uriKey, uriToNormalizedPath, uriToPath } from '../src/lsp/uri';

describe('byte columns → UTF-16 columns', () => {
  it('identity for ASCII; multi-byte characters and surrogate pairs count UTF-16 code units', () => {
    expect(byteColumnToUtf16Column('function foo', 9)).toBe(9);
    expect(byteColumnToUtf16Column('const café = 1', 0)).toBe(0);
    // 'café': c/a/f are 1 byte each, é takes 2 bytes / 1 code unit; byte 4 lands inside é, so it counts as after that character
    expect(byteColumnToUtf16Column('café', 3)).toBe(3);
    expect(byteColumnToUtf16Column('café', 4)).toBe(4);
    expect(byteColumnToUtf16Column('café', 5)).toBe(4);
    // each CJK character takes 3 bytes / 1 code unit
    expect(byteColumnToUtf16Column('中文x', 6)).toBe(2);
    // 😀 takes 4 bytes / 2 code units
    expect(byteColumnToUtf16Column('😀x', 4)).toBe(2);
  });

  it('out-of-range columns clamp to line end and negatives are treated as 0', () => {
    expect(byteColumnToUtf16Column('abc', 99)).toBe(3);
    expect(byteColumnToUtf16Column('abc', -1)).toBe(0);
    // a position inside a multi-byte character counts as the whole character
    expect(byteColumnToUtf16Column('中文', 1)).toBe(1);
  });
});

describe('LSP SymbolKind → NodeKind', () => {
  it('common kinds map and unknown kinds are not forced', () => {
    expect(lspSymbolKindToNodeKind(5)).toBe('class');
    expect(lspSymbolKindToNodeKind(6)).toBe('method');
    expect(lspSymbolKindToNodeKind(9)).toBe('method');
    expect(lspSymbolKindToNodeKind(11)).toBe('interface');
    expect(lspSymbolKindToNodeKind(12)).toBe('function');
    expect(lspSymbolKindToNodeKind(14)).toBe('constant');
    expect(lspSymbolKindToNodeKind(23)).toBe('struct');
    expect(lspSymbolKindToNodeKind(26)).toBe('type_alias');
    expect(lspSymbolKindToNodeKind(1)).toBeNull();   // File is not a symbol
    expect(lspSymbolKindToNodeKind(19)).toBeNull();  // Null
    expect(lspSymbolKindToNodeKind(999)).toBeNull();
  });
});

describe('language families and languageId', () => {
  it('支持的语言映射到服务族，tsx/jsx 复用 typescript', () => {
    expect(LSP_FAMILIES).toEqual(['cpp', 'typescript', 'rust', 'go', 'java', 'python']);
    expect(LANGUAGES_BY_FAMILY.typescript).toEqual(['typescript', 'tsx', 'javascript', 'jsx']);
    expect(familyForLanguage('c')).toBe('cpp');
    expect(familyForLanguage('cpp')).toBe('cpp');
    expect(familyForLanguage('typescript')).toBe('typescript');
    expect(familyForLanguage('javascript')).toBe('typescript');
    expect(familyForLanguage('tsx')).toBe('typescript');
    expect(familyForLanguage('rust')).toBe('rust');
    expect(familyForLanguage('go')).toBe('go');
    expect(familyForLanguage('java')).toBe('java');
    expect(familyForLanguage('python')).toBe('python');
    expect(familyForLanguage('ruby')).toBeNull();
    expect(familyForLanguage(null)).toBeNull();

    expect(languageIdFor('tsx')).toBe('typescriptreact');
    expect(languageIdFor('jsx')).toBe('javascriptreact');
    expect(languageIdFor('c')).toBe('c');
    expect(languageIdFor('python')).toBe('python');
  });
});

describe('URI normalization', () => {
  it('paths round-trip through URIs and drive letters are uppercased', () => {
    const filePath = path.resolve('sub dir/a.ts');
    const uri = pathToUri(filePath);
    expect(uri.startsWith('file:///')).toBe(true);
    expect(uri).toContain('sub%20dir');
    expect(uriToPath(uri)).toBe(filePath);
    expect(uriToNormalizedPath(uri)).toBe(normalizeDriveLetter(path.normalize(filePath)));
  });

  it('tsserver %3A encoding and the pathToFileURL form normalize to the same key', () => {
    expect(uriKey('file:///C:/Users/x/a.ts')).toBe(uriKey('file:///c%3A/Users/x/a.ts'));
    expect(uriKey('file:///C:/Users/x/a.ts')).toBe(uriKey('file:///C:\\Users\\x\\a.ts'));
  });

  it('non-file protocols and malformed URIs do not throw', () => {
    expect(uriToPath('jdt://contents/foo')).toBeNull();
    expect(uriToNormalizedPath('untitled:Untitled-1')).toBeNull();
    expect(uriKey('file:///broken/%E0%A4%A')).toBe('file:///broken/%e0%a4%a');
  });
});

describe('executable discovery and spawn plans', () => {
  it('an existing absolute path is returned and a missing one reports why', () => {
    const found = resolveExecutable(process.execPath);
    expect(found.path).toBe(process.execPath);
    expect(found.reason).toBeNull();

    const missing = resolveExecutable(path.join(__dirname, 'definitely-not-here.exe'));
    expect(missing.path).toBeNull();
    expect(missing.reason).toContain('does not exist');
  });

  it('bare commands are searched on PATH and a miss is reported as a PATH problem', () => {
    expect(resolveExecutable('codegraph-definitely-not-on-path').reason).toContain('PATH');
  });

  it('Windows .cmd shims go through the shell while native executables keep an args array', () => {
    const plan = buildSpawnPlan('C:\\tools\\server.cmd', ['--stdio']);
    if (process.platform === 'win32') {
      expect(plan.shell).toBe(true);
      expect(plan.args).toEqual([]);
      expect(plan.command).toBe('C:\\tools\\server.cmd --stdio');
    } else {
      expect(plan.shell).toBe(false);
      expect(plan.args).toEqual(['--stdio']);
    }

    // Paths with spaces must be quoted or cmd truncates the path
    const spaced = buildSpawnPlan('C:\\Program Files\\server.cmd', ['--x']);
    if (process.platform === 'win32') {
      expect(spaced.command).toBe('"C:\\Program Files\\server.cmd" --x');
    }

    const native = buildSpawnPlan('/usr/bin/rust-analyzer', []);
    expect(native).toEqual({ command: '/usr/bin/rust-analyzer', args: [], shell: false });
  });
});
