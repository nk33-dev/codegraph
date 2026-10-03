/**
 * Cargo.toml reading, shared by the workspace resolver and the query-time rust
 * build context.
 *
 * Hand-rolled, deliberately: there is no TOML dependency here, and the shapes
 * that matter (`[workspace].members`, `[package].name`, the dependency tables,
 * `[features]`) are line-oriented in every real manifest. What this module must
 * not do is disagree with itself — the resolver looks up `use foo::...` against
 * the same names the build context reports, so both read them from here.
 *
 * Known limits, all of them consequences of not being a TOML parser:
 *   - `[target.'cfg(...)'.dependencies]` and `[workspace.dependencies]` are not
 *     read; only the plain and per-name dependency tables are.
 *   - An inline dependency table must be on one line (`foo = { path = ".." }`).
 *     The multi-line form is written as a `[dependencies.foo]` table anyway.
 *   - Comments are stripped with the same crude `#`-to-end-of-line rule the
 *     resolver already used, so a `#` inside a quoted value would truncate it.
 */

/** Which dependency table an entry came from. */
export type CargoDependencyKind = 'normal' | 'dev' | 'build';

/** One declared dependency, as written — not as resolved. */
export interface CargoDependency {
  name: string;
  kind: CargoDependencyKind;
  /** `registry` unless the entry names a `path` or `git`. */
  source: 'registry' | 'path' | 'git';
  version?: string;
  path?: string;
  git?: string;
  /** Whether the entry asks for `optional = true`. */
  optional: boolean;
  /** Feature names this dependency is requested with. */
  features: string[];
}

export interface CargoManifestDetails {
  /** `[package].name`, or null for a virtual workspace manifest. */
  packageName: string | null;
  /** `[workspace].members`, before glob expansion. */
  workspaceMembers: string[];
  /** `[features]` keys — the features the crate declares, not the ones enabled. */
  features: string[];
  dependencies: CargoDependency[];
}

const SECTION_HEADER = /^\[([^\]]+)\]$/;
/** `dependencies`, `dev-dependencies`, `build-dependencies`, optionally `.NAME`. */
const DEPENDENCY_HEADER = /^(?:(dev|build)-)?dependencies(?:\.([A-Za-z0-9_-]+))?$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip a trailing comment the way the resolver always has. */
function stripComment(line: string): string {
  return line.replace(/#.*$/, '');
}

/**
 * The lines of one `[section]`, up to the next header. `null` when the manifest
 * has no such section (which is how callers tell "absent" from "empty").
 */
export function getSection(content: string, sectionName: string): string | null {
  const lines = content.split('\n');
  let inSection = false;
  const sectionLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inSection) {
      if (trimmed === `[${sectionName}]`) {
        inSection = true;
      }
      continue;
    }

    if (SECTION_HEADER.test(trimmed)) {
      break;
    }

    sectionLines.push(line);
  }

  if (!inSection) return null;
  return sectionLines.join('\n');
}

/** The quoted strings in a TOML value list, in order. */
export function extractQuotedValues(valueList: string): string[] {
  const values: string[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let current = '';

  for (const ch of valueList) {
    if (!quote) {
      if (ch === '"' || ch === "'") {
        quote = ch;
        current = '';
      }
      continue;
    }

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === quote) {
      values.push(current.trim());
      quote = null;
      current = '';
      continue;
    }

    current += ch;
  }

  return values.filter(Boolean);
}

/** The `[...]` array written for `key` in `section`, brackets excluded. */
export function getArrayValue(section: string, key: string): string | null {
  // The leading guard rejects a hyphenated sibling: `members` must not match inside
  // `default-members`, which is a subset of the members and not the member list itself.
  const keyRegex = new RegExp(`(?:^|[^\\w-])${escapeRegExp(key)}\\s*=`, 'm');
  const keyMatch = keyRegex.exec(section);
  if (!keyMatch) return null;

  let i = keyMatch.index + keyMatch[0].length;
  while (i < section.length && /\s/.test(section.charAt(i))) i++;
  if (section.charAt(i) !== '[') return null;
  i++;

  let inQuote: '"' | "'" | null = null;
  let escaped = false;
  let depth = 1;
  const start = i;

  while (i < section.length) {
    const ch = section.charAt(i);

    if (inQuote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inQuote) {
        inQuote = null;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inQuote = ch;
      i++;
      continue;
    }

    if (ch === '[') {
      depth++;
      i++;
      continue;
    }

    if (ch === ']') {
      depth--;
      if (depth === 0) {
        return section.slice(start, i);
      }
      i++;
      continue;
    }

    i++;
  }

  return null;
}

/** `[workspace].members`, unexpanded (globs are the caller's business). */
export function parseCargoWorkspaceMembers(cargoToml: string): string[] {
  const workspaceSection = getSection(cargoToml, 'workspace');
  if (!workspaceSection) return [];
  const membersValue = getArrayValue(workspaceSection, 'members');
  if (!membersValue) return [];
  return extractQuotedValues(membersValue);
}

/** `[package].name`. */
export function parseCargoPackageName(cargoToml: string): string | null {
  const packageSection = getSection(cargoToml, 'package');
  if (!packageSection) return null;
  const packageNameMatch = packageSection.match(/name\s*=\s*["']([^"'\n]+)["']/);
  return packageNameMatch?.[1]?.trim() ?? null;
}

