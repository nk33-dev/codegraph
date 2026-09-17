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
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(2_500);
    expect(SERVER_INSTRUCTIONS_NO_ROOT_INDEX.length).toBeLessThanOrEqual(700);
    expect(serialized.length).toBeLessThanOrEqual(6_500);
    expect(SERVER_INSTRUCTIONS.length + serialized.length).toBeLessThanOrEqual(9_000);
  });

  it('保持单个默认工具描述简洁', () => {
    delete process.env[TOOL_ENV];
    const surface = getStaticTools();
    const explore = surface.find((tool) => tool.name === 'codegraph_explore')!;
    const edit = surface.find((tool) => tool.name === 'codegraph_edit')!;

    expect(explore.description.length).toBeLessThanOrEqual(300);
    expect(edit.description.length).toBeLessThanOrEqual(400);
  });
});
