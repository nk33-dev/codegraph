/**
 * Kernel↔wasm parity for the DYNAMIC namespace import:
 * `const ns = await import('./module')`.
 *
 * Why this needs its own gate rather than a case in `kernel-tsjs-parity`:
 * `import('./x')` is a runtime call, so the static `import_statement` pass never
 * sees it, and for a long time the wasm path emitted a synthetic `import` node
 * for it while the kernel emitted nothing at all. No checked-in torture fixture
 * contains the shape, so the whole `kernel-*.test.ts` set stayed green on a real
 * divergence — and since releases ship the kernel prebuilds (`release.yml`),
 * that divergence was a PLATFORM difference in the product: on a machine with
 * the kernel, `ns.foo()` lost its import edge and the callers/impact/Steps for
 * anything reached that way were incomplete; on the wasm fallback it worked.
 *
 * The regex fallback in `import-resolver.ts` cannot cover this on its own — it
 * reads the module's basename (`x`) as the local name, which names no binding in
 * `ns.foo()`. The node's signature is the only channel carrying the real
 * binding, so the assertions below check it parses back through the actual
 * consumer (`dynamicNamespaceImportMapping`), not just that two extractors agree.
 *
 * Skips when no kernel binary is staged; `CODEGRAPH_KERNEL_EXPECT=1` turns that
 * into a failure (wired in kernel-scaffold.test.ts).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import { dynamicNamespaceImportMapping } from '../src/graph/dynamic-import';
import type { ExtractionResult, Language } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelBuilt = fs.existsSync(KERNEL_PATH);

function canon(result: ExtractionResult): { nodes: string[]; edges: string[]; refs: string[] } {
  return {
    nodes: result.nodes
      .map(({ updatedAt: _u, ...n }) => JSON.stringify(n, Object.keys(n).sort()))
      .sort(),
    edges: result.edges.map((e) => JSON.stringify(e, Object.keys(e).sort())).sort(),
    refs: result.unresolvedReferences
      .map((r) => JSON.stringify(r, Object.keys(r).sort()))
      .sort(),
  };
}

/** The `import` nodes carrying a dynamic-namespace signature, by module source. */
function dynamicImportNodes(result: ExtractionResult) {
  return result.nodes
    .filter((n) => n.kind === 'import' && dynamicNamespaceImportMapping(n.signature) !== null)
    .map((n) => ({ name: n.name, map: dynamicNamespaceImportMapping(n.signature)! }));
}

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;
let savedEnv: Record<string, string | undefined>;

describe.skipIf(!kernelBuilt)('kernel dynamic namespace import parity', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['typescript', 'tsx', 'javascript', 'jsx']);
  });

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetKernelForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetKernelForTests();
  });

  function both(filePath: string, source: string, language: Language) {
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    const kernel = tryKernelExtract(filePath, source, language);
    expect(kernel, `kernel extraction failed for ${filePath}`).not.toBeNull();

    process.env.CODEGRAPH_KERNEL = '0';
    const wasm = extractFromSource(filePath, source, language);
    delete process.env.CODEGRAPH_KERNEL;
    return { kernel: kernel!, wasm };
  }

  function assertParity(filePath: string, source: string, language: Language): ExtractionResult {
    const { kernel, wasm } = both(filePath, source, language);
    const k = canon(kernel);
    const w = canon(wasm);
    expect(k.nodes, `${filePath}: nodes`).toEqual(w.nodes);
    expect(k.edges, `${filePath}: edges`).toEqual(w.edges);
    expect(k.refs, `${filePath}: refs`).toEqual(w.refs);
    return wasm;
  }

  const inFunction = (decl: string): string =>
    `async function load() {\n  ${decl}\n  return ns;\n}\n`;

  it.each([
    ['ts', 'typescript'], ['tsx', 'tsx'],
  ] as const)('emits the same node and ref as wasm inside a function body: %s', (ext, language) => {
    const result = assertParity(`dyn.${ext}`, inFunction(`const ns = await import('./mod');`), language);
    const imports = dynamicImportNodes(result);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.name).toBe('./mod');
    expect(imports[0]!.map).toMatchObject({ localName: 'ns', source: './mod', isNamespace: true, exportedName: '*' });
    expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'imports').map((r) => r.referenceName))
      .toEqual(['ns']);
  });

  it.each([
    ['js', 'javascript'], ['jsx', 'jsx'],
  ] as const)('stays silent in a %s function body, as wasm does', (ext, language) => {
    // Not a port gap: the wasm body-walker site is gated on
    // TYPE_ANNOTATION_LANGUAGES, which lists typescript/tsx and twelve typed
    // languages but NOT javascript/jsx — so a `.js` file gets no dynamic
    // namespace mapping at all. The kernel mirrors the gate rather than
    // "fixing" it, because parity is the contract; widening it is a separate
    // behavior change that has to move both extractors and this expectation.
    const result = assertParity(`dyn.${ext}`, inFunction(`const ns = await import('./mod');`), language);
    expect(dynamicImportNodes(result)).toHaveLength(0);
  });

  it.each([
    ['ts', 'typescript'], ['js', 'javascript'],
  ] as const)('at module scope the shape is language-independent: %s', (ext, language) => {
    const result = assertParity(
      `dyn-top.${ext}`,
      `const ns = await import('./top');\nexport const run = () => ns.go();\n`,
      language,
    );
    expect(dynamicImportNodes(result).map((n) => n.map.localName)).toEqual(['ns']);
  });

  it('emits it at module scope too, where the call site orders it differently', () => {
    const result = assertParity('dyn-top.ts', `const ns = await import('./top');\nexport const run = () => ns.go();\n`, 'typescript');
    expect(dynamicImportNodes(result).map((n) => n.map.localName)).toEqual(['ns']);
  });

  it('accepts a double-quoted specifier', () => {
    const result = assertParity('dyn-dq.ts', inFunction(`const mod = await import("./dq");`), 'typescript');
    expect(dynamicImportNodes(result)[0]!.map).toMatchObject({ localName: 'mod', source: './dq' });
  });

  it('carries the binding the regex fallback cannot know', () => {
    // The whole point of the node: `import-resolver.ts`'s regex reads `./utils`
    // as local name `utils`, which names nothing in `utils.fmt()`. The node is
    // the only channel that says the binding is `utils` here — the name matches
    // by luck in this spelling and by design in the aliased one.
    const result = assertParity('dyn-alias.ts', inFunction(`const u = await import('./utils');`), 'typescript');
    expect(dynamicImportNodes(result)[0]!.map.localName).toBe('u');
  });

  it.each([
    ['non-static specifier', `const ns = await import(name);`],
    ['empty specifier', `const ns = await import('');`],
    ['destructured binding', `const { a } = await import('./m');`],
    ['plain static import', `import ns from './m';`],
  ])('stays silent for %s — in both extractors', (_label, decl) => {
    const result = assertParity('dyn-none.ts', inFunction(decl), 'typescript');
    expect(dynamicImportNodes(result)).toHaveLength(0);
    expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'imports')).toHaveLength(0);
  });

  it('is key-order exact: the signature round-trips through the resolver', () => {
    const { wasm } = both('dyn-sig.ts', inFunction(`const ns = await import('./sig');`), 'typescript');
    const node = dynamicImportNodes(wasm)[0]!;
    expect(node.map).toEqual({
      localName: 'ns',
      exportedName: '*',
      source: './sig',
      isDefault: false,
      isNamespace: true,
    });
  });
});
