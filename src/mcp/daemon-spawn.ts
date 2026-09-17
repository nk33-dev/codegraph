/**
 * 共享 daemon 的启动与版本切换 —— 个人版升级体验（安装新版后旧 daemon 仍在跑）。
 *
 * 背景：daemon 与客户端必须**同版本**才共享（版本不一致时 connectWithHello 返回
 * 'version-mismatch'，调用方退回进程内服务）。此前 mismatch 只被当作“不可用”：
 * 旧版 daemon 继续占着 `.codegraph/daemon.pid` 与 socket，新客户端每次都要退回
 * 进程内，编辑命令甚至在写路径上只报“未能确认”，只有手工 `codegraph daemon`
 * 停掉旧进程才恢复。
 *
 * 本模块把那次手工操作自动化，并作为唯一实现（MCP 代理与 CLI 共用）：
 *   1. {@link spawnDetachedDaemon} 以分离进程启动当前版本 daemon；
 *   2. {@link waitForDaemonSocket} 轮询候选 socket 直到 hello 与本版一致；
 *   3. {@link restartSharedDaemon} 先请旧进程退出（身份经 socket hello 证明，
 *      不认识的 pid 一律不动），再启动本版并等到可用。
 *
 * 安全性：只有能证明“这个 pid 确实是本项目的 CodeGraph daemon”时才发送信号；
 * 无法证明时返回 'unverified'，由调用方退回进程内服务，绝不误杀无关进程。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawn, StdioOptions } from 'child_process';
import { getCodeGraphDir } from '../directory';
import { HOST_PPID_ENV } from '../extraction/wasm-runtime-flags';
import { getDaemonPidPath, getDaemonSocketCandidates, decodeLockInfo } from './daemon-paths';
import { retireStaleDaemon } from './daemon-registry';
import { connectWithHello } from './proxy';
import { CodeGraphPackageVersion } from './version';

/**
 * 标记“本进程就是分离 daemon 自身”的环境变量（由 {@link spawnDetachedDaemon} 重新调用
 * CLI 时设置）。没有它时 `serve --mcp` 是启动器（连接或拉起 daemon）；有它时进程
 * 就是 daemon，必须绝不再拉起第二个（否则无限 spawn）。
 */
export const DAEMON_INTERNAL_ENV = 'CODEGRAPH_DAEMON_INTERNAL';

/** 与 src/mcp/index.ts 的启动器保持一致：240 × 25ms ≈ 6s 的冷启动预算。 */
const DAEMON_CONNECT_MAX_RETRIES = 240;
const DAEMON_CONNECT_RETRY_DELAY_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 以完全分离的后台进程方式启动共享 daemon：独立会话/进程组（终端的 SIGHUP/SIGINT
 * 影响不到它），stdio 与启动器解耦（日志写入 `.codegraph/daemon.log`）。通过复用
 * `process.argv[0]`（正确的 node）、`process.execArgv` 与 `process.argv[1]`（本脚本）
 * 忠实重新调用同一个 CLI。被拉起的进程自行竞争 O_EXCL 锁，因此并发的启动器各自
 * 都可能拉起一个 —— 失败者退出，所有启动器最终都经过唯一的赢家。
 */
export function spawnDetachedDaemon(root: string): void {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    // 无法解析可重新调用的 CLI 入口 —— 让调用方退回 direct 模式，而不是启动一个坏的进程。
    throw new Error('cannot resolve CLI script path to spawn the daemon');
  }

  let logFd: number | null = null;
  let stdio: StdioOptions = 'ignore';
  try {
    logFd = fs.openSync(path.join(getCodeGraphDir(root), 'daemon.log'), 'a');
    stdio = ['ignore', logFd, logFd];
  } catch {
    stdio = 'ignore'; // 没有日志文件时丢弃 daemon 输出，而不是让启动失败
  }
  try {
    // daemon 没有宿主：清掉线程化的 host pid，避免它泄漏进 daemon 的环境（进而泄漏给
    // daemon 拉起的任何进程），否则一个早已退出的会话 pid 会触发莫名的关闭。
    const env: NodeJS.ProcessEnv = { ...process.env, [DAEMON_INTERNAL_ENV]: '1' };
    delete env[HOST_PPID_ENV];
    const child = spawn(
      process.execPath,
      [...process.execArgv, scriptPath, 'serve', '--mcp', '--path', root],
      { detached: true, stdio, windowsHide: true, env },
    );
    child.unref();
  } finally {
    // 子进程已经持有自己的日志 fd 副本；启动器不再需要它。
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch { /* ignore */ }
    }
  }
}

