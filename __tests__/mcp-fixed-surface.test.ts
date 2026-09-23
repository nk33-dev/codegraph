/**
 * P0：MCP 固定表面与公共契约。
 *
 * 这一组测试把「固定表面只由配置决定」写成可执行的契约，而不是注释里的承诺：
 *   - 默认 tools/list 在 149 / 499 / 500 / 4999 / 5000 文件数下字节完全一致，并且与
 *     无引擎的静态代理表面相同，默认路径也不再读取仓库规模（P0 问题 1）；
 *   - 显式 CODEGRAPH_MCP_TOOLS 严格按白名单返回：小仓库规则不再删除白名单指定的工具
 *     （P0 问题 5）；
 *   - maxFiles 的 schema 不再声明固定默认值 12，分档是运行时唯一事实来源（P0 问题 4）；
 *   - mode 枚举与描述明确列出结构化模式（P0 问题 3）；
 *   - explore 响应只陈述本次调用的事实，通用契约只在初始化说明里出现一次（P0 问题 2）。
 *
 * 这些断言都是确定性的：不依赖模型行为，也不需要 A/B。A/B 通过标准属于 P1/P2。
 */
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ToolHandler,
  allTools,
  getExploreOutputBudget,
  getStaticTools,
  type ToolDefinition,
} from '../src/mcp/tools';
import { SERVER_INSTRUCTIONS } from '../src/mcp/server-instructions';
import type CodeGraph from '../src/index';
import { IndexedProject } from './indexed-project';

const ENV = 'CODEGRAPH_MCP_TOOLS';

/** 只提供 getTools() 需要的 `getStats`：伪造仓库规模，同时记录它是否被读取。 */
function fakeGraph(fileCount: number, onStats?: () => void): CodeGraph {
  return {
    getStats: () => {
      onStats?.();
      return { fileCount };
    },
  } as unknown as CodeGraph;
}

function exploreOf(defs: ToolDefinition[]): ToolDefinition {
  const explore = defs.find((tool) => tool.name === 'codegraph_explore');
  expect(explore, 'codegraph_explore 缺失').toBeDefined();
  return explore!;
}

