/**
 * Phase 4: the text-edit engine on its own.
 *
 * These are the rules every edit path inherits (LSP WorkspaceEdits and graph-native body edits both
 * end up here), so they are pinned directly: UTF-16 columns, back-to-front application, refusal of an
 * overlapping or out-of-range edit, CRLF preservation, and the preview's line accounting.
 */
import { describe, expect, it } from 'vitest';
import {
  applyTextEdits,
  buildEditPreview,
  detectEol,
  lineStartOffsets,
  normalizeEol,
  offsetAt,
  positionAt,
  splitLines,
} from '../src/edits/text-edits';
import { CodeEditRefusal, previewHashOf, validateCodeEditRequest, type EditFilePreview } from '../src/edits/contract';

describe('line/offset arithmetic', () => {
  it('indexes LF, CRLF and lone CR line starts alike', () => {
    expect(lineStartOffsets('a\nb\n')).toEqual([0, 2, 4]);
    expect(lineStartOffsets('a\r\nb\r\n')).toEqual([0, 3, 6]);
    expect(lineStartOffsets('a\rb')).toEqual([0, 2]);
    expect(lineStartOffsets('')).toEqual([0]);
  });

  it('resolves a position to an offset and back, and treats "line count, column 0" as end of file', () => {
    const text = 'ab\ncd';
    const starts = lineStartOffsets(text);
    expect(offsetAt(text, starts, { line: 0, character: 0 })).toBe(0);
    expect(offsetAt(text, starts, { line: 1, character: 2 })).toBe(5);
    // One past the last line at column 0 is how "append at EOF" is expressed.
    expect(offsetAt(text, starts, { line: 2, character: 0 })).toBe(5);
    expect(positionAt(text, starts, 4)).toEqual({ line: 1, character: 1 });
  });

  it('refuses a line or column past the end instead of clamping', () => {
    const text = 'ab\ncd';
    const starts = lineStartOffsets(text);
    expect(() => offsetAt(text, starts, { line: 2, character: 1 })).toThrow(CodeEditRefusal);
    expect(() => offsetAt(text, starts, { line: 0, character: 3 })).toThrow(/past the end of line 1/);
    expect(() => offsetAt(text, starts, { line: 9, character: 0 })).toThrow(/past the end of the file/);
  });

  it('detects and rewrites the file line ending', () => {
    expect(detectEol('a\nb\n')).toBe('\n');
    expect(detectEol('a\r\nb\r\n')).toBe('\r\n');
    expect(normalizeEol('x\ny\r\nz', '\r\n')).toBe('x\r\ny\r\nz');
    expect(normalizeEol('x\r\ny', '\n')).toBe('x\ny');
  });

  it('splits lines without inventing a trailing empty line', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\n')).toEqual(['a']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
  });
});

describe('applyTextEdits', () => {
  it('applies edits back-to-front so earlier offsets stay valid', () => {
    const text = 'a\nb\nc\n';
    const result = applyTextEdits(text, [
      { start: { line: 0, character: 0 }, end: { line: 0, character: 1 }, newText: 'A' },
      { start: { line: 2, character: 0 }, end: { line: 2, character: 1 }, newText: 'C' },
    ]);
    expect(result).toBe('A\nb\nC\n');
  });

  it('inserts without deleting, and treats "line count, column 0" as end of file', () => {
    expect(applyTextEdits('abc', [{ start: { line: 0, character: 3 }, end: { line: 0, character: 3 }, newText: '!' }]))
      .toBe('abc!');
    // A file that ends with a newline has a final empty line: inserting there appends a line.
    expect(applyTextEdits('a\nb\n', [{ start: { line: 2, character: 0 }, end: { line: 2, character: 0 }, newText: 'c\n' }]))
      .toBe('a\nb\nc\n');
    // Without a trailing newline the same position is the end of the last line — callers that want a
    // new line must supply the line break themselves (graph insert-after does exactly that).
    expect(applyTextEdits('a\nb', [{ start: { line: 2, character: 0 }, end: { line: 2, character: 0 }, newText: 'c\n' }]))
      .toBe('a\nbc\n');
  });

  it('writes inserted text with the file\'s own line ending', () => {
    const result = applyTextEdits('a\r\nb\r\n', [
      { start: { line: 1, character: 0 }, end: { line: 1, character: 1 }, newText: 'X\nY' },
    ]);
    expect(result).toBe('a\r\nX\r\nY\r\n');
  });

  it('counts columns in UTF-16 code units, not bytes or code points', () => {
    // '😀' is two UTF-16 code units (and four UTF-8 bytes); the name after it starts at character 3.
    const text = 'const 😀 = 1; // x\nconst x = 2;\n';
    const result = applyTextEdits(text, [
      { start: { line: 0, character: 6 }, end: { line: 0, character: 8 }, newText: 'y' },
    ]);
    expect(result.startsWith('const y = 1;')).toBe(true);
  });

  it('refuses overlapping edits and a backwards range', () => {
    expect(() => applyTextEdits('abcdef', [
      { start: { line: 0, character: 0 }, end: { line: 0, character: 4 }, newText: 'X' },
      { start: { line: 0, character: 2 }, end: { line: 0, character: 5 }, newText: 'Y' },
    ])).toThrow(/overlap/);
    expect(() => applyTextEdits('abc', [
      { start: { line: 0, character: 2 }, end: { line: 0, character: 1 }, newText: 'X' },
    ])).toThrow(/ends before it starts/);
  });

  it('is a no-op for an empty edit list', () => {
    expect(applyTextEdits('abc', [])).toBe('abc');
  });
});

