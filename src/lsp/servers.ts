/**
 * Language family registry and language server process discovery.
 *
 * One "family" = the set of CodeGraph languages a single language server process can cover:
 *   cpp        ← c, cpp                        (clangd handles both)
 *   typescript ← typescript, tsx, javascript, jsx (tsserver covers all four)
 *   rust / go / java / python
 *
 * Phase two deliberately does not install language servers automatically: this only probes
 * whether one exists on the path and reports the missing reason faithfully; the user names the
 * command in `.codegraph/lsp.json`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import type { Language } from '../types';

export const LSP_FAMILIES = ['cpp', 'typescript', 'rust', 'go', 'java', 'python'] as const;
export type LspFamily = typeof LSP_FAMILIES[number];

/** Languages covered by each family, shared by status output and language→family routing. */
export const LANGUAGES_BY_FAMILY: Record<LspFamily, Language[]> = {
  cpp: ['c', 'cpp'],
  typescript: ['typescript', 'tsx', 'javascript', 'jsx'],
  rust: ['rust'],
  go: ['go'],
  java: ['java'],
  python: ['python'],
};

/** CodeGraph language → LSP language family; null for unsupported languages. */
export function familyForLanguage(language: Language | null | undefined): LspFamily | null {
  if (!language) return null;
  for (const family of LSP_FAMILIES) {
    if (LANGUAGES_BY_FAMILY[family].includes(language)) return family;
  }
  return null;
}

/** CodeGraph language → LSP `languageId` (used by didOpen). */
export function languageIdFor(language: Language | null | undefined): string | null {
  switch (language) {
    case 'c': return 'c';
    case 'cpp': return 'cpp';
    case 'typescript': return 'typescript';
    case 'tsx': return 'typescriptreact';
    case 'javascript': return 'javascript';
    case 'jsx': return 'javascriptreact';
    case 'rust': return 'rust';
    case 'go': return 'go';
    case 'java': return 'java';
    case 'python': return 'python';
    default: return null;
  }
}

/** One candidate way to launch a server. */
export interface ServerCandidate {
  command: string;
  args: string[];
}

export interface FamilyDefaults {
  /** Candidate commands in priority order; the first one found on PATH wins. */
  candidates: ServerCandidate[];
  /**
   * true means there is no single executable that can be launched directly and a full command must
   * be given in the config (jdt.ls needs JVM arguments + a launcher jar + a configuration directory).
   */
  configRequired: boolean;
  /** Extra user-facing note (returned alongside `unavailable` when the server is missing). */
  note?: string;
}

/** Default candidate commands per family. Order is priority. */
export const DEFAULT_SERVERS: Record<LspFamily, FamilyDefaults> = {
  cpp: {
    candidates: [{ command: 'clangd', args: ['--background-index'] }],
    configRequired: false,
    note: 'clangd needs compile_commands.json; without it, cross-file references and diagnostics are incomplete.',
  },
  typescript: {
    candidates: [
      { command: 'typescript-language-server', args: ['--stdio'] },
      { command: 'vtsls', args: ['--stdio'] },
    ],
    configRequired: false,
    note: 'typescript-language-server needs a resolvable typescript package inside the project.',
  },
  rust: {
    candidates: [{ command: 'rust-analyzer', args: [] }],
    configRequired: false,
    note: 'rust-analyzer keeps indexing after initialize, so a query issued immediately may come back empty.',
  },
  go: {
    candidates: [{ command: 'gopls', args: ['serve'] }],
    configRequired: false,
  },
  java: {
    candidates: [{ command: 'jdtls', args: [] }],
    configRequired: true,
    note: 'jdt.ls needs a full launch command (java + JVM flags + launcher jar + configuration directory); set it in .codegraph/lsp.json.',
  },
  python: {
    candidates: [
      { command: 'pyright-langserver', args: ['--stdio'] },
      { command: 'pylsp', args: [] },
    ],
    configRequired: false,
    note: 'pyright-langserver or pylsp must be installed and available on PATH; pyright uses the project configuration when present.',
  },
};

export interface ExecutableLookup {
  /** Resolved absolute path; null when not found. */
  path: string | null;
  /** The concrete reason it was not found, for status output and troubleshooting. */
  reason: string | null;
}

