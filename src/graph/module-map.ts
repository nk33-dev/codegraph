/**
 * File → module assignment, shared by the viewer's map and the architecture report.
 *
 * The rule is the same in both places: a module is a directory, not a guess. A file maps to the
 * first `depth` path segments under the chosen root, a level being one folder plus any
 * pass-through folder that follows it; a loose file folds into a `(root files)` bucket, except a
 * façade (`index.ts`, `lib.rs`, `__init__.py`) which is a box of its own.
 *
 * This lived in `src/ui-server/api/map.ts` until the CLI/MCP architecture report needed the same
 * grouping. Keeping one implementation is what stops the map and the report from disagreeing
 * about what "module" means.
 */

/** Normalize backslashes so the same path is one module on every platform. */
export const toPosixPath = (p: string): string => p.replace(/\\/g, '/');

/**
 * Basenames that stay their own box when they sit loose in a module root.
 *
 * These are façades — the file every other module imports the directory
 * *through*. Folding `src/index.ts` into a "(root files)" bucket with the type
 * declarations next to it hides the busiest node on the map.
 */
export const FACADE_STEMS = new Set(['index', 'main', 'lib', 'mod', '__init__', 'init']);

/** Id of the bucket loose files fall into. Deliberately not a real directory name. */
export function rootFilesId(root: string): string {
  return root ? `${root}/(root files)` : '(root files)';
}

/** Strip a trailing slash and any leading `./`, so `src/` and `src` are one root. */
export function normalizeRoot(raw: string | undefined): string {
  let root = (raw ?? '').trim().replace(/\\/g, '/');
  while (root.startsWith('./')) root = root.slice(2);
  while (root.endsWith('/')) root = root.slice(0, -1);
  if (root === '.' || root === '/') return '';
  return root;
}

function stemOf(basename: string): string {
  const dot = basename.indexOf('.');
  return dot <= 0 ? basename : basename.slice(0, dot);
}

/**
 * Directories a module boundary never falls on: exactly one subdirectory and
 * no file of their own. A Maven project keeps every line of Java under
 * `src/main/java/org/springframework/samples/petclinic/`, and the first four
 * of those folders split nothing — cutting at any of them draws the whole
 * program as one box, and no depth the reader can pick gets past them. Such a
 * folder joins the level below it, so depth counts folders that fork.
 *
 * Read from every indexed file, tests included, so a module's id does not
 * change when the reader toggles tests. The repository root is never one.
 */
export function passThroughDirs(paths: Iterable<string>): Set<string> {
  const children = new Map<string, Set<string>>();
  const holdsFiles = new Set<string>();
  for (const raw of paths) {
    const parts = toPosixPath(raw).split('/').filter(Boolean);
    let dir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      let kids = children.get(dir);
      if (!kids) children.set(dir, (kids = new Set()));
      kids.add(parts[i]!);
      dir = dir ? `${dir}/${parts[i]}` : parts[i]!;
    }
    holdsFiles.add(dir);
  }
  const out = new Set<string>();
  for (const [dir, kids] of children) {
    if (dir !== '' && kids.size === 1 && !holdsFiles.has(dir)) out.add(dir);
  }
  return out;
}

/**
 * Where each level of a file's directory path ends, as indexes into `dirs`: a
 * level is one folder plus every pass-through folder that follows it.
 */
export function levelEnds(root: string, dirs: readonly string[], passThrough: ReadonlySet<string> | undefined): number[] {
  const ends: number[] = [];
  for (let i = 0; i < dirs.length; ) {
    i++;
    while (passThrough && i < dirs.length && passThrough.has(joinPath(root, dirs.slice(0, i)))) i++;
    ends.push(i);
  }
  return ends;
}

function joinPath(root: string, segments: readonly string[]): string {
  return [root, ...segments].filter(Boolean).join('/');
}

/** The first `levels` levels of `dirs`, a chain of three or more folders written `first/…/last`. */
function levelLabel(root: string, dirs: readonly string[], ends: readonly number[]): string {
  const out: string[] = root ? [root] : [];
  let from = 0;
  for (const end of ends) {
    const chain = dirs.slice(from, end);
    out.push(chain.length >= 3 ? `${chain[0]}/…/${chain[chain.length - 1]}` : chain.join('/'));
    from = end;
  }
  return out.join('/');
}

/**
 * Which module a file belongs to, or `null` when it is outside the root.
 *
 * `depth` levels under the root name the module — a level being a folder and
 * the {@link passThroughDirs} that follow it (without them, one level per
 * folder). A file with fewer levels than that is loose in the root: a façade
 * keeps its own box, everything else joins the `(root files)` bucket.
 */
export function moduleIdFor(
  filePath: string,
  root: string,
  depth: number,
  passThrough?: ReadonlySet<string>
): { id: string; facade: boolean; label: string } | null {
  const path = toPosixPath(filePath);
  let rel = path;
  if (root) {
    if (!path.startsWith(`${root}/`)) return null;
    rel = path.slice(root.length + 1);
  }
  const parts = rel.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  const dirs = parts.slice(0, -1);
  const ends = levelEnds(root, dirs, passThrough);
  if (ends.length < depth) {
    // A loose file. The directories it DOES have still qualify it, so
    // `src/a/b.ts` at depth 2 lands in `src/a/(root files)`, not the top one.
    const dir = joinPath(root, dirs);
    const dirLabel = levelLabel(root, dirs, ends);
    const file = parts[parts.length - 1] ?? '';
    if (FACADE_STEMS.has(stemOf(file))) {
      return { id: joinPath(root, parts), facade: true, label: dirLabel ? `${dirLabel}/${file}` : file };
    }
    return { id: rootFilesId(dir), facade: false, label: rootFilesId(dirLabel) };
  }
  return {
    id: joinPath(root, dirs.slice(0, ends[depth - 1])),
    facade: false,
    label: levelLabel(root, dirs, ends.slice(0, depth)),
  };
}

/**
 * Rename `x/(root files)` to `x` wherever the bucket is all `x` has.
 *
 * The bucket earns its name only when it stands beside something: `src` holding
 * both `src/api` and three loose files needs a box for the loose ones, and that
 * box has to say it is not the whole of `src`. But a `backend/controllers` with
 * no subdirectories in it is not a directory with a bucket in it — it IS the
 * directory, and drawing it as `backend/controllers/(root files)` names a thing
 * the repository does not have. Deeper groupings hit this constantly (every
 * leaf directory becomes a bucket), which is what makes it worth a pass.
 *
 * Returns only the ids that move, so a caller can leave the rest alone.
 */
export function collapseLoneRootFiles(ids: ReadonlySet<string>): Map<string, string> {
  const renamed = new Map<string, string>();
  for (const id of ids) {
    const cut = id.lastIndexOf('/(root files)');
    // A bucket at the very top (`(root files)`) has no directory to become.
    if (cut <= 0 || cut + '/(root files)'.length !== id.length) continue;
    const dir = id.slice(0, cut);
    let alone = true;
    for (const other of ids) {
      // A façade counts: `src/utils` beside `src/utils/index.tsx` would read as
      // if the box contained the file drawn next to it.
      if (other !== id && other.startsWith(`${dir}/`)) {
        alone = false;
        break;
      }
    }
    // `dir` can only already be a module if something lives BELOW it, which is
    // exactly the case `alone` just ruled out — so this rename cannot collide.
    if (alone) renamed.set(id, dir);
  }
  return renamed;
}
