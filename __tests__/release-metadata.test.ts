import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const script = path.resolve(__dirname, '../scripts/sync-ui-version.mjs');
const roots: string[] = [];

function fixture(engineVersion: string, uiVersion: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-release-metadata-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'ui'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: engineVersion }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'ui', 'package.json'), JSON.stringify({ version: uiVersion }, null, 2) + '\n');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('个人发行版本元数据', () => {
  it('版本一致时只读检查通过', () => {
    const root = fixture('1.2.3-personal.4', '1.2.3-personal.4');
    const result = spawnSync(process.execPath, [script, '--check', '--root', root], {
      encoding: 'utf8', windowsHide: true,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('ui already at 1.2.3-personal.4');
  });

  it('版本不一致时给出修复命令且不改文件', () => {
    const root = fixture('1.2.3-personal.5', '1.2.3-personal.4');
    const ui = path.join(root, 'ui', 'package.json');
    const before = fs.readFileSync(ui, 'utf8');
    const result = spawnSync(process.execPath, [script, '--check', '--root', root], {
      encoding: 'utf8', windowsHide: true,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm run version:sync');
    expect(fs.readFileSync(ui, 'utf8')).toBe(before);
  });

  it('同步命令只更新 UI 版本字段', () => {
    const root = fixture('1.2.3-personal.5', '1.2.3-personal.4');
    const result = spawnSync(process.execPath, [script, '--root', root], {
      encoding: 'utf8', windowsHide: true,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'ui', 'package.json'), 'utf8')).version)
      .toBe('1.2.3-personal.5');
  });
});