/** Skip the PATH search when the command contains a path separator or is absolute. */
function looksLikePath(command: string): boolean {
  return path.isAbsolute(command) || command.includes('/') || command.includes('\\');
}

/**
 * Executable extensions on Windows, in priority order. Deliberately not all of PATHEXT:
 * `.js`/`.py` and friends depend on file associations, so which interpreter would launch a
 * language server is not something we can know.
 */
const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat'];

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve an executable: absolute/relative paths are validated directly; bare commands are
 * searched on PATH + PATHEXT.
 *
 * On Windows only `.exe/.com/.cmd/.bat` are considered:
 *   - npm writes both an **extensionless** POSIX sh script and a `.cmd` into the bin directory;
 *     Windows cannot launch the extensionless one directly, so choosing it means guaranteed failure;
 *   - `.ps1` cannot be launched by cmd.exe, so it is skipped deliberately with a reason.
 * To run a script-based server, the config should use an explicit command such as `node <script>`.
 */
export function resolveExecutable(command: string, baseDir?: string): ExecutableLookup {
  const trimmed = command.trim();
  if (!trimmed) return { path: null, reason: 'the command is empty' };

  if (looksLikePath(trimmed)) {
    const resolved = path.resolve(baseDir ?? process.cwd(), trimmed);
    if (isFile(resolved)) {
      if (process.platform === 'win32' && /\.ps1$/i.test(resolved)) {
        return { path: null, reason: `${resolved} is a PowerShell script and cannot be launched by cmd.exe` };
      }
      return { path: resolved, reason: null };
    }
    return { path: null, reason: `file does not exist: ${resolved}` };
  }

  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const hasExtension = path.extname(trimmed) !== '';
  const extensions = process.platform === 'win32' && !hasExtension
    ? WINDOWS_EXECUTABLE_EXTENSIONS
    : [''];

  let sawScriptOnly = false;
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, trimmed + ext);
      if (!isFile(candidate)) continue;
      if (process.platform === 'win32' && /\.ps1$/i.test(candidate)) {
        sawScriptOnly = true;
        continue;
      }
      return { path: candidate, reason: null };
    }
    if (process.platform === 'win32' && !hasExtension && isFile(path.join(dir, `${trimmed}.ps1`))) {
      sawScriptOnly = true;
    }
  }
  if (sawScriptOnly) return { path: null, reason: `only the PowerShell shim (${trimmed}.ps1) was found, which cannot be launched directly` };
  return { path: null, reason: `${trimmed} is not on PATH` };
}

/** cmd.exe argument quoting: quote when it contains whitespace or special characters. */
function quoteWindowsArgument(argument: string): string {
  if (argument === '') return '""';
  return /[\s"&|<>^()%!]/.test(argument) ? `"${argument.replace(/"/g, '\\"')}"` : argument;
}

/**
 * Assemble the actual spawn arguments.
 *
 * On Windows Node refuses to spawn `.cmd`/`.bat` directly (since CVE-2024-27980), so a shell is
 * required. Here the command line is joined into a single string and passed through the
 * single-argument overload of `spawn(command, {shell:true})`, avoiding the deprecated
 * "args + shell" path (DEP0190).
 */
export function buildSpawnPlan(
  resolved: string,
  args: string[],
): { command: string; args: string[]; shell: boolean } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
    return {
      command: [resolved, ...args].map(quoteWindowsArgument).join(' '),
      args: [],
      shell: true,
    };
  }
  return { command: resolved, args, shell: false };
}

export interface SpawnServerOptions {
  cwd: string;
  env?: Record<string, string>;
}

/** Start the language server process per the plan; stdout/stdin carry LSP, stderr goes to the caller for diagnostics. */
export function spawnServer(resolved: string, args: string[], options: SpawnServerOptions): ChildProcess {
  const plan = buildSpawnPlan(resolved, args);
  const spawnOptions = {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  };
  // The shell branch must actually pass shell:true to spawn — using it only to pick a branch is
  // the same as not going through a shell and fails with ENOENT on Windows (.cmd cannot be
  // CreateProcess'd).
  return plan.shell
    ? spawn(plan.command, { ...spawnOptions, shell: true })
    : spawn(plan.command, plan.args, spawnOptions);
}
