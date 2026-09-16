/**
 * Read-only MCP ToolAnnotations on every codegraph tool (issue #1018).
 *
 * Every codegraph *query* tool is read-only — it reads the pre-built index and never mutates the
 * workspace. Clients gate on this: Cursor's Ask mode refuses any MCP tool that doesn't advertise
 * `readOnlyHint: true`, so without annotations the codegraph tools were blocked there even though
 * they only read.
 *
 * These tests pin that the read-only contract is present on the master tool array AND survives every
 * transform that builds a `tools/list` response — the static proxy surface (`getStaticTools`), the
 * live surface (`getTools`, which rewrites codegraph_explore's description via spread), and the no-
 * default-project surface (`withRequiredProjectPath`, which clones the schema). A drop in any of those
 * would silently re-block the tools in Ask mode.
 *
 * `codegraph_explore`'s `_meta` (`anthropic/alwaysLoad`, #1696) rides the same spreads, so each
 * surface is checked for it here too.
 *
 * Personal-fork note: phase 4 adds `codegraph_edit`, the one tool that DOES mutate the workspace. It
 * lives in a separate array (`editTools`, merged into `allTools`) so the read-only contract stays
 * assertable over `tools` alone; its own mutating annotations are asserted separately below.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolHandler, allTools, getStaticTools, tools, type ToolDefinition } from '../src/mcp/tools';
import { CodeGraph } from '../src';

const ENV = 'CODEGRAPH_MCP_TOOLS';
const ALL_TOOLS = allTools.map((t) => t.name).join(',');
/** The fork's mutating tools (today: just `codegraph_edit`). */
const MUTATING_TOOLS = allTools.filter((t) => !tools.includes(t));

/** Assert a single tool advertises the full read-only contract from #1018. */
function expectReadOnly(tool: ToolDefinition): void {
  expect(tool.annotations, `${tool.name} is missing annotations`).toBeDefined();
  // The hint Cursor Ask mode (and other clients) gate on.
  expect(tool.annotations!.readOnlyHint).toBe(true);
  // The exact triplet the issue asks for, plus the honest closed-world hint.
  expect(tool.annotations!.destructiveHint).toBe(false);
  expect(tool.annotations!.idempotentHint).toBe(true);
  expect(tool.annotations!.openWorldHint).toBe(false);
}

/** Assert the one mutating tool advertises the opposite contract (phase 4). */
function expectMutating(tool: ToolDefinition): void {
  expect(tool.name).toBe('codegraph_edit');
  expect(tool.annotations).toMatchObject({
    readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false,
  });
}

/** Assert a whole `tools/list` surface: read-only tools must say so, the edit tool must not lie. */
function expectSurface(surface: ToolDefinition[]): void {
  for (const tool of surface) {
    if (tool.annotations?.readOnlyHint === false) expectMutating(tool);
    else expectReadOnly(tool);
  }
}

/** Assert the explore tool in a `tools/list` surface is marked always-load for Claude Code (#1696). */
function expectExploreAlwaysLoad(surface: ToolDefinition[]): void {
  const explore = surface.find((t) => t.name === 'codegraph_explore');
  expect(explore, 'codegraph_explore is missing from the surface').toBeDefined();
  expect(explore!._meta).toEqual({ 'anthropic/alwaysLoad': true });
}

describe('Read-only annotations on the codegraph MCP tools (#1018)', () => {
  const original = process.env[ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it('every tool in the master array is annotated read-only', () => {
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expectReadOnly(tool);
    // The mutating tool is defined separately and keeps its own (opposite) contract.
    expect(MUTATING_TOOLS.map((tool) => tool.name)).toEqual(['codegraph_edit']);
    for (const tool of MUTATING_TOOLS) expectMutating(tool);
    expectExploreAlwaysLoad(tools);
  });

  it('the static proxy surface carries annotations on every exposed tool', () => {
    // getStaticTools() answers tools/list before any project opens (proxy path).
    process.env[ENV] = ALL_TOOLS;
    const got = getStaticTools();
    expect(got.map((t) => t.name).sort()).toEqual(allTools.map((t) => t.name).sort());
    expectSurface(got);
    expectExploreAlwaysLoad(got);
  });

  it('the no-default-project surface keeps annotations through the schema clone', () => {
    // withRequiredProjectPath (null cg) clones each tool's inputSchema — the
    // top-level annotations field must ride along on the spread.
    process.env[ENV] = ALL_TOOLS;
    const got = new ToolHandler(null).getTools();
    expect(got.length).toBe(allTools.length);
    for (const tool of got) {
      expectSurface([tool]);
      // Sanity: this IS the clone path (projectPath got marked required).
      expect(tool.inputSchema.required ?? []).toContain('projectPath');
    }
    expectExploreAlwaysLoad(got);
  });
});

describe('Live tool surface keeps annotations with a project open (#1018)', () => {
  let tempDir: string;
  let cg: CodeGraph;
  const original = process.env[ENV];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-annot-'));
    fs.writeFileSync(
      path.join(tempDir, 'pay.ts'),
      'export function processPayment(amount: number): boolean { return amount > 0; }\n'
    );
    cg = await CodeGraph.init(tempDir, { index: true });
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it('getTools() keeps annotations, incl. codegraph_explore whose description is rebuilt', () => {
    process.env[ENV] = ALL_TOOLS;
    const got = new ToolHandler(cg).getTools();
    expect(got.length).toBeGreaterThan(0);
    expectSurface(got);

    // explore's description is regenerated with a per-repo advisory-guidance
    // suffix via object spread; the annotation must survive that rewrite.
    const explore = got.find((t) => t.name === 'codegraph_explore');
    expect(explore).toBeDefined();
    expect(explore!.description).toMatch(/advisory only, NOT a quota/);
    expect(explore!.description).not.toMatch(/make at most/);
    expectReadOnly(explore!);
    expectExploreAlwaysLoad(got);
  });
});
