/**
 * Language server lifecycle manager (one instance per project).
 *
 * Design points:
 *   - Lazy start: only the first query that genuinely needs LSP spawns a process; the registry itself is free.
 *   - Reuse: one process per (project root, language family); multiple MCP clients inside the same
 *     process (daemon mode) share one ToolHandler → one CodeGraph → one manager.
 *   - Idle exit: after 5 minutes with no request the server is shutdown/exit'ed and the process reclaimed (0 = stay resident).
 *   - Bounded crash restarts: at most 3 within 60s; beyond that it returns `unavailable` with the
 *     stderr tail, avoiding "restarting a server that always crashes on every query".
 *   - Document sync: didOpen/didChange/didClose only for queried files, LRU cap 64,
 *     no whole-project pre-open.
 *   - No installation of any kind: commands come only from `.codegraph/lsp.json` + environment variables.
 *   - Resource governance (phase 1): a per-project soft cap evicts the least recently used idle
 *     server before a new family starts, and a cross-daemon file lease registry coordinates the
 *     global LSP budget. Both are off when `CODEGRAPH_RESOURCE_GOVERNANCE=0` or
 *     `CODEGRAPH_LSP_GLOBAL_LEASE=0` (see the fallback note on the constructor).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import type { ChildProcess } from 'child_process';
import type { Language } from '../types';
import { resolveResourceProfile, resourceGovernanceEnabled, type ResourceProfileSettings } from '../resource-profile';
import { resourceMetrics } from '../resource-metrics';
import {
  loadLspConfig,
  getLspConfigPath,
  type LspProjectConfig,
  type LspServerConfig,
} from './config';
import {
  DEFAULT_SERVERS,
  LANGUAGES_BY_FAMILY,
  LSP_FAMILIES,
  familyForLanguage,
  languageIdFor,
  resolveExecutable,
  spawnServer,
  type LspFamily,
} from './servers';
import {
  LSP_LEASE_STALE_MS,
  acquireLspLease,
  countLiveLspLeases,
  heartbeatLspLease,
  listLiveLspLeases,
  releaseAllLspLeases,
  releaseLspLease,
  type LspLeaseRecord,
} from './lease-registry';
import { LspConnection, LspError } from './protocol';
import { pathToUri, uriKey } from './uri';
import type { EditFilePreview } from '../edits/contract';

/** LSP position: line and character are both 0-based (the character unit is determined by positionEncoding). */
export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspLocation { uri: string; range: LspRange }

export interface LspDiagnostic {
  range: LspRange;
  severity: number | null;
  code: string | number | null;
  source: string | null;
  message: string;
}

export interface LspSymbolNode {
  name: string;
  detail: string | null;
  kind: number;
  containerName: string | null;
  range: LspRange;
  selectionRange: LspRange;
  children: LspSymbolNode[];
}

/** One file's text edits, as returned by a workspace edit (`changes` or `documentChanges`). */
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

/**
 * A normalized workspace edit: text edits for one file, a file rename, or a file create/delete.
 *
 * The protocol's two shapes (`changes` and the ordered `documentChanges`) are flattened into one
 * list, because the caller has to validate and preview every file *before* writing any of them — and
 * an unhandled change kind must be a refusal, not something quietly dropped.
 */
export interface LspWorkspaceEditOperation {
  kind: 'edits' | 'rename' | 'create' | 'delete';
  /** The affected file's URI (`rename` uses `newUri` for the destination). */
  uri: string;
  edits: LspTextEdit[];
  /** `kind: "rename"` only: the destination URI. */
  newUri: string | null;
}

/** Query results plus whether they were retried after waiting because "the server is still indexing" (callers report this faithfully). */
export interface LspQueryOutcome<T> {
  items: T[];
  retried: boolean;
}

export interface LspCapabilities {  definition: boolean;
  references: boolean;
  documentSymbol: boolean;
  /** textDocument/rename: true when the server advertises renameProvider (an object form counts too). */
  rename: boolean;
  /** pull = supports textDocument/diagnostic; push = only sends publishDiagnostics. */
  diagnostics: 'pull' | 'push' | 'none';
  positionEncoding: string;
  fileOperations: { create: boolean; rename: boolean; delete: boolean };
}

export type LspServerState = 'starting' | 'ready' | 'crashed' | 'stopped';

/**
 * 服务器停止原因，直接对应 `resourceMetrics().recordLspStop(reason)` 的取值：
 * `idle` 空闲退出，`budget` 每项目软上限 / 全局预算回收，`shutdown` 显式关闭，
 * `crash` 启动失败或异常退出，`other` 其它。
 */
export type LspStopReason = 'idle' | 'budget' | 'shutdown' | 'crash' | 'other';

export interface LspServerStatus {
  family: LspFamily;
  languages: Language[];
  configured: boolean;
  command: string[];
  resolvedPath: string | null;
  state: LspServerState;
  pid: number | null;
  startedAt: number | null;
  lastUsedAt: number | null;
  requestCount: number;
  openDocuments: number;
  /** The server is still indexing/analyzing (an unfinished $/progress was received). */
  indexing: boolean;
  capabilities: LspCapabilities | null;
  lastError: string | null;
  stderrTail: string[];
}

/** Server unavailable (not installed / not configured / disabled / inside a crash window): not a failed query but a handleable state. */
export class LspUnavailableError extends Error {
  constructor(readonly family: LspFamily, message: string, readonly remedy: string) {
    super(message);
    this.name = 'LspUnavailableError';
  }
}

/** Empty results within this window after startup are treated as "may still be indexing" and retried once. */
const WARMUP_RETRY_WINDOW_MS = 60_000;
/** Longest polling wait when indexing is waited on forcefully (more conservative than warmupTimeoutMs, to avoid long blocking). */
const FORCED_WARMUP_CAP_MS = 10_000;
/** Polling granularity while waiting for an indexing signal. */
const WARMUP_POLL_MS = 250;
/** Retry count and delay for transient LSP errors (ContentModified/ServerCancelled). */
const TRANSIENT_RETRY_ATTEMPTS = 2;
const TRANSIENT_RETRY_DELAY_MS = 200;
const MAX_OPEN_DOCUMENTS = 64;
const IDLE_SWEEP_INTERVAL_MS = 30_000;
/**
 * 租约心跳间隔。必须**明显小于**注册表的 {@link LSP_LEASE_STALE_MS}（60 秒），
 * 否则一次心跳抖动就会让别的 daemon 把本进程的服务器当成陈旧记录清掉。
 */
const LEASE_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_CRASHES_PER_WINDOW = 3;
const CRASH_WINDOW_MS = 60_000;
const STDERR_TAIL_LINES = 50;
/** Window to wait for publishDiagnostics after pull diagnostics fail (matches Serena's 2.5s). */
const PUBLISH_WAIT_MS = 2_500;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const EXIT_GRACE_MS = 2_000;
/** An empty result within this window after startup hints that the server may still be indexing. */
export const SERVER_WARMUP_HINT_MS = 20_000;

const SYMBOL_KIND_VALUE_SET = Array.from({ length: 26 }, (_, i) => i + 1);

function lspLog(message: string): void {
  process.stderr.write(`[CodeGraph LSP] ${message}\n`);
}

/** jdt.ls workspace data directory: user-level, isolated by a hash of the project root, never inside the project root. */
export function defaultJdtlsWorkspaceDir(projectRoot: string): string {
  const digest = createHash('sha1').update(path.resolve(projectRoot)).digest('hex').slice(0, 12);
  return path.join(os.homedir(), '.codegraph', 'lsp', 'jdtls', digest);
}

function lspDebug(message: string): void {
  if (process.env.CODEGRAPH_LSP_DEBUG) lspLog(message);
}

/** Registry of live child processes: kills them if the process exits abnormally, so no orphan language servers are left behind. */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function registerChild(child: ChildProcess): void {
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const live of liveChildren) {
      try { live.kill(); } catch { /* already exited */ }
    }
  });
}

