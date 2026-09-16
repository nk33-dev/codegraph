/**
 * The one place where a text edit is turned into file content (phase 4).
 *
 * Every edit path (an LSP WorkspaceEdit, a graph-native body replacement, an insertion) ends up here,
 * so there is a single definition of "apply these edits": how columns are interpreted (UTF-16 code
 * units, exactly like the query contract's `lsp` coordinates), what a valid range is, that edits are
 * applied back-to-front, and that a newline in inserted text follows the file's own line ending
 * instead of silently converting a CRLF file to LF.
 *
 * Positions here are LSP-shaped (0-based lines and characters); the public contract converts to its
 * 1-based line / 0-based column form at the boundary.
 */
import { CodeEditRefusal } from './contract';

export interface InternalPosition {
  line: number;
  character: number;
}

export interface InternalTextEdit {
  start: InternalPosition;
  end: InternalPosition;
  newText: string;
}

export type Eol = '\n' | '\r\n';

/** The file's dominant line ending; CRLF wins when the file contains one (a mixed file is treated as CRLF). */
export function detectEol(text: string): Eol {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Rewrite every line break in `text` to the file's own line ending. */
export function normalizeEol(text: string, eol: Eol): string {
  return text.replace(/\r\n|\r|\n/g, eol);
}

/** Byte offsets of every line start. A trailing newline produces a final empty line, as in an editor. */
export function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10) {
      starts.push(index + 1);
    } else if (code === 13) {
      if (text.charCodeAt(index + 1) === 10) index += 1;
      starts.push(index + 1);
    }
  }
  return starts;
}

/** Content length of a line, excluding its line break. */
export function lineLength(text: string, starts: number[], line: number): number {
  const start = starts[line]!;
  let end = start;
  while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1;
  return end - start;
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 0-based (line, character) → offset. A position past the last line is accepted only as the exact
 * end of the file (line == line count, character 0), which is how "append at EOF" is expressed.
 */
export function offsetAt(text: string, starts: number[], position: InternalPosition): number {
  const { line, character } = position;
  if (!Number.isSafeInteger(line) || line < 0) throw new CodeEditRefusal(`invalid line ${line}`);
  if (!Number.isSafeInteger(character) || character < 0) throw new CodeEditRefusal(`invalid character ${character}`);
  if (line > starts.length - 1) {
    if (line === starts.length && character === 0) return text.length;
    throw new CodeEditRefusal(`line ${line + 1} is past the end of the file`);
  }
  const length = lineLength(text, starts, line);
  if (character > length) {
    throw new CodeEditRefusal(`column ${character} is past the end of line ${line + 1} (length ${length})`);
  }
  return starts[line]! + character;
}

/** 0-based offset → 0-based (line, character), used to report positions back to the caller. */
export function positionAt(text: string, starts: number[], offset: number): InternalPosition {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= clamped) low = middle;
    else high = middle - 1;
  }
  return { line: low, character: clamped - starts[low]! };
}

interface ResolvedEdit {
  start: number;
  end: number;
  newText: string;
}

/**
 * Validate and apply edits to `text`.
 *
 * Refusals (never a best-effort rewrite of a file):
 *   - a range that ends before it starts;
 *   - a range past the end of the file or of its line;
 *   - two edits that overlap.
 *
 * Insertions at the same offset are allowed (they apply in the given order), and edits are applied
 * from the end backwards so earlier offsets stay valid.
 */
export function applyTextEdits(text: string, edits: InternalTextEdit[], eol = detectEol(text)): string {
  if (edits.length === 0) return text;
  const starts = lineStartOffsets(text);
  const resolved: ResolvedEdit[] = edits.map((edit) => {
    const start = offsetAt(text, starts, edit.start);
    const end = offsetAt(text, starts, edit.end);
    if (end < start) throw new CodeEditRefusal('an edit ends before it starts');
    return { start, end, newText: normalizeEol(edit.newText, eol) };
  });

  const ordered = [...resolved].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.start < ordered[index - 1]!.end) {
      throw new CodeEditRefusal('two edits overlap; refusing to guess an order');
    }
  }

  let out = text;
  for (const edit of [...ordered].sort((a, b) => b.start - a.start || b.end - a.end)) {
    out = out.slice(0, edit.start) + edit.newText + out.slice(edit.end);
  }
  return out;
}

