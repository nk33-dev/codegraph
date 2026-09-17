# Phase 4: structured editing

This phase adds the write side of the toolset: **rename a symbol, replace a symbol's body, insert code before or after a symbol**. All three are one flow — resolve a target through the index, plan every file's edit, show a preview, and only then write — and that flow is reachable from the library (`CodeGraph.editCode`), from MCP (`codegraph_edit`) and from the CLI (`codegraph edit`).

Three decisions shape the phase:

- **A preview is the default.** Nothing is written unless the request says `apply: true`; `previewHash` binds content consistency, while `operationId` makes apply and retry idempotent.
- **`rename` is the language server's job.** It is a real `textDocument/rename` WorkspaceEdit, so it reaches every file the server knows about. With no usable server the answer is `status: "unavailable"` — a textual rename would rewrite strings, comments and same-named locals, and a wrong write is not something a caller can ignore.
- **The other three are graph-native.** They are textual at a range the index already knows, so they work in every indexed language without a server.

There was no pre-existing edit flow to reuse: this phase establishes `src/edits/` as that single flow (the way `src/graph/code-query.ts` is the single query contract), so the CLI, MCP and library cannot drift apart.

## Usage entry point

| Capability | Call |
| --- | --- |
| Preview a body replacement | `codegraph_edit {operation:"replace-body", symbol:"run", file:"src/a.ts", content:"export function run() { return 42; }"}` |
| Apply it, bound to the preview read | `... , apply:true, expectPreviewHash:"<hash>", operationId:"<id from preview>"` |
| Apply it directly (one call, nothing bound) | `... , apply:true` |
| Insert before/after a symbol | `codegraph_edit {operation:"insert-after", symbol:"View", file:"view.js", content:"export function helper() {}"}` |
| Rename (whole project) | `codegraph_edit {operation:"rename", symbol:"Widget", file:"a.ts", newName:"Gadget"}` |
| Rename from a position | `codegraph_edit {operation:"rename", file:"a.ts", line:1, column:13, newName:"Gadget"}` |

```sh
codegraph edit run --operation replace-body --file src/a.ts --content-file new-body.ts
codegraph edit run --operation replace-body --file src/a.ts --content-file new-body.ts --apply
codegraph edit Widget --operation rename --file a.ts --new-name Gadget --apply
codegraph edit View --operation insert-after --file view.js --content 'export function helper() {}' --apply
```

The CLI prints the same JSON the MCP tool returns and exits non-zero for every status other than `preview`/`applied`. Like a structured query, it prefers an already-running daemon and never starts one itself. It does not silently switch execution paths after a daemon fails to confirm the call: retry with the same operation ID so the persisted terminal result is returned without another write.

Library users call `CodeGraph.editCode(request)`; `queryCode`/`queryCodeWithBackend` are unchanged.

## Request contract

| Field | Meaning |
| --- | --- |
| `operation` | `rename`, `replace-body`, `insert-before`, `insert-after` |
| `symbol` | The target name or qualified name, resolved through the index (an exact-match lookup, never a text scan) |
| `file` | An exact project-relative path; pins an ambiguous name. Optional: a name that matches exactly one indexed definition resolves without it |
| `line` / `column` | `rename` only: a position target (1-based line, 0-based UTF-16 column) instead of a name |
| `newName` | `rename` only, no whitespace |
| `content` | `replace-body`/`insert-*` only |
| `apply` | `false` (default) = preview only. `true` replans and writes in the same call; the two IDs below are optional |
| `expectPreviewHash` | `apply: true` only, optional: bind the write to a specific preview and refuse on mismatch |
| `operationId` | Optional idempotency key; preview supplies one, while direct apply derives a default from request identity |

An argument that does not belong to the operation is an error, not something ignored: `content` on a rename, `newName` on a body replacement, `line` on an insert, or `expectPreviewHash` without `apply` all fail outright.

A bare `apply: true` re-plans against the current index and re-verifies every target file against the current bytes before staging. It does not bind the write to a previously reviewed preview. Callers that require review-to-write identity must pass `expectPreviewHash` and reuse `operationId`.

## Result contract

`status` is one of `preview`, `applied`, `not_found`, `ambiguous`, `stale`, `conflict`, `unavailable`, `rejected`, `not_indexed`, `error`. `preview` and `applied` are successes; the rest say why nothing (or only part of something) was written:

- `not_found` — no indexed definition matches the name;
- `ambiguous` — the name matches several definitions; the message lists them, pass `file` (or a qualified name) to pin one;
- `stale` — the file's index row no longer matches the bytes on disk, so the recorded position cannot be trusted (run `codegraph sync`, then query again);
- `conflict` — the file changed between the preview and the write, the preview hash did not match, or a planned create/rename destination already exists;
- `unavailable` — `rename` without a usable language server (not installed, not configured, disabled, or the server has no `renameProvider`), or a server that returned no edits for this symbol;
- `rejected` — refused on safety grounds: a path outside the project root, a workspace edit that is not a file edit, a delete-plus-edit for one file, an edit kind the client does not understand;
- `error` — a real failure (I/O, protocol, timeout).

