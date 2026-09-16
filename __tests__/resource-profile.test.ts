/**
 * 资源档位解析（阶段一）。
 *
 * 这些用例锁定开发计划 §4 的表格：档位默认值、精细环境变量覆盖档位的优先级、
 * 非法输入的回退、以及 `CODEGRAPH_RESOURCE_GOVERNANCE=0` 的整档回退。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_RESOURCE_PROFILE,
  MAX_QUERY_WORKERS,
  describeResourceProfile,
  parseResourceProfileName,
  resetResourceProfileWarnings,
  resolveQueryPoolSizing,
  resolveResourceProfile,
  resourceGovernanceEnabled,
} from '../src/resource-profile';

/** 空环境：不受运行测试的机器上真实 CODEGRAPH_* 变量影响。 */
const emptyEnv = (): NodeJS.ProcessEnv => ({}) as NodeJS.ProcessEnv;

beforeEach(() => resetResourceProfileWarnings());

describe('resolveResourceProfile：档位默认值', () => {
  it('未设置时用 balanced，且与该档位的表格一致', () => {
    const p = resolveResourceProfile(emptyEnv());
    expect(p.name).toBe(DEFAULT_RESOURCE_PROFILE);
    expect(p.name).toBe('balanced');
    expect(p.queryWorkersInitial).toBe(1);
    expect(p.queryWorkersMin).toBe(1);
    expect(p.queryWorkersMax).toBe(4);
    expect(p.queryIdleShrinkMs).toBe(120_000);
    expect(p.resolveWorkersMax).toBe(5);
    expect(p.lspPerProjectSoftMax).toBe(2);
    expect(p.lspGlobalMax).toBe(3);
    expect(p.lspIdleTimeoutMs).toBe(300_000);
    expect(p.sessionCacheMb).toBe(128);
    expect(p.deepDualIndex).toBe('onDemand');
    expect(p.governanceEnabled).toBe(true);
  });

  it('battery 最省：2 个查询 worker、1 个 LSP/项目、90 秒空闲退出', () => {
    const p = resolveResourceProfile({ CODEGRAPH_RESOURCE_PROFILE: 'battery' } as NodeJS.ProcessEnv);
    expect(p.queryWorkersMax).toBe(2);
    expect(p.queryIdleShrinkMs).toBe(45_000);
    expect(p.queryWorkersMin).toBe(1);
    expect(p.resolveWorkersMax).toBe(2);
    expect(p.lspPerProjectSoftMax).toBe(1);
    expect(p.lspGlobalMax).toBe(2);
    expect(p.lspIdleTimeoutMs).toBe(90_000);
    expect(p.sessionCacheMb).toBe(64);
    expect(p.deepDualIndex).toBe('explicit');
  });

  it('performance 预热 2 个 worker、缩容到 2、LSP 上限更高', () => {
    const p = resolveResourceProfile({ CODEGRAPH_RESOURCE_PROFILE: 'performance' } as NodeJS.ProcessEnv);
    expect(p.queryWorkersInitial).toBe(2);
    expect(p.queryWorkersMin).toBe(2);
    expect(p.queryWorkersMax).toBe(8);
    expect(p.queryIdleShrinkMs).toBe(300_000);
    expect(p.resolveWorkersMax).toBe(8);
    expect(p.lspPerProjectSoftMax).toBe(3);
    expect(p.lspGlobalMax).toBe(6);
    expect(p.lspIdleTimeoutMs).toBe(600_000);
    expect(p.sessionCacheMb).toBe(256);
    expect(p.deepDualIndex).toBe('prewarm');
  });

  it('档位名大小写不敏感；无法识别时回退 balanced', () => {
    expect(parseResourceProfileName('Battery')).toBe('battery');
    expect(parseResourceProfileName('  performance ')).toBe('performance');
    expect(parseResourceProfileName('turbo')).toBeNull();
    const p = resolveResourceProfile({ CODEGRAPH_RESOURCE_PROFILE: 'turbo' } as NodeJS.ProcessEnv);
    expect(p.name).toBe('balanced');
  });
});

describe('resolveResourceProfile：环境变量覆盖档位', () => {
  it('CODEGRAPH_QUERY_POOL_SIZE 覆盖查询 worker 上限并钳制到硬上限', () => {
    expect(resolveResourceProfile({ CODEGRAPH_QUERY_POOL_SIZE: '2' } as NodeJS.ProcessEnv).queryWorkersMax).toBe(2);
    expect(resolveResourceProfile({ CODEGRAPH_QUERY_POOL_SIZE: '999' } as NodeJS.ProcessEnv).queryWorkersMax).toBe(MAX_QUERY_WORKERS);
    expect(resolveResourceProfile({ CODEGRAPH_QUERY_POOL_SIZE: '0' } as NodeJS.ProcessEnv).queryWorkersMax).toBe(0);
  });

  it('非法数值回退档位默认值，而不是抛错', () => {
    const p = resolveResourceProfile({
      CODEGRAPH_QUERY_POOL_SIZE: 'abc',
      CODEGRAPH_LSP_GLOBAL_MAX: '-3',
      CODEGRAPH_LSP_IDLE_TIMEOUT_MS: '1.5',
    } as NodeJS.ProcessEnv);
    expect(p.queryWorkersMax).toBe(4);
    expect(p.lspGlobalMax).toBe(3);
    expect(p.lspIdleTimeoutMs).toBe(300_000);
  });

  it('LSP 数量与空闲退出可以单独覆盖', () => {
    const p = resolveResourceProfile({
      CODEGRAPH_RESOURCE_PROFILE: 'battery',
      CODEGRAPH_LSP_PER_PROJECT_MAX: '2',
      CODEGRAPH_LSP_GLOBAL_MAX: '5',
      CODEGRAPH_LSP_IDLE_TIMEOUT_MS: '15000',
    } as NodeJS.ProcessEnv);
    expect(p.lspPerProjectSoftMax).toBe(2);
    expect(p.lspGlobalMax).toBe(5);
    expect(p.lspIdleTimeoutMs).toBe(15_000);
  });

  it('缩容到 0 表示关闭自动缩容', () => {
    expect(resolveResourceProfile({ CODEGRAPH_QUERY_IDLE_SHRINK_MS: '0' } as NodeJS.ProcessEnv).queryIdleShrinkMs).toBe(0);
  });

  it('最小/初始 worker 永远不会超过上限', () => {
    const p = resolveResourceProfile({
      CODEGRAPH_RESOURCE_PROFILE: 'performance',
      CODEGRAPH_QUERY_POOL_SIZE: '1',
    } as NodeJS.ProcessEnv);
    expect(p.queryWorkersMax).toBe(1);
    expect(p.queryWorkersMin).toBe(1);
    expect(p.queryWorkersInitial).toBe(1);
  });
});