/** Test hook: number of live language server processes across managers. */
export function liveLspChildCount(): number {
  return liveChildren.size;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asPosition(value: unknown): LspPosition | null {
  if (!isRecord(value)) return null;
  const { line, character } = value as { line?: unknown; character?: unknown };
  if (typeof line !== 'number' || typeof character !== 'number') return null;
  return { line, character };
}

function asRange(value: unknown): LspRange | null {
  if (!isRecord(value)) return null;
  const start = asPosition(value.start);
  const end = asPosition(value.end);
  if (!start || !end) return null;
  return { start, end };
}

/** Definition/reference response normalization: Location | Location[] | LocationLink[] | null. */
export function normalizeLocations(result: unknown): LspLocation[] {
  if (result === null || result === undefined) return [];
  const entries = Array.isArray(result) ? result : [result];
  const out: LspLocation[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (typeof entry.uri === 'string') {
      const range = asRange(entry.range);
      if (range) out.push({ uri: entry.uri, range });
      continue;
    }
    // LocationLink
    if (typeof entry.targetUri === 'string') {
      const range = asRange(entry.targetSelectionRange) ?? asRange(entry.targetRange);
      if (range) out.push({ uri: entry.targetUri, range });
    }
  }
  return out;
}

/**
 * WorkspaceEdit normalization for `textDocument/rename` (and any other edit-returning request).
 *
 * `changes` (uri → TextEdit[]) and the ordered `documentChanges` (TextDocumentEdit | CreateFile |
 * RenameFile | DeleteFile) are flattened into one list. An entry whose shape is not understood is a
 * hard error: silently dropping one would rename half a symbol, which is worse than refusing.
 */
export function normalizeWorkspaceEdit(result: unknown): LspWorkspaceEditOperation[] {
  if (result === null || result === undefined) return [];
  const out: LspWorkspaceEditOperation[] = [];
  const readEdits = (value: unknown): LspTextEdit[] => {
    if (!Array.isArray(value)) throw new LspError('workspace edit carries a non-array edits field', 'protocol');
    const edits: LspTextEdit[] = [];
    for (const entry of value) {
      const range = isRecord(entry) ? asRange(entry.range) : null;
      const newText = isRecord(entry) && typeof entry.newText === 'string' ? entry.newText : null;
      if (!range || newText === null) throw new LspError('workspace edit carries a malformed TextEdit', 'protocol');
      edits.push({ range, newText });
    }
    return edits;
  };

  if (isRecord(result) && isRecord(result.changes)) {
    for (const [uri, edits] of Object.entries(result.changes)) {
      const normalized = readEdits(edits);
      if (normalized.length > 0) out.push({ kind: 'edits', uri, edits: normalized, newUri: null });
    }
  }

  if (isRecord(result) && Array.isArray(result.documentChanges)) {
    for (const entry of result.documentChanges) {
      if (!isRecord(entry)) throw new LspError('workspace edit carries a malformed documentChanges entry', 'protocol');
      if (typeof entry.kind === 'string') {
        if (entry.kind === 'create' && typeof entry.uri === 'string') {
          out.push({ kind: 'create', uri: entry.uri, edits: [], newUri: null });
          continue;
        }
        if (entry.kind === 'delete' && typeof entry.uri === 'string') {
          out.push({ kind: 'delete', uri: entry.uri, edits: [], newUri: null });
          continue;
        }
        if (entry.kind === 'rename' && typeof entry.oldUri === 'string' && typeof entry.newUri === 'string') {
          out.push({ kind: 'rename', uri: entry.oldUri, edits: [], newUri: entry.newUri });
          continue;
        }
        throw new LspError(`workspace edit uses an unsupported documentChanges kind "${entry.kind}"`, 'unsupported');
      }
      const document = isRecord(entry.textDocument) ? entry.textDocument : null;
      const uri = document && typeof document.uri === 'string' ? document.uri : null;
      if (uri === null) throw new LspError('workspace edit carries a documentChanges entry without a uri', 'protocol');
      const normalized = readEdits(entry.edits);
      if (normalized.length > 0) out.push({ kind: 'edits', uri, edits: normalized, newUri: null });
    }
  }

  return out;
}

/** documentSymbol normalization: DocumentSymbol[] (hierarchical) or SymbolInformation[] (flat). */export function normalizeDocumentSymbols(result: unknown): LspSymbolNode[] {
  if (!Array.isArray(result)) return [];
  const out: LspSymbolNode[] = [];
  for (const entry of result) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name : null;
    const kind = typeof entry.kind === 'number' ? entry.kind : null;
    if (name === null || kind === null) continue;
    const range = asRange(entry.range);
    const selectionRange = asRange(entry.selectionRange) ?? range;
    if (!range || !selectionRange) continue;
    const children = normalizeDocumentSymbols(entry.children);
    out.push({
      name,
      detail: typeof entry.detail === 'string' ? entry.detail : null,
      kind,
      containerName: typeof entry.containerName === 'string' ? entry.containerName : null,
      range,
      selectionRange,
      children,
    });
  }
  return out;
}

function normalizeDiagnostics(result: unknown): LspDiagnostic[] {
  if (!Array.isArray(result)) return [];
  const out: LspDiagnostic[] = [];
  for (const entry of result) {
    if (!isRecord(entry)) continue;
    const range = asRange(entry.range);
    if (!range || typeof entry.message !== 'string') continue;
    const code = entry.code;
    out.push({
      range,
      severity: typeof entry.severity === 'number' ? entry.severity : null,
      code: typeof code === 'string' || typeof code === 'number' ? code : null,
      source: typeof entry.source === 'string' ? entry.source : null,
      message: entry.message,
    });
  }
  return out;
}

interface OpenDocument {
  uri: string;
  filePath: string;
  languageId: string;
  version: number;
  mtimeMs: number;
  size: number;
  lastUsedAt: number;
}

interface DiagnosticCacheEntry {
  items: LspDiagnostic[];
  generation: number;
}

interface ResolvedServer {
  family: LspFamily;
  config: LspServerConfig;
  resolvedPath: string | null;
  resolvedArgs: string[];
  /** Unavailability reason (executable not found, etc.); null means available. */
  unavailableReason: string | null;
}

interface ServerEntry {
  family: LspFamily;
  resolved: ResolvedServer;
  state: LspServerState;
  child: ChildProcess | null;
  connection: LspConnection | null;
  capabilities: LspCapabilities | null;
  startedAt: number | null;
  lastUsedAt: number;
  requestCount: number;
  activeQueries: number;
  stderrTail: string[];
  lastError: string | null;
  startPromise: Promise<void> | null;
  crashTimes: number[];
  suppressedUntil: number;
  /** In-flight $/progress tokens — non-empty means the server is still indexing/analyzing. */
  progressTokens: Set<string>;
  /** rust-analyzer's experimental/serverStatus.quiescent; null = not received yet. */
  quiescent: boolean | null;
  /** Whether any indexing signal has been received ($/progress or serverStatus). */
  sawIndexSignal: boolean;
  /** Whether an empty result already triggered a wait-for-indexing retry (done only once per server process). */
  emptyRetryDone: boolean;
  /** Wake-up functions waiting for "indexing finished". */
  idleWaiters: Array<() => void>;
  diagnostics: Map<string, DiagnosticCacheEntry>;
  diagnosticsGeneration: number;
  diagnosticWaiters: Map<string, Array<() => void>>;
  documents: Map<string, OpenDocument>;
  shutdownPromise: Promise<void> | null;
}

/** Availability summary derived from the language server's capabilities, used for `lsp.server.capabilities` in results. */
function capabilitiesFromInitialize(result: unknown): LspCapabilities {
  const capabilities = isRecord(result) && isRecord(result.capabilities) ? result.capabilities : {};
  const workspace = isRecord(capabilities.workspace) ? capabilities.workspace : {};
  const fileOperations = isRecord(workspace.fileOperations) ? workspace.fileOperations : {};
  const provided = (value: unknown): boolean => value === true || isRecord(value);
  return {
    definition: provided(capabilities.definitionProvider),
    references: provided(capabilities.referencesProvider),
    documentSymbol: provided(capabilities.documentSymbolProvider),
    rename: provided(capabilities.renameProvider),
    diagnostics: capabilities.diagnosticProvider !== undefined ? 'pull' : 'push',
    positionEncoding: typeof capabilities.positionEncoding === 'string' ? capabilities.positionEncoding : 'utf-16',
    fileOperations: {
      create: fileOperations.didCreate !== undefined,
      rename: fileOperations.didRename !== undefined,
      delete: fileOperations.didDelete !== undefined,
    },
  };
}

