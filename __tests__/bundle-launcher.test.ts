import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveGitBash } from './shell-paths';

const windows = process.platform === 'win32';
// Git Bash runs the release recipe; machines without it (or with Git in a
// non-default location) resolve here rather than failing on a hard-coded path.
const bash = resolveGitBash();
const bashExec = bash ?? 'bash';
const bashAvailable = bash !== null;
if (!bashAvailable) {
  console.warn(
    '[bundle-launcher] bash not found (set CODEGRAPH_TEST_BASH or install Git for Windows); ' +
    'skipping the Git Bash launcher execution tests. The launcher recipe is still read and checked below.',
  );
}
const recipe = fs.readFileSync(path.resolve('scripts/build-bundle.sh'), 'utf8');
// Execute the release recipe itself, without downloading Node or rebuilding the UI.
const launcherRecipe = recipe.slice(recipe.indexOf('# 4. Vendored'), recipe.indexOf('# 5. Archive'));
const archiveRecipe = recipe.slice(recipe.indexOf('# 5. Archive'));
const roots: string[] = [];
const env = { ...process.env, CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_PROMPT_HOOK: '1' };

function shell(script: string, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}, input?: string) {
  // A file avoids Windows command-line quoting altering the recipe's printf
  // escapes or our argument fixtures before Bash even reads them.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-shell-'));
  roots.push(root);
  const file = path.join(root, 'test.sh');
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(file, `set -- ${args.map(quote).join(' ')}\n${script}`);
  return spawnSync(bashExec, ['--noprofile', '--norc', file], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true, env: { ...env, ...extraEnv }, input,
  });
}

function stage(osfam = windows ? 'win32' : process.platform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph bundle space '));
  roots.push(root);
  const bundle = path.join(root, `codegraph-${osfam}-x64`);
  fs.mkdirSync(path.join(bundle, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'lib/dist/bin'), { recursive: true });
  const convert = windows ? '$(cygpath -u "$1")' : '$1';
  const node = windows ? '$(cygpath -u "$2")' : '$2';
  const result = shell(`set -eu\nSTAGE="${convert}"\nNODE_BIN="${node}"\nOSFAM="$3"\n${launcherRecipe}`, [bundle, process.execPath, osfam]);
  expect(result.status, result.stderr || String(result.error)).toBe(0);
  return { root, bundle };
}

function invoke(bundle: string, command: string, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}, input?: string) {
  const convert = windows ? '$(cygpath -u "$1")' : '$1';
  // Exclude system Node: execution must use the runtime in the bundle.
  return shell(`STAGE="${convert}"\nshift\nPATH="$STAGE/bin:/usr/bin:/bin"\nexport PATH\n${command}`,
    [bundle, ...args], extraEnv, input);
}

function probe(bundle: string) {
  fs.writeFileSync(path.join(bundle, 'lib/dist/bin/codegraph.js'), `
console.log(JSON.stringify({args: process.argv.slice(2), flags: process.execArgv,
  host: process.env.CODEGRAPH_HOST_PPID, exe: process.execPath}));
process.exit(23);
`);
}

function checkForwarding(bundle: string) {
  probe(bundle);
  const args = ['two words', '', 'quote"value', "single'value", '$literal', '*.ts', 'a&b'];
  const result = invoke(bundle, 'codegraph "$@"', args, { CODEGRAPH_HOST_PPID: '12345' });
  expect(result.status, result.stderr).toBe(23);
  const output = JSON.parse(result.stdout);
  expect(output.args).toEqual(args);
  expect(output.flags).toEqual(['--liftoff-only', '--disable-warning=ExperimentalWarning']);
  expect(output.host).toBe('12345');
  expect(fs.realpathSync(output.exe)).toBe(fs.realpathSync(path.join(bundle, windows ? 'node.exe' : 'node')));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('bundled launchers (#1278)', () => {
  // Never needs a shell: the recipe is read from disk at module load.
  it('ships the launcher + archive recipe in scripts/build-bundle.sh', () => {
    const scriptPath = path.resolve('scripts/build-bundle.sh');
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(launcherRecipe.length).toBeGreaterThan(0);
    expect(archiveRecipe.length).toBeGreaterThan(0);
  });

  it.skipIf(windows || !bashAvailable)('preserves POSIX arguments, exit status, runtime flags and host PID', () => {
    checkForwarding(stage().bundle);
  });

  it.skipIf(!windows || !bashAvailable)('runs from Git Bash in a spaced path and forwards arguments, exit status, flags and host PID', () => {
    checkForwarding(stage().bundle);
  });

  it.skipIf(!windows || !bashAvailable)('runs the real CLI and prompt hook in Git Bash, and keeps cmd and PowerShell working', () => {
    const { bundle } = stage();
    fs.rmSync(path.join(bundle, 'lib/dist'), { recursive: true });
    fs.symlinkSync(path.resolve('dist'), path.join(bundle, 'lib/dist'), 'junction');
    const version = require('../package.json').version;
    const result = invoke(bundle, 'codegraph --version');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(version);
    const hook = invoke(bundle, 'codegraph prompt-hook', [], {}, '{"prompt":"test"}\n');
    expect(hook.status, hook.stderr).toBe(0);
    const bin = path.join(bundle, 'bin');
    for (const [exe, args] of [
      ['cmd.exe', ['/d', '/s', '/c', 'codegraph --version']],
      ['powershell.exe', ['-NoProfile', '-Command', 'codegraph --version']],
    ] as const) {
      const control = spawnSync(exe, [...args], {
        cwd: bin, encoding: 'utf8', timeout: 30_000, windowsHide: true,
        env: {
          ...Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'path')),
          Path: `${bin};${process.env.Path || process.env.PATH}`,
        },
      });
      expect(control.status, control.stderr).toBe(0);
      expect(control.stdout.trim(), exe).toBe(version);
    }
  });

  it.skipIf(windows || !bashAvailable).each(['x64', 'arm64'])('ships both launchers in the Windows %s archive', (arch) => {
    const { root, bundle } = stage('win32');
    const target = `win32-${arch}`;
    if (arch !== 'x64') fs.renameSync(bundle, path.join(root, `codegraph-${target}`));
    const result = shell(`set -eu\nWORK="$1"\nOUT="$1/release"\nOSFAM=win32\nTARGET="$2"\n${archiveRecipe}`, [root, target]);
    expect(result.status, result.stderr).toBe(0);
    const list = spawnSync('unzip', ['-Z1', path.join(root, 'release', `codegraph-${target}.zip`)], { encoding: 'utf8', windowsHide: true });
    expect(list.status, list.stderr).toBe(0);
    const entries = list.stdout.split('\n');
    for (const file of ['bin/codegraph', 'bin/codegraph.cmd', 'node.exe']) {
      expect(entries).toContain(`codegraph-${target}/${file}`);
    }
  });
});