Other fields:

- `target`: the resolved symbol (`source: "index"` for the graph-native operations, `"lsp"` for rename), its file, range, kind, language, node ID and `freshness`. For `replace-body` the range is the range actually replaced (see below); for the other operations it is the definition's range.
- `files[]`: per file — `operation` (`modify`/`create`/`rename`/`delete`), `baseHash` (sha256 of the content the plan was computed from; null for a create), `resultHash`, `edits[]` (1-based lines, 0-based UTF-16 columns, `oldText`/`newText`), `preview[]` (context/remove/add/gap lines, capped at 200 per file with `previewTruncated`), `additions`/`deletions` and, for a file rename, `movedTo`.
- `summary`: files, edits, additions, deletions and whether any preview was truncated.
- `previewHash`: a stable hash of the planned change — no randomness, so a preview taken by the CLI and one taken by the daemon agree. Hand it back with `apply: true` to make the write refuse if anything moved on.
- `operationId`: stable request identity. A terminal operation is replayed from disk; reusing the ID for different request content returns `conflict`.
- `routing`: which source planned the change (`index`/`lsp`) and, for rename, whether a language server was requested, could be used, and which family.
- `canApply` / `blockers`: 预览是否已通过当前已知安全门槛，以及阻止 apply 的结构化原因；调用方不需要从英文 `warnings` 中解析“apply will be refused”。
- `applied`: present after commit or rollback — operation ID, replay flag, transaction state, paths committed, index status, and each file's committed/restored/manual-recovery state.
- `warnings`: the honest notes, including "Nothing was written: this is a preview", a server that returned no rename edits, a workspace edit touching several files, and the fragment-kind note below.

The MCP tool sets `isError` for every status other than `preview`/`applied`: a refusal is not a successful answer for a write, and an agent must not read "the edit did not happen" as if it had.

## Operation semantics

- **`replace-body`** replaces the definition's range with `content`, trimmed (the indentation before the declaration and the line break after it stay in the file). The **declaration modifiers on the same line are included**: the TypeScript extractor's node for `export function run()` starts at `function`, so replacing the node alone would produce `export export function …`. The scan is over a run of pure modifiers (`export`, `default`, `declare`, `async`, `static`, `pub`, `public`, …) and stops at anything else, so a comment or an attribute stays outside the replaced range. For node kinds whose indexed range is only a fragment of the declaration (`variable`, `constant`, `property`, `field`, `parameter` — e.g. a TS `const` node covers `NAME = value` and not the surrounding keywords), a warning says so and `files[].edits` shows exactly what is replaced.
- **`insert-before`** inserts at the start of the declaration's line when only whitespace precedes the declaration (so the declaration keeps its own indentation — the caller's text must carry its own), otherwise immediately before the declaration's first character. The inserted text always ends with a line break.
- **`insert-after`** inserts at the start of the line following the definition. When the definition ends without a line break (end of file) one is added, and an existing blank separator line is kept before the new code.
- **`rename`** asks the server for `textDocument/rename` at the symbol's name position (found on the declaration line, because a server returns nothing for a rename at `pub`/`int`/`export`), then flattens the returned WorkspaceEdit: `changes` plus the ordered `documentChanges` (text-document edits, and `create`/`rename`/`delete` file operations). Every target must be inside the project root; a `documentChanges` kind the client does not understand refuses the **whole** rename before anything is written; a delete-plus-edit for one file is refused as ambiguous. Inserted text takes the file's own line ending (a CRLF file stays CRLF).
- Root containment is symlink-aware for existing files and for not-yet-created destinations: a path below an in-project link whose real parent is outside the project is rejected before preview or write.

## Writing

1. Every file is re-read and compared with the preview, then its result and original backup are written under `.codegraph/edit-transactions/<operationId>/`.
2. Cross-volume targets, symbolic-link targets, duplicate destinations and destinations that appeared after preview are refused before source changes.
3. Files commit one by one from the same-filesystem staging area. A later failure restores earlier files in reverse order; an incomplete rollback retains backups and returns a per-file recovery action.
4. The manifest records each commit boundary. Startup rolls back interrupted staging/commit states; a fully committed edit interrupted during index refresh is kept and re-indexed.
5. The index is refreshed and live language servers receive supported file notifications. Unsupported servers still have old documents closed explicitly.
6. Refresh means symbols and call edges are both current: `indexFiles()` preloads the edited files' grammars, then the edit service resolves references introduced by those files. The resolution step remains separate from `indexFiles()` so recovery tests can still model extraction completed before resolution.

