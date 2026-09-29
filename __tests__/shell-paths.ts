/**
 * Locating a shell for tests that execute shipped shell recipes.
 *
 * The suites that run `install.sh` / the bundled launcher need a real POSIX
 * shell. CI's Windows runners have Git Bash at the default install path, but a
 * contributor's machine may have it elsewhere (this fork's own machine keeps it
 * in `D:\Develop\Git`) — or not at all. Resolving the binary up front lets those
 * tests skip with a printed reason instead of failing on an `ENOENT` spawn.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const windows = process.platform === 'win32';

/** `where <name>` on Windows, `command -v <name>` elsewhere. */
function commandPath(name: string): string[] {
  const probe = windows
    ? spawnSync('where', [name], { encoding: 'utf8', windowsHide: true })
    : spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8', windowsHide: true });
  if (probe.status !== 0) return [];
  return probe.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function firstExisting(candidates: (string | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Git Bash (or `bash` on POSIX). Honors `CODEGRAPH_TEST_BASH`, then the default
 * Windows install path, then `PATH`. Returns null when no bash is installed.
 */
export function resolveGitBash(): string | null {
  return firstExisting([
    process.env.CODEGRAPH_TEST_BASH,
    windows
      ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
      : undefined,
    ...commandPath('bash'),
  ]);
}

/**
 * POSIX `sh`. Always present on POSIX platforms; Windows has none, so the
 * POSIX-only suites that need it resolve to null there and skip.
 */
export function resolvePosixSh(): string | null {
  if (windows) return null;
  return firstExisting(commandPath('sh'));
}
