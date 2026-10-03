/**
 * Cargo Workspace Resolver Helper
 *
 * Parses a project's root Cargo.toml and member crate manifests to
 * build a crate-name -> member-directory map. Used by the Rust
 * resolver to resolve `use crate_name::...` references that point
 * into workspace member crates.
 *
 * The manifest reading itself lives in `src/cargo-manifest.ts`, shared with the
 * query-time rust build context so the two cannot report different crate names
 * for the same file.
 */

import picomatch from 'picomatch';
import { parseCargoPackageName, parseCargoWorkspaceMembers } from '../../cargo-manifest';
import { ResolutionContext } from '../types';

const GLOB_CHARS = /[*?[\]{}!]/;
const SKIP_DIRS = new Set(['target', 'node_modules', '.git', 'dist', 'build']);
const MAX_GLOB_WALK_DEPTH = 5;

function addCrateAlias(map: Map<string, string>, crateName: string, memberPath: string): void {
  const normalized = crateName.replace(/-/g, '_');
  map.set(crateName, memberPath);
  if (normalized !== crateName) {
    map.set(normalized, memberPath);
  }
}

function cleanPath(memberPath: string): string {
  return memberPath.replace(/\\/g, '/').replace(/\/$/, '');
}

function expandGlobMember(member: string, context: ResolutionContext): string[] {
  if (!context.listDirectories) return [];

  const firstGlobIdx = member.search(GLOB_CHARS);
  const staticPrefix = member
    .slice(0, firstGlobIdx)
    .replace(/[^/]*$/, '')
    .replace(/\/$/, '');

  const matcher = picomatch(member, { dot: false });
  const matches: string[] = [];
  const seen = new Set<string>();

  function walk(dir: string, depth: number): void {
    if (depth > MAX_GLOB_WALK_DEPTH) return;
    const children = context.listDirectories!(dir);
    for (const child of children) {
      if (SKIP_DIRS.has(child) || child.startsWith('.')) continue;
      const rel = dir === '.' ? child : `${dir}/${child}`;
      if (matcher(rel) && !seen.has(rel)) {
        seen.add(rel);
        matches.push(rel);
      }
      walk(rel, depth + 1);
    }
  }

  walk(staticPrefix || '.', 0);
  return matches;
}

function expandMembers(members: string[], context: ResolutionContext): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    const candidates = GLOB_CHARS.test(member)
      ? expandGlobMember(member, context)
      : [member];
    for (const candidate of candidates) {
      const cleaned = cleanPath(candidate);
      if (seen.has(cleaned)) continue;
      seen.add(cleaned);
      expanded.push(cleaned);
    }
  }
  return expanded;
}

/**
 * Build a map from crate-name aliases to workspace member directory paths.
 * Example: "mytool-core" and "mytool_core" -> "crates/mytool-core"
 *
 * Supports glob members (e.g. `members = ["crates/*"]`) via picomatch
 * when the context exposes `listDirectories`.
 */
export function getCargoWorkspaceCrateMap(context: ResolutionContext): Map<string, string> {
  const result = new Map<string, string>();
  const rootCargoToml = context.readFile('Cargo.toml');
  if (!rootCargoToml) return result;

  const rawMembers = parseCargoWorkspaceMembers(rootCargoToml);
  const members = expandMembers(rawMembers, context);

  for (const memberPath of members) {
    const memberCargoPath = `${memberPath}/Cargo.toml`;
    const memberCargoToml = context.readFile(memberCargoPath);
    if (!memberCargoToml) continue;

    const packageName = parseCargoPackageName(memberCargoToml);
    if (!packageName) continue;

    addCrateAlias(result, packageName, memberPath);
  }

  return result;
}
