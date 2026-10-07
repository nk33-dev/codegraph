import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph, type CodeSymbol, type CodeReference } from '../src';
import { extractFieldContracts } from '../src/graph/field-contracts';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import type { Language, Node } from '../src/types';
import { DatabaseConnection } from '../src/db';
import { runMigrations, CURRENT_SCHEMA_VERSION, getCurrentVersion } from '../src/db/migrations';
import { QueryBuilder } from '../src/db/queries';

const roots: string[] = [];
const graphs: CodeGraph[] = [];
const fixture = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-contracts-')); roots.push(root); return root; };
const write = (root: string, file: string, source: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), source);
};
const open = async (root: string) => { const cg = CodeGraph.initSync(root); graphs.push(cg); await cg.indexAll(); return cg; };

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['rust', 'go', 'python', 'java', 'csharp', 'typescript', 'javascript']);
});
afterEach(() => {
  for (const cg of graphs.splice(0)) cg.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function extract(language: Language, source: string) {
  const owner: Node = { id: 'owner', kind: language === 'rust' || language === 'go' ? 'struct' : 'class',
    name: 'Settings', qualifiedName: 'Settings', filePath: 'source', language,
    startLine: 1, endLine: 100, startColumn: 0, endColumn: 0, updatedAt: 0 };
  return extractFieldContracts('source', source, language, [owner])!;
}

describe('serialization contracts', () => {
  it('keeps boolean type, explicit rename, alias direction, rename_all and skip semantics', () => {
    const result = extract('rust', `#[serde(rename_all = "camelCase")]
pub struct Settings {
  #[serde(rename = "officialMixApiKey", alias = "legacySwitch")]
  pub official_mix_api_key: bool,
  pub user_name: String,
  #[serde(skip)] pub hidden: String,
  #[serde(skip_serializing)] pub input_only: String,
}`);
    expect(result.contracts.filter(row => row.fieldName === 'official_mix_api_key').map(row => [row.externalName, row.direction, row.fieldType]))
      .toEqual([['officialMixApiKey', 'serialize', 'bool'], ['officialMixApiKey', 'deserialize', 'bool'], ['legacySwitch', 'deserialize', 'bool']]);
    expect(result.contracts.some(row => row.externalName === 'userName')).toBe(true);
    expect(result.contracts.some(row => row.fieldName === 'hidden')).toBe(false);
    expect(result.contracts.filter(row => row.fieldName === 'input_only').map(row => row.direction)).toEqual(['deserialize']);
  });

  it('honors different serde names for serialization and deserialization', () => {
    const result = extract('rust', `pub struct Settings {
 #[serde(rename(serialize = "outputKey", deserialize = "inputKey"))] pub key: String,
}`);
    expect(result.contracts.map(row => [row.externalName, row.direction])).toEqual([['outputKey', 'serialize'], ['inputKey', 'deserialize']]);
  });

  it('keeps a key literally named skip and excludes aliases of skipped inputs', () => {
    const rows = extract('rust', `pub struct Settings {
 #[serde(rename="skip")] pub enabled: bool,
 #[serde(skip_deserializing, alias="legacy")] pub output: String,
}`).contracts;
    expect(rows.filter(row => row.fieldName === 'enabled').map(row => row.externalName)).toEqual(['skip', 'skip']);
    expect(rows.some(row => row.externalName === 'legacy')).toBe(false);
  });

  it.each([
    ['go', 'package app\ntype Settings struct { Enabled bool `json:"officialMixApiKey,omitempty"`; Hidden string `json:"-"` }'],
    ['python', 'from pydantic import BaseModel, Field\nclass Settings(BaseModel):\n    enabled: bool = Field(alias="officialMixApiKey")\n'],
    ['java', 'import com.fasterxml.jackson.annotation.JsonProperty;\nclass Settings { @JsonProperty("officialMixApiKey") boolean enabled; }'],
    ['csharp', 'using System.Text.Json.Serialization;\nclass Settings { [JsonPropertyName("officialMixApiKey")] public bool Enabled { get; set; } }'],
  ] as Array<[Language, string]>)('reads explicit %s contracts from syntax', (language, source) => {
    const rows = extract(language, source).contracts;
    expect(rows.map(row => row.externalName)).toEqual(['officialMixApiKey', 'officialMixApiKey']);
    expect(rows[0]?.fieldType).toMatch(/bool|boolean/);
  });

  it('keeps Pydantic validation and serialization aliases separate', () => {
    const rows = extract('python', 'from pydantic import BaseModel, Field\nclass Settings(BaseModel):\n    enabled: bool = Field(validation_alias="input", serialization_alias="output")\n').contracts;
    expect(rows.map(row => [row.externalName, row.direction])).toEqual([['output', 'serialize'], ['input', 'deserialize']]);
  });

  it('does not turn ordinary annotation names or method assignments into model fields', () => {
    expect(extract('java', 'class Settings { @JsonProperty("key") boolean enabled; }').contracts).toEqual([]);
    expect(extract('python', 'from pydantic import Field\nclass Settings:\n    def run(self):\n        local: bool = Field(alias="key")\n').contracts).toEqual([]);
  });

  it('looks up JSON names and preserves ownership when two models share a key', async () => {
    const root = fixture();
    write(root, 'settings.rs', '#[serde(rename_all="camelCase")]\npub struct Settings { pub official_mix_api_key: bool }\n');
    write(root, 'other.rs', '#[serde(rename_all="camelCase")]\npub struct Other { pub official_mix_api_key: String }\n');
    const cg = await open(root);
    const result = cg.queryCode({ mode: 'definitions', query: 'officialMixApiKey' });
    expect(result.items).toHaveLength(2);
    expect(result.ambiguous).toBe(true);
    expect((result.items as CodeSymbol[]).map(item => item.fieldContracts![0]!.fieldType).sort()).toEqual(['String', 'bool']);
    expect(cg.queryCode({ mode: 'definitions', query: 'Settings.officialMixApiKey' }).items).toHaveLength(1);
  });

  it('removes old names after edits and converges with a fresh index', async () => {
    const root = fixture();
    write(root, 'settings.rs', 'pub struct Settings { #[serde(rename="oldKey")] pub enabled: bool }\n');
    const cg = await open(root);
    write(root, 'settings.rs', 'pub struct Settings { #[serde(rename="newKey")] pub enabled: bool }\n');
    await cg.sync();
    expect(cg.queryCode({ mode: 'definitions', query: 'oldKey' }).items).toEqual([]);
    expect(cg.queryCode({ mode: 'definitions', query: 'newKey' }).items).toHaveLength(1);
    const before = cg.getFieldContracts();
    await cg.indexAll();
    expect(cg.getFieldContracts()).toEqual(before);
    fs.unlinkSync(path.join(root, 'settings.rs'));
    await cg.sync();
    expect(cg.getFieldContracts()).toEqual([]);
  });

  it('retains separate owners for same-line models and scopes typed key accesses', async () => {
    const root = fixture();
    write(root, 'settings.rs', 'pub struct First { #[serde(rename="sameKey")] pub first: bool } pub struct Second { #[serde(rename="sameKey")] pub second: String }\n');
    write(root, 'client.ts', 'export function read(settings: Second) { return settings["sameKey"]; }\n');
    const cg = await open(root);
    expect(cg.getFieldContracts().map(contract => [contract.owner, contract.fieldName])).toEqual([
      ['First', 'first'], ['First', 'first'], ['Second', 'second'], ['Second', 'second'],
    ]);
    const result = cg.queryCode({ mode: 'references', query: 'Second.sameKey' }).items as CodeReference[];
    expect(result.some(item => item.source.name === 'read' && item.target.name === 'second')).toBe(true);
    expect(result.some(item => item.target.name === 'first')).toBe(false);
  });
});

describe('registered string calls', () => {
  it('connects an imported Tauri alias to the registered command inside its own app', async () => {
    const root = fixture();
    write(root, 'apps/a/src-tauri/src/lib.rs', 'mod commands;\npub fn setup() { tauri::generate_handler![commands::load_settings]; }\n');
    write(root, 'apps/a/src-tauri/src/commands.rs', '#[tauri::command]\npub fn load_settings() -> bool { true }\n');
    write(root, 'apps/b/src-tauri/src/lib.rs', 'mod commands;\npub fn setup() { tauri::generate_handler![commands::load_settings]; }\n');
    write(root, 'apps/b/src-tauri/src/commands.rs', '#[tauri::command]\npub fn load_settings() -> bool { false }\n');
    write(root, 'apps/a/src/main.ts', 'import { invoke as nativeCall } from "@tauri-apps/api/core";\nconst call = <T,>(command: string) => nativeCall<T>(command);\nexport function click() { return nativeCall<boolean>("load_settings"); }\nexport function wrapped() { return call<boolean>("load_settings"); }\nexport function shadowed(nativeCall: (name: string) => unknown) { return nativeCall("load_settings"); }\n');
    write(root, 'apps/a/src/unrelated.ts', 'function invoke(name: string) { return name; }\nexport function other() { return invoke("load_settings"); }\n');
    const cg = await open(root);
    const calls = cg.queryCode({ mode: 'callees', query: 'click' }).items as CodeReference[];
    expect(calls.some(item => item.target.name === 'load_settings' && item.target.filePath.startsWith('apps/a/'))).toBe(true);
    expect(calls.some(item => item.target.filePath.startsWith('apps/b/'))).toBe(false);
    expect(cg.queryCode({ mode: 'callees', query: 'wrapped' }).items.some(item => (item as CodeReference).target?.name === 'load_settings')).toBe(true);
    expect(cg.queryCode({ mode: 'callees', query: 'shadowed' }).items.some(item => (item as CodeReference).target?.name === 'load_settings')).toBe(false);
    expect(cg.queryCode({ mode: 'callees', query: 'other' }).items.some(item => (item as CodeReference).target?.name === 'load_settings')).toBe(false);
    write(root, 'apps/a/src-tauri/src/lib.rs', 'mod commands;\npub fn setup() {}\n');
    await cg.sync();
    expect(cg.queryCode({ mode: 'callees', query: 'click' }).items.some(item => (item as CodeReference).target?.name === 'load_settings')).toBe(false);
  });

  it('connects wrappers to Rust path arms and limits each route to its own calls', async () => {
    const root = fixture();
    write(root, 'routes.rs', `fn settings_value() -> bool { true }
fn delete_value() -> bool { false }
pub fn handle_bridge_request(path: &str) -> bool {
 match path {
  "/settings/get" => settings_value(),
  "/delete" => delete_value(),
  _ => false,
 }
}
`);
    write(root, 'client.ts', 'function postJson(path: string, payload: unknown) { return window.nativeBridge(path, payload); }\nexport function load() { return postJson("/settings/get", {}); }\nexport function dynamic(path: string) { return postJson(path, {}); }\n');
    const cg = await open(root);
    expect(cg.queryCode({ mode: 'callees', query: 'load' }).items.some(item => (item as CodeReference).target?.name === '/settings/get')).toBe(true);
    const route = cg.queryCode({ mode: 'callees', query: '/settings/get' }).items as CodeReference[];
    expect(route.map(item => item.target.name)).toContain('settings_value');
    expect(route.map(item => item.target.name)).not.toContain('delete_value');
    expect(cg.queryCode({ mode: 'callees', query: 'dynamic' }).items.some(item => (item as CodeReference).target?.kind === 'route')).toBe(false);
  });

  it('recognizes JS switch arms and a called static route map', async () => {
    const root = fixture();
    write(root, 'routes.ts', 'function settings() { return true; }\nexport function dispatch(path: string) { switch(path) { case "/settings/get": return settings(); default: return false; } }\nexport function mapped(path: string) { const handlers = {"/settings/set": settings}; return handlers[path](); }\n');
    write(root, 'client.ts', 'function postJson(path: string, payload: unknown) { return window.nativeBridge(path, payload); }\nexport function get() { return postJson("/settings/get", {}); }\nexport function set() { return postJson("/settings/set", {}); }\n');
    const cg = await open(root);
    expect(cg.queryCode({ mode: 'callees', query: 'get' }).items.some(item => (item as CodeReference).target?.name === '/settings/get')).toBe(true);
    expect(cg.queryCode({ mode: 'callees', query: 'set' }).items.some(item => (item as CodeReference).target?.name === '/settings/set')).toBe(true);
  });
});

it('repairs upstream migrations skipped by the personal schema 13 and preserves file text', () => {
  const root = fixture();
  const db = DatabaseConnection.initialize(path.join(root, 'copy.db'));
  try {
    const connection = db.getDb();
    connection.exec(`DELETE FROM schema_versions WHERE version >= 12;
      INSERT INTO schema_versions VALUES (12, 0, 'Replay the synthesis stage for databases that recorded the fork-owned version 10');
      INSERT INTO schema_versions VALUES (13, 0, 'Add persisted file content for project-wide text search');
      DROP INDEX idx_unresolved_failed_import_tail;
      DROP INDEX idx_unresolved_failed_import_name;
      INSERT INTO file_text VALUES ('kept.md', 'kept', 4, 0, 0);
    `);
    runMigrations(connection, 13);
    expect(connection.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_unresolved_failed_import_tail'").get()).toBeTruthy();
    expect(connection.prepare("SELECT content FROM file_text WHERE path='kept.md'").get()).toEqual({ content: 'kept' });
    expect(connection.prepare('SELECT MAX(version) AS version FROM schema_versions').get()).toEqual({ version: CURRENT_SCHEMA_VERSION });
    runMigrations(connection, CURRENT_SCHEMA_VERSION);
  } finally { db.close(); }
});

it('rolls back an interrupted bridge and resumes without losing failed references', () => {
  const root = fixture();
  const connection = DatabaseConnection.initialize(path.join(root, 'interrupted.db'));
  try {
    const db = connection.getDb();
    const queries = new QueryBuilder(db);
    queries.insertNodes([{ id: 'caller', kind: 'function', name: 'run', qualifiedName: 'run', filePath: 'caller.ts',
      language: 'typescript', startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 0 }]);
    queries.insertUnresolvedRefsBatch([{ fromNodeId: 'caller', referenceName: './later.ts', referenceKind: 'imports', line: 1, column: 0 }]);
    db.exec(`DELETE FROM schema_versions WHERE version >= 12;
      INSERT INTO schema_versions VALUES (12, 0, 'Replay the synthesis stage for databases that recorded the fork-owned version 10');
      INSERT INTO schema_versions VALUES (13, 0, 'Add persisted file content for project-wide text search');
      UPDATE unresolved_refs SET status='failed', name_tail='ts';
      CREATE TRIGGER interrupt_bridge BEFORE UPDATE OF name_tail ON unresolved_refs BEGIN SELECT RAISE(ABORT, 'interrupted bridge'); END;
    `);
    expect(() => runMigrations(db, 13)).toThrow('interrupted bridge');
    expect(getCurrentVersion(db)).toBe(16);
    expect(db.prepare('SELECT name_tail FROM unresolved_refs').get()).toEqual({ name_tail: 'ts' });
    db.exec('DROP TRIGGER interrupt_bridge');
    runMigrations(db, getCurrentVersion(db));
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.prepare('SELECT name_tail FROM unresolved_refs').get()).toEqual({ name_tail: 'later' });
  } finally { connection.close(); }
});
