import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { planRefresh } from '../src/sync/refresh-plan';
import { resolveIndexWorkerLimit, resolveResourceProfile } from '../src/resource-profile';

let root: string | undefined;
let graph: CodeGraph | undefined;

afterEach(() => {
  graph?.close();
  graph = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('索引状态、局部刷新与任务等级', () => {
  it('普通文件刷新保持局部范围，结构变化扩大范围并生成新版本', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-refresh-version-'));
    fs.writeFileSync(path.join(root, 'service.ts'), 'export function run() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'main.ts'), "import { run } from './service';\nexport function main() { return run(); }\n");
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    const first = graph.getIndexStatus();
    expect(first.version).toBeTruthy();
    expect(first.state).toBe('complete');

    fs.writeFileSync(path.join(root, 'service.ts'), 'export function run() { return 2; }\n');
    const ordinary = await graph.refresh('service.ts');
    expect(ordinary.plan.scope).toBe('file');
    expect(ordinary.plan.taskLevel).toBe('ordinary');
    expect(ordinary.version).not.toBe(first.version);

    fs.writeFileSync(path.join(root, 'service.ts'), 'export interface Runner { run(): number }\nexport function run() { return 3; }\n');
    const structural = await graph.refresh('service.ts');
    expect(structural.plan.scope).toBe('related');
    expect(structural.plan.taskLevel).toBe('interface');
    expect(graph.getIndexStatus().failureReason).toBeNull();
  }, 30_000);

  it('资源档位显式区分任务等级，不检测充电状态也不默认满载', () => {
    const battery = resolveResourceProfile({ CODEGRAPH_RESOURCE_PROFILE: 'battery' } as NodeJS.ProcessEnv);
    const performance = resolveResourceProfile({ CODEGRAPH_RESOURCE_PROFILE: 'performance' } as NodeJS.ProcessEnv);
    expect(resolveIndexWorkerLimit('ordinary', battery)).toBe(1);
    expect(resolveIndexWorkerLimit('interface', battery)).toBe(2);
    expect(resolveIndexWorkerLimit('global', performance)).toBe(8);
  });

  it('refresh plan recognizes project configuration', () => {
    const plan = planRefresh('C:/project', 'package.json');
    expect(plan).toMatchObject({ scope: 'project', taskLevel: 'global' });
  });
});
