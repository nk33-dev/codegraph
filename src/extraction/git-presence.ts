import * as fs from 'node:fs';
import * as path from 'node:path';

/** Reject only paths that cannot belong to a repository; Git remains the authority. */
export function mayHaveGitRepository(root: string): boolean {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR) return true;
  let current: string;
  try { current = fs.realpathSync(root); }
  catch { return true; }
  for (;;) {
    try {
      fs.statSync(path.join(current, '.git'));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return true;
    }
    // Bare repositories have no .git entry. Avoid excluding those or their children.
    if (fs.existsSync(path.join(current, 'HEAD')) && fs.existsSync(path.join(current, 'objects'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
