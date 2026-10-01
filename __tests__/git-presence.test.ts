import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'child_process';
import CodeGraph from '../src/index';
import { getGitHeadSha } from '../src/extraction';
import { mayHaveGitRepository } from '../src/extraction/git-presence';

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

let root = '';
let cg: CodeGraph | undefined;
const createRoot = () => root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-presence-'));
const git = (...args: string[]) => execFileSync('git', args, {
  cwd: root, encoding: 'utf8', windowsHide: true, stdio: 'pipe', timeout: 5000,
});

afterEach(() => {
  vi.unstubAllEnvs();
  cg?.close();
  cg = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('Git repository discovery before subprocess work', () => {
  it('indexes and syncs a non-Git project without spawning revision, status or listing probes', async () => {
    createRoot();
    fs.writeFileSync(path.join(root, 'main.ts'), 'export function hello() { return 1; }\n');
    vi.mocked(execFileSync).mockClear();
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    await cg.sync();
    expect(cg.getNodesByName('hello')).toHaveLength(1);
    const probes = vi.mocked(execFileSync).mock.calls.filter(([file, args]) =>
      file === 'git' && Array.isArray(args) && ['rev-parse', 'status', 'ls-files'].includes(args[0]));
    expect(probes).toEqual([]);
  });

  it('detects git init after a previous non-Git query and finds repositories above the project', () => {
    createRoot();
    expect(getGitHeadSha(root)).toBeNull();
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    git('commit', '--allow-empty', '-qm', 'initial');
    const child = path.join(root, 'src', 'nested');
    fs.mkdirSync(child, { recursive: true });
    expect(getGitHeadSha(child)).toBe(git('rev-parse', 'HEAD').trim());
  });

  it('retains worktree pointers, bare repositories and environment-selected repositories', () => {
    createRoot();
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: ../external-git-directory\n');
    expect(mayHaveGitRepository(root)).toBe(true);
    fs.unlinkSync(path.join(root, '.git'));
    git('init', '--bare', '-q');
    expect(mayHaveGitRepository(root)).toBe(true);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-env-'));
    try {
      vi.stubEnv('GIT_DIR', root);
      expect(mayHaveGitRepository(outside)).toBe(true);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
});
