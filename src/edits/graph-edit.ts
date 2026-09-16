/**
 * Graph-native symbol edits (phase 4): replace a symbol body, insert code before or after a symbol.
 *
 * These three are purely textual at a range the index already knows, so they need no language server:
 * the range comes from the symbol's node (1-based lines and UTF-8 byte columns), converted to the
 * UTF-16 columns this contract reports, and the replacement text is written with the file's own line
 * ending.
 *
 * Conventions (deliberately the same shape Serena uses, so callers moving between the two are not
 * surprised):
 *   - `replace-body` replaces the whole definition (signature included) — what "the body" means is
 *     decided by the parser, not by us, and docstrings/annotations are part of it when the grammar
 *     includes them;
 *   - the replacement text is trimmed, because the indentation before the declaration stays in the
 *     file and the text after the declaration (its line break) is untouched;
 *   - `insert-before` inserts above the declaration's line when only whitespace precedes the
 *     declaration (so the declaration keeps its indentation — the caller's text must carry its own),
 *     otherwise immediately before the declaration's first character, and guarantees a line break
 *     after the inserted text;
 *   - `insert-after` inserts at the start of the line following the declaration; when the symbol ends
 *     without a line break (end of file) one is added, and an existing blank separator line is kept
 *     before the new code.
 */
import {
  CodeEditRefusal,
  sha256,
  type CodeEditRequest,
  type EditFilePreview,
  type EditTextEdit,
} from './contract';
import type { Node } from '../types';
import {
  applyTextEdits,
  buildEditPreview,
  detectEol,
  lineLength,
  lineStartOffsets,
  normalizeEol,
  offsetAt,
  type InternalPosition,
  type InternalTextEdit,
} from './text-edits';
import { nodeRangePositions, type ResolvedEditTarget } from './target';

/** The insertion point's text prefix so the inserted code starts on its own line. */
function insertionPrefix(text: string, offset: number, eol: '\n' | '\r\n'): string {
  const atLineStart = offset === 0 || text[offset - 1] === '\n' || text[offset - 1] === '\r';
  if (!atLineStart) return eol;
  // Keep one existing blank separator line before the new code instead of swallowing it.
  let end = offset;
  while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1;
  const restOfLine = text.slice(offset, end);
  const hasFollowingContent = end < text.length;
  return restOfLine.trim() === '' && hasFollowingContent ? eol : '';
}

/**
 * Declaration modifiers that belong to the definition but sit outside the parser's node.
 *
 * The TypeScript extractor's node for `export function run()` starts at `function`, leaving
 * `export ` outside it: replacing the node alone would produce `export export function …`. A run of
 * these at the start of the declaration line is therefore pulled into the replaced range. The set is
 * deliberately limited to pure modifiers — `const`/`let`/`var` are **not** in it, because for a
 * variable declaration the node covers only `NAME = value`, so pulling the keyword in would then
 * leave the trailing `;` behind (see {@link FRAGMENT_KINDS}).
 */
const DECLARATION_MODIFIERS = new Set([
  'export', 'default', 'declare', 'abstract', 'async', 'static', 'public', 'private', 'protected',
  'internal', 'final', 'open', 'override', 'sealed', 'partial', 'virtual', 'inline', 'extern',
  'unsafe', 'readonly', 'mut', 'pub', 'synchronized', 'native', 'transient', 'volatile', 'strictfp',
  'constexpr', 'consteval', 'constinit', 'nested', 'global', 'local', 'friend',
]);

/**
 * Node kinds whose indexed range is only a fragment of the declaration (the name, or `name = value`),
 * so a body replacement cannot promise "the whole definition". The caller is warned and the edits
 * show exactly what is replaced.
 */
export const FRAGMENT_KINDS: ReadonlySet<Node['kind']> = new Set<Node['kind']>([
  'variable', 'constant', 'property', 'field', 'parameter',
]);

/**
 * The start of the **definition**, not of the node: leading declaration modifiers on the same line are
 * included. A comment, an annotation and any other non-modifier token stop the scan, so
 * `#[attr] pub fn f()` and `/* c *&#47; export function f()` keep everything before the node untouched.
 */
