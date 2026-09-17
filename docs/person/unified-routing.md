# Phase 3: unified routing, impact analysis and shared services

On the same `codegraph_explore` entry point, this phase puts the phase 1 graph queries and the phase 2 language servers **behind one explainable route**: `backend:"auto"` selects one source and `backend:"both"` merges the two sources; it adds the two graph-native modes `impact` / `tests`; and short-lived CLI processes begin to reuse an already running daemon (sharing the index and LSP services across processes). Graph query, LSP query and the phase 1 API are unchanged in behavior.

## Usage entry point

The same tool and the same command, with two more values each for `mode` and `backend`:

| Capability | Call |
| --- | --- |
| Automatic source selection | `codegraph_explore {mode:"definitions", backend:"auto", query:"Name"}` |
| Two-source merging | `codegraph_explore {mode:"references", backend:"both", query:"Name"}` |
| Change impact | `codegraph_explore {mode:"impact", query:"Name", depth:2}` or `backend:"both"` |
| Related tests | `codegraph_explore {mode:"tests", query:"src/a.ts src/b.ts"}` (or `files:["src/a.ts"]`); indirect candidates require `includeIndirect:true` |
| Service diagnostics | `codegraph_explore {mode:"status", backend:"auto", query:"status"}` |
| Run the CLI through the shared service | `codegraph explore resolveProjectPath --mode definitions --backend lsp` (automatically reused when a daemon exists) |

```sh
codegraph explore resolveProjectPath --mode definitions --backend auto
codegraph explore Widget --mode references --backend both --limit 20
codegraph explore resolveProjectPath --mode impact --depth 3
codegraph explore src/a.ts src/b.ts --mode tests --depth 5
codegraph explore status --mode status --backend auto
```

Library users go through the same entry point: `CodeGraph.queryCodeWithBackend(request)`; `queryCode(request)` is still the synchronous pure graph query.

## Automatic routing rules

