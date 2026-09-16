/**
 * File paths ↔ `file://` URIs.
 *
 * Language servers only speak URIs and echo them back with their own casing and percent-encoding
 * (on Windows `file:///d%3A/...` is common), so path comparison always normalizes first:
 * backslashes to forward slashes, drive letters uppercased, lowercase keys on Windows. The
 * diagnostics cache is indexed by URI, and keys must be stable or one file ends up with two cache
 * entries.
 */
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

/** Absolute path → file URI. */
export function pathToUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

/** file URI → local path; null for non-file protocols or when parsing fails. */
export function uriToPath(uri: string): string | null {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/** Uppercase the drive letter (`d:\a` → `D:\a`); other paths are returned unchanged. */
export function normalizeDriveLetter(filePath: string): string {
  return /^[a-z]:[\\/]/.test(filePath) ? filePath[0]!.toUpperCase() + filePath.slice(1) : filePath;
}

/**
 * Comparison key for normalized URIs: uniform slashes, percent-decoded, case-insensitive on Windows.
 *
 * Percent-decoding is required: tsserver writes the drive-letter colon as `%3A`
 * (`file:///c%3A/...`), while `pathToFileURL` emits `file:///C:/...`. Without this step the same
 * file gets two keys and the diagnostics cache never sees a publish (observed with TypeScript
 * diagnostics).
 */
export function uriKey(uri: string): string {
  let normalized = uri.replace(/\\/g, '/');
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep URIs with malformed percent escapes unchanged instead of letting decoding throw.
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** URI → normalized absolute path (for `filePath` in results); null for non-file URIs. */
export function uriToNormalizedPath(uri: string): string | null {
  const filePath = uriToPath(uri);
  return filePath === null ? null : normalizeDriveLetter(path.normalize(filePath));
}

/**
 * Turn a normalized key back into a URI usable for LSP requests: the key is decoded and
 * lowercased, so sending it as-is would make the server fail to recognize the document. This is
 * only for **display and keys**; requests always use the result of {@link pathToUri}.
 */
export function isSameDocumentUri(a: string, b: string): boolean {
  return uriKey(a) === uriKey(b);
}
