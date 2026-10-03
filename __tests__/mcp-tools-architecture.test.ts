/**
 * `codegraph_architecture` 的 MCP 表面契约。
 *
 * 这个工具默认不出现在 tools/list 里（默认只有 explore 和 edit），加进来会动到固定表面的字符预算
 * 契约——所以这里要同时钉住两件事：工具存在且带只读注解，以及默认表面不受它影响。
 */
import { describe, expect, it } from 'vitest';
import { allTools, getStaticTools, tools } from '../src/mcp/tools';

describe('codegraph_architecture tool surface', () => {
  it('is defined once, with the read-only annotations every tool must carry', () => {
    const matches = tools.filter((tool) => tool.name === 'codegraph_architecture');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.annotations?.readOnlyHint).toBe(true);
    expect(matches[0]!.annotations?.openWorldHint).toBe(false);
    expect(allTools.filter((tool) => tool.name === 'codegraph_architecture')).toHaveLength(1);
  });

  it('declares the scope and cycle options, and accepts projectPath like the other tools', () => {
    const schema = tools.find((tool) => tool.name === 'codegraph_architecture')!.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      'depth',
      'includeCycles',
      'maxViolations',
      'minConfidence',
      'projectPath',
      'root',
    ]);
    expect(schema.required ?? []).not.toContain('projectPath');
  });

  it('stays off the default surface: explore and edit only', () => {
    const names = getStaticTools().map((tool) => tool.name);
    expect(names).toHaveLength(2);
    expect(names).not.toContain('codegraph_architecture');
  });
});
