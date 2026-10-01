/**
 * A file the query named must not lose a REGION of itself in silence.
 *
 * Two shapes, both observed on a real .vue component before this gate existed:
 *
 *  1. **The head.** A Vue SFC's `component` node spans the whole file
 *     (`src/extraction/vue-extractor.ts`), so it hits the envelope filter's
 *     "container covering >50% of the file" rule. When the query names the file
 *     by PATH that container is the only node covering the top — `<template>`
 *     and `<style>` both precede the `<script setup>` — so lines 1..N were
 *     never rendered at all: `Panel.vue` came back as lines 159-353. Nothing
 *     said so, because gap markers only label holes BETWEEN two rendered
 *     slices. Naming the component by SYMBOL was fine (that path exempts
 *     `flow.namedNodeIds`); only the path pin was broken.
 *
 *  2. **The tail.** A section that runs out of budget stops, and the stop was
 *     reported only as the generic "Some file sections were trimmed for size".
 *     A 700-line component named by symbol came back as lines 1-503 with no
 *     line range for the 197 it dropped and no callable way to ask for them.
 *
 * The fixture is a .vue SFC — template, style, then a script block — plus
 * competing files heavy enough to make the budget bite, so both cases are
 * reproducible rather than incidental.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler, uncoveredRuns, formatContinuationNote } from '../src/mcp/tools';

const BIG = 'src/components/BigPanel.vue';
const HUGE = 'src/components/HugePanel.vue';
const SMALL = 'src/components/SmallPanel.vue';
/** Sits on line 2, so its presence proves line 1 of the file was rendered. */
const HEAD_MARKER = 'TEMPLATE_HEAD_MARKER';

/**
 * A single-file component: `<template>` (20% of the file), `<style>` (to 45%),
 * then a `<script setup>` of short functions. The split is the point — every
 * indexed symbol lives after the style block, so nothing else covers the top.
 */
function makeVue(lines: number, prefix: string, headMarker?: string): string {
  const out: string[] = ['<template>', `  <div class="${headMarker ?? prefix}-root">`];
  const templateEnd = Math.floor(lines * 0.2);
  while (out.length < templateEnd) out.push(`    <span>${prefix} row ${out.length}</span>`);
  out.push('  </div>', '</template>', '', '<style scoped>');
  const styleEnd = Math.floor(lines * 0.45);
  while (out.length < styleEnd) out.push(`.${prefix}-${out.length} { margin: ${out.length % 9}px; }`);
  out.push('</style>', '', '<script setup lang="ts">');
  let i = 0;
  while (out.length < lines - 3) {
    i++;
    out.push(`function ${prefix}Helper${i}(input: number): number {`);
    out.push(`  const scaled = input * ${i};`);
    out.push(`  return scaled + ${i};`);
    out.push('}');
    out.push('');
  }
  out.push('</script>');
  return out.join('\n') + '\n';
}

/** An unrelated TS file, sized to compete for the envelope. */
function makeTs(n: number, prefix: string): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`export function ${prefix}Filler${i}(value: number): number {`);
    out.push(`  const doubled = value * ${i + 2};`);
    out.push(`  return doubled + ${i};`);
    out.push('}');
    out.push('');
  }
  return out.join('\n') + '\n';
}

