import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'dist/bin/codegraph.js');
const run = (args: string[]) => execFileSync(process.execPath, [cli, ...args], {
  encoding: 'utf8', windowsHide: true,
  env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_WASM_RELAUNCHED: '1' },
});

describe('个人运行入口', () => {
  it('包元数据指向个人仓库，并禁止误发根包', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.private).toBe(true);
    expect(pkg.repository.url).toBe('git+https://github.com/nk33-dev/codegraph.git');
    expect(pkg.homepage).toContain('nk33-dev/codegraph');
    expect(pkg.bugs.url).toContain('nk33-dev/codegraph/issues');
  });

  it('无需索引即可显示实际入口、产物指纹和安装来源', () => {
    const info = JSON.parse(run(['doctor', '--json']));
    expect(info).toMatchObject({ distribution: 'personal', packageRoot: root, entry: cli, viewerAvailable: true });
    expect(info.build.buildId).toMatch(/^[a-f0-9]{24}$/);
    expect(info.build).toEqual(JSON.parse(fs.readFileSync(path.join(root, 'dist/build-info.json'), 'utf8')));
    expect(info.updateCommand).toContain('github:nk33-dev/codegraph#personal');
  });

  it('个人版强制升级也不会调用官方安装流程', () => {
    const output = run(['upgrade', '--force']);
    expect(output).toContain('github:nk33-dev/codegraph#personal');
    expect(output).toContain('does not install upstream releases');
    expect(output).not.toContain('@colbymchenry/codegraph@latest');
  });

  it('个人配置向导不询问安装官方 CLI，且保留其他 MCP 配置', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-personal-installer-'));
    const configPath = path.join(directory, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(configPath));
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { command: 'keep-me' } } }));
    try {
      const install = () => execFileSync(process.execPath, [cli, 'install', '--target', 'cursor', '--location', 'local'], {
        cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_WASM_RELAUNCHED: '1' },
      });
      expect(install()).toContain('github:nk33-dev/codegraph#personal');
      const first = fs.readFileSync(configPath, 'utf8');
      expect(JSON.parse(first).mcpServers).toMatchObject({ other: { command: 'keep-me' }, codegraph: { command: 'codegraph' } });
      install();
      expect(fs.readFileSync(configPath, 'utf8')).toBe(first);
      expect(fs.existsSync(path.join(directory, '.codegraph'))).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
