/**
 * codegraph_explore: a requested test file renders as a compact summary.
 *
 * Reported regression: a natural-language query that asked for a symbol's
 * definition, callers, AND related tests returned the right three files but
 * 23,508 characters / 587 lines, because the test file's whole body was
 * rendered — fixture literals, table rows, setup scaffolding and all. The
 * question was "where are the tests and what do they exercise", and the answer
 * was buried in ~500 lines of data the agent never asked to read.
 *
 * The contract pinned here:
 *   1. a requested test file is NAMED, its test declarations are listed, and
 *      each declaration is marked with the production symbols it exercises;
 *   2. its body is sampled rather than dumped, and the response is a fraction of
 *      the full-source render;
 *   3. `includeTestSource: true` still returns the whole file as source, and
 *      full test references remain reachable by exploring a test's own name;
 *   4. a query that does NOT ask for tests is untouched — a test file reached
 *      incidentally (and, more importantly, a plain query on a source file)
 *      renders exactly as before.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

/** A test file whose scaffolding dwarfs the code under test. */
function bulkyTestFile(): string {
  const rows = Array.from({ length: 90 }, (_, i) =>
    `  expect(normalizeTabs(${i})).toBe(${i});\n` +
    `  expect(normalizeTabs(-${i})).toBe(0);\n` +
    `  expect(tabColumns(${i})).toEqual([${i}]); // row-${i}\n`).join('');
  return (
    `import { normalizeTabs, tabColumns } from '../src/tabs';\n` +
    `\n` +
    `const BIG_TABLE: Array<[string, number]> = [\n` +
    Array.from({ length: 120 }, (_, i) => `  ['row-${i}', ${i}],`).join('\n') +
    `\n];\n` +
    `\n` +
    `export function handlesEveryTableRow(): number {\n` +
    `  let total = 0;\n${rows}` +
    `  return total + BIG_TABLE.length;\n` +
    `}\n` +
    `\n` +
    `export function rejectsNegativeIndexes(): boolean {\n` +
    `  return normalizeTabs(-1) === 0;\n` +
    `}\n`
  );
}

describe('codegraph_explore — requested test files render compactly', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-testsummary-'));
    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(testDir, '__tests__'), { recursive: true });

    fs.writeFileSync(path.join(testDir, 'src', 'tabs.ts'),
      `export function normalizeTabs(value: number): number {\n` +
      `  return value < 0 ? 0 : value;\n` +
      `}\n` +
      `export function tabColumns(value: number): number[] {\n` +
      `  return [value];\n` +
      `}\n`);
    fs.writeFileSync(path.join(testDir, 'src', 'bin.ts'),
      `import { normalizeTabs } from './tabs';\n` +
      `export function tabCommand(value: number): number {\n` +
      `  return normalizeTabs(value);\n` +
      `}\n`);
    fs.writeFileSync(path.join(testDir, '__tests__', 'tabs.test.ts'), bulkyTestFile());

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  const explore = async (
    query: string,
    args: Record<string, unknown> = {},
  ): Promise<string> => {
    const res = await handler.execute('codegraph_explore', { query, ...args });
    expect(res.isError).toBeFalsy();
    return res.content[0]!.text;
  };

  const TEST_QUERY = 'normalizeTabs definition, all callers and related tests';

  it('names the test file and its declarations instead of dumping the body', async () => {
    const text = await explore(TEST_QUERY);

    expect(text).toContain('__tests__/tabs.test.ts');
    // Test declarations are named, with their line numbers.
    expect(text).toMatch(/\d+\texport function handlesEveryTableRow/);
    expect(text).toMatch(/\d+\texport function rejectsNegativeIndexes/);
    // The fixture table is NOT: 120 rows of data the query never asked for.
    expect(text).not.toContain("['row-119', 119]");
    expect(text).not.toContain('BIG_TABLE = [');
  });

  it('says what each declaration exercises and how to get its full body', async () => {
    const text = await explore(TEST_QUERY);

    // The exercised production symbols, read from the call edges inside the test.
    expect(text).toMatch(/exercises\s+normalizeTabs, tabColumns/);
    // The expansion path is stated rather than left to be guessed: the sampled
    // body says which name to explore.
    expect(text).toMatch(/test body elided — explore `handlesEveryTableRow`/);
    expect(text).toMatch(/test bod(y|ies) sampled/);
  });

  it('replaces hundreds of lines with a fraction of the characters', async () => {
    const compact = await explore(TEST_QUERY);
    const full = await explore(TEST_QUERY, { includeTestSource: true });

    // The file's own bytes dominate the full render; the summary must shed the
    // overwhelming majority of them, not shave a few percent.
    expect(full.length).toBeGreaterThan(compact.length * 4);
    expect(compact).toMatch(/test summary — 2 declarations/);
    // The 270-line test body is what the summary trades away; everything it
    // keeps is the declaration, its line, and what it exercises.
    expect(compact).not.toContain('tabColumns(89)');
    // The full render still spends bytes on that body.
    expect(full).toContain('tabColumns(0)');
  });

  it('includeTestSource: true renders the test file as ordinary source', async () => {
    const full = await explore(TEST_QUERY, { includeTestSource: true });

    // No summary header, no sampled-body note: this is the ordinary render path.
    expect(full).not.toContain('test summary');
    expect(full).not.toMatch(/test bod(y|ies) sampled/);
    expect(full).toContain('tabColumns(0)');
  });

  it('keeps a test reachable by its own name, so no reference is lost', async () => {
    // The summary points at the declaration, and exploring that name returns the
    // exact body — the structured result the compact view trades bytes for.
    const body = await explore('handlesEveryTableRow');
    expect(body).toContain('row-89');
    expect(body).toContain('return total + BIG_TABLE.length;');
    expect(body).not.toMatch(/test body elided/);
  });

  it('does not compact test files when the query never asked for tests', async () => {
    // A query that names no test intent is untouched: the render path is the
    // ordinary one, whatever the ranking brings along.
    const text = await explore('normalizeTabs');
    expect(text).toBeTruthy();
    expect(text).not.toMatch(/bodies sampled/);
  });
});