export function definitionStart(
  text: string,
  starts: number[],
  start: InternalPosition,
): InternalPosition {
  const lineStart = starts[start.line]!;
  const offset = lineStart + start.character;
  const prefix = text.slice(lineStart, offset);
  if (prefix.trim() === '') return start;
  let index = 0;
  let sawModifier = false;
  for (;;) {
    while (index < prefix.length && (prefix[index] === ' ' || prefix[index] === '\t')) index += 1;
    if (index >= prefix.length) break;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(\([^()]*\))?/.exec(prefix.slice(index));
    if (!match || !DECLARATION_MODIFIERS.has(match[1]!)) return start;
    const after = index + match[0].length;
    if (after < prefix.length && prefix[after] !== ' ' && prefix[after] !== '\t') return start;
    index = after;
    sawModifier = true;
  }
  if (!sawModifier) return start;
  let first = 0;
  while (first < prefix.length && (prefix[first] === ' ' || prefix[first] === '\t')) first += 1;
  return { line: start.line, character: first };
}

/**
 * The end of the definition's last content line.
 *
 * A node whose range ends at column 0 of a later line (some grammars report it that way) has its last
 * content on the previous line: taking that position literally would either swallow the line break
 * (a body replacement gluing the next line onto the new text) or insert one line too low.
 */
function definitionEnd(
  text: string,
  starts: number[],
  range: { start: InternalPosition; end: InternalPosition },
): InternalPosition {
  if (range.end.character !== 0 || range.end.line <= range.start.line) return range.end;
  const line = range.end.line - 1;
  return { line, character: lineLength(text, starts, line) };
}

function toPublicEdit(text: string, starts: number[], edit: InternalTextEdit): EditTextEdit {
  const start = offsetAt(text, starts, edit.start);
  const end = offsetAt(text, starts, edit.end);
  return {
    startLine: edit.start.line + 1,
    startColumn: edit.start.character,
    endLine: edit.end.line + 1,
    endColumn: edit.end.character,
    oldText: text.slice(start, end),
    newText: edit.newText,
  };
}

/** Build the preview for one of the three graph-native operations. */
export function planGraphEdit(
  request: CodeEditRequest,
  target: ResolvedEditTarget,
): EditFilePreview {
  const node = target.node;
  if (!node) {
    throw new CodeEditRefusal(`operation "${request.operation}" needs a symbol resolved from the index`);
  }
  const text = target.text;
  const eol = detectEol(text);
  const starts = lineStartOffsets(text);
  const range = nodeRangePositions(text, node);
  // The definition starts at its first modifier, not at the parser node (see DECLARATION_MODIFIERS).
  const start = definitionStart(text, starts, range.start);
  const end = definitionEnd(text, starts, range);
  const content = normalizeEol(request.content ?? '', eol);

  let edit: InternalTextEdit;
  if (request.operation === 'replace-body') {
    const replacement = content.trim();
    if (!replacement) throw new CodeEditRefusal('replace-body needs non-empty content');
    edit = { start, end, newText: replacement };
  } else if (request.operation === 'insert-before') {
    const body = content.replace(/\s+$/, '');
    if (!body.trim()) throw new CodeEditRefusal('insert-before needs non-empty content');
    // Inserting at the declaration's own column would swallow its indentation (the whitespace before
    // it becomes the inserted block's first line); when only whitespace precedes the declaration, the
    // insertion goes to the start of the line so the declaration keeps its place and indentation.
    const linePrefix = text.slice(starts[start.line]!, offsetAt(text, starts, start));
    const insertion = linePrefix.trim() === '' ? { line: start.line, character: 0 } : start;
    edit = { start: insertion, end: insertion, newText: `${body}${eol}` };
  } else {
    const body = content.replace(/\s+$/, '');
    if (!body.trim()) throw new CodeEditRefusal('insert-after needs non-empty content');
    const position = { line: end.line + 1, character: 0 };
    const offset = offsetAt(text, starts, position);
    edit = {
      start: position,
      end: position,
      newText: `${insertionPrefix(text, offset, eol)}${body}${eol}`,
    };
  }

  const resultText = applyTextEdits(text, [edit], eol);
  const preview = buildEditPreview(text, [edit], { eol });
  return {
    filePath: target.filePath,
    operation: 'modify',
    baseHash: sha256(text),
    resultHash: sha256(resultText),
    edits: [toPublicEdit(text, starts, edit)],
    preview: preview.lines,
    previewTruncated: preview.truncated,
    additions: preview.additions,
    deletions: preview.deletions,
  };
}
