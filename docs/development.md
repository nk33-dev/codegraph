# CodeGraph development reference

Read only the sections relevant to the module you are changing; there is no need to read the whole file every time. Migrated here from the technical notes in the former root AGENTS.md; code paths in this document are relative to the repository root. The current implementation follows the source, and personal branch and release rules follow the [maintenance process](person/maintenance.md).

## Build, Test, Run

```bash
npm run build           # tsc + copy schema.sql and *.wasm + build the viewer into dist/; chmods dist/bin/codegraph.js
npm run build:lib       # the viewer's components as @colbymchenry/codegraph-ui (ui/dist) — NOT part of `build`
npm run dev             # tsc --watch
npm run clean           # rm -rf dist

npm test                # vitest run (all)
npm run test:watch
npm run test:eval       # only __tests__/evaluation/
npm run eval            # build then run __tests__/evaluation/runner.ts via tsx

npm run cli             # build then run the local dist binary

# Single test file / pattern
npx vitest run __tests__/installer-targets.test.ts
npx vitest run __tests__/extraction.test.ts -t "TypeScript"
```

`copy-assets` (called from `build`) copies `src/db/schema.sql` and all `src/extraction/wasm/*.wasm` files into `dist/`. **Any new SQL or grammar wasm must be copied or it won't ship.**

