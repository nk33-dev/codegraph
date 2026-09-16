/**
 * 跨 daemon 的 LSP 文件租约注册表（开发计划 §4 / 阶段一）。
 *
 * 背景：同一台机器上可能有多个 codegraph daemon（每个项目一个），每个 daemon 各自
 * 管理自己项目的语言服务器。每项目的软上限只能约束单个 daemon，「全局 LSP 上限」
 * 必须让多个进程互相看见对方在跑什么，否则 battery 档位下几个项目就能各留一套。
 *
 * 设计约定（与 `src/mcp/daemon-registry.ts` 的 daemon 注册表同源，但**不** import 它，
 * 避免 MCP 层与 LSP 层的反向依赖）：
 *   - 不引入常驻中央服务：每个 (root, family) 一个 JSON 文件，放在用户级目录
 *     `~/.codegraph/lsp-leases/`（可用 `CODEGRAPH_LSP_LEASE_DIR` 覆盖）；
 *   - 存活判断是 **PID 身份 + 心跳时间** 的双条件，**不得只凭 PID**：OS 会复用 PID，
 *     一个已死 daemon 的记录可能正好对应一个无关的新进程（同类考量见 daemon-registry
 *     #1553）。所以记录只有在「pid 是活进程」且「心跳未超过 {@link LSP_LEASE_STALE_MS}」
 *     时才算 live；
 *   - 全部操作 best-effort：目录不存在、文件损坏、JSON 非法、权限错误都不抛异常，
 *     最坏情况只是少统计一个 lease（宁可偶尔低估，也不误杀别的进程的服务器）；
 *   - 回收是**协作式**的：本注册表只用来数数，绝不跨进程 kill。超预算时由各 daemon
 *     自己关闭「空闲且最久未使用」的服务器。
 *
 * 文件命名：`${sha256(path.resolve(root)).slice(0, 16)}-${family}.json`，JSON + 换行，
 * 权限 0o600（目录 0o700）；写入走「临时文件 + rename」，读方不会看到半个 JSON。
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LSP_FAMILIES, type LspFamily } from './servers';

/** 记录格式版本；读到别的版本按「无法理解」处理，不猜测字段含义。 */
export const LSP_LEASE_SCHEMA_VERSION = 1;

/** 心跳超过这个窗口即视为陈旧；由 daemon 的 30 秒心跳刷新，留一倍余量。 */
export const LSP_LEASE_STALE_MS = 60_000;

export interface LspLeaseRecord {
  schemaVersion: 1;
  /** 持有该语言服务器的进程 pid（daemon 自身）。 */
  pid: number;
  /** 语言服务器所属项目根（已 resolve 的绝对路径）。 */
  root: string;
  family: LspFamily;
  /** 该 family 的服务器启动时刻（epoch ms）；重启后由同一进程重新获得时保留原值。 */
  startedAt: number;
  /** 最近一次心跳时刻（epoch ms）；超过 stale 窗口即视为陈旧。 */
  updatedAt: number;
  /** 上报时的活跃请求数（只用于诊断，不参与存活判断）。 */
  activeQueries: number;
}

/**
 * 租约目录：`CODEGRAPH_LSP_LEASE_DIR` 优先，否则 `~/.codegraph/lsp-leases`。
 * 显式传入 `env` 便于测试注入，不依赖 `process.env` 被改写。
 */
export function getLspLeaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CODEGRAPH_LSP_LEASE_DIR;
  if (raw !== undefined && raw.trim() !== '') return path.resolve(raw.trim());
  return path.join(os.homedir(), '.codegraph', 'lsp-leases');
}

/**
 * `pid` 是否是一个活进程？`kill(pid, 0)` 不发信号、只探测：ESRCH ⇒ 已死，
 * EPERM ⇒ 活着但不属于当前用户（仍然算活着）。这里刻意重复实现而不是复用
 * `src/mcp/daemon-registry.ts` 的同名函数，避免 LSP 层反向依赖 MCP 层。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 一条 (root, family) 对应的租约文件绝对路径。 */