describe('资源治理总开关', () => {
  it('0/false/off 关闭，其余（含未设置）开启', () => {
    expect(resourceGovernanceEnabled(emptyEnv())).toBe(true);
    expect(resourceGovernanceEnabled({ CODEGRAPH_RESOURCE_GOVERNANCE: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(resourceGovernanceEnabled({ CODEGRAPH_RESOURCE_GOVERNANCE: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(resourceGovernanceEnabled({ CODEGRAPH_RESOURCE_GOVERNANCE: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    expect(resourceGovernanceEnabled({ CODEGRAPH_RESOURCE_GOVERNANCE: 'off' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('关闭后 profile 仍然可解析，但标记 governanceEnabled=false', () => {
    const p = resolveResourceProfile({ CODEGRAPH_RESOURCE_GOVERNANCE: '0' } as NodeJS.ProcessEnv);
    expect(p.governanceEnabled).toBe(false);
    expect(describeResourceProfile(p)).toMatch(/disabled/);
  });
});

describe('resolveQueryPoolSizing', () => {
  it('默认走档位上限，并被核心数收紧', () => {
    expect(resolveQueryPoolSizing(emptyEnv(), 16)).toMatchObject({ initial: 1, min: 1, max: 4, idleShrinkMs: 120_000, source: 'profile' });
    expect(resolveQueryPoolSizing(emptyEnv(), 64)).toMatchObject({ max: 4 });
    expect(resolveQueryPoolSizing({ CODEGRAPH_RESOURCE_PROFILE: 'battery' } as NodeJS.ProcessEnv, 16).max).toBe(2);
    expect(resolveQueryPoolSizing({ CODEGRAPH_RESOURCE_PROFILE: 'performance' } as NodeJS.ProcessEnv, 16)).toMatchObject({ initial: 2, min: 2, max: 8 });
    // 2 核机器只给 1 个 worker（cores-1），档位不会把上限抬高。
    expect(resolveQueryPoolSizing(emptyEnv(), 2).max).toBe(1);
    expect(resolveQueryPoolSizing(emptyEnv(), 1).max).toBe(1);
  });

  it('显式 CODEGRAPH_QUERY_POOL_SIZE 覆盖档位并标出来源', () => {
    expect(resolveQueryPoolSizing({ CODEGRAPH_QUERY_POOL_SIZE: '3' } as NodeJS.ProcessEnv, 16)).toMatchObject({ max: 3, source: 'override' });
    expect(resolveQueryPoolSizing({ CODEGRAPH_QUERY_POOL_SIZE: '0' } as NodeJS.ProcessEnv, 16)).toMatchObject({ max: 0, initial: 0, source: 'override' });
  });

  it('治理关闭时回退旧行为：cores-1、不缩容', () => {
    const sizing = resolveQueryPoolSizing({ CODEGRAPH_RESOURCE_GOVERNANCE: '0' } as NodeJS.ProcessEnv, 16);
    expect(sizing).toMatchObject({ initial: 1, min: 1, max: 15, idleShrinkMs: 0, source: 'legacy' });
    expect(resolveQueryPoolSizing({ CODEGRAPH_RESOURCE_GOVERNANCE: '0' } as NodeJS.ProcessEnv, 64).max).toBe(MAX_QUERY_WORKERS);
  });
});

describe('describeResourceProfile', () => {
  it('一行里给出 profile、worker、解析 worker 和 LSP 预算', () => {
    const text = describeResourceProfile(resolveResourceProfile({ CODEGRAPH_RESOURCE_PROFILE: 'battery' } as NodeJS.ProcessEnv));
    expect(text).toContain('profile=battery');
    expect(text).toContain('queryWorkers=1..2');
    expect(text).toContain('resolveWorkers<=2');
    expect(text).toContain('lsp=1/project, 2/global');
  });

  it('关闭缩容时明确写 off', () => {
    const text = describeResourceProfile(resolveResourceProfile({ CODEGRAPH_QUERY_IDLE_SHRINK_MS: '0' } as NodeJS.ProcessEnv));
    expect(text).toContain('idle shrink off');
  });
});