describe('buildEditPreview', () => {
  it('shows the differing lines with context, and counts them', () => {
    const preview = buildEditPreview('a\nb\nc\nd\n', [
      { start: { line: 1, character: 0 }, end: { line: 1, character: 1 }, newText: 'B1\nB2' },
    ]);
    expect(preview.lines).toEqual([
      { kind: 'context', line: 1, text: 'a' },
      { kind: 'remove', line: 2, text: 'b' },
      { kind: 'add', line: 2, text: 'B1' },
      { kind: 'add', line: 3, text: 'B2' },
    ]);
    expect({ additions: preview.additions, deletions: preview.deletions, truncated: preview.truncated })
      .toEqual({ additions: 2, deletions: 1, truncated: false });
  });

  it('separates distant edits with a gap and numbers added lines through the running shift', () => {
    const preview = buildEditPreview('a\nb\nc\n', [
      { start: { line: 0, character: 0 }, end: { line: 0, character: 1 }, newText: 'A' },
      { start: { line: 2, character: 0 }, end: { line: 2, character: 1 }, newText: 'C' },
    ]);
    expect(preview.lines.map((line) => line.kind)).toEqual(['remove', 'add', 'gap', 'context', 'remove', 'add']);
    expect(preview.lines[5]).toEqual({ kind: 'add', line: 3, text: 'C' });
  });

  it('truncates the display but keeps the counts complete', () => {
    const preview = buildEditPreview('a\nb\nc\n', [
      { start: { line: 0, character: 0 }, end: { line: 2, character: 1 }, newText: '1\n2\n3\n4\n5' },
    ], { maxLines: 2 });
    expect(preview.truncated).toBe(true);
    expect(preview.lines).toHaveLength(2);
    expect(preview.additions).toBe(5);
    expect(preview.deletions).toBe(3);
  });

  it('trims the lines both sides share and keeps nothing when nothing differs', () => {
    const same = buildEditPreview('a\nb\n', [
      { start: { line: 1, character: 0 }, end: { line: 1, character: 1 }, newText: 'b' },
    ]);
    expect(same.lines).toEqual([]);
    expect({ additions: same.additions, deletions: same.deletions }).toEqual({ additions: 0, deletions: 0 });
  });
});

describe('edit contract helpers', () => {
  it('rejects arguments that do not belong to the operation', () => {
    expect(() => validateCodeEditRequest({ operation: 'rename', symbol: 'x', file: 'a.ts', newName: 'y', content: 'z' }))
      .toThrow(/content is not accepted by rename/);
    expect(() => validateCodeEditRequest({ operation: 'replace-body', symbol: 'x', file: 'a.ts', newName: 'y', content: 'z' }))
      .toThrow(/newName is only accepted by rename/);
    expect(() => validateCodeEditRequest({ operation: 'replace-body', symbol: 'x', file: 'a.ts' }))
      .toThrow(/requires content/);
    expect(() => validateCodeEditRequest({ operation: 'rename', symbol: 'x', newName: 'given name' }))
      .toThrow(/must not contain whitespace/);
    expect(() => validateCodeEditRequest({ operation: 'rename', symbol: 'x', newName: 'y', apply: false, expectPreviewHash: 'abc' }))
      .toThrow(/only meaningful with apply:true/);
    expect(() => validateCodeEditRequest({ operation: 'insert-after', symbol: 'x', file: 'a.ts', content: 'c', line: 3 }))
      .toThrow(/only supported by rename/);
  });

  it('hashes a preview stably and sensitively', () => {
    const file = (overrides: Partial<EditFilePreview> = {}): EditFilePreview => ({
      filePath: 'a.ts', operation: 'modify', baseHash: 'base', resultHash: 'result',
      edits: [{ startLine: 1, startColumn: 0, endLine: 1, endColumn: 3, oldText: 'old', newText: 'new' }],
      preview: [], previewTruncated: false, additions: 1, deletions: 1, ...overrides,
    });
    const first = previewHashOf('replace-body', [file()]);
    expect(previewHashOf('replace-body', [file()])).toBe(first);
    expect(previewHashOf('insert-after', [file()])).not.toBe(first);
    expect(previewHashOf('replace-body', [file({ resultHash: 'other' })])).not.toBe(first);
  });
});
