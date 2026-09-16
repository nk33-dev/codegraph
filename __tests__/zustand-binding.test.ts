import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { buildFlowEvidenceReport } from '../src/graph/flow-evidence';
import { resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';

describe('Zustand 动态绑定', () => {
  let dir = '';
  let cg: CodeGraph | null = null;

  afterEach(() => {
    cg?.close();
    cg = null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  const write = (file: string, source: string): void => {
    fs.writeFileSync(path.join(dir, file), source);
  };

  it('把解构、selector、getState 和 store 内 get() 连接到唯一 action，并保留证据', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-zustand-binding-'));
    const storeSource = `import { create } from 'zustand';
export const useSession = create((set, get) => ({
  reset: () => set({ token: '' }),
  refresh: async () => {
    await fetch('/session');
    get().reset();
  },
}));
`;
    write('store.ts', storeSource);
    write('entry.ts', `import { useSession } from './store';
const { reset: clearSession } = useSession.getState();
const selectedReset = useSession((state) => state.reset);
export function clearFromMenu() { clearSession(); }
export function clearFromSelector() { selectedReset(); }
export function clearImmediately() { useSession.getState().reset(); }
`);

    cg = await CodeGraph.init(dir, { index: true, silent: true });
    const reset = cg.getNodesByKind('function').find((node) => node.name === 'reset' && node.filePath === 'store.ts');
    expect(reset).toBeDefined();

    const incoming = cg.getIncomingEdges(reset!.id).filter((edge) => edge.kind === 'calls');
    const callers = incoming.map((edge) => cg!.getNode(edge.source)?.name).filter(Boolean);
    expect(callers).toEqual(expect.arrayContaining([
      'refresh',
      'clearFromMenu',
      'clearFromSelector',
      'clearImmediately',
    ]));
    for (const edge of incoming) {
      expect(edge.provenance).toBe('heuristic');
      expect(edge.metadata).toMatchObject({
        synthesizedBy: 'zustand-binding',
        registeredAt: `store.ts:${reset!.startLine}`,
      });
    }

    // 这里复用 explore 的共享路径与证据推导，验证不是只有孤立边落库。
    const flow = resolveNamedSymbolFlow(cg, 'clearFromMenu reset', {
      mode: 'directed',
      from: 'clearFromMenu',
      to: 'reset',
    });
    expect(flow.chains).toHaveLength(1);
    expect(flow.chains[0]!.steps.map((step) => step.node.name)).toEqual(['clearFromMenu', 'reset']);
    const evidence = buildFlowEvidenceReport(cg, flow).report.evidence;
    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'heuristic',
        synthesizedBy: 'zustand-binding',
        registrationLocation: { filePath: 'store.ts', line: reset!.startLine },
      }),
    ]));

    // caller 不变时，目标删除应清边并保留可恢复引用；目标回来后增量同步重建它。
    write('store.ts', `import { create } from 'zustand';
export const useSession = create(() => ({ refresh: async () => fetch('/session') }));
`);
    await cg.sync();
    expect(cg.getNode(reset!.id)).toBeNull();
    write('store.ts', `${storeSource}\n`);
    await cg.sync();
    const restored = cg.getNodesByKind('function').find((node) => node.name === 'reset' && node.filePath === 'store.ts');
    expect(restored).toBeDefined();
    expect(cg.getCallers(restored!.id).map((entry) => entry.node.name)).toContain('clearFromMenu');
  });

  it('拒绝局部遮蔽、普通工厂、跨语言同名函数和不可证明的 store', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-zustand-controls-'));
    write('store.ts', `import { create } from 'zustand';
export const useStore = create(() => ({ reset: () => 1 }));
`);
    write('factory.ts', 'export const makeStore = (value: unknown) => value;\n');
    write('controls.ts', `import { useStore } from './store';
import { makeStore } from './factory';
const fakeStore: any = makeStore({ reset: () => 2 });
function shadow(useStore: any) { useStore.getState().reset(); }
export function blockScope() {
  { const useStore: any = fakeStore; useStore.getState().reset(); }
  // 多字节文本用于覆盖 tree-sitter 字节偏移与 JS 字符偏移不同的情况：中文中文中文。
  useStore.getState().reset();
}
export function fake() { fakeStore.getState().reset(); }
`);
    write('control.py', 'def reset():\n    return 3\n\ndef call():\n    return reset()\n');

    cg = await CodeGraph.init(dir, { index: true, silent: true });
    const reset = cg.getNodesByKind('function').find((node) => node.name === 'reset' && node.filePath === 'store.ts');
    expect(reset).toBeDefined();
    const callers = cg.getCallers(reset!.id).map((entry) => entry.node.name);
    expect(callers).toContain('blockScope');
    expect(callers).not.toContain('shadow');
    expect(callers).not.toContain('fake');
    expect(callers).not.toContain('call');

    const blockEdges = cg.getOutgoingEdges(
      cg.getNodesByKind('function').find((node) => node.name === 'blockScope')!.id,
    ).filter((edge) => edge.target === reset!.id);
    expect(blockEdges).toHaveLength(1);
  });
});
