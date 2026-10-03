/**
 * Front-load hook project resolution (#964).
 *
 * The Claude `UserPromptSubmit` front-load hook must inject CodeGraph context
 * for the RIGHT project — including the monorepo case where the agent's cwd is
 * an un-indexed workspace root and the index lives in a sub-project. These test
 * `planFrontload` / `findIndexedSubprojectRoots` directly (the hook's decision
 * logic), plus the built CLI's confidence tiers against a real index.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import { CodeGraph } from '../src';
// This fork gates the hook solely on graph-verified code tokens (the structural
// keyword table and the prose-segment MEDIUM tier were removed by design), so the
// prompt-hook behaviour is covered end-to-end below rather than per keyword list.
import { planFrontload, isTaskNotification, isAgentMessage, findIndexedSubprojectRoots, unsafeIndexRootReason, extractCodeTokens, PROMPT_HOOK_INJECTION_MAX, CLAUDE_CODE_INLINE_HOOK_OUTPUT_LIMIT, capPromptHookInjection } from '../src/directory';

// Make the built-in exports configurable so HOME can point at a real temp
// fixture without changing the process environment or the user's home files.
vi.mock('os', async (importOriginal) => ({ ...await importOriginal<typeof import('os')>() }));

/**
 * Make `dir` indexed. isInitialized needs `.codegraph/codegraph.db` WITH the
 * codegraph schema — an empty file no longer counts (#1895).
 */
function mkIndexed(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  CodeGraph.initSync(dir).close();
  return dir;
}
/** A workspace-root manifest so the down-scan gate (looksLikeProjectRoot) passes. */
function mkWorkspaceRoot(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true,"workspaces":["packages/*"]}');
  return dir;
}

describe('planFrontload — front-load hook project resolution (#964)', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-frontload-'))); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('cwd is itself indexed → front-load cwd (the common single-project case)', () => {
    mkIndexed(tmp);
    const plan = planFrontload(tmp, 'how does login work');
    expect(plan.exploreRoot).toBe(tmp);
    expect(plan.viaSubScan).toBe(false);
    expect(plan.nudgeProjects).toEqual([]);
  });

  it('a nested file under an indexed project resolves up to that project', () => {
    mkIndexed(tmp);
    const nested = path.join(tmp, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    expect(planFrontload(nested, 'trace the flow').exploreRoot).toBe(tmp);
  });

  it('un-indexed workspace root with ONE indexed sub-project → front-load it (the #964 case)', () => {
    mkWorkspaceRoot(tmp);
    const api = mkIndexed(path.join(tmp, 'packages', 'api'));
    const plan = planFrontload(tmp, 'how does the request get handled');
    expect(plan.exploreRoot).toBe(api);
    expect(plan.viaSubScan).toBe(true);
    expect(plan.nudgeProjects).toEqual([]);
  });

  it('multiple indexed sub-projects, prompt names one by path → front-load it, nudge the rest', () => {
    mkWorkspaceRoot(tmp);
    const api = mkIndexed(path.join(tmp, 'packages', 'api'));
    const web = mkIndexed(path.join(tmp, 'packages', 'web'));
    const plan = planFrontload(tmp, 'in packages/api, how does the handler validate the token?');
    expect(plan.exploreRoot).toBe(api);
    expect(plan.viaSubScan).toBe(true);
    expect(plan.nudgeProjects).toEqual([web]);
  });

  it('multiple indexed sub-projects, prompt names one by package name → front-load it', () => {
    mkWorkspaceRoot(tmp);
    mkIndexed(path.join(tmp, 'packages', 'api'));
    const web = mkIndexed(path.join(tmp, 'packages', 'web'));
    const plan = planFrontload(tmp, 'how does the web frontend render the dashboard?');
    expect(plan.exploreRoot).toBe(web);
  });

  it('multiple indexed sub-projects, NO clear match → nudge the full list, do not guess', () => {
    mkWorkspaceRoot(tmp);
    const api = mkIndexed(path.join(tmp, 'packages', 'api'));
    const web = mkIndexed(path.join(tmp, 'packages', 'web'));
    const plan = planFrontload(tmp, 'how does authentication work end to end?');
    expect(plan.exploreRoot).toBeNull();
    expect(plan.viaSubScan).toBe(true);
    expect(plan.nudgeProjects.sort()).toEqual([api, web].sort());
  });

  it('un-indexed dir that is NOT a workspace root → no-op (guards $HOME-style crawls)', () => {
    // Indexed project exists below, but cwd has no manifest, so the down-scan is skipped.
    mkIndexed(path.join(tmp, 'some', 'project'));
    const plan = planFrontload(tmp, 'how does it work');
    expect(plan.exploreRoot).toBeNull();
    expect(plan.nudgeProjects).toEqual([]);
  });

  it.each([
    { root: 'home', manifest: 'package.json', children: 1 },
    { root: 'home', manifest: 'package.json', children: 2 },
    { root: 'home', manifest: 'WORKSPACE', children: 1 },
    { root: 'parent of home', manifest: 'package.json', children: 1 },
  ])('$root with stray $manifest and $children indexed children → no-op (#1454)', ({ root, manifest, children }) => {
    const homeDir = root === 'home' ? tmp : path.join(tmp, 'user');
    fs.mkdirSync(homeDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
    if (manifest === 'package.json') mkWorkspaceRoot(tmp);
    else fs.mkdirSync(path.join(tmp, manifest)); // Even a WORKSPACE directory opens the manifest gate.
    mkIndexed(path.join(tmp, 'packages', 'api'));
    if (children === 2) mkIndexed(path.join(tmp, 'packages', 'web'));
    expect(unsafeIndexRootReason(tmp)).toBe(root === 'home' ? 'your home directory' : 'a parent of your home directory');

    expect(planFrontload(tmp, 'how does authentication work end to end?')).toEqual({
      exploreRoot: null,
      nudgeProjects: [],
      viaSubScan: false,
    });
    expect(findIndexedSubprojectRoots(tmp)).toEqual([]);
  });

  it('nothing indexed anywhere → no-op', () => {
    mkWorkspaceRoot(tmp);
    fs.mkdirSync(path.join(tmp, 'packages', 'api'), { recursive: true });
    const plan = planFrontload(tmp, 'how does it work');
    expect(plan.exploreRoot).toBeNull();
    expect(plan.nudgeProjects).toEqual([]);
  });
});

