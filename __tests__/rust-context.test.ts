/**
 * Rust build context: which crate a file belongs to, and what that crate's
 * manifest declares.
 *
 * Two halves. `parseCargoManifestDetails` is the shared reader — the workspace
 * resolver consumes the same functions, so a name this parser gets wrong is also
 * a name resolution gets wrong. `loadRustCrateCatalog` / `rustContextForFile`
 * are the query-time side: longest crate-directory prefix wins, glob members are
 * expanded, and an edited manifest invalidates the cache.
 *
 * The tests deliberately pin the LIMITS too: `[workspace.dependencies]`,
 * target-specific dependency tables and multi-line inline tables are not read,
 * and the reported features are declared keys, never an enabled set.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseCargoManifestDetails } from '../src/cargo-manifest';
import { loadRustCrateCatalog, rustContextForFile } from '../src/graph/rust-context';
import CodeGraph from '../src';

const MANIFEST = `
[package]
name = "mytool-core"
version = "0.1.0"

[features]
default = ["fast"]
fast = []
slow = ["dep:tokio"]

[dependencies]
serde = "1.0"
serde_json = { version = "1", optional = true, features = ["preserve_order"] }
local-util = { path = "../util" }
gitdep = { git = "https://example.invalid/x.git" }

[dev-dependencies]
criterion = "0.5"

[build-dependencies]
cc = "1"

[dependencies.tokio]
version = "1"
features = ["rt-multi-thread"]

[target.'cfg(unix)'.dependencies]
nix = "0.27"

[workspace.dependencies]
shared = "2"
`;

describe('parseCargoManifestDetails', () => {
  const details = parseCargoManifestDetails(MANIFEST);

  it('reads the package name and the declared feature keys', () => {
    expect(details.packageName).toBe('mytool-core');
    expect(details.features).toEqual(['default', 'fast', 'slow']);
  });

  it('reads inline, per-name and non-normal dependency tables with their source', () => {
    const byName = new Map(details.dependencies.map((dep) => [dep.name, dep]));
    expect(byName.get('serde')).toMatchObject({ kind: 'normal', source: 'registry', version: '1.0', optional: false });
    expect(byName.get('serde_json')).toMatchObject({ source: 'registry', optional: true, features: ['preserve_order'] });
    expect(byName.get('local-util')).toMatchObject({ source: 'path', path: '../util' });
    expect(byName.get('gitdep')).toMatchObject({ source: 'git', git: 'https://example.invalid/x.git' });
    // `[dependencies.tokio]` — the name is in the header, the body is the table.
    expect(byName.get('tokio')).toMatchObject({ kind: 'normal', version: '1', features: ['rt-multi-thread'] });
    expect(byName.get('criterion')).toMatchObject({ kind: 'dev' });
    expect(byName.get('cc')).toMatchObject({ kind: 'build' });
  });

  it('does not read dependency tables it does not claim to support', () => {
    const names = details.dependencies.map((dep) => dep.name);
    // The module documents both of these as out of scope; they must not leak in
    // half-parsed and look like real dependencies.
    expect(names).not.toContain('nix');
    expect(names).not.toContain('shared');
  });

  it('does not mistake other sections for dependency entries', () => {
    const names = details.dependencies.map((dep) => dep.name);
    expect(names).not.toContain('name');
    expect(names).not.toContain('version');
    expect(names).not.toContain('default');
  });

  it('reads workspace members without expanding globs', () => {
    expect(parseCargoManifestDetails('[workspace]\nmembers = ["a", "crates/*"]\n').workspaceMembers)
      .toEqual(['a', 'crates/*']);
  });

  it('reports no package for a virtual workspace manifest', () => {
    expect(parseCargoManifestDetails('[workspace]\nmembers = ["a"]\n').packageName).toBeNull();
  });
});

describe('rust crate catalog', () => {
  let dir: string;
  const open: CodeGraph[] = [];

  afterEach(() => {
    for (const cg of open.splice(0)) cg.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(relative: string, content: string): void {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  function workspace(): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rustctx-'));
    write('Cargo.toml', '[workspace]\nmembers = ["crates/*", "util"]\n');
    write('crates/alpha/Cargo.toml', '[package]\nname = "alpha"\n[features]\nextra = []\n');
    write('crates/beta/Cargo.toml', '[package]\nname = "beta"\n[dependencies]\nalpha = { path = "../alpha" }\n');
    write('util/Cargo.toml', '[package]\nname = "util"\n');
  }

  it('maps each file to its crate, longest crate directory first', () => {
    workspace();
    write('Cargo.toml', '[package]\nname = "root-crate"\n[workspace]\nmembers = ["crates/*", "util"]\n');
    const catalog = loadRustCrateCatalog(dir)!;
    expect(rustContextForFile(catalog, 'crates/alpha/src/lib.rs')?.crate).toBe('alpha');
    expect(rustContextForFile(catalog, 'util/src/lib.rs')?.crate).toBe('util');
    expect(rustContextForFile(catalog, 'src/main.rs')?.crate).toBe('root-crate');
    expect(rustContextForFile(catalog, 'README.md')?.crate).toBe('root-crate');
  });

  it('reports what a member declares', () => {
    workspace();
    const catalog = loadRustCrateCatalog(dir)!;
    const beta = rustContextForFile(catalog, 'crates/beta/src/lib.rs')!;
    expect(beta.crateRoot).toBe('crates/beta');
    expect(beta.manifest).toBe('crates/beta/Cargo.toml');
    expect(beta.dependencies).toEqual([expect.objectContaining({ name: 'alpha', source: 'path' })]);
    expect(rustContextForFile(catalog, 'crates/alpha/src/lib.rs')!.features).toEqual(['extra']);
  });

  it('returns null for a project with no Cargo.toml', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rustctx-none-'));
    expect(loadRustCrateCatalog(dir)).toBeNull();
    expect(loadRustCrateCatalog(dir)).toBeNull();
  });

  it('picks up an edited manifest without a restart', () => {
    workspace();
    expect(rustContextForFile(loadRustCrateCatalog(dir)!, 'crates/alpha/src/lib.rs')!.features).toEqual(['extra']);
    write('crates/alpha/Cargo.toml', '[package]\nname = "alpha"\n[features]\nextra = []\nrenamed = []\n');
    expect(rustContextForFile(loadRustCrateCatalog(dir)!, 'crates/alpha/src/lib.rs')!.features).toEqual(['extra', 'renamed']);
  });

  it('surfaces the crate for an indexed rust symbol, and only for rust', async () => {
    workspace();
    write('crates/alpha/src/lib.rs', 'pub fn alpha_entry() -> u32 { 1 }\n');
    write('src/main.ts', 'export function tsEntry(): number { return 1 }\n');
    const cg = await CodeGraph.init(dir, { index: true });
    open.push(cg);
    const rust = cg.getNodesInFile('crates/alpha/src/lib.rs').find((n) => n.name === 'alpha_entry')!;
    const ts = cg.getNodesInFile('src/main.ts').find((n) => n.name === 'tsEntry')!;
    expect(cg.getRustBuildContext(rust.id)?.crate).toBe('alpha');
    expect(cg.getRustBuildContext(ts.id)).toBeNull();
  });
});
