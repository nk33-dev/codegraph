/** Persisted daemon metrics must be labelled as live or historical accurately. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  REPORTED_SNAPSHOT_STALE_MS,
  reportedSnapshotState,
  writeResourceMetricsSnapshot,
  type ResourceMetricsSnapshot,
} from '../src/resource-metrics';
import { registerDaemon } from '../src/mcp/daemon-registry';
import { encodeLockInfo, getDaemonPidPath } from '../src/mcp/daemon-paths';
import { IndexedProject } from './indexed-project';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  return child.pid && child.pid !== process.pid ? child.pid : 999_999;
}

function runStatusText(cwd: string, env: Record<string, string>): string {
  return execFileSync(process.execPath, [BIN, 'status'], {
    cwd, encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', NO_COLOR: '1', ...env },
  });
}

function runStatusJson(cwd: string, env: Record<string, string>): Record<string, any> {
  const stdout = execFileSync(process.execPath, [BIN, 'status', '--json'], {
    cwd, encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', ...env },
  });
  return JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()!);
}

describe('daemon snapshot liveness', () => {
  let tempHome: string;
  let tempDir: string;
  let project: IndexedProject;
  let base: ResourceMetricsSnapshot;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-snapshot-home-'));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-snapshot-proj-'));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    fs.writeFileSync(path.join(tempDir, 'a.ts'), 'export function alpha() { return 1; }\n');
    project = new IndexedProject(tempDir);
    await project.index();
    base = project.graph.resourceStatus().process;
  }, 30_000);

  afterEach(async () => {
    await project.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  const write = (pid: number, ageMs: number): void => {
    expect(writeResourceMetricsSnapshot(tempDir, { ...base, pid, updatedAt: Date.now() - ageMs })).toBe(true);
  };

  const registerCurrentProcess = (): void => {
    const socketPath = path.join(tempDir, '.codegraph', 'daemon.sock');
    registerDaemon({ root: path.resolve(tempDir), pid: process.pid, version: '1.0.0', socketPath, startedAt: Date.now() });
    fs.writeFileSync(getDaemonPidPath(tempDir), encodeLockInfo({
      pid: process.pid, version: '1.0.0', socketPath, startedAt: Date.now(),
    }));
  };

  it('distinguishes missing, exited, live, and stale snapshots', () => {
    expect(reportedSnapshotState(tempDir, null)).toEqual({ state: null, ageMs: null });
    expect(reportedSnapshotState(tempDir, {
      ...base, pid: deadPid(), updatedAt: Date.now() - 5_000,
    }).state).toBe('exited');
    expect(reportedSnapshotState(tempDir, {
      ...base, pid: process.pid, updatedAt: Date.now() - 5_000,
    }).state).toBe('exited');

    registerCurrentProcess();
    expect(reportedSnapshotState(tempDir, {
      ...base, pid: process.pid, updatedAt: Date.now() - 3_000,
    }).state).toBe('live');
    expect(reportedSnapshotState(tempDir, {
      ...base, pid: process.pid, updatedAt: Date.now() - REPORTED_SNAPSHOT_STALE_MS - 1,
    }).state).toBe('stale');
  });

  it('labels an exited daemon snapshot as historical in text and JSON', async () => {
    await project.close();
    write(deadPid(), 11_000);

    const text = runStatusText(tempDir, {});
    expect(text).toMatch(/no daemon running/);
    expect(text).toMatch(/LAST DAEMON SNAPSHOT/);
    expect(text).toMatch(/that process has exited/);
    expect(text).not.toMatch(/Daemon: {4}pool /);
    expect(text).toMatch(/Snapshot: {2}pool /);

    const json = runStatusJson(tempDir, {});
    expect(json.resources.reportedState).toBe('exited');
    expect(typeof json.resources.reportedAgeMs).toBe('number');
  });

  it('uses present tense only for a fresh live daemon snapshot', async () => {
    await project.close();
    registerCurrentProcess();
    write(process.pid, 2_000);

    const env = { HOME: tempHome, USERPROFILE: tempHome };
    const text = runStatusText(tempDir, env);
    expect(text).toMatch(/Daemon: {4}pool /);
    expect(text).not.toMatch(/LAST DAEMON SNAPSHOT/);
    expect(runStatusJson(tempDir, env).resources.reportedState).toBe('live');
  });

  it('labels a stale live-process snapshot as historical', async () => {
    await project.close();
    registerCurrentProcess();
    write(process.pid, REPORTED_SNAPSHOT_STALE_MS + 5 * 60_000);

    const env = { HOME: tempHome, USERPROFILE: tempHome };
    const text = runStatusText(tempDir, env);
    expect(text).toMatch(/no daemon running/);
    expect(text).toMatch(/the daemon stopped reporting/);
    expect(text).not.toMatch(/Daemon: {4}pool /);
    expect(runStatusJson(tempDir, env).resources.reportedState).toBe('stale');
  });
});
