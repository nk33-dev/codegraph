import type { IndexStatus } from '../index';

export type RevisionStatus = 'verified' | 'files-current' | 'stale' | 'unverified';

export function indexRevision(status: Pick<IndexStatus, 'indexedCommit' | 'currentCommit' | 'laggingFileCount'>, checkedFiles: boolean): RevisionStatus {
  if (status.laggingFileCount > 0 || (status.indexedCommit && status.currentCommit && status.indexedCommit !== status.currentCommit)) return 'stale';
  if (status.indexedCommit && status.currentCommit) return 'verified';
  return checkedFiles ? 'files-current' : 'unverified';
}

export const REVISION_MESSAGES: Record<RevisionStatus, string> = {
  verified: 'Index commit matches HEAD; unchecked working-tree changes may still exist.',
  'files-current': 'No file changes detected; Git commit provenance is missing.',
  stale: 'Index is behind the current code; run codegraph sync.',
  unverified: 'Git commit provenance is missing and files have not been checked; current code correspondence is unverified.',
};