describe('findIndexedSubprojectRoots', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-subscan-'))); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('finds indexed projects a couple levels down and skips node_modules/.git', () => {
    mkIndexed(path.join(tmp, 'packages', 'api'));
    mkIndexed(path.join(tmp, 'services', 'auth'));
    // Decoys that must NOT be scanned into.
    mkIndexed(path.join(tmp, 'node_modules', 'dep'));
    mkIndexed(path.join(tmp, '.git', 'x'));
    const found = findIndexedSubprojectRoots(tmp).map((p) => path.relative(tmp, p)).sort();
    expect(found).toEqual([path.join('packages', 'api'), path.join('services', 'auth')].sort());
  });

  it('does not descend INTO an indexed project (a project\'s sub-dirs are not separate projects)', () => {
    const api = mkIndexed(path.join(tmp, 'packages', 'api'));
    mkIndexed(path.join(api, 'submodule')); // nested index under an already-indexed project
    const found = findIndexedSubprojectRoots(tmp);
    expect(found).toEqual([api]);
  });

  it('respects the depth bound', () => {
    mkIndexed(path.join(tmp, 'a', 'b', 'c', 'd', 'e', 'deep'));
    expect(findIndexedSubprojectRoots(tmp, { maxDepth: 2 })).toEqual([]);
  });
});

