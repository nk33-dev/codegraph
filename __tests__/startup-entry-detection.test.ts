import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('codegraph_explore startup entry detection', () => {
  const graphs: CodeGraph[] = [];
  const directories: string[] = [];

  afterEach(() => {
    for (const graph of graphs.splice(0)) graph.destroy();
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  async function explore(files: Record<string, string>, query: string): Promise<string> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-startup-entry-'));
    directories.push(directory);
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(directory, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
    }
    const graph = CodeGraph.initSync(directory, {
      config: { include: ['**/*'], exclude: ['node_modules/**'] },
    });
    graphs.push(graph);
    await graph.indexAll();
    const result = await new ToolHandler(graph).execute('codegraph_explore', { query });
    return result.content[0].text;
  }

  it('pins a nested monorepo frontend main file ahead of a component', async () => {
    const output = await explore({
      'packages/frontend/src/main.js': 'export function main() { return App(); }\n',
      'packages/frontend/src/components/AdminDashboard.vue': '<script>export default {};</script>\n',
    }, 'frontend entry');
    expect(output).toContain('packages/frontend/src/main.js');
    expect(output).not.toContain('AdminDashboard');
  });

  it('follows package main and index.html script entries', async () => {
    const output = await explore({
      'packages/app/package.json': '{"main":"src/bootstrap.js"}\n',
      'packages/app/src/bootstrap.js': 'export function bootstrap() {}\n',
      'packages/web/index.html': '<script src="./src/main.ts"></script>\n',
      'packages/web/src/main.ts': 'export function main() {}\n',
    }, 'application entry');
    expect(output).toContain('packages/app/src/bootstrap.js');
    expect(output).toContain('packages/web/src/main.ts');
  });

  it('pins a Spring Boot application class', async () => {
    const output = await explore({
      'service/src/main/java/com/example/Application.java':
        '@SpringBootApplication\npublic class Application { public static void main(String[] args) {} }\n',
    }, 'backend entry');
    expect(output).toContain('service/src/main/java/com/example/Application.java');
  });
});