The full phase-five contract is in [幂等与事务式结构化编辑](edit-transactions.md).

## Rename completeness guard

语言服务器的“工作区”不等于索引的工作区：测试目录被 `tsconfig` 排除、工作区只加载了一半时，服务器会“只改定义却返回成功”。个人版的契约分三层：

1. **LSP 仍是位置第一来源**。计划器把 WorkspaceEdit 与 Graph 已知的静态定义/引用位置核对；启发式边（`provenance: 'heuristic'` 或 `synthesizedBy`）不参与判断，也永远不会被转换成编辑。
2. **索引补全 LSP 没覆盖的位置**。缺口里“行 + 列都被提取器记录、且逐字符核实到标识符”的位置由 Graph 生成编辑，与 LSP 的编辑走完全相同的校验、预览、哈希与事务路径，并在结果的 `files[].edits[].plannedBy` 上标为 `"graph"`（LSP 的标为 `"lsp"`），预览同时给出补全数量与文件列表。**这不是文本替换**：位置必须与 AST 记录的行列逐字符吻合，`confirmed` 为假的位置永远不会生成编辑。
3. **补不了的就拒绝写盘**。两类情况仍然拒绝：（a）只有“可能位置”（没有列）或含别名的关系；（b）动态导入行上未被覆盖的出现——`const { runUpgrade } = await import('./updater')` 这种解构绑定目前没有边，只改同一文件里的调用位置会写出语法正确但语义损坏的代码。拒绝时预览列出具体位置，并以 `canApply:false` / `blockers[]` 暴露给调用方。

覆盖比较使用当前源码中的行列范围，同一行的多个引用不会因其中一个被编辑就全部算作覆盖；引用文件已变化时要求先同步。调用和构造边记录实际标识符列，不再把 `new Widget()` 的 `new` 列当成 `Widget` 的位置。行列请求先确认定义；从调用位置发起时通过 LSP definition 映射到当前索引，无法唯一确认时预览警告、`apply` 拒绝。

JS/TS 的 `const mod = await import('./x')` 现在由 AST 提取 namespace binding，`mod.runUpgrade()` 可沿模块映射解析到导出符号并携带成员的准确位置；这不是正则文本替换。动态解构绑定、计算属性和运行时模块路径仍是不证明就不改的边界。检查只能证明图已知的缺口已覆盖，不能保证任意反射引用完整。

## Code ownership

| Entry point | Responsibility |
| --- | --- |
| `src/edits/contract.ts` | request/result contract, statuses, validation, `previewHashOf`, sha256 helper |
| `src/edits/text-edits.ts` | the single text-edit engine: line/offset arithmetic in UTF-16 units, validation, back-to-front application, preview line construction |
| `src/edits/target.ts` | target resolution through the index (name or position), freshness gate, node-range → UTF-16 position conversion |
| `src/edits/graph-edit.ts` | `replace-body` / `insert-before` / `insert-after` planning, declaration-modifier scan, fragment-kind list |
| `src/edits/lsp-rename.ts` | rename planning: name position, WorkspaceEdit → per-file plans, root/kind/range validation, Graph-confirmed coverage completion (`plannedBy`) |
| `src/edits/transaction.ts` | persistent staging, backup, commit, rollback, replay and startup recovery |
| `src/edits/service.ts` | the one flow: validate → resolve → plan → preview → transaction → index/LSP sync |
| `src/extraction/index.ts` | `indexFiles()` grammar preload; extraction remains separate from reference resolution |
| `src/lsp/manager.ts` | rename request, WorkspaceEdit normalization, document close/change and workspace file notifications |
| `src/lsp/code-query-lsp.ts` | `symbolNamePosition` extracted from the query context so queries and rename share one name-position rule |
| `src/mcp/edit-tool.ts` | the `codegraph_edit` definition and its mutating annotations (kept out of the read-only `tools` array) |
| `src/mcp/tools.ts` | `allTools`, the default surface, the main-thread dispatch, `handleCodeEdit` |
| `src/bin/codegraph.ts` | `codegraph edit` (same JSON, same shared-daemon reuse as a structured query) |
| `src/mcp/server-instructions.ts` | the one place the tool's usage is documented for agents |

## Verification

New suites (all deterministic; the rename ones use the fake language server):