One other build step writes into `dist/` and is subject to the same rule: `build:ui` builds the
browser viewer into `dist/viewer/` (never `dist/ui/` — that's the terminal ui).
`scripts/check-ui-build.mjs` asserts both `dist/viewer/` and the copied grammars in
`dist/extraction/wasm/` after every build and inside every release archive — the viewer's syntax
highlighting reads a file with the same grammar the engine indexed it with, so a missing wasm is an
unhighlighted screen as well as an extraction gap.

`npm run build:lib` is separate and does NOT run as part of `npm run build`: it compiles the same
`ui/src` tree a second way, with `svelte-package`, into `ui/dist` — the `@colbymchenry/codegraph-ui`
component library the Pro app imports (task CG-61). `scripts/check-ui-package.mjs` then prunes the
standalone app's shell out of it, resolves the extensionless import specifiers `svelte-package`
leaves behind, and asserts the seam: nothing outside `lib/adapter.js` may reach the network. The
package is **prepared, not published** — `ui/package.json` carries `"private": true` deliberately,
and `scripts/pack-npm.sh` only packs a tarball when `CODEGRAPH_PACK_UI=1`.

Tests run as **two vitest projects** (`vitest.workspace.mts`): `engine` (node) and `ui` (jsdom, the
Svelte plugin, `resolve.conditions: ['browser']`) for the single `__tests__/ui-package.test.ts`.
`npm test` still runs both. The split is not cosmetic — `browser` is a package-resolution
condition, and applied globally it hands the engine's suites the browser builds of
`web-tree-sitter` and friends. The root config (`vitest.config.mts`, `.mts` because the plugin is
ESM-only and the repo is CJS) is the shared base; note that a workspace project **concatenates**
the base's `include` with its own, which is why the `ui` project does not `extends` it.

Node engines: `>=20.0.0 <25.0.0`. There is a hard exit on Node 25.x and below 20 (see `src/bin/node-version-check.ts`).

## Architecture

### Layered pipeline

```
files → ExtractionOrchestrator (tree-sitter) → DB (nodes/edges/files)
              ↓
       ReferenceResolver (imports, name-matching, framework patterns)
              ↓
       GraphQueryManager / GraphTraverser (callers, callees, impact)
              ↓
       ContextBuilder (markdown/JSON for AI consumption)
```

The public API surface is `src/index.ts` — the `CodeGraph` class wires all the layers and re-exports types. Library users only touch this file; the MCP server and CLI also drive it.

### Module layout

- `src/index.ts` — `CodeGraph` class: `init`/`open`/`close`, `indexAll`, `sync`, `searchNodes`, `getCallers`/`getCallees`, `getImpactRadius`, `buildContext`, `watch`/`unwatch`.
- `src/db/` — `DatabaseConnection`, `QueryBuilder` (prepared statements), `schema.sql`, `sqlite-adapter.ts`. Backed by Node's built-in **`node:sqlite`** (`DatabaseSync`) — real SQLite with WAL + FTS5, exposed through a thin better-sqlite3-shaped adapter. The bundled runtime always ships Node ≥22.5, so `node:sqlite` is always available: **no native build step and no wasm fallback**. (Running from source needs Node ≥22.5.) `codegraph status` reports the live backend (`node-sqlite`, the sole backend).
- `src/extraction/` — `ExtractionOrchestrator`, tree-sitter wrappers, per-language extractors under `languages/` (one file per language), plus standalone extractors for non-tree-sitter formats (`svelte-extractor.ts`, `vue-extractor.ts`, `liquid-extractor.ts`, `dfm-extractor.ts` for Delphi). `parse-worker.ts` runs heavy parsing off the main thread.
- `src/resolution/` — `ReferenceResolver` orchestrates `import-resolver.ts` (with `path-aliases.ts` for tsconfig path aliases + cargo workspace member globs), `name-matcher.ts`, and `frameworks/` (Express, Laravel, Rails, FastAPI, Django, Flask, Spring, Gin, Axum, ASP.NET, Vapor, React Router, Next.js — `nextjs.ts`: pages and `route.ts` handlers from files, `router.push` / `redirect` / `NextResponse.redirect` as `navigates` edges, with `next-router-synthesizer.ts` for `<Link href>` — Expo Router, SvelteKit, Vue/Nuxt, Cargo workspaces). Frameworks emit `route` nodes and `references` edges. `callback-synthesizer.ts` holds the whole-graph synthesis passes (`SYNTH_PASSES`, merged in registry order — first-seen wins a duplicate pair) with the language gates; `tier-synthesizer.ts` is the cross-tier pass (a client's literal `fetch`/`axios` path onto its own route, a queue job onto its consumer, a bus / socket event onto its handler — `channel`, `tier`, `registeredAt` on every edge; registered before the in-process emitter pass so its more specific edge wins); `synth-utils.ts` has the helpers they share (`enclosingFn`, `enclosingValue`, `makeLineAt`). Express's `postExtract` composes `app.use('/prefix', router)` mounts onto a mounted file's route names, idempotently (the original path stays in `qualifiedName`).
- `src/graph/` — `GraphTraverser` (BFS/DFS, impact radius, path finding) and `GraphQueryManager` (high-level queries), plus the shared query-time derivations more than one surface renders: `named-symbol-flow.ts` (the one path finder, behind `codegraph_explore`'s Flow section and the viewer's Flow strip), `dynamic-boundary-report.ts` (where the graph stops), `type-hierarchy.ts` (ancestors/subtypes and the implementation count explore prints and the viewer draws),
  `dead-code.ts` (unreferenced symbols, and every reason a candidate is NOT claimed). A derivation that two callers render must live here, not in `ToolHandler` — two derivations eventually disagree.
- `src/context/` — `ContextBuilder` + formatter for markdown/JSON output.
- `src/search/` — full-text query parser and helpers for FTS5.
- `src/sync/` — `FileWatcher` (native FSEvents/inotify/RDCW) with debounce + filter, and git-hook helpers.
- `src/mcp/` — MCP server (`MCPServer`, `tools.ts`, `transport.ts`). `server-instructions.ts` is what the server returns in the MCP `initialize` response — keep it in sync with the user-facing tool guidance.
- `src/lsp/` — language-server integration (personal phase 2): `protocol.ts` (stdio framing + JSON-RPC + answering server→client requests), `servers.ts` (language-family registry and executable discovery), `config.ts` (`.codegraph/lsp.json` plus `CODEGRAPH_LSP_*` env overrides; the default idle-exit timeout comes from the active resource profile), `manager.ts` (one manager per project: lazy start, reuse, idle exit, document sync, diagnostics cache; phase 4 adds the `rename` request and `normalizeWorkspaceEdit`; the resource-governance phase adds the per-project soft cap and the cooperative global-budget sweep), `lease-registry.ts` (cross-daemon LSP leases under `~/.codegraph/lsp-leases/`: pid identity + heartbeat, stale-record self-healing; see [person/resource-governance.md](person/resource-governance.md)), `code-query-lsp.ts` (maps onto the unified contract in `src/graph/code-query.ts`, and owns `symbolNamePosition`, shared with rename). CLI/MCP reach it only through `CodeGraph.queryCodeWithBackend` / `CodeGraph.editCode`; the `backend:"lsp"` dispatch and the edit path stay on the main thread and never go through the `query-pool` workers.
- `src/resource-profile.ts` / `src/resource-metrics.ts` — the resource-governance layer (`CODEGRAPH_RESOURCE_PROFILE`, pool/LSP budgets, in-process counters, the `.codegraph/resource-metrics.json` snapshot `codegraph status` reads). Policy lives in the profile module, mechanism in the consumers; resource derivations are shared, not re-implemented per surface.
- `src/edits/` — structured editing: `contract.ts` (request/result contract, preview hash and operation ID), `text-edits.ts` (UTF-16 edit engine), `target.ts` (index target + freshness), `graph-edit.ts` and `lsp-rename.ts` (planning), `transaction.ts` (same-filesystem staging, persistent manifest, commit/rollback/replay/recovery), `service.ts` (single orchestration and index refresh). `CodeGraph.editCode` is the library entry point; MCP/CLI are faces over it. See [structured edits](person/structured-edits.md) and [edit transactions](person/edit-transactions.md).
- `src/installer/` — see below.
- `src/bin/codegraph.ts` — CLI (commander). Subcommands: `install`, `init`, `uninit`, `index`, `sync`, `status`, `query`, `explore`, `edit`, `files`, `context`, `affected`, `serve --mcp`.
- `src/ui/` — terminal UI (shimmer progress, worker).
- `src/ui-server/` -- read-only JSON API for the `codegraph ui` browser viewer (`api/`: `node`, `flow`, `map`, `screens`, `steps`, `deadcode`, `trails`, `program`, ...) plus static server; Svelte viewer lives in `ui/` (see `docs/design/codegraph-ui-design-spec.md`). `screens`/`steps`/`program` share one fold (`via`/`when` via `graph/branch-guards.ts`); `api/effects.ts` curates calls that leave the index; `api/route-roots.ts` names where a route's code starts. Derivations rendered by more than one surface belong in `src/graph/`, not `ToolHandler`.

### NodeKind / EdgeKind

Defined in `src/types.ts`. Both extractors and resolvers must use these exact strings.

- **NodeKind**: `file`, `module`, `class`, `struct`, `interface`, `trait`, `protocol`, `function`, `method`, `property`, `field`, `variable`, `constant`, `enum`, `enum_member`, `type_alias`, `namespace`, `parameter`, `import`, `export`, `route`, `component`, `union`.
- **EdgeKind**: `contains`, `calls`, `imports`, `exports`, `extends`, `implements`, `references`, `type_of`, `returns`, `instantiates`, `overrides`, `decorates`.

### Multi-agent installer

`src/installer/` is the entry point for `codegraph install` (and the bare `codegraph`/`npx @colbymchenry/codegraph` invocation). Architecture:

- `targets/registry.ts` lists every supported agent.
- `targets/types.ts` defines the `AgentTarget` interface — adding a 5th agent (Continue, Zed, Windsurf…) is **one new file in `targets/` + one entry in `registry.ts`**. Each target owns its config-file location and MCP-server JSON/TOML/JSONC writing. (Targets no longer write an instructions file — see below.)
- Current targets: `claude.ts`, `cursor.ts`, `codex.ts`, `opencode.ts`.
- `targets/toml.ts` is a hand-rolled TOML serializer scoped to `[mcp_servers.codegraph]` (used by Codex). Sibling tables and `[[array_of_tables]]` are preserved verbatim. No new dependency.
- opencode reads `opencode.jsonc` by default; the installer prefers existing `.jsonc`, falls back to `.json`, and creates `.jsonc` for greenfield installs. Edits are surgical via `jsonc-parser` so user comments and formatting survive install/re-install/uninstall round-trips. The MCP entry is OpenCode 2's native `mcp.servers.codegraph` with `disabled: false` and `codemode: false` (so `codegraph_explore` stays on the native tool list); a pre-#1698 `mcp.codegraph` + `enabled` entry is migrated on re-install and removed by uninstall.
- `instructions-template.ts` no longer holds an instructions body — it exports only the `<!-- CODEGRAPH_START -->`/`<!-- CODEGRAPH_END -->` markers. The installer **stopped writing** a `## CodeGraph` block into each agent's instructions file (`CLAUDE.md` / `~/.codex/AGENTS.md` / `~/.config/opencode/AGENTS.md` / `~/.gemini/GEMINI.md` / `.cursor/rules/codegraph.mdc` / Kiro steering doc) because it duplicated the MCP `initialize` instructions verbatim (issue #529). Each target's `install` (self-heal on upgrade) and `uninstall` use the markers to **strip** a block a previous install left behind. `server-instructions.ts` is the single source of truth for agent-facing guidance.
- All installer changes need matching coverage in `__tests__/installer-targets.test.ts` — there are ~47 parameterized contract tests covering install idempotency, sibling preservation, uninstall reverses install, byte-equal re-runs returning `unchanged`, and partial-state recovery for Codex.

### Cursor MCP working-directory quirk

Cursor launches MCP subprocesses with the wrong cwd and doesn't pass `rootUri` in `initialize`. The installer injects `--path` into Cursor's MCP args — absolute path for local installs, `${workspaceFolder}` for global installs. If you touch Cursor wiring, preserve this.

### MCP server instructions

`src/mcp/server-instructions.ts` is sent back to the agent in the MCP `initialize` response. This is the *first* thing every agent sees about how to use the tools, and as of issue #529 it is the **single source of truth** for agent-facing tool guidance — the installer no longer writes a duplicate `## CodeGraph` instructions block into `CLAUDE.md` / `AGENTS.md` / `.cursor/rules/codegraph.mdc`. Edit tool guidance here and nowhere else.

## Tests and platforms

Tests live in `__tests__/` and mirror the module they cover. Notable ones beyond the obvious:

- `installer-targets.test.ts` — parameterized contract suite across all 4 agent targets (see installer notes above).
- `evaluation/` — `runner.ts` + `test-cases.ts` exercise codegraph against synthetic projects and score the results; run via `npm run eval` (builds first). Not part of `npm test`.
- `sqlite-backend.test.ts` / `node-sqlite-backend.test.ts` — pin that `node:sqlite` is the sole backend: `getBackend()` reports `node-sqlite` and the DB comes up in WAL.
- `pr19-improvements.test.ts`, `frameworks-integration.test.ts` — regression coverage for specific past PRs/incidents; don't rename these, the names anchor to git history.

Tests create temp dirs with `fs.mkdtempSync` and clean up in `afterEach`. They write real files and exercise real SQLite — there is no DB mocking.

Timing assertions go through `perfBudget` / `expectWithinBudget` (`__tests__/perf-utils.ts`): the strict millisecond budget only applies in the serial perf project (`npm run test:perf`, which sets `CODEGRAPH_PERF_ASSERT=1` and runs with a single fork); the normal `npm test` run relaxes those budgets so a loaded 4-worker run can't decide the result. Put a new timing-sensitive suite in the `PERF_SUITES` list in `vitest.workspace.mts`.

CI gate: `.github/workflows/ci.yml` runs `npm ci && npm run build && npm test` on Windows, Ubuntu and macOS, with four Vitest file workers on each platform. Windows was temporarily serialized after indexing timeouts caused SQLite cleanup failures; it now uses the same concurrency after repairing fixture ownership, cancellation/draining and database-worker exit handling. Source-based indexing does not start compiled parse workers when their scripts are absent; do not infer oversubscription from the file-worker count alone. Affected indexing suites use `__tests__/indexed-project.ts` to abort and await pending work before closing SQLite and removing their directories. Real language servers, native-kernel builds, packaged-install checks and daemon recovery/soak run in `.github/workflows/hardening.yml` on a schedule or manual dispatch. Energy measurements remain manual because shared runners are not comparable.

### Windows-gated tests

Behavior that differs by platform (path resolution, drive letters, `SENSITIVE_PATHS`, `%APPDATA%` config dirs, CRLF) must be gated, not assumed. Use `it.runIf(process.platform === 'win32')(...)` for Windows-only assertions and `it.runIf(process.platform !== 'win32')(...)` for POSIX-only ones — e.g. `/etc` is sensitive on POSIX but resolves to `C:\etc` (non-existent) on Windows, so an ungated `/etc` assertion fails on Windows. Validate the Windows side for real (see below); don't merge a Windows-gated test you haven't seen run.

Confirm the actual platform before running anything; do not assume this machine is the upstream maintainer's macOS, and do not rely on their private Parallels/SSH setup.

### Linux (Docker)

With no Linux test machine available, you can validate in a container if Docker is installed locally:

- `FROM node:22-bookworm`; `COPY` the repo with a `.dockerignore` excluding `node_modules`/`dist`/`.git`/`.codegraph`; `RUN npm ci && npm run build`. Don't reuse the Mac `node_modules` — `esbuild`/`rollup` ship platform-specific binaries.
- Run with **`docker run --rm --init`**. The `--init` is load-bearing for any process-lifecycle test (daemon reaping, the #277 PPID watchdog, idle-timeout): without a zombie-reaping PID 1, a SIGKILL'd/exited process lingers as a zombie and `process.kill(pid, 0)` still reports it *alive*, so exit-detection assertions false-fail even though the process did exit.
- Linux is where the inotify watch budget actually bites: count a process's watches via `/proc/<pid>/fdinfo/*` (sum `^inotify ` lines on the fd whose `readlink` is `anon_inode:inotify`).

### Windows

Validate paths, permissions, named pipes, file locks, and process exit on a real Windows environment. Install dependencies on that platform with `npm ci`; do not reuse a macOS/Linux `node_modules`. Refresh PATH when needed under SSH; do not assume the upstream maintainer's VM, accounts, or architecture exist.

测试和运行时代码启动控制台子进程时必须传 `windowsHide: true`，否则从 Codex 等 GUI 宿主运行全量测试会反复闪现 `cmd`/conhost 窗口。`__tests__/windows-child-process.test.ts` 对测试源码执行 AST 检查，覆盖静态导入、`require()` 和动态 `import()`。

Upstream has recorded failures such as symlink permissions and MCP subprocesses holding SQLite/cwd and causing `EPERM` during cleanup. When you hit one, reproduce it on the current upstream baseline first; do not treat a historical record as a waiver for a current failure.

## Installer and documentation changes

- Installer changes also add contract tests and a CHANGELOG entry, preserving other user configuration and comments and keeping repeated installs idempotent.
- When changing a README image, update the URL's `?v=N` as well so caches do not show the old image.
- When handling an external report, check the date, the released version, the upstream merge commit, and the current working branch; a fix in the source does not mean the version users installed is fixed.