export interface LspManagerOptions {
  /** Override config loading (for tests). */
  loadConfig?: (root: string) => LspProjectConfig;
  /** Disable the idle sweep timer (tests call sweepIdle manually instead). Lease heartbeats are NOT disabled by this. */
  idleSweep?: boolean;
  /** 资源档位；默认 `resolveResourceProfile()`（含所有 CODEGRAPH_* 环境变量覆盖）。 */
  profile?: ResourceProfileSettings;
  /** 是否使用跨 daemon 的文件租约；默认由治理开关与 `CODEGRAPH_LSP_GLOBAL_LEASE` 决定。 */
  lease?: boolean;
  /** 租约目录覆盖；默认 `CODEGRAPH_LSP_LEASE_DIR` 或 `~/.codegraph/lsp-leases`。 */
  leaseDir?: string;
  /** 时间注入（测试用）；默认 `Date.now`。 */
  now?: () => number;
}

export class LspManager {
  private readonly entries = new Map<LspFamily, ServerEntry>();
  private readonly profile: ResourceProfileSettings;
  /**
   * 治理（每项目软上限驱逐）是否生效：`CODEGRAPH_RESOURCE_GOVERNANCE=0` 或
   * `CODEGRAPH_LSP_GLOBAL_LEASE=0` 时关闭。
   */
  private readonly governanceActive: boolean;
  /** 是否注册/读取跨 daemon 租约。 */
  private readonly leaseEnabled: boolean;
  private config: LspProjectConfig;
  private configMtimeMs: number;
  private idleTimer: NodeJS.Timeout | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    readonly projectRoot: string,
    private readonly options: LspManagerOptions = {},
  ) {
    this.profile = options.profile ?? resolveResourceProfile();
    /*
     * 回退开关（要求 f）：`CODEGRAPH_RESOURCE_GOVERNANCE=0` 或 `CODEGRAPH_LSP_GLOBAL_LEASE=0`
     * 时，本 manager 不做软上限驱逐、不注册/不读取 lease；正常启动/关闭 server 的行为不变。
     * `options.lease` 只能在此基础上进一步关闭租约，不能强行打开（回退开关优先级最高）。
     */
    const governance = this.profile.governanceEnabled && resourceGovernanceEnabled();
    this.governanceActive = governance && process.env.CODEGRAPH_LSP_GLOBAL_LEASE !== '0';
    this.leaseEnabled = this.governanceActive && (options.lease ?? true);
    this.config = this.readConfig();
    this.configMtimeMs = this.currentConfigMtime();
  }

  /** 注入式时钟：所有租约时间戳与 LRU 时间都走这里，便于测试制造陈旧记录。 */
  private nowMs(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** Whether this family is currently available (without starting a process), for status and unavailable hints. */
  describeFamily(family: LspFamily): { configured: boolean; resolvedPath: string | null; command: string[]; reason: string | null } {
    const resolved = this.resolveServer(family);
    return {
      configured: Boolean(this.config.servers[family]),
      resolvedPath: resolved.resolvedPath,
      command: [resolved.config.command, ...resolved.resolvedArgs],
      reason: resolved.unavailableReason,
    };
  }

  /** Status snapshot of started servers (does not trigger startup). */
  status(): LspServerStatus[] {
    return LSP_FAMILIES.map((family) => {
      const entry = this.entries.get(family);
      const resolved = entry?.resolved ?? this.resolveServer(family);
      return {
        family,
        languages: [...LANGUAGES_BY_FAMILY[family]],
        configured: Boolean(this.config.servers[family]),
        command: [resolved.config.command, ...resolved.resolvedArgs],
        resolvedPath: resolved.resolvedPath,
        state: entry?.state ?? 'stopped',
        pid: entry?.child?.pid ?? null,
        startedAt: entry?.startedAt ?? null,
        lastUsedAt: entry ? entry.lastUsedAt : null,
        requestCount: entry?.requestCount ?? 0,
        openDocuments: entry?.documents.size ?? 0,
        indexing: this.isIndexing(entry),
        capabilities: entry?.capabilities ?? null,
        lastError: entry?.lastError ?? null,
        stderrTail: entry ? [...entry.stderrTail] : [],
      } satisfies LspServerStatus;
    });
  }

  /** Whether any server process already exists (for diagnostics/status; does not start one). */
  hasLiveServer(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.child && entry.state !== 'stopped') return true;
    }
    return false;
  }

  /** Effective timeouts, reported faithfully in results to ease troubleshooting. */
  getTimeouts(): {
    idleTimeoutMs: number;
    initTimeoutMs: number;
    requestTimeoutMs: number;
    diagnosticsTimeoutMs: number;
    warmupTimeoutMs: number;
  } {
    return {
      idleTimeoutMs: this.config.idleTimeoutMs,
      initTimeoutMs: this.config.initTimeoutMs,
      requestTimeoutMs: this.config.requestTimeoutMs,
      diagnosticsTimeoutMs: this.config.diagnosticsTimeoutMs,
      warmupTimeoutMs: this.config.warmupTimeoutMs,
    };
  }

  /** Shut down all server processes. */
  async shutdownAll(): Promise<void> {
    const families = [...this.entries.keys()];
    await Promise.all(families.map((family) => this.shutdownFamily(family, 'shutdown')));
    this.clearIdleTimer();
    this.clearLeaseTimer();
    // 兜底清理本项目的残留记录；同一 daemon 中其它项目的 live 租约必须保留。
    if (this.leaseEnabled) {
      try {
        releaseAllLspLeases(process.pid, this.options.leaseDir, this.projectRoot);
      } catch {
        /* best-effort：租约清理失败不能影响关闭流程 */
      }
    }
  }

  /** Mark the manager closed; later calls fail outright and processes are reclaimed on close. */
  async close(): Promise<void> {
    this.closed = true;
    await this.shutdownAll();
  }

  /** Idle sweep: servers unused for longer than idleTimeoutMs exit (public so tests can trigger it manually). */
  async sweepIdle(now = this.nowMs()): Promise<LspFamily[]> {
    const timeout = this.config.idleTimeoutMs;
    if (timeout <= 0) return [];
    const idle: LspFamily[] = [];
    for (const [family, entry] of this.entries) {
      if (!entry.child) continue;
      if (entry.state !== 'ready' || entry.startPromise || entry.shutdownPromise || entry.activeQueries > 0) continue;
      if (now - entry.lastUsedAt < timeout) continue;
      idle.push(family);
    }
    for (const family of idle) await this.shutdownFamily(family, 'idle');
    return idle;
  }

  // ------------------------------------------------------- Resource governance (phase 1)

  /** 本 manager 当前 live 的 family 数（已启动且未停止）。 */
  private countLiveFamilies(): number {
    let live = 0;
    for (const entry of this.entries.values()) {
      if (this.isLiveEntry(entry)) live += 1;
    }
    return live;
  }

  private isLiveEntry(entry: ServerEntry): boolean {
    return entry.child !== null && entry.state !== 'stopped';
  }

  /** 「可安全关闭」：ready、无活跃请求、没有正在进行的启动/关闭；软上限与全局预算共用同一判据。 */
  private isCloseable(entry: ServerEntry): boolean {
    return entry.child !== null
      && entry.state === 'ready'
      && entry.activeQueries === 0
      && !entry.startPromise
      && !entry.shutdownPromise;
  }

  /** 可关闭候选，按 `lastUsedAt` 升序（最久未使用在前）；`exclude` 用于排除正在请求的 family。 */
  private closeableEntries(exclude?: LspFamily): ServerEntry[] {
    const out: ServerEntry[] = [];
    for (const [family, entry] of this.entries) {
      if (family === exclude) continue;
      if (this.isCloseable(entry)) out.push(entry);
    }
    return out.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  }

  /**
   * 每项目软上限（要求 b）：真正启动一个新的 family 之前，如果本 manager 的 live family 数
   * 已达到 `profile.lspPerProjectSoftMax`，先关闭最久未使用的**空闲** server。
   *
   * 软上限的含义：没有可关闭的空闲 server 时**不阻塞查询**，允许临时超出，只记一条 stderr
   * 日志。绝不关闭有活跃请求（`activeQueries > 0`）或正在启动/关闭的 server。
   */
  private async evictForPerProjectLimit(starting: LspFamily): Promise<void> {
    if (!this.governanceActive) return;
    const softMax = this.profile.lspPerProjectSoftMax;
    if (!Number.isFinite(softMax) || softMax <= 0) return;
    if (this.countLiveFamilies() < softMax) return;

    const candidate = this.closeableEntries(starting)[0];
    if (!candidate) {
      lspLog(
        `per-project LSP soft limit ${softMax} reached and no idle server can be closed; starting ${starting} anyway`,
      );
      return;
    }
    lspLog(`per-project LSP soft limit ${softMax}: closing idle ${candidate.family} before starting ${starting}`);
    await this.shutdownFamily(candidate.family, 'budget');
  }

  /**
   * 全局预算协作回收（要求 c + 开发计划 §4「超过全局上限时按最久未使用且无活跃请求的顺序退出」）。
   *
   * 语义是**跨 daemon 的全局 LRU**：超出的名额是 `excess = 租约总数 - lspGlobalMax`，
   * 只有全局租约列表里**最旧的 excess 条**中属于本 manager（同项目根 + family）的空闲
   * server 才让位；绝不为了凑数关闭「不是最旧」的自己的 server，否则持有最旧租约的另一个
   * daemon 会继续超预算、而本 daemon 反复杀掉刚启动的服务器。
   *
   * 这是**协作式**设计：本方法只关闭自己的服务器，绝不跨进程 kill。最旧的那批租约都不属于
   * 本 manager，或属于本 manager 但都有活跃请求时，什么都不做（只记 debug 日志）。
   * 返回实际关闭的 family 列表（reason 一律为 `budget`）。
   */
  async sweepGlobalBudget(now = this.nowMs()): Promise<LspFamily[]> {
    if (!this.leaseEnabled) return [];
    const max = this.profile.lspGlobalMax;
    if (!Number.isFinite(max) || max < 0) return [];

    let leases: LspLeaseRecord[];
    try {
      // listLiveLspLeases 已按 startedAt 升序（最旧在前）。
      leases = listLiveLspLeases(now, LSP_LEASE_STALE_MS, this.options.leaseDir);
    } catch {
      return [];
    }
    const excess = leases.length - max;
    if (excess <= 0) return [];

    const ownRoot = path.resolve(this.projectRoot);
    const oldestOwnFamilies = new Set<LspFamily>();
    for (const lease of leases.slice(0, excess)) {
      if (path.resolve(lease.root) !== ownRoot) continue;
      if (!this.entries.has(lease.family)) continue;
      oldestOwnFamilies.add(lease.family);
    }
    if (oldestOwnFamilies.size === 0) {
      lspDebug(
        `global LSP budget exceeded (${leases.length} > ${max}) but the oldest ${excess} lease(s) belong to other daemons; `
        + 'leaving recovery to them',
      );
      return [];
    }

    // 本 manager 自己的 LRU 顺序（lastUsedAt 升序），只保留最旧租约命中的 family。
    const candidates = this.closeableEntries().filter((entry) => oldestOwnFamilies.has(entry.family));
    const closed: LspFamily[] = [];
    let live = leases.length;
    for (const entry of candidates) {
      if (live <= max) break;
      const current = this.entries.get(entry.family);
      // 候选是快照，关闭前再确认一次：期间可能已有新请求进来。
      if (!current || !this.isCloseable(current)) continue;
      lspLog(`global LSP budget: ${live} live leases exceed max ${max}; closing idle ${entry.family} (oldest lease)`);
      await this.shutdownFamily(entry.family, 'budget');
      closed.push(entry.family);
      live -= 1;
    }
    if (closed.length === 0) {
      lspDebug(
        `global LSP budget exceeded (${live} > ${max}) but this manager's oldest lease(s) are busy; `
        + 'leaving recovery to the next sweep',
      );
    }
    return closed;
  }

  /**
   * 刷新本 manager 每个 live family 的租约心跳与资源指标（要求 d/e）。
   *
   * 由独立的 30 秒 unref 定时器调用，**不受 `idleSweep: false`（测试模式）影响**；
   * 心跳间隔（30s）必须明显小于注册表的 60s 陈旧窗口。
   */
  heartbeatLeases(now = this.nowMs()): void {
    if (!this.leaseEnabled) return;
    let liveServers = 0;
    for (const entry of this.entries.values()) {
      if (!this.isLiveEntry(entry)) continue;
      liveServers += 1;
      try {
        heartbeatLspLease(this.projectRoot, entry.family, entry.activeQueries, now, this.options.leaseDir);
      } catch {
        /* best-effort：单条心跳失败不影响其它 family */
      }
    }
    let globalLeases = 0;
    try {
      globalLeases = countLiveLspLeases(now, this.options.leaseDir);
    } catch {
      globalLeases = 0; // 注册表不可用时按 0 上报（status 只降级展示）
    }
    resourceMetrics().setLspGauges(liveServers, globalLeases);
    if (liveServers === 0) this.clearLeaseTimer();
  }

  /** 第一个 server 启动成功时创建；与 idle sweep 定时器相互独立。 */
  private ensureLeaseTimer(): void {
    if (this.leaseTimer) return;
    this.leaseTimer = setInterval(() => {
      try {
        this.heartbeatLeases();
      } catch (err) {
        lspDebug(`lease heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, LEASE_HEARTBEAT_INTERVAL_MS);
    this.leaseTimer.unref?.();
  }

  private clearLeaseTimer(): void {
    if (!this.leaseTimer) return;
    clearInterval(this.leaseTimer);
    this.leaseTimer = null;
  }

  // ---------------------------------------------------------------- Query entry points

  async definition(filePath: string, position: LspPosition, language: Language | null): Promise<LspQueryOutcome<LspLocation>> {
    const entry = await this.requireServer(language);
    await this.syncDocument(entry, filePath, language);
    return this.requestWithWarmupRetry(entry, 'textDocument/definition', {
      textDocument: { uri: pathToUri(filePath) },
      position,
    }, normalizeLocations);
  }

  async references(
    filePath: string,
    position: LspPosition,
    language: Language | null,
    includeDeclaration: boolean,
  ): Promise<LspQueryOutcome<LspLocation>> {
    const entry = await this.requireServer(language);
    await this.syncDocument(entry, filePath, language);
    return this.requestWithWarmupRetry(entry, 'textDocument/references', {
      textDocument: { uri: pathToUri(filePath) },
      position,
      context: { includeDeclaration },
    }, normalizeLocations);
  }

  async documentSymbols(filePath: string, language: Language | null): Promise<LspQueryOutcome<LspSymbolNode>> {
    const entry = await this.requireServer(language);
    await this.syncDocument(entry, filePath, language);
    return this.requestWithWarmupRetry(entry, 'textDocument/documentSymbol', {
      textDocument: { uri: pathToUri(filePath) },
    }, normalizeDocumentSymbols);
  }

  /**
   * `textDocument/rename` → the workspace edit the server would apply. Nothing is written here: the
   * caller validates, previews and (only with `apply: true`) writes the files.
   *
   * A server that does not advertise `renameProvider` is reported as unavailable instead of being
   * asked anyway — a textual fallback would rewrite strings, comments and same-named locals.
   */
  async rename(
    filePath: string,
    position: LspPosition,
    language: Language | null,
    newName: string,
  ): Promise<LspQueryOutcome<LspWorkspaceEditOperation>> {
    const entry = await this.requireServer(language);
    await this.syncDocument(entry, filePath, language);
    if (entry.capabilities && !entry.capabilities.rename) {
      throw new LspUnavailableError(
        entry.family,
        `the ${entry.family} language server does not advertise textDocument/rename`,
        'Rename needs a server with rename support; edit the file directly, or point .codegraph/lsp.json at a fuller server.',
      );
    }
    return this.requestWithWarmupRetry(entry, 'textDocument/rename', {
      textDocument: { uri: pathToUri(filePath) },
      position,
      newName,
    }, normalizeWorkspaceEdit);
  }

  /**
   * 把已经提交的工作区编辑同步给当前存活的语言服务器；不会为通知而启动新进程。
   * 不支持 workspace 文件事件的服务器仍会收到旧文档 didClose，避免继续持有已删除路径。
   */
  notifyFileOperations(files: EditFilePreview[]): string[] {
    const warnings: string[] = [];
    const creates = files.filter((file) => file.operation === 'create');
    const renames = files.filter((file) => file.operation === 'rename');
    const deletes = files.filter((file) => file.operation === 'delete');

    for (const entry of this.entries.values()) {
      if (!this.isLiveEntry(entry) || !entry.connection) continue;
      for (const file of [...renames, ...deletes]) {
        const oldUri = pathToUri(path.resolve(this.projectRoot, file.filePath));
        const key = uriKey(oldUri);
        if (entry.documents.has(key)) {
          entry.connection.notify('textDocument/didClose', { textDocument: { uri: oldUri } });
          entry.documents.delete(key);
        }
      }
      for (const file of files.filter((candidate) => candidate.operation === 'modify')) {
        const absolute = path.resolve(this.projectRoot, file.filePath);
        const uri = pathToUri(absolute);
        const document = entry.documents.get(uriKey(uri));
        if (!document) continue;
        try {
          const text = fs.readFileSync(absolute, 'utf-8');
          const stat = fs.statSync(absolute);
          document.version += 1;
          document.mtimeMs = stat.mtimeMs;
          document.size = stat.size;
          document.lastUsedAt = this.nowMs();
          entry.connection.notify('textDocument/didChange', {
            textDocument: { uri, version: document.version }, contentChanges: [{ text }],
          });
        } catch {
          entry.connection.notify('textDocument/didClose', { textDocument: { uri } });
          entry.documents.delete(uriKey(uri));
        }
      }

      const unsupported: string[] = [];
      if (creates.length > 0) {
        if (entry.capabilities?.fileOperations.create) {
          entry.connection.notify('workspace/didCreateFiles', {
            files: creates.map((file) => ({ uri: pathToUri(path.resolve(this.projectRoot, file.filePath)) })),
          });
        } else unsupported.push('create');
      }
      if (renames.length > 0) {
        if (entry.capabilities?.fileOperations.rename) {
          entry.connection.notify('workspace/didRenameFiles', {
            files: renames.map((file) => ({
              oldUri: pathToUri(path.resolve(this.projectRoot, file.filePath)),
              newUri: pathToUri(path.resolve(this.projectRoot, file.movedTo!)),
            })),
          });
        } else unsupported.push('rename');
      }
      if (deletes.length > 0) {
        if (entry.capabilities?.fileOperations.delete) {
          entry.connection.notify('workspace/didDeleteFiles', {
            files: deletes.map((file) => ({ uri: pathToUri(path.resolve(this.projectRoot, file.filePath)) })),
          });
        } else unsupported.push('delete');
      }
      if (unsupported.length > 0) {
        warnings.push(
          `The ${entry.family} language server does not advertise workspace ${unsupported.join('/')} notifications; `
          + 'CodeGraph closed any old document and the next query will reopen current paths from disk.',
        );
      }
    }
    return warnings;
  }

  /**
   * Diagnostics: prefer pull (when the server declares diagnosticProvider); on failure, or when it
   * is not declared, wait for `publishDiagnostics`. Within the wait window the last non-empty
   * publish wins; if the window ends still empty, return an empty set (the server may genuinely
   * have no diagnostics) and label the source faithfully.
   */
  async diagnostics(
    filePath: string,
    language: Language | null,
  ): Promise<{ items: LspDiagnostic[]; source: 'pull' | 'push' | 'cache' | 'none'; retried: boolean }> {
    const entry = await this.requireServer(language);
    return this.withActiveQuery(entry, async () => {
      await this.syncDocument(entry, filePath, language);
      const uri = pathToUri(filePath);
      const key = uriKey(uri);
      const first = await this.collectDiagnostics(entry, uri, key, entry.diagnostics.get(key)?.generation ?? -1);
      const busy = this.isIndexing(entry);
      const freshEmpty = !entry.emptyRetryDone && this.shouldRetryAfterWarmup(entry);
      if (first.items.length > 0 || (!busy && !freshEmpty)) return { ...first, retried: false };

      // 刚启动时的空诊断可能只是尚未分析完成，等索引稳定后再查一次。
      if (freshEmpty) entry.emptyRetryDone = true;
      await this.waitForIndexing(entry, true);
      const second = await this.collectDiagnostics(entry, uri, key, -1);
      return { items: second.items, source: second.source, retried: true };
    });
  }

  /** Pull diagnostics or wait for a push; an empty result is a legitimate result. */
  private async collectDiagnostics(
    entry: ServerEntry,
    uri: string,
    key: string,
    afterGeneration: number,
  ): Promise<{ items: LspDiagnostic[]; source: 'pull' | 'push' | 'cache' | 'none' }> {
    if (entry.capabilities?.diagnostics === 'pull') {
      try {
        const result = await this.request(
          entry,
          'textDocument/diagnostic',
          { textDocument: { uri } },
          Math.min(this.config.requestTimeoutMs, this.config.diagnosticsTimeoutMs),
        );
        if (isRecord(result) && result.kind === 'unchanged') {
          // "unchanged" is the protocol's authoritative "same as last time" answer, not a stale cache.
          const cached = entry.diagnostics.get(key);
          return cached ? { items: [...cached.items], source: 'pull' } : { items: [], source: 'pull' };
        }
        if (isRecord(result) && Array.isArray(result.items)) {
          const items = normalizeDiagnostics(result.items);
          this.storeDiagnostics(entry, key, items);
          return { items, source: 'pull' };
        }
      } catch (err) {
        // Unsupported/protocol errors all degrade to waiting for a push; one query is not turned into a failure.
        lspDebug(`${entry.family}: pull diagnostics unavailable (${err instanceof Error ? err.message : String(err)}); waiting for publishDiagnostics`);
      }
    }
    const published = await this.waitForPublish(entry, key, afterGeneration, PUBLISH_WAIT_MS);
    if (published) return { items: published, source: 'push' };
    const cached = entry.diagnostics.get(key);
    if (cached) return { items: [...cached.items], source: 'cache' };
    return { items: [], source: 'none' };
  }

  // ------------------------------------------------------------ Internal: lifecycle

  private readConfig(): LspProjectConfig {
    return this.options.loadConfig
      ? this.options.loadConfig(this.projectRoot)
      : loadLspConfig(this.projectRoot);
  }

  private currentConfigMtime(): number {
    try {
      return fs.statSync(getLspConfigPath(this.projectRoot)).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * Rebuild when the config file changes: shut down every started server and re-read the config.
   * This way edits to `lsp.json` (swapping commands, adding initialization options) take effect on
   * the next query without restarting the MCP.
   */
  private async refreshConfigIfChanged(): Promise<void> {
    const mtime = this.currentConfigMtime();
    if (mtime === this.configMtimeMs) return;
    this.configMtimeMs = mtime;
    this.config = this.readConfig();
    if (this.entries.size > 0) {
      lspLog('configuration changed; restarting language servers for this project');
      await this.shutdownAll();
      this.entries.clear();
    }
  }

  private resolveServer(family: LspFamily, prepare = false): ResolvedServer {
    const configured = this.config.servers[family];
    const fallback = configured ?? DEFAULT_SERVERS[family].candidates[0]!;
    const config: LspServerConfig = {
      command: fallback.command,
      args: fallback.args ?? [],
    };
    if (configured) {
      config.args = configured.args ?? [];
      if (configured.cwd) config.cwd = configured.cwd;
      if (configured.env) config.env = configured.env;
      if (configured.initializationOptions !== undefined) {
        config.initializationOptions = configured.initializationOptions;
      }
    }

    if (this.config.disabled.includes(family)) {
      return {
        family, config, resolvedPath: null, resolvedArgs: config.args ?? [],
        unavailableReason: `${family} is disabled in .codegraph/lsp.json`,
      };
    }

    const baseDir = config.cwd ? path.resolve(this.projectRoot, config.cwd) : this.projectRoot;
    const lookup = resolveExecutable(config.command, baseDir);
    if (!lookup.path) {
      return {
        family, config, resolvedPath: null, resolvedArgs: config.args ?? [],
        unavailableReason: lookup.reason ?? `command not found: ${config.command}`,
      };
    }
    return {
      family,
      config,
      resolvedPath: lookup.path,
      resolvedArgs: this.withFamilyArgs(family, config, lookup.path, prepare),
      unavailableReason: null,
    };
  }

  /**
   * jdt.ls requires `-data <workspace>`; when it is not given explicitly, add a directory
   * **outside the project root**.
   *
   * It cannot be inside the project root: Eclipse mounts the project directory as a linked
   * resource into its own workspace data directory, and if that data directory lies inside the
   * linked directory jdt.ls rejects it outright ("not a valid location for linked resources"),
   * after which every diagnostic degrades to "non-project file, only syntax errors are reported".
   * So the default is the user-level `~/.codegraph/lsp/jdtls/<project-hash>`, and the config may
   * override it explicitly.
   */
  private withFamilyArgs(
    family: LspFamily,
    config: LspServerConfig,
    resolvedPath: string,
    prepare: boolean,
  ): string[] {
    const args = [...(config.args ?? [])];
    if (family !== 'java') return args;
    if (args.some((arg) => arg === '-data' || arg.startsWith('-data='))) return args;
    const dataDir = defaultJdtlsWorkspaceDir(this.projectRoot);
    if (prepare) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
      } catch { /* let the server report the failure itself; better than swallowing it here */ }
      lspDebug(`${path.basename(resolvedPath)}: appending -data ${dataDir}`);
    }
    return [...args, '-data', dataDir];
  }

  /** Get (starting if needed) the server for a language family; throws LspUnavailableError when unavailable. */
  private async requireServer(language: Language | null): Promise<ServerEntry> {
    if (this.closed) throw new LspError('language server manager is closed', 'exit');
    await this.refreshConfigIfChanged();
    const family = familyForLanguage(language);
    if (!family) {
      throw new LspUnavailableError(
        'cpp',
        `no language server is mapped to language "${String(language)}"`,
        'supported languages: C/C++/JavaScript/TypeScript/Rust/Go/Java/Python',
      );
    }
    const { entry, error } = await this.ensureEntry(family);
    if (error || !entry) throw error ?? new LspError(`language server for ${family} is unavailable`, 'unsupported');
    return entry;
  }

  /** Lazy start: return the existing entry, or create one when needed. The second return value is the failure reason. */
  private async ensureEntry(
    family: LspFamily,
    depth = 0,
  ): Promise<{ entry: ServerEntry | null; error: Error | null }> {
    const existing = this.entries.get(family);
    if (existing && existing.state === 'ready' && existing.connection && !existing.connection.isClosed) {
      existing.lastUsedAt = this.nowMs();
      return { entry: existing, error: null };
    }
    // The server died mid-session: record a crash and fall through to the restart/suppression logic below.
    if (existing && existing.state === 'ready' && existing.connection?.isClosed) {
      existing.state = 'crashed';
      existing.lastError = existing.connection.closedReason ?? 'language server connection closed unexpectedly';
      lspLog(`${family}: ${existing.lastError}`);
      this.noteCrash(existing);
    }

    const now = this.nowMs();
    if (existing && existing.suppressedUntil > now) {
      return {
        entry: null,
        error: new LspUnavailableError(
          family,
          `language server ${family} crashed ${existing.crashTimes.length} times within 60s; restarts are paused`,
          this.remedyFor(family, existing.lastError),
        ),
      };
    }

    const entry = existing ?? this.createEntry(family);
    this.entries.set(family, entry);
    if (entry.startPromise) {
      // Concurrent calls share a single startup; re-evaluate after it settles, but re-enter only one
      // level to avoid a restart cascade on failure.
      await entry.startPromise.catch(() => undefined);
      if (depth >= 1) return { entry: null, error: new LspError(`language server ${family} failed to start`, 'exit') };
      return this.ensureEntry(family, depth + 1);
    }

    if (entry.resolved.unavailableReason) {
      return {
        entry: null,
        error: new LspUnavailableError(family, entry.resolved.unavailableReason, this.remedyFor(family, null)),
      };
    }

    // 每项目软上限（要求 b）：只在「马上要真正启动一个新 family」时驱逐一次，
    // 复用已有 server、配置不可用、并发共享启动的路径都不受影响。
    if (!entry.child) await this.evictForPerProjectLimit(family);

    entry.startPromise = this.startServer(entry);
    try {
      await entry.startPromise;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // The most common startup failure is the server printing one error line and exiting (e.g. an
      // unacceptable JDK version for jdt.ls). Carry those lines along, or callers see only an
      // uninformative exit code.
      const tail = entry.stderrTail.slice(-3).map((line) => line.trim().slice(0, 200)).filter(Boolean);
      const message = tail.length > 0 ? `${raw}; server output: ${tail.join(' | ')}` : raw;
      entry.lastError = message;
      entry.state = 'crashed';
      this.noteCrash(entry);
      return {
        entry: null,
        error: new LspUnavailableError(family, `failed to start the ${family} language server: ${message}`, this.remedyFor(family, message)),
      };
    } finally {
      entry.startPromise = null;
    }
    return { entry, error: null };
  }

  private remedyFor(family: LspFamily, detail: string | null): string {
    const note = DEFAULT_SERVERS[family].note;
    const base = `set a command/args for "${family}" in the project's .codegraph/lsp.json (or CODEGRAPH_LSP_${family.toUpperCase()}_COMMAND)`;
    const parts = [base];
    if (note) parts.push(note);
    if (detail) parts.push(detail);
    return parts.join('; ');
  }

  private createEntry(family: LspFamily): ServerEntry {
    return {
      family,
      resolved: this.resolveServer(family, true),
      state: 'stopped',
      child: null,
      connection: null,
      capabilities: null,
      startedAt: null,
      lastUsedAt: this.nowMs(),
      requestCount: 0,
      activeQueries: 0,
      stderrTail: [],
      lastError: null,
      startPromise: null,
      crashTimes: [],
      suppressedUntil: 0,
      progressTokens: new Set(),
      quiescent: null,
      sawIndexSignal: false,
      emptyRetryDone: false,
      idleWaiters: [],
      diagnostics: new Map(),
      diagnosticsGeneration: 0,
      diagnosticWaiters: new Map(),
      documents: new Map(),
      shutdownPromise: null,
    };
  }

  private noteCrash(entry: ServerEntry): void {
    const now = this.nowMs();
    entry.crashTimes = [...entry.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    if (entry.crashTimes.length >= MAX_CRASHES_PER_WINDOW) {
      entry.suppressedUntil = now + CRASH_WINDOW_MS;
      lspLog(`${entry.family}: ${entry.crashTimes.length} crashes within 60s; suppressing restarts for 60s`);
    }
  }

  private async startServer(entry: ServerEntry): Promise<void> {
    const resolvedPath = entry.resolved.resolvedPath;
    if (!resolvedPath) throw new Error(entry.resolved.unavailableReason ?? 'no executable');
    const cwd = entry.resolved.config.cwd
      ? path.resolve(this.projectRoot, entry.resolved.config.cwd)
      : this.projectRoot;
    entry.state = 'starting';
    entry.lastError = null;

    const child = spawnServer(resolvedPath, entry.resolved.resolvedArgs, {
      cwd,
      env: entry.resolved.config.env,
    });
    registerChild(child);
    entry.child = child;
    entry.startedAt = this.nowMs();

    const connection = new LspConnection(child, {
      onLog: (line) => this.pushStderr(entry, line),
      onNotification: (method, params) => this.handleNotification(entry, method, params),
      onRequest: (method, params) => this.handleServerRequest(entry, method, params),
    });
    entry.connection = connection;

    const failure = new Promise<never>((_, reject) => {
      child.once('error', (err) => reject(new Error(`spawn failed: ${err.message}`)));
      child.once('exit', (code, signal) => {
        reject(new Error(`language server exited during initialize (code ${code ?? 'null'}, signal ${signal ?? 'null'})`));
      });
    });
    // After a successful initialize this promise may still reject because the process exits; with no
    // consumer it would become an unhandled rejection, so attach an empty catch up front.
    void failure.catch(() => undefined);

    const initializeParams = {
      processId: process.pid,
      clientInfo: { name: 'codegraph' },
      rootUri: pathToUri(this.projectRoot),
      workspaceFolders: [{ uri: pathToUri(this.projectRoot), name: path.basename(this.projectRoot) }],
      capabilities: {
        workspace: {
          workspaceFolders: true,
          configuration: false,
          didChangeConfiguration: { dynamicRegistration: false },
          fileOperations: {
            dynamicRegistration: false,
            didCreate: true,
            didRename: true,
            didDelete: true,
          },
        },
        textDocument: {
          synchronization: { dynamicRegistration: false, willSave: false, didSave: false },
          definition: { linkSupport: false },
          references: {},
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
            symbolKind: { valueSet: SYMBOL_KIND_VALUE_SET },
          },
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          publishDiagnostics: { versionSupport: true, relatedInformation: false },
        },
        window: { workDoneProgress: true },
        general: { positionEncodings: ['utf-16'] },
      },
      initializationOptions: entry.resolved.config.initializationOptions ?? {},
      trace: 'off',
    };

    try {
      const result = await Promise.race([
        connection.request('initialize', initializeParams, this.config.initTimeoutMs),
        failure,
      ]);
      entry.capabilities = capabilitiesFromInitialize(result);
      connection.notify('initialized', {});
      entry.state = 'ready';
      // 启动耗时指标 + 跨 daemon 租约（要求 d/e）：都在 initialize 成功后登记，
      // 启动失败的 server 不写租约（否则会凭空多出一个全局 lease）。
      const startedAt = entry.startedAt ?? this.nowMs();
      resourceMetrics().recordLspStart(Math.max(0, this.nowMs() - startedAt));
      if (this.leaseEnabled) {
        try {
          acquireLspLease({
            root: this.projectRoot,
            family: entry.family,
            now: startedAt,
            dir: this.options.leaseDir,
          });
          this.ensureLeaseTimer();
        } catch {
          /* best-effort：租约写入失败不影响服务器可用性 */
        }
      }
      lspLog(`${entry.family}: ${path.basename(resolvedPath)} ready (pid ${child.pid ?? '?'}, encoding ${entry.capabilities.positionEncoding}, diagnostics ${entry.capabilities.diagnostics})`);
    } catch (err) {
      await this.stopEntry(entry, 'crash');
      throw err instanceof Error ? err : new Error(String(err));
    }

    // Unexpected exit after ready: keep the reason, set the state to crashed, and let the next query go through bounded restarts.
    child.on('exit', (code, signal) => {
      if (entry.state === 'stopped') return;
      entry.state = 'crashed';
      entry.lastError = `language server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`;
      // 服务器进程已经不存在：立即释放租约并记一条 crash 停止指标，避免崩溃后继续
      // 占用全局预算（下一次查询重启成功时会重新 acquire / recordLspStart）。
      if (this.leaseEnabled) {
        try {
          releaseLspLease(this.projectRoot, entry.family, this.options.leaseDir);
        } catch {
          /* best-effort：注册表不可用不影响崩溃处理 */
        }
      }
      resourceMetrics().recordLspStop('crash');
      this.noteCrash(entry);
      lspLog(`${entry.family}: ${entry.lastError}`);
    });
  }

  private pushStderr(entry: ServerEntry, line: string): void {
    entry.stderrTail.push(line);
    if (entry.stderrTail.length > STDERR_TAIL_LINES) entry.stderrTail.splice(0, entry.stderrTail.length - STDERR_TAIL_LINES);
    lspDebug(`${entry.family}: ${line}`);
  }

  private handleNotification(entry: ServerEntry, method: string, params: unknown): void {
    if (method === 'textDocument/publishDiagnostics') {
      if (!isRecord(params) || typeof params.uri !== 'string') return;
      const key = uriKey(params.uri);
      this.storeDiagnostics(entry, key, normalizeDiagnostics(params.diagnostics));
      const waiters = entry.diagnosticWaiters.get(key);
      if (waiters && waiters.length > 0) {
        entry.diagnosticWaiters.delete(key);
        for (const wake of waiters) wake();
      }
      return;
    }
    if (method === '$/progress') {
      if (!isRecord(params)) return;
      const token = params.token;
      if (typeof token !== 'string' && typeof token !== 'number') return;
      const key = String(token);
      const value = isRecord(params.value) ? params.value : {};
      if (value.kind === 'end') entry.progressTokens.delete(key);
      else entry.progressTokens.add(key);
      entry.sawIndexSignal = true;
      this.notifyIdleWaiters(entry);
      return;
    }
    if (method === 'experimental/serverStatus') {
      // rust-analyzer's "indexing finished" signal; more reliable than $/progress.
      if (!isRecord(params)) return;
      entry.sawIndexSignal = true;
      if (typeof params.quiescent === 'boolean') {
        entry.quiescent = params.quiescent;
        this.notifyIdleWaiters(entry);
      }
      return;
    }
    if (method === 'window/logMessage' || method === 'window/showMessage') {
      if (isRecord(params) && typeof params.message === 'string') this.pushStderr(entry, params.message);
      return;
    }
    lspDebug(`${entry.family}: unhandled notification ${method}`);
  }

  /** Answers to server-initiated requests; `workspace/configuration` must return an array as long as items. */
  private handleServerRequest(entry: ServerEntry, method: string, params: unknown): unknown {
    switch (method) {
      case 'workspace/configuration': {
        const items = isRecord(params) && Array.isArray(params.items) ? params.items : [];
        return items.map(() => null);
      }
      case 'workspace/workspaceFolders':
        return [{ uri: pathToUri(this.projectRoot), name: path.basename(this.projectRoot) }];
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
        return null;
      default:
        lspDebug(`${entry.family}: unhandled server request ${method}`);
        return null;
    }
  }

  private storeDiagnostics(entry: ServerEntry, key: string, items: LspDiagnostic[]): void {
    entry.diagnosticsGeneration += 1;
    entry.diagnostics.set(key, { items, generation: entry.diagnosticsGeneration });
  }

  private waitForPublish(
    entry: ServerEntry,
    key: string,
    afterGeneration: number,
    timeoutMs: number,
  ): Promise<LspDiagnostic[] | null> {
    const current = entry.diagnostics.get(key);
    if (current && current.generation > afterGeneration) {
      // A publish already arrived after the previous request (e.g. one triggered by didOpen); look at it first.
      const first = [...current.items];
      if (first.length > 0) return Promise.resolve(first);
    }
    return new Promise<LspDiagnostic[] | null>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const waiters = entry.diagnosticWaiters.get(key);
        if (waiters) {
          const remaining = waiters.filter((w) => w !== wake);
          if (remaining.length > 0) entry.diagnosticWaiters.set(key, remaining);
          else entry.diagnosticWaiters.delete(key);
        }
        const latest = entry.diagnostics.get(key);
        if (!latest || latest.generation <= afterGeneration) { resolve(null); return; }
        resolve([...latest.items]);
      };
      const wake = (): void => finish();
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      const waiters = entry.diagnosticWaiters.get(key) ?? [];
      waiters.push(wake);
      entry.diagnosticWaiters.set(key, waiters);
    });
  }

  /**
   * Document sync: open documents only for the files this query touches; a disk change sends a
   * whole-document didChange (LSP allows full sync), and a vanished file sends didClose.
   */
  private async syncDocument(entry: ServerEntry, filePath: string, language: Language | null): Promise<void> {
    const uri = pathToUri(filePath);
    const key = uriKey(uri);
    const languageId = languageIdFor(language) ?? 'plaintext';
    let text: string;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
      text = fs.readFileSync(filePath, 'utf-8');
    } catch {
      if (entry.documents.has(key)) {
        entry.connection?.notify('textDocument/didClose', { textDocument: { uri } });
        entry.documents.delete(key);
      }
      return;
    }

    const existing = entry.documents.get(key);
    if (!existing) {
      entry.connection?.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text },
      });
      entry.documents.set(key, {
        uri, filePath, languageId, version: 1,
        mtimeMs: stat.mtimeMs, size: stat.size, lastUsedAt: this.nowMs(),
      });
    } else {
      existing.lastUsedAt = this.nowMs();
      if (existing.mtimeMs !== stat.mtimeMs || existing.size !== stat.size) {
        existing.version += 1;
        existing.mtimeMs = stat.mtimeMs;
        existing.size = stat.size;
        entry.connection?.notify('textDocument/didChange', {
          textDocument: { uri, version: existing.version },
          contentChanges: [{ text }],
        });
      }
    }
    this.pruneDocuments(entry, key);
  }

  private pruneDocuments(entry: ServerEntry, keepKey: string): void {
    if (entry.documents.size <= MAX_OPEN_DOCUMENTS) return;
    const ordered = [...entry.documents.entries()]
      .filter(([key]) => key !== keepKey)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    while (entry.documents.size > MAX_OPEN_DOCUMENTS && ordered.length > 0) {
      const oldest = ordered.shift()!;
      entry.connection?.notify('textDocument/didClose', { textDocument: { uri: oldest[1].uri } });
      entry.documents.delete(oldest[0]);
    }
  }

  private async request(entry: ServerEntry, method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const connection = entry.connection;
    if (!connection || connection.isClosed) {
      throw new LspError(`language server ${entry.family} is not connected`, 'exit');
    }
    await this.waitForIndexing(entry);
    entry.lastUsedAt = this.nowMs();
    this.ensureIdleTimer();

    // ContentModified(-32801) / ServerCancelled(-32802) are **transient** errors defined by LSP:
    // the server cancelled the request because the document changed. The standard client behavior
    // is to retry rather than report a recoverable cancellation as a failed query.
    let lastError: unknown;
    for (let attempt = 0; attempt <= TRANSIENT_RETRY_ATTEMPTS; attempt += 1) {
      entry.requestCount += 1;
      try {
        return await connection.request(method, params, timeoutMs ?? this.config.requestTimeoutMs);
      } catch (err) {
        lastError = err;
        const code = err instanceof LspError ? err.code : null;
        const transient = code === -32801 || code === -32802;
        if (!transient || attempt === TRANSIENT_RETRY_ATTEMPTS) throw err;
        lspDebug(`${entry.family}: ${method} got transient error ${code}; retrying`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS);
          timer.unref?.();
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Whether the server is still indexing/analyzing (unfinished $/progress, or RA reports quiescent=false). */
  private isIndexing(entry: ServerEntry | undefined): boolean {
    if (!entry) return false;
    if (entry.quiescent === false) return true;
    return entry.progressTokens.size > 0;
  }

  /**
   * Whether an empty result is worth "waiting for indexing to finish and trying once more".
   *
   * Done once and only for a just-started server: still empty after indexing means there really is
   * no result, and waiting again would merely be wasted.
   */
  private shouldRetryAfterWarmup(entry: ServerEntry): boolean {
    if (entry.emptyRetryDone) return false;
    if (entry.startedAt === null) return false;
    return this.nowMs() - entry.startedAt < WARMUP_RETRY_WINDOW_MS;
  }

  /**
   * Request + warmup retry: when the first result is empty and the server just started, wait for
   * indexing to finish and request once more.
   *
   * Why "wait for indexing before the request" is not enough: after initialize and before it truly
   * begins indexing, a language server has a short window where it reports neither progress nor
   * quiescent, so the request returns **empty** at once — callers cannot distinguish "the symbol
   * does not exist" from "indexing is not done". Retrying an empty result once covers that window,
   * while a genuinely absent symbol only costs one extra request.
   */
  private async requestWithWarmupRetry<T>(
    entry: ServerEntry,
    method: string,
    params: unknown,
    extract: (result: unknown) => T[],
    timeoutMs?: number,
  ): Promise<LspQueryOutcome<T>> {
    return this.withActiveQuery(entry, async () => {
      const first = extract(await this.request(entry, method, params, timeoutMs));
      if (first.length > 0) return { items: first, retried: false };

      // 服务器报告忙碌时允许再次等待，例如 rust-analyzer 重新加载依赖；
      // 首次启动的额外重试才受 emptyRetryDone 限制。
      const busy = this.isIndexing(entry);
      const freshEmpty = !entry.emptyRetryDone && this.shouldRetryAfterWarmup(entry);
      if (!busy && !freshEmpty) return { items: first, retried: false };
      if (freshEmpty) entry.emptyRetryDone = true;

      await this.waitForIndexing(entry, true);
      const second = extract(await this.request(entry, method, params, timeoutMs));
      return { items: second, retried: true };
    });
  }

  /** 等待服务器分析也属于正在使用，不能被空闲清理中断。 */
  private async withActiveQuery<T>(entry: ServerEntry, query: () => Promise<T>): Promise<T> {
    entry.activeQueries += 1;
    try {
      return await query();
    } finally {
      entry.activeQueries -= 1;
      entry.lastUsedAt = this.nowMs();
    }
  }

  private notifyIdleWaiters(entry: ServerEntry): void {
    if (entry.idleWaiters.length === 0) return;
    const waiters = entry.idleWaiters;
    entry.idleWaiters = [];
    for (const wake of waiters) wake();
  }

  /**
   * Before the first query, wait for the server to finish indexing the project.
   *
   * Why this is needed: rust-analyzer / jdt.ls / gopls accept requests as soon as initialize
   * returns, but the project is not loaded yet, so definition/references return **empty** — to
   * callers "the symbol does not exist" and "indexing is not done" are completely
   * indistinguishable, exactly the kind of result the phase-one docs repeatedly insist must not be
   * fabricated. Once indexing finishes this wait returns immediately (no progress means no
   * waiting), so it only affects the cold start.
   *
   * `force` is for "empty result retries": judge after the server reports its indexing state even
   * when there is no progress signal right now.
   */
  private async waitForIndexing(entry: ServerEntry, force = false): Promise<void> {
    const timeoutMs = force
      ? Math.min(this.config.warmupTimeoutMs, FORCED_WARMUP_CAP_MS)
      : this.config.warmupTimeoutMs;
    if (timeoutMs <= 0) return;
    const settled = (): boolean => {
      if (entry.quiescent === true) return true;
      if (this.isIndexing(entry)) return false;
      // With no indexing signal ever received, "no progress" does not mean "indexing finished": in forced mode wait a bit longer.
      return entry.sawIndexSignal || !force;
    };
    if (settled()) return;

    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const remaining = timeoutMs - (Date.now() - started);
      const woke = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          const index = entry.idleWaiters.indexOf(wake);
          if (index >= 0) entry.idleWaiters.splice(index, 1);
          resolve(false);
        }, Math.max(50, Math.min(WARMUP_POLL_MS, remaining)));
        timer.unref?.();
        const wake = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        entry.idleWaiters.push(wake);
      });
      if (settled()) {
        const waited = Date.now() - started;
        if (waited > 50) lspDebug(`${entry.family}: waited ${waited}ms for indexing to finish`);
        return;
      }
      if (!woke && entry.connection?.isClosed) return;
    }
    lspDebug(`${entry.family}: still indexing after ${timeoutMs}ms; issuing the request anyway`);
  }

  private ensureIdleTimer(): void {
    if (this.options.idleSweep === false) return;
    if (this.idleTimer || this.config.idleTimeoutMs <= 0) return;
    this.idleTimer = setInterval(() => {
      void this.sweepIdle().catch((err) => lspDebug(`idle sweep failed: ${err instanceof Error ? err.message : String(err)}`));
      // 全局预算协作回收复用同一个 30 秒节拍（要求 c）。注意 `idleTimeoutMs: 0` 表示
      // 「常驻不退」，此时本定时器不创建，预算回收也随之关闭（与「不自动退出」的语义一致）。
      void this.sweepGlobalBudget().catch(
        (err) => lspDebug(`global budget sweep failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, IDLE_SWEEP_INTERVAL_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  /** Gracefully shut down one language family: shutdown → exit → wait for exit → kill if needed. */
  async shutdownFamily(family: LspFamily, reason: LspStopReason): Promise<void> {
    const entry = this.entries.get(family);
    if (!entry) return;
    if (entry.shutdownPromise) return entry.shutdownPromise;
    entry.shutdownPromise = this.stopEntry(entry, reason).finally(() => {
      entry.shutdownPromise = null;
    });
    return entry.shutdownPromise;
  }

  private async stopEntry(entry: ServerEntry, reason: LspStopReason): Promise<void> {
    const { connection, child } = entry;
    entry.state = 'stopped';
    entry.documents.clear();
    entry.capabilities = null;
    entry.progressTokens.clear();
    entry.quiescent = null;
    this.notifyIdleWaiters(entry);
    for (const [key, waiters] of entry.diagnosticWaiters) {
      for (const wake of waiters) wake();
      entry.diagnosticWaiters.delete(key);
    }
    // 停止即释放租约并记一条停止指标（要求 d/e）：放在拆连接之前，避免全局计数
    // 在「正在关闭」的窗口里仍把这个 server 算成 live。
    if (this.leaseEnabled) {
      try {
        releaseLspLease(this.projectRoot, entry.family, this.options.leaseDir);
      } catch {
        /* best-effort：租约删除失败不能影响关闭流程；下一次 listLive 会自愈 */
      }
    }
    resourceMetrics().recordLspStop(reason);

    if (connection && !connection.isClosed) {
      try {
        await connection.request('shutdown', null, SHUTDOWN_TIMEOUT_MS);
      } catch {
        // shutdown failed (protocol unsupported / process already crashed); continue with exit + kill.
      }
      connection.notify('exit', null);
      connection.endInput();
    }

    if (child) {
      await this.waitForExit(child, EXIT_GRACE_MS);
      if (child.exitCode === null && child.signalCode === null) {
        lspDebug(`${entry.family}: killing unresponsive server (pid ${child.pid ?? '?'})`);
        try { child.kill(); } catch { /* already exited */ }
      }
    }
    connection?.dispose();
    entry.child = null;
    entry.connection = null;
    entry.startedAt = null;
    entry.diagnostics.clear();
    if (this.entries.size > 0 && !this.hasLiveServer()) {
      this.clearIdleTimer();
      this.clearLeaseTimer();
    }
    lspDebug(`${entry.family}: stopped (${reason})`);
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.off('exit', onExit);
        resolve();
      }, timeoutMs);
      timer.unref?.();
      const onExit = (): void => {
        clearTimeout(timer);
        resolve();
      };
      child.once('exit', onExit);
    });
  }
}
