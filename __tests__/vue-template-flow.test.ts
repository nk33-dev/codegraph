import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('Vue template event flow', () => {
  let root = '';
  let cg: CodeGraph | null = null;

  afterEach(() => {
    cg?.destroy();
    cg = null;
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('connects @change to a script setup arrow handler and its API call', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-vue-template-flow-'));
    const src = path.join(root, 'src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'api.ts'), [
      'export function previewQuestionAiImport(file: File) {',
      '  return file.name;',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(src, 'ImportPanel.vue'), [
      '<template>',
      '  <span>Word PDF Excel import</span>',
      '  <input accept=".doc,.docx,.pdf,.xlsx" @change="handleDocumentChange" />',
      '</template>',
      '<script setup lang="ts">',
      "import { previewQuestionAiImport } from './api';",
      'const handleDocumentChange = async (file: File) => {',
      '  return previewQuestionAiImport(file);',
      '};',
      '</script>',
    ].join('\n'));

    cg = CodeGraph.initSync(root, { config: { include: ['**/*.ts', '**/*.vue'], exclude: [] } });
    await cg.indexAll();

    const component = cg.getNodesByName('ImportPanel').find((node) => node.kind === 'component');
    const handler = cg.getNodesByName('handleDocumentChange').find((node) => node.kind === 'function');
    const api = cg.getNodesByName('previewQuestionAiImport').find((node) => node.kind === 'function');
    expect(component).toBeDefined();
    expect(handler).toBeDefined();
    expect(api).toBeDefined();

    const templateEdge = cg.getOutgoingEdges(component!.id)
      .find((edge) => edge.target === handler!.id && edge.metadata?.synthesizedBy === 'vue-handler');
    expect(templateEdge).toMatchObject({ line: 3, provenance: 'heuristic' });
    expect(templateEdge?.metadata).toMatchObject({
      event: 'change',
      registeredAt: 'src/ImportPanel.vue:3',
    });
    expect(cg.getOutgoingEdges(handler!.id).some((edge) => edge.target === api!.id && edge.kind === 'calls')).toBe(true);

    const result = await new ToolHandler(cg).execute('codegraph_explore', {
      query: 'ImportPanel handleDocumentChange previewQuestionAiImport',
    });
    const output = result.content[0].text;
    expect(output).toContain('**Flow (call path among the symbols you queried)**');
    expect(output).toContain('dynamic: Vue @change handler');
    expect(output).toMatch(/ImportPanel[\s\S]*handleDocumentChange[\s\S]*previewQuestionAiImport/);
    expect((result.structuredContent as any).evidence.status).toBe('connected');

    const natural = await new ToolHandler(cg).execute('codegraph_explore', {
      query: '查找 Word/PDF/Excel 导入流程',
    });
    expect(natural.content[0].text).toContain('**Flow (confirmed from the matched Vue template)**');
    expect(natural.content[0].text).not.toContain('**Flow status — incomplete**');
    expect(natural.content[0].text).toMatch(/ImportPanel[\s\S]*handleDocumentChange[\s\S]*previewQuestionAiImport/);
    expect((natural.structuredContent as any).evidence.status).toBe('connected');

    fs.writeFileSync(path.join(src, 'AmbiguousImport.vue'), [
      '<template>',
      '  <span>CSV XML JSON ambiguous</span>',
      '  <button @click="importCsv">CSV</button>',
      '  <button @click="importXml">XML</button>',
      '</template>',
      '<script setup lang="ts">',
      "import { previewQuestionAiImport } from './api';",
      'function importCsv(file: File) { return previewQuestionAiImport(file); }',
      'function importXml(file: File) { return previewQuestionAiImport(file); }',
      '</script>',
    ].join('\n'));
    await cg.indexAll();

    const ambiguous = await new ToolHandler(cg).execute('codegraph_explore', {
      query: '查找 CSV/XML/JSON ambiguous flow',
    });
    expect(ambiguous.content[0].text).toContain('**Flow status — incomplete**');
    expect(ambiguous.content[0].text).not.toContain('**Flow (call path among the symbols you queried)**');
    expect((ambiguous.structuredContent as any).evidence.status).toBe('unconnected');
  });
});
