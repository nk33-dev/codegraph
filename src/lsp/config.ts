/**
 * Project-level language server configuration: `.codegraph/lsp.json` + `CODEGRAPH_LSP_*` env vars.
 *
 * Why this lives in `.codegraph/` instead of a committed `codegraph.json`: language server commands
 * almost always carry machine-local absolute paths (jdt.ls JVM arguments, clangd's local install
 * location), and writing that into a team-shared file would commit one machine's paths for
 * everyone. `.codegraph/` is already ignored by its own `.gitignore` `*`, making it the right place
 * for machine-local configuration.
 *
 * Same degradation contract as `project-config.ts`: a missing file, invalid JSON, or a single
 * malformed entry only warns and skips — a query must never throw because of a configuration
 * problem.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getCodeGraphDir } from '../directory';
import { logWarn } from '../errors';
import { resolveResourceProfile } from '../resource-profile';
import { LSP_FAMILIES, type LspFamily } from './servers';

/** Configuration file name under `.codegraph/`. */
export const LSP_CONFIG_FILENAME = 'lsp.json';

/**
 * Fallback idle-exit timeout, used only if the resource profile cannot be resolved
 * (which should not happen — `resolveResourceProfile` clamps and never throws).
 * The effective default comes from the active profile: battery 90s / balanced 300s / performance 600s.
 */
const FALLBACK_IDLE_TIMEOUT_MS = 300_000;
/** `initialize` handshake timeout. */
const DEFAULT_INIT_TIMEOUT_MS = 30_000;
/** Timeout for a single LSP request. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** Overall diagnostics wait cap (pull request + publishDiagnostics wait). */
const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 8_000;
/** Cap on waiting for the server to index the project before the first query (0 = do not wait, query directly). */
const DEFAULT_WARMUP_TIMEOUT_MS = 15_000;

export interface LspServerConfig {
  command: string;
  args?: string[];
  /** Server working directory; defaults to the project root. */
  cwd?: string;
  /** Values added to the process environment (such as JAVA_HOME). */
  env?: Record<string, string>;
  /** initialize's initializationOptions, passed through unchanged. */
  initializationOptions?: unknown;
}

export interface LspProjectConfig {
  servers: Partial<Record<LspFamily, LspServerConfig>>;
  disabled: LspFamily[];
  idleTimeoutMs: number;
  initTimeoutMs: number;
  requestTimeoutMs: number;
  diagnosticsTimeoutMs: number;
  warmupTimeoutMs: number;
}

interface CacheEntry {
  mtimeMs: number;
  config: LspProjectConfig;
}

/** Cached per project root and invalidated when mtime changes (config edits apply without restarting the service). */
const cache = new Map<string, CacheEntry>();

/** Absolute path of `.codegraph/lsp.json`. */
export function getLspConfigPath(projectRoot: string): string {
  return path.join(getCodeGraphDir(projectRoot), LSP_CONFIG_FILENAME);
}

function isFamily(value: string): value is LspFamily {
  return (LSP_FAMILIES as readonly string[]).includes(value);
}

/** Read a non-negative integer timeout; invalid or <0 returns fallback. */
function readTimeout(raw: string | undefined, fallback: number, allowZero: boolean): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  if (value < 0 || (!allowZero && value === 0)) return fallback;
  return value;
}

function parseStringArray(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return null;
  return value as string[];
}

