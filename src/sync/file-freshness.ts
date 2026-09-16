import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import type { FileRecord } from '../types';
import { validatePathWithinRoot } from '../utils';

export type FileFreshness = 'current' | 'changed' | 'missing' | 'unavailable';

/** Only the given file is checked; a file whose timestamp changed but whose content is identical does not count as stale. */
export function indexedFileFreshness(root: string, record: FileRecord | null, content?: string): FileFreshness {
  if (!record) return 'unavailable';
  const absolute = validatePathWithinRoot(root, record.path);
  if (!absolute) return 'unavailable';
  try {
    const stat = statSync(absolute);
    if (!stat.isFile()) return 'unavailable';
    // 编辑目标已经读入内容，必须校验哈希；相同长度和时间戳不能证明源码未变。
    if (content === undefined && stat.size === record.size && Math.floor(stat.mtimeMs) === Math.floor(record.modifiedAt)) return 'current';
    // Matches the extractor's hashContent, so timestamp changes with identical content are not misjudged as stale.
    const hash = createHash('sha256').update(content ?? readFileSync(absolute, 'utf-8')).digest('hex');
    return hash === record.contentHash ? 'current' : 'changed';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable';
  }
}