- `__tests__/edit-text-edits.test.ts` (17): LF/CRLF/CR line starts, offset and position round-trips, refusal of out-of-range and overlapping edits, back-to-front application, UTF-16 columns (a surrogate pair), EOL preservation, preview trimming/gap/truncation, argument validation, preview-hash stability.
- `__tests__/edit-code-edit.test.ts` (12): preview writes nothing, target and edit ranges for a real TS file, unique-name resolution and ambiguity refusal, unknown symbol / out-of-root path / mismatched argument refusal, stale-index refusal, apply + index refresh (the definition is a one-line symbol afterwards), preview-hash binding and conflict, insert-before/after placement (including a nested member and a CRLF file), rename unavailable without a server, the MCP surface and its mutating annotations, and CLI preview/apply/exit-code parity against `dist/bin/codegraph.js`.
- `__tests__/edit-lsp-rename.test.ts` (13): `normalizeWorkspaceEdit` (both shapes, unhandled kind, malformed edit), rename preview and apply with an index refresh, position-based rename, CRLF preservation, ambiguity/not-found refusals, the MCP path, a two-file rename, an edit reaching outside the project root (refused, nothing written), the `documentChanges` form, a server answering `null`, and a server without `renameProvider`.

`__tests__/fixtures/fake-lsp-server.js` gained `--rename`, `--rename-null`, `--rename-document-changes` and `--rename-extra <file>`; none of them changes the default behaviour, so the phase-2/3 suites are unaffected.

Two upstream test files were adjusted because this fork's default MCP surface now lists a second tool: `mcp-tool-annotations.test.ts` asserts the read-only contract over the read-only `tools` array and asserts `codegraph_edit`'s mutating annotations separately, and `mcp-tool-allowlist.test.ts` expects `['codegraph_edit', 'codegraph_explore']` by default. `TINY_REPO_CORE_TOOLS` keeps `codegraph_edit` listed on small repositories.

The table below is the historical phase-four run, not the current phase-five verification result:

| Run | Result |
| --- | --- |
| The 12 phase-1/2/3/4 suites together (the three edit suites, the annotation/allowlist tool-surface suites, and the phase 1-3 query/LSP suites) | `Test Files 12 passed` · `Tests 141 passed` |
| Full suite (`vitest run`) | `Test Files 21 failed \| 236 passed \| 22 skipped (280)` · `Tests 45 failed \| 4476 passed \| 233 skipped (4771)` |

**No failure in the full run belongs to this phase's suites** (all three `edit-*.test.ts` files pass, and so do `mcp-tool-annotations`/`mcp-tool-allowlist` and the phase 1-3 suites). The failures are the categories the phase-2/3 records already listed — `fs.rmSync` `EPERM` on temp dirs (`mcp-initialize`, `mcp-roots`, `arkts`, `frameworks`, `resolution`), the writer-lock "live foreign pid" case, `codegraph_callers` grouping wording, Steps/effects, the `ui-server-api` 100 ms budget, explore factory-closure/oversize allocation — plus run-to-run E2E/loading flakes (`react-native-bridge`, `object-literal-methods`, `nextjs`, `index-command`, `sync-rebuild-convergence`, `extraction-old-git`, one `mcp-daemon` case) that pass when their file is run alone (verified for `mcp-daemon`, `mcp-initialize`, `mcp-roots`, `writer-lock`). The phase-3 baseline was `Test Files 18 failed \| 236 passed` · `Tests 42 failed \| 4436 passed`; the differences are the flaky files above, not this phase (this phase's 42 new tests all pass, and no file that passed at baseline fails in the same way here).

## Limitations and known deviations

- **Rename needs a language server**, with no automatic installation: `.codegraph/lsp.json` (or `CODEGRAPH_LSP_*`) must point at one, and it must advertise `renameProvider`. A server that answers `null` is reported as `unavailable`, not retried with a weaker strategy.
- **The preview is not a stateful review step**: `apply: true` in the same call re-plans and then writes; `expectPreviewHash` is what makes a two-step preview→apply flow refuse if the workspace moved in between. A caller that wants to review first can preview, then apply with the hash.
- **Stale is a refusal, not a re-index.** An edit never silently re-indexes to fix up positions; `codegraph sync` is the caller's call.
- **Fragment kinds.** `replace-body` on a `variable`/`constant`/`property`/`field`/`parameter` replaces exactly the indexed range (often `NAME = value`), warns about it, and leaves the surrounding keywords and punctuation alone. `insert-before`/`insert-after` are usually the better tools there.
- **Advanced refactors remain language-server dependent.** The current public operations do not invent a cross-language signature-change or move-symbol protocol; imports are updated only when the language server includes them in its WorkspaceEdit.
- **The tool is listed by default.** Upstream's default MCP surface is `codegraph_explore` alone; this fork adds `codegraph_edit`, because a write capability that is never advertised cannot be used at all. It still previews by default and carries `readOnlyHint:false`/`destructiveHint:true`, so a client that gates on annotations sees exactly what it is.
- `codegraph_edit` runs on the main thread (never in a query-pool worker), because it writes files and may start a language server.