/** Everything a preview shows for one edit, with the common lines already trimmed away. */
interface TrimmedEdit {
  edit: ResolvedEdit;
  /** Context line (1-based original line number and text), when the edit does not start at the file start. */
  contextLine: { line: number; text: string } | null;
  removedLines: Array<{ line: number; text: string }>;
  addedLines: string[];
}

function trimCommonLines(
  oldLines: string[],
  newLines: string[],
): { old: string[]; added: string[]; trimmedLeading: number } {
  let leading = 0;
  while (leading < oldLines.length && leading < newLines.length && oldLines[leading] === newLines[leading]) {
    leading += 1;
  }
  let trailing = 0;
  while (
    trailing < oldLines.length - leading
    && trailing < newLines.length - leading
    && oldLines[oldLines.length - 1 - trailing] === newLines[newLines.length - 1 - trailing]
  ) {
    trailing += 1;
  }
  return {
    old: oldLines.slice(leading, oldLines.length - trailing),
    added: newLines.slice(leading, newLines.length - trailing),
    trimmedLeading: leading,
  };
}

export interface EditPreviewBuild {
  lines: Array<{ kind: 'context' | 'add' | 'remove' | 'gap'; line: number | null; text: string }>;
  additions: number;
  deletions: number;
  truncated: boolean;
}

/** How many lines of the whole file a preview shows before it stops printing (counts stay complete). */
export const PREVIEW_MAX_LINES = 200;
/** Context lines kept around each edit so a reader can see where it lands. */
const PREVIEW_CONTEXT_LINES = 1;

/**
 * The minimal-ish line preview for a set of edits: per edit, the differing lines (after trimming the
 * lines the two sides share) plus one context line, with a gap marker between edits. `additions` and
 * `deletions` count every edit, whether or not the display was truncated.
 */
export function buildEditPreview(
  before: string,
  edits: InternalTextEdit[],
  options: { eol?: Eol; maxLines?: number } = {},
): EditPreviewBuild {
  const eol = options.eol ?? detectEol(before);
  const maxLines = options.maxLines ?? PREVIEW_MAX_LINES;
  const starts = lineStartOffsets(before);
  const beforeLines = splitLines(before);
  const resolved: ResolvedEdit[] = edits.map((edit) => ({
    start: offsetAt(before, starts, edit.start),
    end: offsetAt(before, starts, edit.end),
    newText: normalizeEol(edit.newText, eol),
  })).sort((a, b) => a.start - b.start || a.end - b.end);

  const trimmed: TrimmedEdit[] = resolved.map((edit) => {
    const oldText = before.slice(edit.start, edit.end);
    const { old, added, trimmedLeading } = trimCommonLines(splitLines(oldText), splitLines(edit.newText));
    const startLine = positionAt(before, starts, edit.start).line;
    const firstRemovedLine = startLine + trimmedLeading;
    const contextIndex = firstRemovedLine - PREVIEW_CONTEXT_LINES;
    return {
      edit,
      contextLine: contextIndex >= 0 && contextIndex < beforeLines.length && (old.length > 0 || added.length > 0)
        ? { line: contextIndex + 1, text: beforeLines[contextIndex]! }
        : null,
      removedLines: old.map((text, index) => ({ line: firstRemovedLine + index + 1, text })),
      addedLines: added,
    };
  });

  const lines: EditPreviewBuild['lines'] = [];
  let additions = 0;
  let deletions = 0;
  let truncated = false;
  let delta = 0;
  for (const entry of trimmed) {
    additions += entry.addedLines.length;
    deletions += entry.removedLines.length;
    if (truncated) {
      delta += entry.addedLines.length - entry.removedLines.length;
      continue;
    }
    if (lines.length > 0) lines.push({ kind: 'gap', line: null, text: '⋯' });
    const push = (kind: 'context' | 'add' | 'remove', line: number | null, text: string): void => {
      if (lines.length >= maxLines) {
        truncated = true;
        return;
      }
      lines.push({ kind, line, text });
    };
    if (entry.contextLine) push('context', entry.contextLine.line, entry.contextLine.text);
    for (const removed of entry.removedLines) push('remove', removed.line, removed.text);
    entry.addedLines.forEach((text, index) => {
      const startLine = positionAt(before, starts, entry.edit.start).line + 1 + delta;
      push('add', startLine + index, text);
    });
    delta += entry.addedLines.length - entry.removedLines.length;
  }
  return { lines, additions, deletions, truncated };
}
