import { describe, expect, it } from 'vitest';
import { parseNpmPackOutput } from '../scripts/lib/npm-pack-output.mjs';

describe('npm pack 输出解析', () => {
  it('解析纯 JSON 输出', () => {
    expect(parseNpmPackOutput('[{"filename":"codegraph.tgz"}]')[0].filename).toBe('codegraph.tgz');
  });

  it('忽略 prepare 和 Vite 的 ANSI 构建日志', () => {
    const output = [
      '> package prepare',
      '\u001b[36mvite v7.3.6 building...\u001b[39m',
      '[check-ui-build] dist/viewer ok',
      '[',
      '  {"filename":"colbymchenry-codegraph-1.6.0-personal.7.tgz"}',
      ']',
    ].join('\n');
    expect(parseNpmPackOutput(output)[0].filename)
      .toBe('colbymchenry-codegraph-1.6.0-personal.7.tgz');
  });

  it('缺少包元数据时给出明确错误', () => {
    expect(() => parseNpmPackOutput('vite built successfully'))
      .toThrow(/没有可识别的包元数据 JSON/);
  });
});
