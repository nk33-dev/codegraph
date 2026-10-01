import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

let root = '';
let cg: CodeGraph | undefined;
async function index(files: Record<string, string>) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-component-bindings-'));
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  cg = CodeGraph.initSync(root);
  await cg.indexAll();
}
afterEach(() => { cg?.close(); cg = undefined; if (root) fs.rmSync(root, { recursive: true, force: true }); });
const edgesFrom = (name: string) => cg!.getOutgoingEdges(cg!.getNodesByName(name).find(n => n.kind === 'function')!.id);
const reaches = (from: string, to: string, kind: string) => edgesFrom(from).some(edge =>
  edge.target === cg!.getNodesByName(to).find(n => n.kind === 'function')?.id && edge.metadata?.synthesizedBy === kind);

describe('frontend binding relationships', () => {
  it('connects imported composable members and destructured aliases to their returned function', async () => {
    await index({
      'usePanel.ts': `export function usePanel() {
function close() { return 1; }
function unrelated() { return 2; }
return { dismiss: close };
}`,
      'useOther.ts': `export function useOther() { function close() { return 9; } return { close }; }`,
      'Panel.vue': `<script setup lang="ts">
import { usePanel } from './usePanel';
const panel = usePanel();
const { dismiss: dismissPanel } = usePanel();
function closePanel() { panel.dismiss(); }
function finish() { dismissPanel(); }
function invalid() { panel.unrelated(); }
</script>`,
    });
    for (const name of ['closePanel', 'finish']) {
      const edges = edgesFrom(name).filter(e => e.metadata?.synthesizedBy === 'composable-binding');
      expect(edges).toHaveLength(1);
      expect(cg!.getNode(edges[0]!.target)).toMatchObject({ name: 'close', filePath: 'usePanel.ts' });
    }
    expect(edgesFrom('invalid').some(e => e.metadata?.synthesizedBy === 'composable-binding')).toBe(false);
    fs.writeFileSync(path.join(root, 'Extra.vue'), '<template><div /></template>');
    await cg!.sync();
    for (const name of ['closePanel', 'finish']) expect(edgesFrom(name).some(e => e.metadata?.synthesizedBy === 'composable-binding')).toBe(true);
  });
  it('connects Vue emits and callback props to the registered parent handler', async () => {
    await index({
      'Child.vue': `<script setup lang="ts">
const emit = defineEmits(['saved']);
const props = defineProps<{ onSave: () => void }>();
function submit() { emit('saved'); }
function confirm() { props.onSave(); }
function shadow(emit: Function) { emit('saved'); }
</script>
<template><button @click="submit" /></template>`,
      'Parent.vue': `<script setup lang="ts">
import Child from './Child.vue';
function save() { return 1; }
const title = 'example';
</script>
<template><Child @saved="save" :on-save="save" :title="title" /></template>`,
    });
    expect(reaches('submit', 'save', 'vue-emit')).toBe(true);
    expect(reaches('confirm', 'save', 'component-prop')).toBe(true);
    expect(reaches('shadow', 'save', 'vue-emit')).toBe(false);
    expect(edgesFrom('submit').find(e => e.metadata?.synthesizedBy === 'vue-emit')).toMatchObject({ provenance: 'heuristic', line: 4, metadata: { registeredAt: 'Parent.vue:6', via: 'saved' } });
    const title = cg!.getNodesByName('title')[0]!;
    expect(cg!.getIncomingEdges(title.id).some(e => e.kind === 'references' && e.metadata?.synthesizedBy === 'component-prop')).toBe(true);
    expect(cg!.getNodesInFile('Child.vue').flatMap(n => cg!.getOutgoingEdges(n.id)).some(e => e.source === e.target && ['defineProps', 'defineEmits'].includes(String(e.metadata?.refName)))).toBe(false);
    const handler = new ToolHandler(cg!);
    const result = await handler.execute('codegraph_explore', { query: 'submit save' });
    expect(result.content[0].text).toContain('Framework/dynamic relationships are partial');
    handler.closeAll();
    fs.writeFileSync(path.join(root, 'Parent.vue'), fs.readFileSync(path.join(root, 'Parent.vue'), 'utf8').replace('@saved="save"', '@closed="save"'));
    await cg!.sync({ paths: ['Parent.vue'] });
    expect(reaches('submit', 'save', 'vue-emit')).toBe(false);
    expect(reaches('confirm', 'save', 'component-prop')).toBe(true);
  });

  it('connects React callback props and keeps unrelated component callbacks separate', async () => {
    await index({
      'Child.tsx': `export function Child(props: { onSave: () => void }) {
function submitReact() { props.onSave(); }
function shadowReact(props: { onSave: () => void }) { props.onSave(); }
return <button onClick={submitReact} />;
}`,
      'Other.tsx': `export function Other(props: { onSave: () => void }) { props.onSave(); return <button />; }`,
      'Parent.tsx': `import { Child } from './Child';
export function Parent() {
function save() { return 1; }
const fake = '<Other onSave={save} />';
return <Child onSave={save} />;
}`,
    });
    expect(reaches('submitReact', 'save', 'component-prop')).toBe(true);
    expect(reaches('shadowReact', 'save', 'component-prop')).toBe(false);
    expect(reaches('Other', 'save', 'component-prop')).toBe(false);
  });

  it('resolves aliased useRouter receivers and refuses shadowed array receivers', async () => {
    await index({
      'package.json': JSON.stringify({ dependencies: { vue: '3', 'vue-router': '4' } }),
      'routes.ts': `import { createRouter } from 'vue-router';
import Child from './Child.vue';
export const router = createRouter({ routes: [{ path: '/child', name: 'child', component: Child }] });`,
      'Child.vue': '<script setup lang="ts">function child() { return 1; }</script>',
      'Parent.vue': `<template><span>中文🦀中文🦀中文🦀中文🦀中文🦀</span></template>
<script setup lang="ts">
import { useRouter as useNavigation } from 'vue-router';
const nav = useNavigation();
function visit() { nav.push('/child'); }
function wrong(nav: string[]) { nav.push('/child'); }
const router = [];
function arrayPush() { router.push('/child'); }
</script>`,
    });
    expect(edgesFrom('visit').some(e => e.kind === 'navigates' && cg!.getNode(e.target)?.name === '/child')).toBe(true);
    expect(edgesFrom('wrong').some(e => e.kind === 'navigates')).toBe(false);
    expect(edgesFrom('arrayPush').some(e => e.kind === 'navigates')).toBe(false);
  });
});
