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
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(2_300);
    expect(SERVER_INSTRUCTIONS_NO_ROOT_INDEX.length).toBeLessThanOrEqual(500);
    expect(serialized.length).toBeLessThanOrEqual(4_850);
    expect(SERVER_INSTRUCTIONS.length + serialized.length).toBeLessThanOrEqual(7_100);
  });

  it('保持单个默认工具描述简洁', () => {
    delete process.env[TOOL_ENV];
    const surface = getStaticTools();
    const explore = surface.find((tool) => tool.name === 'codegraph_explore')!;
    const edit = surface.find((tool) => tool.name === 'codegraph_edit')!;

    expect(explore.description.length).toBeLessThanOrEqual(200);
    expect(edit.description.length).toBeLessThanOrEqual(200);
    // 单个工具的完整定义（描述 + schema + 注解）也设上限，防止参数说明无限增长。
    expect(JSON.stringify(explore).length).toBeLessThanOrEqual(3_100);
    expect(JSON.stringify(edit).length).toBeLessThanOrEqual(1_900);
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
   * 实测（2026-09-17，直接序列化当前构建产物）：常驻说明 2,214、默认 tools/list
   * 4,977（explore 3,017 / 描述 184，edit 1,957 / 描述 356）。
   * always-loaded 与 deferred 的差额就是 tools/list 这部分：Claude Code 的
   * ToolSearch 之前，工具定义本来不进上下文，所以这笔固定成本必须单独有上限。
   * 上限只用来发现「悄悄变胖」，所以留了约 3% 余量，不是精确值断言。
   */
  it('钉住 always-load 的固定上下文成本（P2 问题 11）', () => {
    delete process.env[TOOL_ENV];
    const surface = getStaticTools();
    const explore = surface.find((tool) => tool.name === 'codegraph_explore')!;
    const edit = surface.find((tool) => tool.name === 'codegraph_edit')!;
    const toolsList = JSON.stringify(surface).length;

    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(2_300);
    expect(toolsList).toBeLessThanOrEqual(5_100);
    expect(JSON.stringify(explore).length).toBeLessThanOrEqual(3_150);
    expect(JSON.stringify(edit).length).toBeLessThanOrEqual(2_050);
    expect(SERVER_INSTRUCTIONS.length + toolsList).toBeLessThanOrEqual(7_400);
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