describe('prompt-hook ambiguous words need corroboration (#1654)', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hook-ambiguous-')));
    fs.writeFileSync(path.join(tmp, 'orders.ts'), `
export class OrderStateMachine {
  submitOrder() { return true; }
}
`);
    const cg = await CodeGraph.init(tmp, { silent: true });
    try { await cg.indexAll(); } finally { cg.destroy(); }
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function hook(prompt: string): string {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../dist/bin/codegraph.js'), 'prompt-hook'], {
      cwd: tmp,
      input: JSON.stringify({ cwd: tmp, prompt }),
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      env: {
        ...process.env,
        CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_DAEMON: '1',
        CODEGRAPH_NO_RELAUNCH: '1', CODEGRAPH_WASM_RELAUNCHED: '1',
        // Enable only the hook subprocess under test.
        CODEGRAPH_NO_PROMPT_HOOK: '0', CODEGRAPH_PROMPT_HOOK: '1',
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  }

  it('stays silent for everyday Portuguese, Spanish and German without indexed evidence', () => {
    // This fork removed the multilingual structural keyword table (upstream
    // v1.6.1's `hasStructuralKeyword`) and gates the hook solely on graph-verified
    // code tokens, so no keyword decision is asserted here — only the silence.
    for (const prompt of [
      'eu como pizza toda sexta',
      'faz como a gente combinou ontem',
      'roda os testes como esta e me diz o resultado',
      'commita isso como fix, nao como feat',
      'hazlo como ayer',
      'mach es wie gestern',
      'COMO combinado ontem',
      'Wie gestern bitte',
      'como JavaScript?',
      'wie MissingService?',
      'run the tests and report back',
    ]) {
      expect.soft(hook(prompt), prompt).toBe('');
    }
  });

  it('keeps HIGH for graph-verified identifiers, not for a structural keyword alone', () => {
    // Verified identifiers fire regardless of the surrounding human language.
    for (const prompt of [
      'como OrderStateMachine?',
      'como submitOrder()?',
      'wie OrderStateMachine?',
      'how does OrderStateMachine work?',
    ]) {
      expect.soft(hook(prompt), prompt).toContain('Structural context from CodeGraph');
    }

    // Prose-only structural questions stay silent: upstream v1.6.1 fires these
    // via its Portuguese/German/Spanish keyword list, which this fork dropped by
    // design (docs/person/mcp-experience-review.md, item 16) — without a
    // code-shaped token that verifies against the graph, nothing is injected.
    for (const prompt of [
      'como funciona a máquina de estados?',
      'wie funktioniert die Zustandsmaschine?',
      'onde fica a lógica dos pedidos?',
      '¿cómo se procesan los pedidos?',
    ]) {
      expect.soft(hook(prompt), prompt).toBe('');
    }
  });

  it('stays silent for prose-only prompts without a graph-verified token (#1654)', () => {
    // Upstream MEDIUM matched prose words against symbol-name segments; this fork
    // removed that tier, so the hook injects nothing here. These words are not
    // code-shaped tokens, so no graph evidence is ever established.
    for (const prompt of ['como state machine?', 'wie state machine?']) {
      expect.soft(hook(prompt), prompt).toBe('');
    }
  });

  it('stays silent on a subagent hand-back envelope, even one that names indexed symbols (#2184)', () => {
    const report = 'how does OrderStateMachine work? submitOrder() calls into the state machine.';
    expect(hook(report)).toContain('Structural context from CodeGraph');
    expect(hook(`<agent-message from="agent-7f3e">\n[Subagent hand-back] ${report}\n</agent-message>`)).toBe('');
  });
});

describe('extractCodeTokens — candidate symbols the hook verifies against the graph', () => {
  it('pulls camelCase / PascalCase / snake_case / call / member tokens', () => {
    expect(extractCodeTokens('prepareArticlePublish 的调用链')).toContain('prepareArticlePublish');
    expect(extractCodeTokens('看看 get_user 这段逻辑')).toContain('get_user');   // snake_case
    expect(extractCodeTokens('render() 在哪触发')).toContain('render');          // call form
    expect(extractCodeTokens('user.login 做了什么').sort()).toEqual(['login', 'user']); // member access
    expect(extractCodeTokens('看看 UserService')).toContain('UserService');      // PascalCase class kept
  });

  it('a tech brand is extracted as a CANDIDATE — the hook’s graph check is what rejects it', () => {
    // This is the #994 follow-up: "JavaScript" is identifier-shaped, so it surfaces
    // here as a candidate; the hook only fires if it's a real symbol in the index.
    expect(extractCodeTokens('I really love JavaScript')).toEqual(['JavaScript']);
    expect(extractCodeTokens('thoughts on GitHub vs GitLab').sort()).toEqual(['GitHub', 'GitLab']);
  });

  it('ordinary prose and doc/data filenames yield no tokens', () => {
    expect(extractCodeTokens('fix typo in readme')).toEqual([]);
    expect(extractCodeTokens('fix the typo in README.md')).toEqual([]);   // doc filename excluded
    expect(extractCodeTokens('bump the version in package.json')).toEqual([]);
    expect(extractCodeTokens('water the flower')).toEqual([]);
  });
});

