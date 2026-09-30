/**
 * "Why is this index not being watched?" — the explanation contract.
 *
 * `watching: false` used to be the whole answer, which conflates two very
 * different situations: another CodeGraph process owns the index and keeps it
 * in sync, or nothing will ever update it until someone runs `codegraph sync`.
 * These tests pin the classification and the wording, because the second case
 * is the one that silently serves stale answers when it goes unexplained — and
 * the first is the one that gets WORSE if told to "just run sync" against a
 * lock someone else holds.
 */
import { describe, it, expect } from 'vitest';
import { watchDisabledPolicy, watchDisabledReason } from '../src/sync/watch-policy';
import { indexWarnings, watchInactiveWarning, type IndexBlock } from '../src/graph/code-query';
import type { WatchPolicy } from '../src/sync';

describe('watchDisabledPolicy', () => {
  it('classifies the env opt-out, and keeps the reason string in step', () => {
    const probe = { env: { CODEGRAPH_NO_WATCH: '1' }, isWsl: false };
    expect(watchDisabledPolicy('/home/me/project', probe)).toEqual({
      policy: 'disabled-env',
      reason: 'CODEGRAPH_NO_WATCH=1 is set',
    });
    // The reason is a view over the same decision, so the watcher's log line and
    // the status output can never disagree (#8).
    expect(watchDisabledReason('/home/me/project', probe))
      .toBe(watchDisabledPolicy('/home/me/project', probe)!.reason);
  });

  it('classifies the WSL2 /mnt case, and keeps the reason string in step', () => {
    const probe = { env: {}, isWsl: true };
    expect(watchDisabledPolicy('/mnt/d/code/project', probe)).toEqual({
      policy: 'disabled-wsl',
      reason: 'project is on a WSL2 /mnt/ drive, where recursive fs.watch is too slow to be reliable',
    });
    expect(watchDisabledReason('/mnt/d/code/project', probe))
      .toBe(watchDisabledPolicy('/mnt/d/code/project', probe)!.reason);
  });

  it('returns null when watching is allowed', () => {
    expect(watchDisabledPolicy('/home/me/project', { env: {}, isWsl: true })).toBeNull();
    expect(watchDisabledPolicy('/mnt/d/code/project', { env: { CODEGRAPH_FORCE_WATCH: '1' }, isWsl: true })).toBeNull();
  });
});

describe('watchInactiveWarning', () => {
  it('does NOT tell the agent to sync an index another process is maintaining', () => {
    const warning = watchInactiveWarning(
      'disabled-lock',
      "another CodeGraph process (pid 4242, daemon mode) holds this project's writer lock and keeps the index in sync",
    );
    expect(warning).toContain('File watching is not active in this session');
    expect(warning).toContain('pid 4242');
    expect(warning).toContain('takes over watching if that process exits');
    // Both halves of the old blanket sentence are wrong here: the index IS still
    // auto-updating, and syncing by hand would fight the lock holder.
    expect(warning).not.toContain('will not auto-update');
    expect(warning).not.toContain('codegraph sync');
  });

  it.each(['disabled-env', 'disabled-wsl', 'start-failed', 'never-started', 'unwatched-projectPath'] as const)(
    'tells the agent to sync when %s leaves the index stranded',
    (policy: WatchPolicy) => {
      const warning = watchInactiveWarning(policy, 'some reason');
      expect(warning).toContain('some reason');
      expect(warning).toContain('The index will not auto-update; run codegraph sync after code changes.');
    },
  );

  it('reads cleanly with no reason string', () => {
    expect(watchInactiveWarning('never-started', null))
      .toContain('File watching is not active in this session. ');
  });
});

/** The minimum an IndexBlock needs for the watch branches under test. */
function indexBlock(patch: Partial<IndexBlock>): IndexBlock {
  return {
    version: null, indexedCommit: null, currentCommit: null, textChanges: null,
    state: 'complete', phase: null, lastUpdatedAt: null, laggingFileCount: 0,
    failureReason: null, taskLevel: null, lastIndexedAt: null,
    watching: false, degraded: false, degradedReason: null,
    pendingFiles: [], pendingFileCount: 0, pendingReferences: 0,
    changes: null, changeCounts: null, freshness: 'current', freshnessReason: null, stats: null,
    ...patch,
  };
}

describe('indexWarnings watch reporting', () => {
  it('explains an unwatched index, which previously reported nothing at all', () => {
    const warnings = indexWarnings(indexBlock({
      watching: false,
      watchPolicy: 'disabled-env',
      watchPolicyReason: 'CODEGRAPH_NO_WATCH=1 is set',
    }));
    expect(warnings.join('\n')).toContain('File watching is not active in this session: CODEGRAPH_NO_WATCH=1 is set.');
  });

  it('stays silent while a watcher is running', () => {
    const warnings = indexWarnings(indexBlock({ watching: true }));
    expect(warnings.join('\n')).not.toContain('File watching is not active');
  });

  it('leaves the degraded case to its own, more specific warning', () => {
    const warnings = indexWarnings(indexBlock({
      watching: false, degraded: true, degradedReason: 'watch resources exhausted',
      watchPolicy: 'start-failed', watchPolicyReason: 'the file watcher could not start in this environment',
    }));
    expect(warnings).toContain('Auto-sync is disabled; indexed results may be stale.');
    expect(warnings.join('\n')).not.toContain('File watching is not active');
  });
});
