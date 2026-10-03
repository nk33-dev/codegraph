/**
 * Rust build context for a query: which crate a file belongs to, what that crate
 * declares it depends on, and which features its manifest declares.
 *
 * Query-time evidence only — nothing here is persisted, no node metadata is
 * added, and no `#[cfg(...)]` is evaluated. `#[cfg]` is not extracted anywhere
 * in this codebase, and this module does not pretend otherwise: the honest claim
 * is "the file lives in crate X, whose manifest declares these features and
 * these dependencies", not "this symbol is compiled under feature Y".
 *
 * The manifest reading is shared with the workspace resolver
 * (`src/cargo-manifest.ts`), so `use foo::...` resolution and this context can
 * never disagree about a crate's name.
 */

import * as fs from 'fs';
import * as path from 'path';
import picomatch from 'picomatch';
import { parseCargoManifestDetails, type CargoDependency } from '../cargo-manifest';

/** One crate's declared build context. */
export interface RustManifestContext {
  /** `[package].name`. */
  crate: string;
  /** Directory of the crate relative to the project root, posix; `''` is the root crate. */
  crateRoot: string;
  /** Manifest path relative to the project root, posix. */
  manifest: string;
  /** `[features]` keys the crate declares — not the features enabled by a build. */
  features: string[];
  dependencies: CargoDependency[];
}

export interface RustCrateCatalog {
  /** Manifest paths to revalidate against (absolute). */
  revalidate: string[];
  /** Crate directory (posix, `''` for the root crate) to its context. */
  byCrateDir: Map<string, RustManifestContext>;
}

const SKIP_DIRS = new Set(['target', 'node_modules', '.git', 'dist', 'build']);
const MAX_GLOB_WALK_DEPTH = 5;
const GLOB_CHARS = /[*?[\]{}!]/;

interface CacheEntry {
  signature: string;
  catalog: RustCrateCatalog;
}

const cache = new Map<string, CacheEntry>();

/** mtime + size of each manifest, so an edited Cargo.toml invalidates the catalog. */
function statSignature(files: readonly string[]): string {
  const parts: string[] = [];
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      parts.push(`${file}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${file}:absent`);
    }
  }
  return parts.join('|');
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

/** Expand a `[workspace].members` entry that contains glob characters. */
function expandGlobMember(projectRoot: string, member: string): string[] {
  if (!GLOB_CHARS.test(member)) return [member];
  const matcher = picomatch(member, { dot: false });
  const staticPrefix = member.slice(0, member.search(GLOB_CHARS)).replace(/[^/]*$/, '').replace(/\/$/, '');
  const matches: string[] = [];
  const seen = new Set<string>();

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_GLOB_WALK_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(projectRoot, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const rel = dir === '' || dir === '.' ? entry.name : `${dir}/${entry.name}`;
      if (matcher(rel) && !seen.has(rel)) {
        seen.add(rel);
        matches.push(rel);
      }
      walk(rel, depth + 1);
    }
  };

  walk(staticPrefix, 0);
  return matches;
}

function readManifest(projectRoot: string, relativeDir: string): RustManifestContext | null {
  const manifestPath = relativeDir === '' ? 'Cargo.toml' : `${relativeDir}/Cargo.toml`;
  let content: string;
  try {
    content = fs.readFileSync(path.join(projectRoot, manifestPath), 'utf8');
  } catch {
    return null;
  }
  const details = parseCargoManifestDetails(content);
  if (!details.packageName) return null; // a virtual workspace manifest declares no crate
  return {
    crate: details.packageName,
    crateRoot: relativeDir,
    manifest: manifestPath,
    features: details.features,
    dependencies: details.dependencies,
  };
}

/**
 * The crate catalog for a project, or `null` when it has no Cargo.toml.
 *
 * Cached per project root and revalidated by manifest mtime + size, so editing a
 * Cargo.toml is picked up without restarting the process. Revalidation is a
 * `stat` per crate — on a large workspace that is a few dozen calls per lookup,
 * which is why the result is cached rather than recomputed.
 */
export function loadRustCrateCatalog(projectRoot: string): RustCrateCatalog | null {
  const entry = cache.get(projectRoot);
  if (entry && statSignature(entry.catalog.revalidate) === entry.signature) return entry.catalog;

  let rootContent: string;
  try {
    rootContent = fs.readFileSync(path.join(projectRoot, 'Cargo.toml'), 'utf8');
  } catch {
    cache.delete(projectRoot);
    return null;
  }

  const byCrateDir = new Map<string, RustManifestContext>();
  const revalidate: string[] = [path.join(projectRoot, 'Cargo.toml')];

  const rootCrate = readManifest(projectRoot, '');
  if (rootCrate) {
    byCrateDir.set('', rootCrate);
    if (rootCrate.manifest !== 'Cargo.toml') revalidate.push(path.join(projectRoot, rootCrate.manifest));
  }

  const members = parseCargoManifestDetails(rootContent).workspaceMembers;
  for (const rawMember of members) {
    for (const member of expandGlobMember(projectRoot, rawMember)) {
      const cleaned = toPosix(member).replace(/\/$/, '');
      if (byCrateDir.has(cleaned)) continue;
      const crate = readManifest(projectRoot, cleaned);
      if (!crate) continue;
      byCrateDir.set(cleaned, crate);
      revalidate.push(path.join(projectRoot, crate.manifest));
    }
  }

  const catalog: RustCrateCatalog = { revalidate, byCrateDir };
  cache.set(projectRoot, { signature: statSignature(revalidate), catalog });
  return catalog;
}

/**
 * The crate a file belongs to: the manifest whose directory is the longest
 * prefix of the file's own directory. Nested crates win over the workspace root,
 * which is what `crates/foo/src/lib.rs` should report.
 */
export function rustContextForFile(
  catalog: RustCrateCatalog,
  filePath: string
): RustManifestContext | null {
  const posix = toPosix(filePath).replace(/^\.\//, '');
  let best: RustManifestContext | null = null;
  for (const crate of catalog.byCrateDir.values()) {
    if (crate.crateRoot !== '' && !posix.startsWith(`${crate.crateRoot}/`)) continue;
    if (best === null || crate.crateRoot.length > best.crateRoot.length) best = crate;
  }
  return best;
}
