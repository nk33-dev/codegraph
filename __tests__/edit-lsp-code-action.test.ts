import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { clearLspConfigCache } from '../src/lsp/config';
import { createFakeProject, type FakeProject } from './lsp-test-utils';

const FILE_CONTENT = 'export class Widget {\n  render() { return Missing; }\n}\n';

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

describe('LSP code-action preview and apply', () => {
  it('previews a diagnostic-backed quick fix without writing', async () => {
    await setup();
    const result = await cg.editCode({
      operation: 'code-action', file: 'a.ts', line: 1, column: 2, actionKinds: ['quickfix'],
    });

    expect(result).toMatchObject({
      operation: 'code-action', status: 'preview', canApply: true,
      routing: { source: 'lsp', lsp: { requested: true, available: true, family: 'typescript' } },
    });
    expect(result.files[0]?.edits[0]?.newText).toContain("import { Missing }");
    expect(read()).toBe(FILE_CONTENT);
    expect(project.events('textDocument/codeAction')[0]?.params.context.diagnostics).toHaveLength(1);
  });

  it('applies the selected action transactionally and refreshes the file', async () => {
    await setup();
    const preview = await cg.editCode({
      operation: 'code-action', file: 'a.ts', line: 1, column: 2, actionKinds: ['quickfix'],
    });
    const applied = await cg.editCode({
      operation: 'code-action', file: 'a.ts', line: 1, column: 2, actionKinds: ['quickfix'],
      apply: true, expectPreviewHash: preview.previewHash!, operationId: preview.operationId!,
    });

    expect(applied.status).toBe('applied');
    expect(read()).toContain("import { Missing } from './missing';");
    expect(applied.applied?.indexSynced).toBe(true);
  });

  it('passes source action filters and can organize imports', async () => {
    await setup();
    const result = await cg.editCode({
      operation: 'code-action', file: 'a.ts', line: 1, actionKinds: ['source.organizeImports'],
    });

    expect(result.files[0]?.edits[0]?.newText).toContain('imports organized');
    expect(project.events('textDocument/codeAction')[0]?.params.context.only).toEqual(['source.organizeImports']);
  });

  it('refuses command-only actions instead of executing arbitrary commands', async () => {
    await setup(['--semantic-tools', '--code-action-command-only']);
    const result = await cg.editCode({ operation: 'code-action', file: 'a.ts', line: 1, column: 2 });

    expect(result.status).toBe('unavailable');
    expect(result.canApply).toBe(false);
    expect(result.blockers.join('\n')).toContain('requires command execution');
    expect(result.routing.lsp.reason).toContain('requires command execution');
  });

  it('refuses an action that edits outside the project before writing anything', async () => {
    const outside = path.join(os.tmpdir(), `cg-code-action-outside-${process.pid}-${Date.now()}.ts`);
    fs.writeFileSync(outside, 'export const outside = true;\n');
    try {
      await setup(['--semantic-tools', '--code-action-extra', outside]);
      const result = await cg.editCode({ operation: 'code-action', file: 'a.ts', line: 1, column: 2, actionKinds: ['quickfix'] });

      expect(result.status).toBe('rejected');
      expect(result.canApply).toBe(false);
      expect(result.blockers.join('\n')).toContain('outside the project root');
      expect(read()).toBe(FILE_CONTENT);
      expect(fs.readFileSync(outside, 'utf-8')).toBe('export const outside = true;\n');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});
