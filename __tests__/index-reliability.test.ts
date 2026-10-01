import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src';
import { createDatabase } from '../src/db/sqlite-adapter';
import { QueryBuilder } from '../src/db/queries';

describe('Index reliability', { timeout: 60_000 }, () => {
  let root: string;
  let cg: CodeGraph;
  const readers: CodeGraph[] = [];
  const write = (file: string, content: string) => fs.writeFileSync(path.join(root, file), content);
  const snapshot = () => {
    const { db } = createDatabase(path.join(root, '.codegraph', 'codegraph.db'), { readOnly: true });
    try {
      return {
        nodes: db.prepare('SELECT id FROM nodes ORDER BY id').all(),
        edges: db.prepare('SELECT source, target, kind, line, col FROM edges ORDER BY source, target, kind, line, col').all(),
      };
    } finally { db.close(); }
  };
  const rebuild = async () => {
    cg.destroy();
    cg = await CodeGraph.recreate(root);
    await cg.indexAll();
    return snapshot();
  };
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-reliability-')); });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const reader of readers.splice(0)) reader.destroy();
    cg?.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps calls bound to the right class after editing same-named methods', async () => {
    write('service.ts', 'export class Alpha { run() { return 1; } }\nexport class Beta { run() { return 2; } }\n');
    write('caller.ts', "import { Alpha } from './service';\nexport function call() { return new Alpha().run(); }\n");
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    const target = cg.getNodesByKind('method').find(n => /Alpha(?:::|\.)run$/.test(n.qualifiedName))!;
    expect(target).toBeDefined();
    expect(cg.getCallers(target.id).map(r => r.node.name)).toContain('call');
    write('service.ts', '\nexport class Alpha { run() { return 10; } }\nexport class Beta { run() { return 20; } }\n');
    await cg.sync();
    const synced = snapshot();
    expect(synced).toEqual(await rebuild());
  });

  it('recovers incoming calls when replacement storage fails after deleting the old file', async () => {
    write('service.ts', 'export function work() { return 1; }\n');
    write('caller.ts', "import { work } from './service';\nexport function call() { return work(); }\n");
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    write('service.ts', '\nexport function work() { return 20; }\n');
    const store = vi.spyOn(QueryBuilder.prototype, 'storeFileBundle').mockImplementationOnce(() => { throw new Error('Interrupted store'); });
    await expect(cg.sync()).rejects.toThrow('Interrupted store');
    store.mockRestore();
    cg.destroy();
    cg = CodeGraph.openSync(root);
    await cg.sync();
    const recovered = snapshot();
    await cg.sync();
    expect(snapshot()).toEqual(recovered);
    expect(recovered).toEqual(await rebuild());
  });

  it('recovers a definition change after extraction finishes before the rebind pass', async () => {
    write('caller.ts', 'export function call() { return work(); }\n');
    write('zeta.ts', 'export function work() { return 1; }\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    write('alpha.ts', 'export function work() { return 2; }\n');
    await expect(cg.sync({ onProgress: p => {
      if (p.phase === 'resolving') throw new Error('Interrupted resolution');
    } })).rejects.toThrow('Interrupted resolution');
    cg.destroy();
    cg = CodeGraph.openSync(root);
    await cg.sync();
    const recovered = snapshot();
    expect(recovered).toEqual(await rebuild());
  });

  it('refreshes cached nodes in multiple long-lived readers after another connection syncs', async () => {
    write('service.ts', 'export function work() { return 1; }\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    const node = cg.getNodesByKind('function')[0]!;
    for (let i = 0; i < 2; i++) {
      const reader = CodeGraph.openSync(root, { readOnly: true });
      readers.push(reader);
      expect(reader.getNode(node.id)?.endLine).toBe(1);
    }
    write('service.ts', 'export function work() {\n  return 20;\n}\n');
    await cg.sync();
    for (const reader of readers) {
      expect(reader.getNode(node.id)?.endLine).toBe(3);
      expect(reader.getNodesByIds([node.id]).get(node.id)?.endLine).toBe(3);
    }
    write('service.ts', 'export function changed() { return 1; }\n');
    await cg.sync();
    for (const reader of readers) expect(reader.getNode(node.id)).toBeNull();
  });

  it('removes partial chunks when a file changes again before recovery', async () => {
    write('service.ts', 'export function work() { return 1; }\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    write('service.ts', Array.from({ length: 2100 }, (_, i) => `export function work${i}() { return ${i}; }`).join('\n'));
    const insertNodes = QueryBuilder.prototype.insertNodes;
    const interrupted = vi.spyOn(QueryBuilder.prototype, 'insertNodes').mockImplementationOnce(function (nodes) {
      insertNodes.call(this, nodes);
      throw new Error('Interrupted chunk');
    });
    await expect(cg.sync()).rejects.toThrow('Interrupted chunk');
    interrupted.mockRestore();
    cg.destroy();
    cg = CodeGraph.openSync(root);
    write('service.ts', 'export function finalWork() { return 20; }\n');
    await cg.sync();
    const recovered = snapshot();
    expect(recovered).toEqual(await rebuild());
  });

  it('retries historical failures after the extraction-only edit path adds a definition', async () => {
    write('caller.ts', 'export function call() { return missingWork(); }\n');
    write('service.ts', 'export function otherWork() { return 1; }\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    write('service.ts', 'export function missingWork() { return 20; }\n');
    await cg.indexFiles(['service.ts']);
    await cg.resolveReferencesForFiles(['service.ts']);
    const refreshed = snapshot();
    expect(refreshed).toEqual(await rebuild());
  });

  it('keeps node and edge identities stable across repeated Go syncs', async () => {
    write('go.mod', 'module example.test/reliability\n\ngo 1.22\n');
    write('service.go', 'package reliability\ntype Worker struct {}\nfunc (w *Worker) Run() int { return 1 }\nfunc Call(w *Worker) int { return w.Run() }\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    const initial = snapshot();
    expect(initial.edges.length).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) {
      const result = await cg.sync();
      expect(result.filesAdded + result.filesModified + result.filesRemoved).toBe(0);
      expect(snapshot()).toEqual(initial);
    }
  });

  it('reclaims names from repeated renames and indexes a returning name again', async () => {
    write('service.ts', 'export function InitialService() { return 1; }\n');
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    const { db } = createDatabase(path.join(root, '.codegraph', 'codegraph.db'), { readOnly: true });
    try {
      for (let i = 0; i < 8; i++) {
        const name = i === 7 ? 'InitialService' : `RenamedService${i}`;
        write('service.ts', `export function ${name}() { return ${i}; }\n`);
        await cg.sync();
        const names = db.prepare('SELECT DISTINCT name FROM name_segment_vocab ORDER BY name').all();
        expect(names).toEqual([{ name }]);
      }
    } finally { db.close(); }
  });
});