/** Line numbers rendered for `file` in an explore response. */
function renderedLines(text: string, file: string): Set<number> {
  const out = new Set<number>();
  let current: string | null = null;
  let inFence = false;
  for (const line of text.split('\n')) {
    const header = /^\*\*`([^`]+)`\*\*/.exec(line);
    if (header && !inFence) { current = header[1]!; continue; }
    if (line.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence && current === file) {
      const m = /^(\d+)\t/.exec(line);
      if (m) out.add(Number(m[1]));
    }
  }
  return out;
}

/** The `> Not shown for ...` note naming `file`, or ''. */
function noteFor(text: string, file: string): string {
  return text.split('\n').find((l) => l.startsWith('> Not shown for `' + file + '`')) ?? '';
}

let dir: string;
let cg: CodeGraph;

/**
 * The file's last CONTENT line — trailing blank lines dropped, which is the
 * same line the renderer counts to. Hardcoding a number here instead is how
 * this test first went wrong: `makeVue(700)` ends with a newline, so the file
 * is 699 content lines, and the note was right while the expectation was not.
 */
function contentLines(file: string): number {
  const lines = fs.readFileSync(path.join(dir, file), 'utf-8').split('\n');
  let n = lines.length;
  while (n > 0 && lines[n - 1]!.trim() === '') n--;
  return n;
}

async function explore(query: string): Promise<string> {
  const res = await new ToolHandler(cg).execute('codegraph_explore', { query });
  return res.content?.[0]?.text ?? '';
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-named-cont-'));
  fs.mkdirSync(path.join(dir, 'src/components'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"named-cont","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, BIG), makeVue(360, 'bigPanel', HEAD_MARKER));
  fs.writeFileSync(path.join(dir, HUGE), makeVue(700, 'hugePanel'));
  fs.writeFileSync(path.join(dir, SMALL), makeVue(24, 'smallPanel'));
  // Competing files: without pressure every section ships whole and neither
  // case below can be exercised.
  for (let k = 0; k < 6; k++) {
    fs.writeFileSync(path.join(dir, `src/lib/panelPart${k}.ts`), makeTs(220, `Part${k}`));
  }
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
}, 240_000);

afterAll(() => {
  cg?.destroy();
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('fixture shape — if this rots, the gates below mean nothing', () => {
  it('the SFC component spans the whole file, and every symbol sits after the template', () => {
    const nodes = cg.getNodesInFile(BIG);
    const component = nodes.find((n) => n.kind === 'component');
    expect(component?.startLine).toBe(1);
    const firstHelper = Math.min(
      ...nodes.filter((n) => n.kind === 'function').map((n) => n.startLine),
    );
    // Far enough past line 1 that the head is a region, not a rounding error.
    expect(firstHelper).toBeGreaterThan(100);
  });
});

describe('a file pinned by path keeps its head', () => {
  it('renders from line 1, template included', async () => {
    const text = await explore(`${BIG} panel helper`);
    const lines = renderedLines(text, BIG);
    expect(lines.size, 'the file rendered at all').toBeGreaterThan(0);
    expect(Math.min(...lines), 'the render starts at the top of the file').toBe(1);
    expect(text, 'the <template> region is present').toContain(HEAD_MARKER);
    expect(lines.has(2), 'line 2, where the marker lives').toBe(true);
  });

  it('the head survives even when the section is trimmed below it', async () => {
    // BigPanel is small enough to ship whole; HugePanel is not, so this is
    // where "the trim takes the TAIL, never the head" is actually exercised.
    const text = await explore(`${HUGE} hugePanel helper`);
    const lines = [...renderedLines(text, HUGE)].sort((a, b) => a - b);
    expect(lines.length, 'the file rendered').toBeGreaterThan(0);
    expect(lines.length, 'the section omits source')
      .toBeLessThan(contentLines(HUGE));
    expect(noteFor(text, HUGE), 'omitted regions have a continuation').not.toBe('');
    expect(lines[0], 'and the head is still there').toBe(1);
  });
});

describe('a named file that stops short says where', () => {
  it('names the dropped tail with a callable follow-up', async () => {
    const text = await explore('HugePanel');
    const last = contentLines(HUGE);
    const lines = [...renderedLines(text, HUGE)].sort((a, b) => a - b);
    expect(lines.length, 'the file rendered').toBeGreaterThan(0);
    const rendered = lines[lines.length - 1]!;
    expect(rendered, 'it really did stop short').toBeLessThan(last);

    const note = noteFor(text, HUGE);
    expect(note, 'the section carries a continuation note').not.toBe('');
    // The note's first run starts exactly where the render stopped.
    const m = /lines (\d+)-(\d+)/.exec(note)!;
    expect(Number(m[1])).toBe(rendered + 1);
    expect(Number(m[2])).toBe(last);
    // And it names a call this tool actually accepts.
    expect(note).toContain('codegraph_explore');
    expect(note).toContain('mode:"source"');
    expect(note).toContain(`file:"${HUGE}"`);
    expect(note).toContain(`startLine:${rendered + 1}`);
    expect(note).toMatch(/limit:\d+/);
  });

  it('never steers the agent to Read', async () => {
    const text = await explore('HugePanel');
    const note = noteFor(text, HUGE);
    expect(note).not.toBe('');
    expect(note, 'a note about source must not offer the Read tool')
      .not.toMatch(/Read the file|Read this file|Read them/i);
    expect(note).toContain('do NOT Read');
  });
});

describe('the note is not noise', () => {
  it('a file that fits has no note', async () => {
    const text = await explore(SMALL);
    expect(renderedLines(text, SMALL).size).toBeGreaterThan(0);
    expect(noteFor(text, SMALL)).toBe('');
  });

  it('a file the query never named has no note', async () => {
    // The competing fillers are read by no one's ask; naming them would turn a
    // response into a list of its own trimming.
    const text = await explore('Part3Filler12');
    expect(text).not.toContain('> Not shown for `src/lib/panelPart');
  });
});

