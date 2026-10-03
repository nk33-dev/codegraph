/**
 * `codegraph_hotspots` 的 MCP 表面契约。
 *
 * 与 architecture 同款：工具默认不在 tools/list 里，加进来会挤动固定表面的字符预算，所以这里同时
 * 钉住工具本身（只读、参数面）和默认表面不受影响。行为的正确性在 `hotspots.test.ts` 里。
 */
import { describe, expect, it } from 'vitest';
import { allTools, getStaticTools, tools } from '../src/mcp/tools';

describe('codegraph_hotspots tool surface', () => {
  it('is defined once, with the read-only annotations every tool must carry', () => {
    const matches = tools.filter((tool) => tool.name === 'codegraph_hotspots');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.annotations?.readOnlyHint).toBe(true);
    expect(matches[0]!.annotations?.openWorldHint).toBe(false);
    expect(allTools.filter((tool) => tool.name === 'codegraph_hotspots')).toHaveLength(1);
  });

  it('declares the diff, threshold and item options, and accepts projectPath like the other tools', () => {
    const schema = tools.find((tool) => tool.name === 'codegraph_hotspots')!.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      'base',
      'maxItems',
      'projectPath',
      'threshold',
    ]);
    expect(schema.required ?? []).not.toContain('projectPath');
  });

  it('stays off the default surface: explore and edit only', () => {
    const names = getStaticTools().map((tool) => tool.name);
    expect(names).toHaveLength(2);
    expect(names).not.toContain('codegraph_hotspots');
  });
});
