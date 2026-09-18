/**
 * MCP 固定表面：初始化说明与默认 tools/list 的字符预算和语义边界。
 *
 * 预算固定在当前实测值附近，任何一次「顺手多说一句」都会在这里失败；同时用语义断言保证
 * 为了压字符不把关键安全约束删掉（P0 问题 2 的验证要求）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getStaticTools } from '../src/mcp/tools';
import {
  SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTIONS_NO_ROOT_INDEX,
} from '../src/mcp/server-instructions';

const TOOL_ENV = 'CODEGRAPH_MCP_TOOLS';
const originalToolEnv = process.env[TOOL_ENV];

/**
 * always-load 固定上下文成本的实测上限（P2 问题 11）。
 *
 * 上限只是用来发现「悄悄变胖」，所以是「当前实测值 + 约 2% 余量」，不是精确值断言；
 * 同一个量在两个用例里共用同一个常量，避免同一次改动只撞破其中一个阈值。
 *
 * 2026-09 基线（新增 explore 的 includeTestSource 选项之后实测）：
 * 常驻说明 2,214；默认 tools/list 4,932（其中 explore 3,206、edit 1,723）；
 * 两者合计 7,146。当时把上限从 4,850 / 3,100 / 3,150 / 7,100 上调到下面这组，
 * 因为 explore 的 schema 确实多了一个可发现的可选参数——这是唯一一次有意增长：
 * 参数本身只花 173 字符，描述已经压到最短，语义（默认摘要、可按名再查全文）
 * 由摘要分节自身的表头承载。
 */
const SURFACE_MAX = {
  instructions: 2_300,
  noRootInstructions: 500,
  toolsList: 5_050,
  explore: 3_280,
  edit: 2_100,
  combined: 7_300,
} as const;

afterEach(() => {
  if (originalToolEnv === undefined) delete process.env[TOOL_ENV];
  else process.env[TOOL_ENV] = originalToolEnv;
});

describe('MCP 常驻说明', () => {
  it('保持默认表面精简且语义完整', () => {
    delete process.env[TOOL_ENV];
    const surface = getStaticTools();
    const serialized = JSON.stringify(surface);

    expect(surface.map((tool) => tool.name)).toEqual(['codegraph_explore', 'codegraph_edit']);
    expect(SERVER_INSTRUCTIONS).toContain('codegraph_explore');
    expect(SERVER_INSTRUCTIONS).toContain('codegraph_edit');
    expect(SERVER_INSTRUCTIONS).not.toMatch(/single tool|There is a single tool/i);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(SURFACE_MAX.instructions);
    expect(SERVER_INSTRUCTIONS_NO_ROOT_INDEX.length).toBeLessThanOrEqual(SURFACE_MAX.noRootInstructions);
    expect(serialized.length).toBeLessThanOrEqual(SURFACE_MAX.toolsList);
    expect(SERVER_INSTRUCTIONS.length + serialized.length).toBeLessThanOrEqual(SURFACE_MAX.combined);
  });

  it('保持单个默认工具描述简洁', () => {
    delete process.env[TOOL_ENV];
    const surface = getStaticTools();
    const explore = surface.find((tool) => tool.name === 'codegraph_explore')!;
    const edit = surface.find((tool) => tool.name === 'codegraph_edit')!;

    expect(explore.description.length).toBeLessThanOrEqual(200);
    expect(edit.description.length).toBeLessThanOrEqual(200);
    // 单个工具的完整定义（描述 + schema + 注解）也设上限，防止参数说明无限增长。
    expect(JSON.stringify(explore).length).toBeLessThanOrEqual(SURFACE_MAX.explore);
    expect(JSON.stringify(edit).length).toBeLessThanOrEqual(SURFACE_MAX.edit);
  });

  it('压缩后仍保留源码完整性、编辑安全与未索引项目的约束', () => {
    // 源码完整性边界：缺口意味着省略，编辑前要按名字重新查询。
    expect(SERVER_INSTRUCTIONS).toMatch(/gap|truncation/i);
    expect(SERVER_INSTRUCTIONS).toContain('query the missing symbol or range before editing it');
    expect(SERVER_INSTRUCTIONS).toContain('Treat displayed lines as already read');
    // 编辑安全：预览默认开启，只有 canApply 为真且 blockers 为空才应用。
    expect(SERVER_INSTRUCTIONS).toContain('canApply:true');
    expect(SERVER_INSTRUCTIONS).toMatch(/blockers/);
    // 未索引项目：改用内置工具，索引是用户的决定。
    expect(SERVER_INSTRUCTIONS).toMatch(/no \`\.codegraph\/\`/);
    expect(SERVER_INSTRUCTIONS).toContain('do not run');
    expect(SERVER_INSTRUCTIONS_NO_ROOT_INDEX).toContain('projectPath');
  });

  /**
   * P2 问题 11：always-load 的固定上下文成本要可分解、可回归。
   *
   * 这里量的是同一组固定成本（与上一个用例共用 {@link SURFACE_MAX} 的上限），
   * 外加 explore/edit 各自的完整定义。always-loaded 与 deferred 的差额就是
   * tools/list 这部分：Claude Code 的 ToolSearch 之前，工具定义本来不进上下文，
   * 所以这笔固定成本必须单独有上限。
   */
  it('钉住 always-load 的固定上下文成本（P2 问题 11）', () => {
    delete process.env[TOOL_ENV];
    const surface = getStaticTools();
    const explore = surface.find((tool) => tool.name === 'codegraph_explore')!;
    const edit = surface.find((tool) => tool.name === 'codegraph_edit')!;
    const toolsList = JSON.stringify(surface).length;

    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(SURFACE_MAX.instructions);
    expect(toolsList).toBeLessThanOrEqual(SURFACE_MAX.toolsList);
    expect(JSON.stringify(explore).length).toBeLessThanOrEqual(SURFACE_MAX.explore);
    expect(JSON.stringify(edit).length).toBeLessThanOrEqual(SURFACE_MAX.edit);
    expect(SERVER_INSTRUCTIONS.length + toolsList).toBeLessThanOrEqual(SURFACE_MAX.combined);
  });

  /**
   * P2 问题 12：「已展示源码视为已读取」在模型可见的固定表面里只声明一次。
   *
   * 保留的是初始化说明里那一句；工具描述只做定位（P0 的「一句话定位 + 何时使用」），
   * 响应尾注只讲本次调用事实。契约不变，只是不再重复三遍。
   */
  it('模型可见表面只声明一次「已展示源码视为已读取」（P2 问题 12）', () => {
    delete process.env[TOOL_ENV];
    const surface = getStaticTools();
    const visible = [
      SERVER_INSTRUCTIONS,
      SERVER_INSTRUCTIONS_NO_ROOT_INDEX,
      ...surface.map((tool) => `${tool.description} ${JSON.stringify(tool.inputSchema)}`),
    ].join('\n');

    const declarations = visible.match(
      /treat (?:displayed|shown)(?: lines| source)? as (?:already )?read|do not re-?read/gi,
    ) ?? [];
    expect(declarations).toHaveLength(1);
    expect(SERVER_INSTRUCTIONS).toContain('Treat displayed lines as already read.');
    expect(surface.find((tool) => tool.name === 'codegraph_explore')!.description)
      .not.toMatch(/treat|re-?read/i);
  });
});