`auto` **selects only one source** (merging is `both`'s business: one answer can have only one coordinate system). The decision narrows layer by layer through "mode → language → server availability", and the reason for each step is written into `routing.reason`:

| Case | Choice | Reason (summary) |
| --- | --- | --- |
| `diagnostics` | lsp | the graph index has no diagnostics; when the server is unavailable it returns `unavailable` and does not fall back (there is no graph version to fall back to) |
| `tests` | graph | related tests come from the file dependency graph; a language server has no concept of "test association" |
| `status` | both | gives the index status and the status table for all language families in one go, and **starts no process** |
| A position query (`file` + `line`, definitions/references) | lsp | only a language server resolves a position; the index can only answer by name, so there is no graph fallback (not even for `both`) |
| `impact` | graph | the distance is derived graph-natively; the reason points to `backend:"both"` to also get the server's reference positions |
| The language is not C/C++/TS/JS/Rust/Go/Java/Python | graph | this phase has no corresponding language server |
| The language family is `disabled`, or the executable is not found | graph | the reason and `fallback` give the concrete cause (not configured/not installed/disabled) |
| The server is available | lsp | the semantic results come from the language server |

After `auto` has selected lsp it still falls back: when the server returns `unavailable`/`error`, the graph index is used instead and this is explained on the first line of `warnings`; when the server returns an empty result (`not_found`) while the graph has items, the graph index is used instead and the server's warnings are carried along — **"the server did not answer" and "this thing does not exist" must not be conflated**. A position query is the one exception: it has no graph version, so it is returned as `unavailable`/`not_found` from the server rather than answered by name.

## 关联测试分层

关联测试的 `direct` 表示测试文件自身变化或直接依赖改动文件；`high` 表示三跳内、所有中间模块的反向依赖数不超过 12 的路径；其余为 `indirect`。这是图启发式分类。存在多条路径时先取最高置信度，再取该置信度下的最短距离，并只保留对应前驱；分类不会依赖邻接边枚举顺序。`includeIndirect` 经统一路由传递，CLI、MCP 和库返回同一分类。

## Two-source merging (`both`)

- Both sources are executed; items keep their **original fields unchanged** and gain `origin: "graph" | "lsp"` and `corroborated: boolean`.
- The dedup key is **file + line + name** (excluding column): the graph index stores the declaration start (column 0 of `export function run`), while the language server returns the name range (column 7); using the column in the key would keep the same place from ever merging. The same name on the same line counts as the same place, which is the only equivalence that holds up.
- The same place hit by both sources → the LSP item is kept and marked `corroborated: true`, and `routing.corroborated` gives the total. This is the signal of "two independent sources confirming each other", not a reason to drop the graph item.
- Pagination is applied after both complete source result sets are merged. Source pages are collected in batches of 200, so a non-zero `offset` cannot skip once inside each backend and then skip a second time in the merged list.
- Merged results are uniformly output in **UTF-16 code unit columns** (`coordinates.columnEncoding: "utf-16"`): graph items are converted from UTF-8 byte columns using the current on-disk line text. If the file cannot be read, the byte column is kept and `columnEncoding: "utf-8"` is written **on that item**, instead of letting the caller believe it is UTF-16.
- `sources` gives the number of items each source produced (before merging), with `resolved: "both"`. `diagnostics` is lsp-only, and `both` resolves to lsp (the graph has no diagnostics to merge).

## Impact scope and related tests

Both modes are derived graph-natively, implemented in `src/graph/change-impact.ts`, and the CLI's `impact` / `affected` commands **share the same implementation** with them:

- `impact`: for each matched definition it takes `getImpactRadius`, then derives the distances backwards from the subgraph itself (dependency edges are 1 hop, and a container's `contains` children have the same age as the container), using 0-1 BFS for the shortest path. Items are the full symbol + `distance` + `via` (the edge type pointing to a nearer node, including `lsp_usage`) + `rootId`. **The distance is the number of propagation steps in the graph, not "it will definitely break"**; dynamic calls, reflection and unresolved references have no edge and are therefore invisible. File nodes (files that import the changed symbol) are also in the result, honestly labeled `kind: "file"`.
- `tests`: if the changed file is itself a test it is hit directly (`reason: "changed"`, distance 0); otherwise test files are found layer by layer along `getFileDependents` (`reason: "dependent"`), giving `distance` and the direct dependency `via` on the shortest path. Test file detection uses the project-wide `isTestPath`; when the CLI `--filter` overrides it, a custom check is used. Unindexed changed files and missing dependency edges both produce warnings.
- Depth: `depth` 1–10 (impact defaults to 2, tests to 5), valid only in these two modes.
- The LSP side of impact scope is only **one hop**: the symbol the server reference points to (`distance: 1`, `via: ["lsp_usage"]`); reference positions that cannot be attributed to an index node are counted and warned about, without inventing symbols. `auto` selects graph for impact, and only `both` merges the two into the same result.

## Return contract (new in phase 3)

- `routing`: `requested` (the requested backend), `resolved` (what actually ran: `graph`/`lsp`/`both`), `reason`, `fallback`, `families`, `sources`, `corroborated`, `servedBy` (`in-process` / `shared-daemon`) and `daemonPid`. Explicit `graph`/`lsp` also carry this block, only its contents honestly describe "whatever was requested is what is used".
- `backend` is still the **actual source**: when `auto` resolves to lsp, `backend: "lsp"` (`coordinates` is UTF-16 accordingly); when it resolves to graph, `backend: "graph"`. For `both`, `backend: "both"`.
- New item types: `ImpactItem` (`CodeSymbol` + `distance`/`via`/`rootId`), `AffectedTestItem` (`filePath`/`language`/`distance`/`reason`/`via`), `MergedCodeQueryItem` (`origin`/`corroborated`, plus `columnEncoding` when necessary).
- Validation still prefers to error out: `depth` only in impact/tests, `files` only in tests, `tests` does not accept a single `file`, `tests` + `backend:"lsp"` reports `tests mode is graph-only`, and an unknown backend reports `backend must be "graph", "lsp", "auto", or "both"`.
- When `backend:"both"` is projected onto a single source it drops the arguments that source has no concept of (the graph side drops `line`/`column`/`severity`/`includeDeclaration`, the LSP side drops `checkFiles`/`files`) — this is a necessary condition of "trying both", not silent ignoring.

## Multi-window sharing of the index and LSP services

MCP clients already share the same daemon with each other (one process per project, one SQLite connection, one watcher, one set of language servers). What this phase adds is the **cross-process** half:

- A structured query from `codegraph explore` (`mode != explore`) first tries to reuse the daemon **already running** for that project: read `.codegraph/daemon.pid` → verify the process identity (PIDs are reused by the system, so reading the pidfile is not enough) → verify the version → go through the MCP handshake + `tools/call` and print the structured JSON as-is.
- **Never start a daemon on its own**: if there is none, so be it, and fall back to querying in this process (existing behavior). `routing.servedBy` / `daemonPid` in the result honestly state what produced it.
- Read-only structured queries fall back to this process after any daemon failure (no daemon, version mismatch, handshake failure, timeout, tool error); sharing is only a means of acceleration, not a new query failure point. Structured edits use at-most-once delivery instead: no daemon still falls back locally, but once a live daemon is found, a missing confirmation is reported as uncertain and is never replayed locally.
- Off switch: `CODEGRAPH_SHARED_SERVICE=0|off|false|no` forces this process; the timeout is `CODEGRAPH_SHARED_SERVICE_TIMEOUT_MS` (default 120s).
- Text `mode:explore` does not take part in sharing: its output depends on in-session state (cross-call dedup and so on).

## Code ownership

| Entry point | Responsibility |
| --- | --- |
| `src/graph/code-query.ts` | contract, validation, `routing` defaults, graph queries (including `impact`/`tests` modes), `makeSymbolBuilder`, path normalization |
| `src/graph/change-impact.ts` | impact scope (distance, supporting edges, edge sets) and related-test derivation; shared by the CLI and the query entry point |
| `src/graph/code-query-route.ts` | `decideRoute`, `projectRequest`, `queryCodeRouted`, `mergeItems`/`mergeResults`, language detection and column conversion |
| `src/lsp/code-query-lsp.ts` | LSP path (including the one-hop `impact`) and `assertRoutableMode` |
| `src/mcp/daemon-client.ts` | CLI-side shared service client (discovery, handshake, `tools/call`, timeout, fallback) |
| `src/index.ts` | `queryCodeWithBackend` four-path dispatch, `lspAvailability` (probe only, no startup) |
| `src/mcp/tools.ts` | tool schema (backend/mode/depth/files), `backend` passed through as-is |
| `src/bin/codegraph.ts` | explore's new modes/`--depth`/shared service; `impact`/`affected` reuse the shared implementation |

## Verification

- `__tests__/code-query-routing.test.ts` (22 items): auto decisions and fallback, `both` merge dedup and corroboration, column conversion (multibyte lines, unreadable file), dropped fields on projection, argument validation, status starting no process, MCP pass-through as-is, and "a position query gets no graph fallback" when no server can answer it.
- `__tests__/code-query-impact.test.ts` (13 items): impact distance/supporting edges/pagination, changed/dependent for tests, depth effects, `files` equivalent to query, unindexed warning, CLI/MCP/library consistency, CLI `impact`/`affected` consistent with the shared implementation.
- `__tests__/cli-shared-service.test.ts` (3 items): real daemon + real MCP client + two independent CLI processes → the fake language server is `initialize`d only once (cross-process reuse); with `CODEGRAPH_SHARED_SERVICE=0` it falls back to this process and starts its own; with no daemon it does not start one.
- Regressions: `code-query.test.ts`, `lsp-*.test.ts`, `cli-definition-grouping.test.ts`, `cli-affected-*.test.ts`, `no-silent-fuzzy-symbol.test.ts`, `status-json.test.ts`, `daemon-*.test.ts` and `mcp-daemon.test.ts` all pass.

Measured here (Windows, this machine, final run of this phase):

| Run | Result |
| --- | --- |
| The 13 phase-1/2/3 suites together | `Test Files 13 passed` · `Tests 143 passed` |
| Full suite (`vitest run`) | `Test Files 18 failed \| 236 passed \| 22 skipped` · `Tests 42 failed \| 4436 passed \| 233 skipped` · 1 unhandled worker-exit error |

**No failure in the full run belongs to this phase's suites.** The 42 are the categories the phase-2 record already listed — `fs.rmSync` `EPERM` on temp dirs, writer-lock treating pid 1 as a live foreign process, the `codegraph_callers` grouping text, Steps/effects, the `ui-server-api` 100 ms budget, explore factory-closure/oversize allocation — plus E2E resolution flakes (`react-native-bridge`, `object-literal-methods`, `nextjs`) that flip between runs. The phase-2 record was `Test Files 20 failed | 231 passed` · `Tests 44 failed | 4396 passed`; the differences between runs are run-to-run flakiness, not this phase (three tests that failed in the first full run of this phase — including the new shared-service one, whose daemon identity probe was too short at 1s — pass in the final one, and none that passed in the first fails in the final).

## Limitations and known deviations

- `auto` does not merge results; only `both` merges. "Merging but running only one source" does not exist.
- The merge equivalence is "same line + same name", so two same-named siblings on one line (very rare overloads) may be treated as one place — a deliberately conservative equivalence, preferring to under-merge rather than fake corroboration.
- Column conversion reads the **current on-disk** line text; when the graph index position is stale (the file has changed), the conversion result corresponds to the disk rather than the index, and the `freshness` field still marks it as stale.
- The `impact` distance is the number of propagation steps in the graph; `tests` relies on file dependency edges and misses tests when edges are missing. Neither carries the semantics of "it will definitely break / definitely fail".
- The shared service takes effect only when a daemon **already exists**; this phase provides no switch for "the CLI conveniently brings up a daemon".
- The shared service covers structured queries only; the text output of `mode:explore` is still produced in this process.