describe('uncoveredRuns', () => {
  it('is the complement of what was delivered', () => {
    expect(uncoveredRuns([{ start: 20, end: 100 }], 300)).toEqual([{ start: 1, end: 19 }, { start: 101, end: 300 }]);
  });

  it('merges adjacent and overlapping spans before taking the complement', () => {
    expect(uncoveredRuns([{ start: 20, end: 60 }, { start: 61, end: 100 }], 150))
      .toEqual([{ start: 1, end: 19 }, { start: 101, end: 150 }]);
  });

  it('drops runs too short to be a lost region', () => {
    // A 5-line hole is section spacing (the per-symbol view's own windows),
    // not something worth a follow-up call.
    expect(uncoveredRuns([{ start: 1, end: 50 }, { start: 56, end: 100 }], 100)).toEqual([]);
  });

  it('is empty when the section covered the file', () => {
    expect(uncoveredRuns([{ start: 1, end: 300 }], 300)).toEqual([]);
    expect(uncoveredRuns([], 0)).toEqual([]);
  });
});

describe('formatContinuationNote', () => {
  it('names the run, the call, and the do-NOT-Read', () => {
    const note = formatContinuationNote('src/a.ts', [{ start: 504, end: 700 }]);
    expect(note).toContain('lines 504-700');
    expect(note).toContain('(197 lines)');
    expect(note).toContain('mode:"source"');
    expect(note).toContain('file:"src/a.ts"');
    expect(note).toContain('startLine:504');
    expect(note).toContain('limit:197');
    expect(note).toContain('do NOT Read');
  });

  it('says where to resume when a run exceeds the source-mode limit', () => {
    const note = formatContinuationNote('src/a.ts', [{ start: 10, end: 10 + 2500 - 1 }]);
    expect(note).toContain('limit:2000');
    expect(note).toContain('repeat from 2010');
  });

  it('folds extra runs into a count', () => {
    const note = formatContinuationNote('src/a.ts', [
      { start: 10, end: 40 }, { start: 60, end: 90 }, { start: 110, end: 140 },
      { start: 160, end: 190 }, { start: 210, end: 240 },
    ]);
    expect(note).toContain('+2 more');
  });

  it('is empty for no runs, and always fits the reserve the caller takes', () => {
    expect(formatContinuationNote('src/a.ts', [])).toBe('');
    // A long-but-real path is the worst case the reserve has to cover.
    const deep = 'src/components/very/deeply/nested/feature/area/BigPanel.vue';
    const note = formatContinuationNote(deep, [{ start: 1, end: 5000 }]);
    expect(note.length).toBeLessThanOrEqual(240);
    expect(note).toContain(`file:"${deep}"`);
  });
});
