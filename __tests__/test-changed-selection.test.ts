import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

let root = '';
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

describe('affected test selection', () => {
  it('keeps imported tests and runs normal projects once without the strict perf project', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-test-selection-'));
    for (const dir of ['scripts', '__tests__', 'node_modules/vitest']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../scripts/test-changed.mjs'), path.join(root, 'scripts/test-changed.mjs'));
    fs.writeFileSync(path.join(root, '__tests__/matched.test.ts'), "import type { Service } from '../src/service';\n");
    fs.writeFileSync(path.join(root, '__tests__/unrelated.test.ts'), "import '../src/other';\n");
    fs.writeFileSync(path.join(root, 'node_modules/vitest/vitest.mjs'),
      "import fs from 'node:fs'; fs.writeFileSync('received.json', JSON.stringify(process.argv.slice(2)));\n");
    const output = execFileSync(process.execPath, ['scripts/test-changed.mjs', 'src/service.ts'], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    expect(output).toContain('__tests__/matched.test.ts');
    expect(output).not.toContain('__tests__/unrelated.test.ts');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'received.json'), 'utf8'))).toEqual([
      'run', '__tests__/matched.test.ts', '--project', 'engine', '--project', 'ui',
    ]);
  });
});
