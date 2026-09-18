/**
 * codegraph_explore: natural-language intent words stay out of fuzzy matching.
 *
 * Regression: querying `runUpgrade` was precise, but adding Chinese phrases for definitions,
 * all callers, and related tests pulled in unrelated `run` functions. The intent phrases were
 * not recognized as a unit, so the camelCase fragment `run` continued through FTS.
 *
 * Once the index uniquely identifies an exact symbol, remaining intent text selects the view:
 * return the target, direct relationships, and direct tests. Queries naming another symbol stay broad.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

/** Paths explore rendered as full-body ``**`<path>`** —`` source sections, in order. */
function sourcedFiles(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\*\*`(.+?)`\*\* —/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

describe('codegraph_explore — 意图词收束', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-intent-'));

    // Target symbol: updater.ts contains the only exact runUpgrade definition.
    fs.mkdirSync(path.join(testDir, 'src', 'upgrade'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'src', 'upgrade', 'updater.ts'),
      `export function normalizeVersion(v: string): string {\n` +
      `  return v.startsWith('v') ? v : 'v' + v;\n` +
      `}\n` +
      `export function resolveLatestVersion(): string {\n` +
      `  return normalizeVersion('9.9.9');\n` +
      `}\n` +
      `export function runUpgrade(): string {\n` +
      `  const latest = resolveLatestVersion();\n` +
      `  return latest;\n` +
      `}\n`);

    // Noise: unrelated run() functions that match the camelCase fragment.
    fs.mkdirSync(path.join(testDir, 'src', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'src', 'tasks', 'runner.ts'),
      `import { settle } from './settle';\n` +
      `export interface RunOptions { retries: number }\n` +
      `export function run(options: RunOptions): number {\n` +
      `  let total = 0;\n` +
      `  for (let i = 0; i < options.retries; i += 1) total += settle(i);\n` +
      `  return total;\n` +
      `}\n`);
    fs.writeFileSync(path.join(testDir, 'src', 'tasks', 'settle.ts'),
      `export function settle(value: number): number {\n` +
      `  return value * 2;\n` +
      `}\n`);
    fs.writeFileSync(path.join(testDir, 'src', 'tasks', 'batch.ts'),
      `import { run } from './runner';\n` +
      `export function runBatch(): number {\n` +
      `  return run({ retries: 2 });\n` +
      `}\n`);

    fs.writeFileSync(path.join(testDir, 'src', 'large.ts'),
      `export class LargeCoordinator {\n` +
      Array.from({ length: 30 }, (_, i) => `  step${i}(): number { return ${i}; }\n`).join('') +
      `}\n`);

    // 动态 namespace import 的成员调用必须作为直接调用方进入精确意图结果。
    fs.mkdirSync(path.join(testDir, 'src', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'src', 'bin', 'codegraph.ts'),
      `export async function upgradeCommand(): Promise<string> {\n` +
      `  const up = await import('../upgrade/updater');\n` +
      `  return up.runUpgrade();\n` +
      `}\n`);

    // Direct test that calls runUpgrade.
    fs.mkdirSync(path.join(testDir, '__tests__'), { recursive: true });
    fs.writeFileSync(path.join(testDir, '__tests__', 'updater.test.ts'),
      `import { runUpgrade } from '../src/upgrade/updater';\n` +
      `export function upgradesWithoutError(): boolean {\n` +
      `  return runUpgrade().length > 0;\n` +
      `}\n`);

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function explore(query: string): Promise<string> {
    const res = await handler.execute('codegraph_explore', { query });
    expect(res.isError).toBeFalsy();
    return res.content[0]!.text;
  }

  it('唯一精确符号 + 中文意图词：不混入其他文件里同片段命名的 run', async () => {
    const files = sourcedFiles(await explore('runUpgrade 的定义、所有调用方和相关测试'));
    expect(files[0]).toMatch(/updater\.ts$/);
    expect(files.filter((f) => /runner\.ts$|batch\.ts$/.test(f))).toEqual([]);
  });

  it('英文意图词同样收束', async () => {
    const files = sourcedFiles(await explore('runUpgrade definition, all callers and related tests'));
    expect(files[0]).toMatch(/updater\.ts$/);
    expect(files.filter((f) => /runner\.ts$|batch\.ts$/.test(f))).toEqual([]);
  });

  it('直接调用方被解析为结构化范围，不作为第二个检索主题', async () => {
    const text = await explore('runUpgrade 的定义、所有直接调用方和相关测试');
    const files = sourcedFiles(text);
    expect(files.some((f) => f.endsWith('src/bin/codegraph.ts'))).toBe(true);
    expect(text).toContain('up.runUpgrade()');
    expect(files[0]).toMatch(/updater\.ts$/);
    expect(files.filter((f) => /runner\.ts$|batch\.ts$/.test(f))).toEqual([]);
  });

  it('大型精确类查询至少保留类自身的定义源码', async () => {
    const text = await explore('LargeCoordinator');
    expect(sourcedFiles(text)[0]).toMatch(/large\.ts$/);
    expect(text).toContain('export class LargeCoordinator');
  });

  it('请求测试时返回直接测试文件', async () => {
    const files = sourcedFiles(await explore('runUpgrade 的定义、所有调用方和相关测试'));
    expect(files.some((f) => f.endsWith('__tests__/updater.test.ts'))).toBe(true);
  });

  it('仍命名了第二个符号时不收束', async () => {
    const files = sourcedFiles(await explore('runUpgrade 和 run 的关系'));
    expect(files.some((f) => f.endsWith('updater.ts'))).toBe(true);
    expect(files.some((f) => /runner\.ts$/.test(f))).toBe(true);
  });
});