function parseEnvMap(value: unknown): Record<string, string> | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function parseServers(raw: unknown, file: string): Partial<Record<LspFamily, LspServerConfig>> {
  const out: Partial<Record<LspFamily, LspServerConfig>> = {};
  if (raw === undefined) return out;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    logWarn(`Ignoring "servers" in ${LSP_CONFIG_FILENAME}: must be an object keyed by language family`, { file });
    return out;
  }
  for (const [family, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isFamily(family)) {
      logWarn(`Ignoring unknown language family "${family}" in ${LSP_CONFIG_FILENAME}`, { file });
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      logWarn(`Ignoring "servers.${family}": must be an object`, { file });
      continue;
    }
    const server = entry as Record<string, unknown>;
    if (typeof server.command !== 'string' || !server.command.trim()) {
      logWarn(`Ignoring "servers.${family}": "command" must be a non-empty string`, { file });
      continue;
    }
    const parsed: LspServerConfig = { command: server.command.trim() };
    const args = parseStringArray(server.args);
    if (server.args !== undefined && args === null) {
      logWarn(`Ignoring "servers.${family}.args": must be an array of strings`, { file });
    } else if (args) {
      parsed.args = args;
    }
    if (typeof server.cwd === 'string' && server.cwd.trim()) parsed.cwd = server.cwd.trim();
    const env = parseEnvMap(server.env);
    if (server.env !== undefined && env === null) {
      logWarn(`Ignoring "servers.${family}.env": must be an object of strings`, { file });
    } else if (env) {
      parsed.env = env;
    }
    if (server.initializationOptions !== undefined) parsed.initializationOptions = server.initializationOptions;
    out[family] = parsed;
  }
  return out;
}

function parseDisabled(raw: unknown, file: string): LspFamily[] {
  const list = parseStringArray(raw);
  if (raw === undefined) return [];
  if (list === null) {
    logWarn(`Ignoring "disabled" in ${LSP_CONFIG_FILENAME}: must be an array of language families`, { file });
    return [];
  }
  const out: LspFamily[] = [];
  for (const entry of list) {
    if (isFamily(entry)) out.push(entry);
    else logWarn(`Ignoring unknown language family "${entry}" in "disabled"`, { file });
  }
  return out;
}

function parseTimeoutField(parsed: Record<string, unknown>, file: string, key: string): number | null {
  const raw = parsed[key];
  if (raw === undefined) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    logWarn(`Ignoring "${key}" in ${LSP_CONFIG_FILENAME}: must be a non-negative integer`, { file });
    return null;
  }
  return raw;
}