function leaseFile(root: string, family: LspFamily, dir: string): string {
  const digest = crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
  return path.join(dir, `${digest}-${family}.json`);
}

function isFamily(value: unknown): value is LspFamily {
  return typeof value === 'string' && (LSP_FAMILIES as readonly string[]).includes(value);
}

/**
 * 读取结果：`exists` 表示文件确实存在（即使内容不可解析）。
 * 读取失败（权限、竞态删除）时 `exists === false`，调用方不应据此清理文件。
 */
interface LeaseReadResult {
  record: LspLeaseRecord | null;
  exists: boolean;
}

/** 读取并校验一条记录；损坏/版本不符/字段非法都返回 `record: null, exists: true`。 */
function readLeaseFile(file: string): LeaseReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return { record: null, exists: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { record: null, exists: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { record: null, exists: true };
  const value = parsed as Record<string, unknown>;
  if (value.schemaVersion !== LSP_LEASE_SCHEMA_VERSION) return { record: null, exists: true };
  if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0) {
    return { record: null, exists: true };
  }
  if (typeof value.root !== 'string' || value.root.trim() === '') return { record: null, exists: true };
  if (!isFamily(value.family)) return { record: null, exists: true };
  if (typeof value.startedAt !== 'number' || typeof value.updatedAt !== 'number') {
    return { record: null, exists: true };
  }
  const activeQueries = typeof value.activeQueries === 'number' && Number.isFinite(value.activeQueries) && value.activeQueries > 0
    ? Math.floor(value.activeQueries)
    : 0;
  return {
    record: {
      schemaVersion: LSP_LEASE_SCHEMA_VERSION,
      pid: value.pid,
      root: value.root,
      family: value.family,
      startedAt: value.startedAt,
      updatedAt: value.updatedAt,
      activeQueries,
    },
    exists: true,
  };
}

/** best-effort 写入（临时文件 + rename，权限 0o600）；失败返回 false。 */
function writeLeaseFile(file: string, record: LspLeaseRecord, dir: string): boolean {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* 未创建或已被清理 */ }
    return false;
  }
}

/** best-effort 删除一个文件；文件不存在或权限不足都静默忽略。 */
function removeFile(file: string): void {
  try { fs.unlinkSync(file); } catch { /* 已不存在/不可写：下一次清理再试 */ }
}

/** 目录下所有租约文件（完整路径）；目录不存在返回空数组。 */
function leaseFiles(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    // 只认 .json；`.${pid}.tmp` 形式的半成品天然被排除，不参与统计也不被清理。
    if (!name.endsWith('.json')) continue;
    out.push(path.join(dir, name));
  }
  return out;
}

export interface AcquireLspLeaseOptions {
  root: string;
  family: LspFamily;
  /** 默认 `process.pid`（测试可注入）。 */
  pid?: number;
  /** 默认 `Date.now()`；同时用作新记录的 `startedAt`/`updatedAt`。 */
  now?: number;
  /** 覆盖租约目录；默认 `getLspLeaseDir()`。 */
  dir?: string;
}

/**
 * 登记一条租约（语言服务器启动成功后调用）。同一 (root, family) 已有**本进程自己**
 * 的记录时保留原 `startedAt`，这样「同一套服务器」的启动时刻不会因为重启而漂移。
 * 写不进去（目录不可写等）返回 null，调用方继续正常服务。
 */
export function acquireLspLease(options: AcquireLspLeaseOptions): LspLeaseRecord | null {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now();
  const dir = options.dir ?? getLspLeaseDir();
  const file = leaseFile(options.root, options.family, dir);
  const existing = readLeaseFile(file).record;
  const startedAt = existing && existing.pid === pid ? existing.startedAt : now;
  const record: LspLeaseRecord = {
    schemaVersion: LSP_LEASE_SCHEMA_VERSION,
    pid,
    root: path.resolve(options.root),
    family: options.family,
    startedAt,
    updatedAt: now,
    activeQueries: 0,
  };
  return writeLeaseFile(file, record, dir) ? record : null;
}

