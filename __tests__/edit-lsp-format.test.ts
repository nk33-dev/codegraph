/**
 * `format` (phase 4): a language server's whole-file formatting goes through the same preview →
 * verify → transaction path as every other edit — there is no separate write path for it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CodeGraph } from '../src';
import { clearLspConfigCache } from '../src/lsp/config';
import { createFakeProject, type FakeProject } from './lsp-test-utils';

const FILE_CONTENT = 'export class Widget {\n  render() { return 1; }\n}\n';

let project: FakeProject;
let cg: CodeGraph;

async function setup(serverArgs: string[] = ['--semantic-tools']): Promise<void> {
  project = createFakeProject({ 'a.ts': FILE_CONTENT }, { serverArgs });
  cg = CodeGraph.initSync(project.root);
  await cg.indexAll();
}

const read = (): string => fs.readFileSync(path.join(project.root, 'a.ts'), 'utf-8');

afterEach(() => {
  try { cg?.close(); } catch { /* already closed */ }
  clearLspConfigCache();
  project?.cleanup();
});

describe('LSP format preview and apply', () => {
  it('previews the server edits without writing', async () => {
    await setup();
    const result = await cg.editCode({ operation: 'format', file: 'a.ts' });

    expect(result).toMatchObject({
      operation: 'format', status: 'preview', canApply: true,
      routing: { source: 'lsp', lsp: { requested: true, available: true, family: 'typescript' } },
    });
    expect(result.files[0]?.edits[0]?.newText).toBe('// formatted by fake-lsp\n');
    expect(read()).toBe(FILE_CONTENT);
    expect(project.events('textDocument/formatting')).toHaveLength(1);
  });

  it('applies atomically and refreshes the index', async () => {
    await setup();
    const preview = await cg.editCode({ operation: 'format', file: 'a.ts' });
    const applied = await cg.editCode({
      operation: 'format', file: 'a.ts',
      apply: true, expectPreviewHash: preview.previewHash!, operationId: preview.operationId!,
    });

    expect(applied.status).toBe('applied');
    expect(read()).toBe(`// formatted by fake-lsp\n${FILE_CONTENT}`);
  });

  it('reports an already-formatted file instead of writing identical bytes', async () => {
    await setup(['--semantic-tools', '--format-noop']);
    const result = await cg.editCode({ operation: 'format', file: 'a.ts' });

    expect(result.canApply).toBe(false);
    expect(result.warnings.join('\n')).toContain('no formatting edits');
    expect(read()).toBe(FILE_CONTENT);
  });

  it('requires a file and refuses symbol/newName', async () => {
    await setup();
    const noFile = await cg.editCode({ operation: 'format' });
    expect(noFile.canApply).toBe(false);
    expect(noFile.warnings.join('\n')).toContain('file');

    const withSymbol = await cg.editCode({ operation: 'format', file: 'a.ts', symbol: 'Widget' });
    expect(withSymbol.canApply).toBe(false);
    expect(withSymbol.warnings.join('\n')).toContain('does not accept');
  });
});
