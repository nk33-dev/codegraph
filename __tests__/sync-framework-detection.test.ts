/**
 * A sync that adds the first file of a language re-detects frameworks.
 *
 * Detection is gated on the languages present in the index, so a framework whose only
 * language appears later (a PHP file landing in a TypeScript repo) is invisible to the pass
 * that ran before it existed. `indexAll` re-initializes the resolver once its first files are
 * indexed; a sync that only runs the post-extract pass would resolve those files with no
 * framework resolver until the next full index. Laravel is the cheapest witness: it is gated
 * on PHP and its `detect` names two files this test controls.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const dirs: string[] = [];
const graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs.splice(0)) {
    try { graph.destroy(); } catch { /* already closed */ }
  }
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows handles */ }
  }
});

describe('framework detection across an incremental sync', () => {
  it('detects a framework whose language only appears in a synced file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-framework-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'artisan'), '#!/usr/bin/env php\n');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src/index.ts'), 'export function hello(): string { return "world"; }\n');

    const cg = CodeGraph.initSync(dir, { config: { include: ['**/*'], exclude: [] } });
    graphs.push(cg);
    await cg.indexAll();
    // The project has no PHP yet, so the language gate keeps Laravel out even though `artisan` exists.
    expect(cg.getDetectedFrameworks()).not.toContain('laravel');

    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app', 'Kernel.php'), '<?php\nclass Kernel {}\n');
    await cg.sync();

    expect(cg.getDetectedFrameworks()).toContain('laravel');
  });

  it('extracts a framework node from a file synced together with the framework manifest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-framework-extract-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src/app.ts'), 'export function boot(): string { return "ok"; }\n');

    const cg = CodeGraph.initSync(dir, { config: { include: ['**/*'], exclude: [] } });
    graphs.push(cg);
    await cg.indexAll();
    // No manifest and no express pattern anywhere, so the extractor must not run.
    expect(cg.getDetectedFrameworks()).not.toContain('express');

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { express: '^4.18.0' } }));
    fs.writeFileSync(path.join(dir, 'src/routes.js'), "const app = express();\napp.get('/hello', handler);\n");
    await cg.sync();

    // The cached framework names came from a pass that ran before express existed; reusing
    // them would leave the route invisible (the file was still extracted, just without it).
    expect(cg.getNodesInFile('src/routes.js').some((node) => node.kind === 'route' && node.name === 'GET /hello')).toBe(true);
  });
});
