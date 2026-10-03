/**
 * File-text cache used by LSP positioning and document sync: one read per file while mtime+size
 * are unchanged, revalidation after an edit, and invalidation when the language server stops.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { LspManager, liveLspChildCount } from '../src/lsp/manager';
import { createFakeProject, waitFor, type FakeProject } from './lsp-test-utils';

const FILE_CONTENT = 'export class Widget {\n  render() { return 1; }\n}\n';

const managers: LspManager[] = [];
const projects: FakeProject[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.close().catch(() => undefined);
  }
  for (const project of projects.splice(0)) project.cleanup();
  await waitFor(() => liveLspChildCount() === 0, 5000);
});

function setup(): { manager: LspManager; file: string } {
  const project = createFakeProject({ 'a.ts': FILE_CONTENT });
  projects.push(project);
  const manager = new LspManager(project.root, { idleSweep: false });
  managers.push(manager);
  return { manager, file: path.join(project.root, 'a.ts') };
}

describe('LSP file text cache', () => {
  it('reuses the same read while the file is unchanged', () => {
    const { manager, file } = setup();
    const first = manager.readFileText(file);
    const second = manager.readFileText(file);
    expect(first?.text).toBe(FILE_CONTENT);
    expect(second).toBe(first);
  });

  it('re-reads after the file changes', () => {
    const { manager, file } = setup();
    const first = manager.readFileText(file);
    const updated = `${FILE_CONTENT}// touched\n`;
    fs.writeFileSync(file, updated);
    // Size alone would already differ, but a later mtime keeps the check honest on coarse clocks.
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(file, later, later);

    const second = manager.readFileText(file);
    expect(second).not.toBe(first);
    expect(second?.text).toBe(updated);
  });

  it('returns null for a missing file and drops the cached entry', () => {
    const { manager, file } = setup();
    expect(manager.readFileText(file)?.text).toBe(FILE_CONTENT);
    fs.rmSync(file);
    expect(manager.readFileText(file)).toBeNull();
    fs.writeFileSync(file, FILE_CONTENT);
    expect(manager.readFileText(file)?.text).toBe(FILE_CONTENT);
  });

  it('drops cached text when the language server shuts down', async () => {
    const { manager, file } = setup();
    await manager.definition(file, { line: 0, character: 13 }, 'typescript');
    const first = manager.readFileText(file);
    expect(first?.text).toBe(FILE_CONTENT);

    await manager.shutdownAll();
    const second = manager.readFileText(file);
    expect(second).not.toBe(first);
    expect(second?.text).toBe(FILE_CONTENT);
  });
});
