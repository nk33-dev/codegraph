import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import { execFileSync } from 'child_process';

const excludeFiles = new AsyncLocalStorage<Map<string, string | null>>();

/** Index and sync each read their own config snapshot; concurrent projects do not share it. */
export function withGitConfigSnapshot<T>(run: () => T): T {
  return excludeFiles.run(new Map(), run);
}

export function gitExcludeFile(root: string): string | null {
  const cache = excludeFiles.getStore();
  const environment = Object.entries(process.env)
    .filter(([name]) => name.startsWith('GIT_') || ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME'].includes(name))
    .sort(([a], [b]) => a.localeCompare(b));
  const key = JSON.stringify([path.resolve(root), environment]);
  if (cache?.has(key)) return cache.get(key)!;
  try {
    const configured = execFileSync('git', ['-C', root, 'config', '--get', 'core.excludesFile'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim() || null;
    cache?.set(key, configured);
    return configured;
  } catch (error) {
    // An unset key is stable within this task; command failures must remain retryable.
    if ((error as { status?: number }).status !== 1) throw error;
    cache?.set(key, null);
    return null;
  }
}