/** Assemble environment variable overrides (the process environment is fixed so one read would do, but computing them per load lets tests inject values). */
function applyEnvOverrides(config: LspProjectConfig): LspProjectConfig {
  const out: LspProjectConfig = {
    ...config,
    servers: { ...config.servers },
    disabled: [...config.disabled],
  };

  for (const family of LSP_FAMILIES) {
    const prefix = `CODEGRAPH_LSP_${family.toUpperCase()}`;
    const command = process.env[`${prefix}_COMMAND`];
    const argsRaw = process.env[`${prefix}_ARGS`];
    if (command !== undefined && command.trim()) {
      out.servers[family] = { ...(out.servers[family] ?? {}), command: command.trim() };
    }
    if (argsRaw !== undefined && argsRaw.trim()) {
      try {
        const parsed: unknown = JSON.parse(argsRaw);
        const args = parseStringArray(parsed);
        if (args === null) throw new Error('not a string array');
        const current = out.servers[family];
        if (current) out.servers[family] = { ...current, args };
      } catch (err) {
        logWarn(`Ignoring ${prefix}_ARGS: must be a JSON array of strings`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const disabledRaw = process.env.CODEGRAPH_LSP_DISABLED;
  if (disabledRaw !== undefined) {
    const set = new Set(out.disabled);
    for (const entry of disabledRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
      if (isFamily(entry)) set.add(entry);
      else logWarn(`Ignoring unknown language family "${entry}" in CODEGRAPH_LSP_DISABLED`);
    }
    out.disabled = [...set];
  }

  out.idleTimeoutMs = readTimeout(process.env.CODEGRAPH_LSP_IDLE_TIMEOUT_MS, out.idleTimeoutMs, true);
  out.initTimeoutMs = readTimeout(process.env.CODEGRAPH_LSP_INIT_TIMEOUT_MS, out.initTimeoutMs, false);
  out.requestTimeoutMs = readTimeout(process.env.CODEGRAPH_LSP_REQUEST_TIMEOUT_MS, out.requestTimeoutMs, false);
  out.diagnosticsTimeoutMs = readTimeout(process.env.CODEGRAPH_LSP_DIAGNOSTICS_TIMEOUT_MS, out.diagnosticsTimeoutMs, false);
  out.warmupTimeoutMs = readTimeout(process.env.CODEGRAPH_LSP_WARMUP_TIMEOUT_MS, out.warmupTimeoutMs, true);
  return out;
}

/**
 * 档位给出的空闲退出时间（battery 90s / balanced 300s / performance 600s）。
 *
 * 注意 `resolveResourceProfile()` 自身已经处理 `CODEGRAPH_LSP_IDLE_TIMEOUT_MS`
 * （显式环境变量覆盖档位默认值），所以这里拿到的是「环境变量 > 档位」的结果；
 * 文件里显式的 `idleTimeoutMs` 仍由 `parseConfig` 覆盖本默认值，
 * `applyEnvOverrides` 之后继续按既有行为处理环境变量。
 */
function defaultIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  try {
    const value = resolveResourceProfile(env).lspIdleTimeoutMs;
    return Number.isInteger(value) && value >= 0 ? value : FALLBACK_IDLE_TIMEOUT_MS;
  } catch {
    return FALLBACK_IDLE_TIMEOUT_MS;
  }
}

function defaultConfig(env: NodeJS.ProcessEnv = process.env): LspProjectConfig {
  return {
    servers: {},
    disabled: [],
    idleTimeoutMs: defaultIdleTimeoutMs(env),
    initTimeoutMs: DEFAULT_INIT_TIMEOUT_MS,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    diagnosticsTimeoutMs: DEFAULT_DIAGNOSTICS_TIMEOUT_MS,
    warmupTimeoutMs: DEFAULT_WARMUP_TIMEOUT_MS,
  };
}

function parseConfig(file: string): LspProjectConfig {
  let rawText: string;
  try {
    rawText = fs.readFileSync(file, 'utf-8');
  } catch {
    return defaultConfig();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    logWarn(`Ignoring ${LSP_CONFIG_FILENAME}: not valid JSON`, {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return defaultConfig();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logWarn(`Ignoring ${LSP_CONFIG_FILENAME}: top level must be an object`, { file });
    return defaultConfig();
  }

  const object = parsed as Record<string, unknown>;
  const config = defaultConfig();
  config.servers = parseServers(object.servers, file);
  config.disabled = parseDisabled(object.disabled, file);
  config.idleTimeoutMs = parseTimeoutField(object, file, 'idleTimeoutMs') ?? config.idleTimeoutMs;
  config.initTimeoutMs = parseTimeoutField(object, file, 'initTimeoutMs') ?? config.initTimeoutMs;
  config.requestTimeoutMs = parseTimeoutField(object, file, 'requestTimeoutMs') ?? config.requestTimeoutMs;
  config.diagnosticsTimeoutMs = parseTimeoutField(object, file, 'diagnosticsTimeoutMs') ?? config.diagnosticsTimeoutMs;
  config.warmupTimeoutMs = parseTimeoutField(object, file, 'warmupTimeoutMs') ?? config.warmupTimeoutMs;
  return config;
}

/**
 * Load a project's LSP configuration, cached by mtime. The path where the file is missing costs
 * one `stat` per call, and stale cache entries are dropped, so creating/deleting `lsp.json` takes
 * effect immediately.
 */
export function loadLspConfig(projectRoot: string): LspProjectConfig {
  const file = getLspConfigPath(projectRoot);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    cache.delete(projectRoot);
    return applyEnvOverrides(defaultConfig());
  }
  const entry = cache.get(projectRoot);
  if (entry && entry.mtimeMs === mtimeMs) return applyEnvOverrides(entry.config);
  const config = parseConfig(file);
  cache.set(projectRoot, { mtimeMs, config });
  return applyEnvOverrides(config);
}

/** Test/maintenance hook: clear the configuration cache. */
export function clearLspConfigCache(): void {
  cache.clear();
}
