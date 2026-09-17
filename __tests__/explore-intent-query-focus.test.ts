/**
 * codegraph_explore — 自然语言意图词不参与模糊匹配（个人版精确检索契约）。
 *
 * 真实报告：查询 `runUpgrade` 很准确；查询 “runUpgrade 的定义、所有调用方和相关测试”
 * 时混入其他文件里名为 `run` 的函数——意图词（定义/所有/调用方/相关测试）没有被
 * 整体识别，收束没有触发，查询文本继续走 FTS，camelCase 片段 “run” 命中了无关文件。
 *
 * 契约：一旦索引能唯一确认一个精确符号，其余文本只当作意图——
 * 只展开目标符号、直接关系和直接测试；仍命名了第二个符号的查询保持完整探索路径。
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

    // 目标符号：updater.ts 的 runUpgrade 是索引里唯一的精确命中。
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

    // 噪声：其他文件里的 run()。camelCase 片段 “run” 会命中它们。
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

    // 直接测试：调用 runUpgrade。
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