describe('默认工具表面与仓库规模无关（P0 问题 1）', () => {
  const original = process.env[ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it('149 / 499 / 500 / 4999 / 5000 文件数下默认 tools/list 字节完全一致', () => {
    delete process.env[ENV];
    const expected = JSON.stringify(getStaticTools());
    // 500 是历史上小仓库工具的过滤阈值，这里特意取它两侧的档位边界。
    for (const fileCount of [149, 499, 500, 4999, 5000]) {
      let statsCalls = 0;
      const listed = new ToolHandler(fakeGraph(fileCount, () => { statsCalls++; })).getTools();
      expect(JSON.stringify(listed), `fileCount=${fileCount} 的表面与默认表面不一致`).toBe(expected);
      // 默认两工具表面不再调用 getStats()：规模既不是输入，也不应被读取。
      expect(statsCalls, `fileCount=${fileCount} 时默认路径读取了仓库规模`).toBe(0);
    }
  });

  it('默认工具定义不含文件数、调用预算或时间', () => {
    delete process.env[ENV];
    const serialized = JSON.stringify(getStaticTools());
    expect(serialized).not.toMatch(/files indexed/i);
    expect(serialized).not.toMatch(/\d[\d,.]*-file project/i);
    expect(serialized).not.toMatch(/suggested coverage/i);
    expect(serialized).not.toMatch(/\d+\s*ms ago/i);
    expect(serialized).not.toMatch(/last indexed/i);
  });

  it('已加载项目的默认工具描述与静态代理定义一致', async () => {
    delete process.env[ENV];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fixed-surface-'));
    let project: IndexedProject | undefined;
    try {
      fs.writeFileSync(
        path.join(dir, 'pay.ts'),
        'export function processPayment(amount: number): boolean { return amount > 0; }\n',
      );
      project = new IndexedProject(dir);
      await project.index();

      expect(JSON.stringify(new ToolHandler(project.graph).getTools()))
        .toBe(JSON.stringify(getStaticTools()));
    } finally {
      await project?.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe('显式白名单完全替换默认表面（P0 问题 5）', () => {
  const original = process.env[ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  const namesAt = (fileCount: number): string[] =>
    new ToolHandler(fakeGraph(fileCount)).getTools().map((tool) => tool.name).sort();

  it('小仓库里显式启用 callers/node/search 时三者原样出现', () => {
    process.env[ENV] = 'callers,node,search';
    expect(namesAt(10)).toEqual(['codegraph_callers', 'codegraph_node', 'codegraph_search']);
  });

  it('白名单结果与仓库规模无关', () => {
    process.env[ENV] = 'callers,node,search,impact';
    const small = namesAt(10);
    expect(small).toEqual(['codegraph_callers', 'codegraph_impact', 'codegraph_node', 'codegraph_search']);
    expect(namesAt(100_000)).toEqual(small);
  });

  it('小仓库的默认表面仍是 explore + edit，与阈值另一侧一致', () => {
    delete process.env[ENV];
    expect(namesAt(10)).toEqual(['codegraph_edit', 'codegraph_explore']);
    expect(namesAt(10)).toEqual(namesAt(5000));
  });

  it('白名单不改变已定义工具集合本身', () => {
    process.env[ENV] = 'callers,node,search';
    const defined = allTools.map((tool) => tool.name).sort();
    expect(defined).toContain('codegraph_edit');
    expect(defined).toContain('codegraph_status');
    expect(defined).toContain('codegraph_impact');
  });
});

describe('maxFiles 的公共契约与运行时一致（P0 问题 4）', () => {
  const original = process.env[ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it('schema 不再声明固定的 default: 12', () => {
    delete process.env[ENV];
    const maxFiles = exploreOf(getStaticTools()).inputSchema.properties.maxFiles as {
      default?: unknown;
      description: string;
    };
    expect(maxFiles, 'maxFiles 参数缺失').toBeDefined();
    expect(maxFiles.default).toBeUndefined();
    // 描述必须说明「未指定时按项目规模选择」，否则这个参数的行为无从得知。
    expect(maxFiles.description).toMatch(/project-size tier/i);
  });

  it('运行时分档是唯一事实来源：4 / 5 / 8', () => {
    expect(getExploreOutputBudget(149).defaultMaxFiles).toBe(4);
    expect(getExploreOutputBudget(499).defaultMaxFiles).toBe(5);
    expect(getExploreOutputBudget(500).defaultMaxFiles).toBe(8);
    expect(getExploreOutputBudget(4999).defaultMaxFiles).toBe(8);
    expect(getExploreOutputBudget(5000).defaultMaxFiles).toBe(8);
    // 历史上 schema 写死 12，与任何一档都不同 —— 这正是被移除的不一致。
    for (const fileCount of [149, 499, 500, 4999, 5000, 50_000]) {
      expect(getExploreOutputBudget(fileCount).defaultMaxFiles).not.toBe(12);
    }
  });
});

describe('结构化模式的可见性（P0 问题 3）', () => {
  const STRUCTURED_MODES = ['definitions', 'references', 'symbols', 'diagnostics', 'impact', 'tests', 'status'];

  it('mode 枚举与描述都明确列出结构化模式', () => {
    const mode = exploreOf(getStaticTools()).inputSchema.properties.mode as {
      enum: string[];
      description: string;
      default?: string;
    };
    expect(mode.default).toBe('explore');
    for (const name of STRUCTURED_MODES) {
      expect(mode.enum, `mode 枚举缺少 ${name}`).toContain(name);
      expect(mode.description, `mode 描述缺少 ${name}`).toContain(name);
    }
  });

  it('初始化说明仍点名结构化模式，且没有因此新增默认工具', () => {
    for (const name of STRUCTURED_MODES) {
      expect(SERVER_INSTRUCTIONS).toContain(name);
    }
    delete process.env[ENV];
    expect(getStaticTools()).toHaveLength(2);
  });

  it('tests 模式可只传 files，其余模式仍由运行时要求 query', () => {
    const schema = exploreOf(getStaticTools()).inputSchema;
    expect(schema.required).toBeUndefined();
    expect(schema.anyOf).toEqual([
      { required: ['query'] },
      { required: ['mode', 'files'], properties: { mode: { const: 'tests' } } },
    ]);
    expect(schema.properties.query.description).toMatch(/omit only for tests/i);
  });
});

describe('explore 响应只陈述本次调用的事实（P0 问题 2）', () => {
  let testDir: string;
  let project: IndexedProject;
  let handler: ToolHandler;
  const original = process.env[ENV];

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fixed-response-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'session.ts'),
      [
        'export class Session {',
        '  run(arg: string): string { return this.helper(arg); }',
        '  private helper(arg: string): string { return arg.repeat(2); }',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(srcDir, 'caller.ts'),
      "import { Session } from './session';\nexport function drive(s: Session) { return s.run('hi'); }\n",
    );
    project = new IndexedProject(testDir);
    await project.index();
    handler = new ToolHandler(project.graph);
  });

  afterAll(async () => {
    await project?.close();
    if (testDir) fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it('逐次重复的通用教程不再出现在响应里', async () => {
    const result = await handler.execute('codegraph_explore', { query: 'Session run helper' });
    const text = result.content?.[0]?.text ?? '';

    // 通用契约只在初始化说明里声明一次。
    expect(SERVER_INSTRUCTIONS).toContain('query the missing symbol or range before editing it');
    expect(text).not.toContain('Numbered lines are current source excerpts');
    expect(text).not.toContain('query missing names or ranges before editing');
    // 本次调用的事实仍然在：源码区仍在，并且仍然声明它逐字、当前。
    expect(text).toContain('**Source Code**');
    expect(text).toMatch(/> Lines below are verbatim, current source excerpts\./);
  });

  it('中等档的完整性说明只讲本次调用的跨度，不再附通用编辑教程', async () => {
    // 500+ 文件才打开完整性说明；合成工程很小，所以伪造 stats 落到该档。
    const spy = vi.spyOn(project.graph, 'getStats')
      .mockReturnValue({ fileCount: 1000 } as ReturnType<CodeGraph['getStats']>);
    try {
      const result = await handler.execute('codegraph_explore', { query: 'Session run helper' });
      const text = result.content?.[0]?.text ?? '';
      expect(text).toMatch(/> Shown source spans \d+ files/);
      expect(text).not.toContain('explore those names before editing');
    } finally {
      spy.mockRestore();
    }
  });
});