export interface WaitForDaemonSocketOptions {
  /** 轮询次数，默认覆盖约 6s 的冷启动窗口。 */
  attempts?: number;
  /** 每次轮询间隔，默认 25ms。 */
  delayMs?: number;
}

/**
 * 轮询候选 socket，直到某个 daemon 的 hello 与本版一致。
 * 返回的 socket 已经消费过 hello 并回过 client-hello，调用方直接接管即可。
 */
export async function waitForDaemonSocket(
  root: string,
  options: WaitForDaemonSocketOptions = {},
): Promise<net.Socket | 'version-mismatch' | null> {
  const attempts = options.attempts ?? DAEMON_CONNECT_MAX_RETRIES;
  const delayMs = options.delayMs ?? DAEMON_CONNECT_RETRY_DELAY_MS;
  const candidates = getDaemonSocketCandidates(root);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (delayMs > 0) await sleep(delayMs);
    for (const candidate of candidates) {
      const socket = await connectWithHello(candidate);
      // 版本不一致是确定的结论（有 daemon，但版本不同），不要继续轮询。
      if (socket === 'version-mismatch') return socket;
      if (socket) return socket;
    }
  }
  return null;
}

export interface RestartSharedDaemonResult {
  /**
   * 'switched'    —— 新版本 daemon 已就绪（socket 可复用）；
   * 'unverified'  —— 锁文件里的进程无法证明是本项目 daemon，拒绝动它；
   * 'unavailable' —— 旧进程已退出（或无旧进程），但新版本在超时内没有起来。
   */
  outcome: 'switched' | 'unverified' | 'unavailable';
  previousPid: number | null;
  previousVersion: string | null;
  /** 新 daemon 的 pid（读到锁文件时）。 */
  pid: number | null;
  /** 新 daemon 的连接（仅 'switched' 时非空），hello 已消费。 */
  socket: net.Socket | null;
}

/** 读取项目锁文件里的 daemon 身份；缺失或损坏时返回 null。 */
function readDaemonLock(root: string): { pid: number; version: string } | null {
  try {
    const info = decodeLockInfo(fs.readFileSync(getDaemonPidPath(root), 'utf8'));
    return info ? { pid: info.pid, version: info.version } : null;
  } catch {
    return null;
  }
}

/**
 * 把项目上的 daemon 换成当前版本：旧进程优雅退出 → 启动本版 → 等到 hello 匹配。
 *
 * 旧进程不存在时也照常启动本版（`codegraph daemon --restart` 的“确保在跑”语义）。
 * 并发的两个客户端同时切换是安全的：退出与启动都是幂等的，最终都会连到同一个
 * 胜出的新 daemon。
 */
export async function restartSharedDaemon(root: string): Promise<RestartSharedDaemonResult> {
  const previous = readDaemonLock(root);
  const retired = await retireStaleDaemon(root);
  if (retired.outcome === 'unverified') {
    return {
      outcome: 'unverified',
      previousPid: previous?.pid ?? null,
      previousVersion: previous?.version ?? null,
      pid: null,
      socket: null,
    };
  }

  if (retired.outcome === 'stopped' && retired.pid !== null) {
    // 只有版本确实不同才说 “outdated”：同版本的 --restart 只是把 daemon 换成新进程。
    const described = retired.version && retired.version !== CodeGraphPackageVersion
      ? `outdated daemon (pid ${retired.pid}, v${retired.version})`
      : `running daemon (pid ${retired.pid}, v${retired.version ?? 'unknown'})`;
    process.stderr.write(`[CodeGraph daemon] Stopped the ${described} and started v${CodeGraphPackageVersion}.\n`);
  }

  spawnDetachedDaemon(root);
  const socket = await waitForDaemonSocket(root);
  if (!socket || socket === 'version-mismatch') {
    // 'version-mismatch' 时 connectWithHello 已经关掉了那条连接；这里没有别的资源要收拾。
    return {
      outcome: 'unavailable',
      previousPid: previous?.pid ?? null,
      previousVersion: previous?.version ?? null,
      pid: null,
      socket: null,
    };
  }

  return {
    outcome: 'switched',
    previousPid: previous?.pid ?? null,
    previousVersion: previous?.version ?? null,
    pid: readDaemonLock(root)?.pid ?? null,
    socket,
  };
}
