import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clearProjectConfigCache,
  loadApiCorrelationConfig,
  writeApiCorrelationConfig,
} from '../src/project-config';

describe('apiCorrelation project configuration', () => {
  const roots: string[] = [];

  afterEach(() => {
    clearProjectConfigCache();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('defaults to enabled and accepts normalized client/server roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-api-config-'));
    roots.push(root);
    expect(loadApiCorrelationConfig(root)).toEqual({ enabled: true, clientPaths: [], serverPaths: [] });

    writeApiCorrelationConfig(root, {
      enabled: true,
      clientPaths: ['./web/', 'frontend\\app'],
      serverPaths: ['api/'],
    });

    expect(loadApiCorrelationConfig(root)).toEqual({
      enabled: true,
      clientPaths: ['web', 'frontend/app'],
      serverPaths: ['api'],
    });
  });

  it('can explicitly disable correlation without losing other project keys', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-api-config-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ extensions: { '.foo': 'typescript' } }));
    writeApiCorrelationConfig(root, { enabled: false });
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'codegraph.json'), 'utf8')) as Record<string, unknown>;
    expect(raw.extensions).toEqual({ '.foo': 'typescript' });
    expect(loadApiCorrelationConfig(root).enabled).toBe(false);
  });
});