/**
 * 刷新心跳（daemon 每 30 秒调用一次，明显小于 60 秒陈旧窗口）。
 *
 * 若同一 (root, family) 的记录属于**另一个仍然活着且心跳新鲜**的进程，则不去抢写
 * （两个 daemon 同时持有同一项目同一 family 的服务器属于异常状态，最坏只是少统计
 * 一个 lease）；记录属于已死进程或已陈旧时，由本进程接管。
 */
export function heartbeatLspLease(
  root: string,
  family: LspFamily,
  activeQueries: number,
  now: number = Date.now(),
  dir: string = getLspLeaseDir(),
): boolean {
  const pid = process.pid;
  const file = leaseFile(root, family, dir);
  const existing = readLeaseFile(file).record;
  if (
    existing
    && existing.pid !== pid
    && isProcessAlive(existing.pid)
    && now - existing.updatedAt <= LSP_LEASE_STALE_MS
  ) {
    return false;
  }
  const startedAt = existing && existing.pid === pid ? existing.startedAt : now;
  const record: LspLeaseRecord = {
    schemaVersion: LSP_LEASE_SCHEMA_VERSION,
    pid,
    root: path.resolve(root),
    family,
    startedAt,
    updatedAt: now,
    activeQueries: Number.isFinite(activeQueries) && activeQueries > 0 ? Math.floor(activeQueries) : 0,
  };
  return writeLeaseFile(file, record, dir);
}

/** 释放一条租约（服务器停止时调用）；重复释放、目录不可写都静默忽略。 */
export function releaseLspLease(root: string, family: LspFamily, dir: string = getLspLeaseDir()): void {
  removeFile(leaseFile(root, family, dir));
}

/**
 * 兜底清理：删除属于 `pid` 的租约记录；传入 `projectRoot` 时只清理该项目，
 * 避免同一 daemon 里的一个 manager 关闭时误删其它项目仍存活的租约。
 * 返回实际删除的条数。损坏到无法归属的文件不在这里处理，由 {@link listLiveLspLeases} 自愈。
 */
export function releaseAllLspLeases(
  pid: number,
  dir: string = getLspLeaseDir(),
  projectRoot?: string,
): number {
  const resolvedRoot = projectRoot === undefined ? null : path.resolve(projectRoot);
  let removed = 0;
  for (const file of leaseFiles(dir)) {
    const record = readLeaseFile(file).record;
    if (!record || record.pid !== pid || (resolvedRoot !== null && path.resolve(record.root) !== resolvedRoot)) continue;
    try {
      fs.unlinkSync(file);
      removed += 1;
    } catch {
      /* 竞态删除/权限问题：忽略 */
    }
  }
  return removed;
}

/**
 * 列出所有 live 租约，按 `startedAt` 升序（最久远的在前，便于「谁该先让位」判断）。
 *
 * 自愈：遍历时顺带清理「pid 已死」「心跳超过 `staleMs`」以及无法解析的记录文件；
 * 目录不存在或读取失败只返回空数组，绝不抛异常。
 */
export function listLiveLspLeases(
  now: number = Date.now(),
  staleMs: number = LSP_LEASE_STALE_MS,
  dir: string = getLspLeaseDir(),
): LspLeaseRecord[] {
  const live: LspLeaseRecord[] = [];
  for (const file of leaseFiles(dir)) {
    const { record, exists } = readLeaseFile(file);
    if (!exists) continue;
    if (!record || !isProcessAlive(record.pid) || now - record.updatedAt > staleMs) {
      removeFile(file);
      continue;
    }
    live.push(record);
  }
  return live.sort((a, b) => a.startedAt - b.startedAt);
}

/** 全局 live 租约数量（跨 daemon）；注册表不可用时返回 0。 */
export function countLiveLspLeases(now: number = Date.now(), dir: string = getLspLeaseDir()): number {
  return listLiveLspLeases(now, LSP_LEASE_STALE_MS, dir).length;
}
