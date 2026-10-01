import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'child_process';
import { buildDefaultIgnore } from '../src/extraction';
import { gitExcludeFile, withGitConfigSnapshot } from '../src/extraction/git-config';

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

let root: string;
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  vi.mocked(execFileSync).mockReset().mockImplementation(actual.execFileSync);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-config-'));
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'global-config'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('Git config snapshots', () => {
  it('reuses an unset key within a task and reads it again in the next task', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw { status: 1 }; });
    for (let task = 0; task < 2; task++) {
      withGitConfigSnapshot(() => {
        expect(gitExcludeFile(root)).toBeNull();
        expect(gitExcludeFile(root)).toBeNull();
      });
    }
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it.each([null, 128])('retries command failures with status %s within the same task', status => {
    const failure = Object.assign(new Error('Git config failed'), { status });
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw failure; }).mockReturnValue('ignore-file\n');
    withGitConfigSnapshot(() => {
      expect(() => gitExcludeFile(root)).toThrow(failure);
      expect(gitExcludeFile(root)).toBe('ignore-file');
      expect(gitExcludeFile(root)).toBe('ignore-file');
    });
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('isolates overlapping async tasks even for the same root', async () => {
    vi.mocked(execFileSync).mockReturnValueOnce('first\n').mockReturnValueOnce('second\n');
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const first = withGitConfigSnapshot(async () => {
      expect(gitExcludeFile(root)).toBe('first');
      await barrier;
      expect(gitExcludeFile(root)).toBe('first');
    });
    await withGitConfigSnapshot(async () => {
      expect(gitExcludeFile(root)).toBe('second');
      await Promise.resolve();
      expect(gitExcludeFile(root)).toBe('second');
    });
    release();
    await first;
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('separates project roots and observes environment changes', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('first\n').mockReturnValueOnce('other\n').mockReturnValueOnce('changed\n');
    withGitConfigSnapshot(() => {
      expect(gitExcludeFile(root)).toBe('first');
      expect(gitExcludeFile(path.join(root, 'other'))).toBe('other');
      vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'different-config'));
      expect(gitExcludeFile(root)).toBe('changed');
    });
    expect(execFileSync).toHaveBeenCalledTimes(3);
  });

  it('reads uncached config outside indexing tasks', () => {
    vi.mocked(execFileSync).mockReturnValueOnce('first\n').mockReturnValueOnce('changed\n');
    expect(gitExcludeFile(root)).toBe('first');
    expect(gitExcludeFile(root)).toBe('changed');
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('rereads ignore contents during a task and config paths in the next task', () => {
    const first = path.join(root, 'first-ignore');
    const second = path.join(root, 'second-ignore');
    const configure = (file: string) => execFileSync('git', ['config', '--global', 'core.excludesFile', file], {
      encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 5000,
    });
    fs.writeFileSync(first, 'old.ts\n');
    fs.writeFileSync(second, 'next.ts\n');
    configure(first);
    withGitConfigSnapshot(() => {
      expect(buildDefaultIgnore(root).ignores('old.ts')).toBe(true);
      fs.writeFileSync(first, 'new.ts\n');
      const updated = buildDefaultIgnore(root);
      expect(updated.ignores('old.ts')).toBe(false);
      expect(updated.ignores('new.ts')).toBe(true);
    });
    configure(second);
    withGitConfigSnapshot(() => {
      const updated = buildDefaultIgnore(root);
      expect(updated.ignores('new.ts')).toBe(false);
      expect(updated.ignores('next.ts')).toBe(true);
    });
  });
});