/** `[features]` keys. */
export function parseCargoFeatures(cargoToml: string): string[] {
  const featuresSection = getSection(cargoToml, 'features');
  if (!featuresSection) return [];
  const names: string[] = [];
  for (const raw of featuresSection.split('\n')) {
    const line = stripComment(raw).trim();
    if (!line || line.startsWith('[')) continue;
    const key = /^([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1];
    if (key) names.push(key);
  }
  return names;
}

/**
 * A single dependency's key/value body — either the one-line `{ ... }` table
 * after `=`, or the lines of a `[dependencies.NAME]` table. Values keep their
 * quotes so `readString` can hand them back verbatim.
 */
function readKeyValues(entries: string[]): Map<string, string> {
  const values = new Map<string, string>();
  let pendingKey: string | null = null;
  let pendingValue = '';

  const commit = (): void => {
    if (pendingKey !== null) values.set(pendingKey, pendingValue.trim());
    pendingKey = null;
    pendingValue = '';
  };

  for (const entry of entries) {
    if (pendingKey !== null) {
      // Continuation of an array value that spanned lines.
      pendingValue += entry;
      if (bracketsBalanced(pendingValue)) commit();
      continue;
    }
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(entry.trim());
    if (!match) continue;
    pendingKey = match[1]!;
    pendingValue = match[2]!;
    if (bracketsBalanced(pendingValue)) commit();
  }
  commit();
  return values;
}

/** Whether every `[` in a value fragment has its `]`, quotes respected. */
function bracketsBalanced(text: string): boolean {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of text) {
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[') depth++;
    else if (ch === ']') depth--;
  }
  return quote === null && depth <= 0;
}

/** Split one line's `{ ... }` body on top-level commas. */
function splitInlineTable(body: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function readString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const quoted = /^\s*["']([^"']*)["']\s*$/.exec(value);
  return quoted?.[1];
}

function readBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

function buildDependency(name: string, kind: CargoDependencyKind, keyValues: Map<string, string>): CargoDependency {
  const path = readString(keyValues.get('path'));
  const git = readString(keyValues.get('git'));
  const version = readString(keyValues.get('version'));
  return {
    name,
    kind,
    // A `path` or `git` key is what "source" means here; neither is resolved.
    source: path !== undefined ? 'path' : git !== undefined ? 'git' : 'registry',
    ...(version !== undefined ? { version } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(git !== undefined ? { git } : {}),
    optional: readBoolean(keyValues.get('optional')),
    features: featuresArray(keyValues.get('features')),
  };
}

/** The quoted names in a `features = [...]` value; a bare string counts as one. */
function featuresArray(value: string | undefined): string[] {
  if (value === undefined) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) return extractQuotedValues(trimmed);
  const single = readString(trimmed);
  return single !== undefined ? [single] : [];
}

/**
 * The dependency tables of one manifest: the plain tables (`[dependencies]`,
 * `[dev-dependencies]`, `[build-dependencies]`, each with `name = ...` lines)
 * and the per-name tables (`[dependencies.name]`, whose header carries the name).
 *
 * `[target.'cfg(...)'.dependencies]` and `[workspace.dependencies]` do not
 * match the header shape, so they are skipped rather than misread.
 */
function parseCargoDependencies(cargoToml: string): CargoDependency[] {
  const dependencies: CargoDependency[] = [];
  /** The dependency table the current lines belong to; null when they belong to none. */
  let current: { kind: CargoDependencyKind; named: string | null } | null = null;
  let body: string[] = [];

  const flush = (): void => {
    const table = current;
    if (table && body.length > 0) {
      if (table.named !== null) {
        dependencies.push(buildDependency(table.named, table.kind, readKeyValues(body)));
      } else {
        for (const entry of body) {
          const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(entry);
          if (!match) continue;
          const rawValue = match[2]!.trim();
          const keyValues = rawValue.startsWith('{')
            ? readKeyValues(splitInlineTable(rawValue.replace(/^\s*\{/, '').replace(/\}\s*$/, '')))
            : new Map<string, string>([['version', rawValue]]);
          dependencies.push(buildDependency(match[1]!, table.kind, keyValues));
        }
      }
    }
    body = [];
  };

  for (const raw of cargoToml.split('\n')) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const header = SECTION_HEADER.exec(line);
    if (header) {
      flush();
      const parsed = DEPENDENCY_HEADER.exec(header[1]!.trim());
      current = parsed
        ? {
            kind: parsed[1] === 'dev' ? 'dev' : parsed[1] === 'build' ? 'build' : 'normal',
            named: parsed[2] ?? null,
          }
        : null;
      continue;
    }
    if (current) body.push(line);
  }
  flush();
  return dependencies;
}

/** Everything the build context needs from one manifest. */
export function parseCargoManifestDetails(cargoToml: string): CargoManifestDetails {
  return {
    packageName: parseCargoPackageName(cargoToml),
    workspaceMembers: parseCargoWorkspaceMembers(cargoToml),
    features: parseCargoFeatures(cargoToml),
    dependencies: parseCargoDependencies(cargoToml),
  };
}