describe('prompt-hook injection cap (#1694)', () => {
  it('PROMPT_HOOK_INJECTION_MAX stays under Claude Code\'s 10k inline hook-output limit', () => {
    expect(PROMPT_HOOK_INJECTION_MAX).toBe(9000);
    expect(CLAUDE_CODE_INLINE_HOOK_OUTPUT_LIMIT).toBe(10_000);
    expect(PROMPT_HOOK_INJECTION_MAX).toBeLessThan(CLAUDE_CODE_INLINE_HOOK_OUTPUT_LIMIT);
    // Leave headroom for the <codegraph_context> wrapper + projectPath nudge lines.
    expect(CLAUDE_CODE_INLINE_HOOK_OUTPUT_LIMIT - PROMPT_HOOK_INJECTION_MAX).toBeGreaterThanOrEqual(500);
  });

  it('capPromptHookInjection leaves short payloads intact', () => {
    expect(capPromptHookInjection('hello')).toBe('hello');
    expect(capPromptHookInjection('x'.repeat(PROMPT_HOOK_INJECTION_MAX))).toBe('x'.repeat(PROMPT_HOOK_INJECTION_MAX));
  });

  it('capPromptHookInjection truncates oversize payloads with the explore notice', () => {
    const over = 'a'.repeat(PROMPT_HOOK_INJECTION_MAX + 500);
    const out = capPromptHookInjection(over);
    expect(out.length).toBeLessThan(over.length);
    expect(out.startsWith('a'.repeat(PROMPT_HOOK_INJECTION_MAX))).toBe(true);
    expect(out).toContain('…(truncated; call codegraph_explore for the rest)');
    // Capped body alone must still fit under the host inline limit.
    expect(out.length).toBeLessThan(CLAUDE_CODE_INLINE_HOOK_OUTPUT_LIMIT);
  });
});

describe('system task notifications (#1832)', () => {
  it('skips the complete system envelope', () => {
    expect(isTaskNotification('<task-notification>trace AuthService login flow</task-notification>')).toBe(true);
    expect(isTaskNotification(' <task-notification>\n<task-id>abc</task-id>\n<summary>done</summary>\n</task-notification>\n')).toBe(true);
  });
  it('does not suppress a user question that mentions the marker', () => {
    expect(isTaskNotification('Why does <task-notification>trace</task-notification> trigger the hook?')).toBe(false);
    expect(isTaskNotification('<task-notification>trace</task-notification> Explain this.')).toBe(false);
    expect(isTaskNotification('<other-tag>trace AuthService</other-tag>')).toBe(false);
    expect(isTaskNotification('trace AuthService login')).toBe(false);
  });
});

describe('subagent hand-backs (#2184)', () => {
  const handBack = '<agent-message from="a1b2c3">\n[Subagent hand-back] Traced how AuthService.login calls TokenStore.save and which callers are affected.\n</agent-message>';

  it('skips the complete hand-back envelope', () => {
    expect(isAgentMessage(handBack)).toBe(true);
    expect(isAgentMessage(` \n${handBack}\n`)).toBe(true);
    expect(isAgentMessage('<agent-message>trace AuthService login flow</agent-message>')).toBe(true);
  });
  it('does not suppress a user question that mentions the marker', () => {
    expect(isAgentMessage(`Why does ${handBack} trigger the hook?`)).toBe(false);
    expect(isAgentMessage(`${handBack} Explain this.`)).toBe(false);
    expect(isAgentMessage('<agent-messages>trace AuthService</agent-messages>')).toBe(false);
    expect(isAgentMessage('<agent-message from="x">trace AuthService')).toBe(false);
    expect(isAgentMessage('trace AuthService login')).toBe(false);
  });
});
