import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CodeGraph } from '../src';
import { createFakeProject, type FakeProject } from './lsp-test-utils';

let project: FakeProject | undefined;
let cg: CodeGraph | undefined;

afterEach(async () => {
  if (cg) {
    await cg.getLspManager().close();
    cg.close();
  }
  project?.cleanup();
});

describe('Python LSP', () => {
  it('复用 Python 服务完成查询、诊断和编辑，并在关闭后释放进程', async () => {
    project = createFakeProject({ 'main.py': 'def target_value():\n    return 1\n\nresult = target_value()\n' },
      { serverArgs: ['--pull-diagnostics', '--rename'] });
    project.writeConfig({ config: { servers: { python: project.serverCommand() } } });
    cg = CodeGraph.initSync(project.root);
    await cg.indexAll();

    for (const mode of ['definitions', 'references', 'symbols', 'diagnostics'] as const) {
      const result = await cg.queryCodeWithBackend({ backend: 'auto', mode,
        query: mode === 'symbols' || mode === 'diagnostics' ? 'main.py' : 'target_value', file: 'main.py' });
      expect(result.status, result.warnings.join(' ')).toBe('ok');
      expect(result.routing).toMatchObject({ resolved: 'lsp', families: ['python'] });
    }
    const applied = await cg.editCode({ operation: 'rename', symbol: 'target_value', file: 'main.py', newName: 'next_value', apply: true });
    expect(applied.status).toBe('applied');
    expect(fs.readFileSync(path.join(project.root, 'main.py'), 'utf8')).toContain('result = next_value()');
    expect(project.events('initialize')).toHaveLength(1);
    expect(project.events('textDocument/didOpen')[0]?.params.textDocument.languageId).toBe('python');
    await cg.getLspManager().close();
    expect(cg.getLspManager().status().find((entry) => entry.family === 'python')?.pid).toBeNull();
  }, 30_000);
});
