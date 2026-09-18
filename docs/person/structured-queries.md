# Phase 1: structured graph queries

This phase extends the existing graph queries: it does not start LSP, does not add a separate MCP service, and does not change the default source and call-chain output. Definitions and references come from the Tree-sitter/graph index and must not be treated as the complete semantic result of a language server.

## Usage entry point

Keep using `codegraph_explore`, selecting structured queries through `mode`:

| mode | query | Result |
| --- | --- | --- |
| `explore` (default) | Question or symbol name | The original source and call-chain text |
| `definitions` | Symbol name or qualified name | Positions of matching definitions; definitions sharing a name are not merged on our own |
| `references` | Symbol name or qualified name | Reference relations in the graph, each item stating source, target, relation type and provenance |
| `symbols` | Exact project-relative file path | File symbol overview, including parent symbol IDs |
| `status` | `status` | Index time, watcher state, pending files and unfinished reference resolution |

Structured modes accept `offset` (0-based, default 0) and `limit` (1–200, default 50); `file` is an exact file qualifier and does not do fuzzy suffix matching. In `symbols`, file can override the path given by query. `projectPath` reuses the existing cross-project resolution and path validation.

```json
{"mode":"definitions","query":"CodeGraph.queryCode","file":"src/index.ts","limit":20}
```

The CLI is used through explore as well, and structured modes output JSON directly:

```sh
codegraph explore CodeGraph.queryCode --mode definitions --file src/index.ts
codegraph explore queryCode --mode references --limit 20
codegraph explore src/index.ts --mode symbols
codegraph explore status --mode status --check-files
```

Development verification must invoke the local `node dist/bin/codegraph.js`; a globally installed old version must not stand in for the current implementation. Library users get the same results through `CodeGraph.queryCode(request)`.

## Return contract

- `schemaVersion: 1`, `backend: "graph"`, `mode`, `query` and `projectRoot` identify the query source.
- `status` distinguishes `ok`, `not_found`, `not_indexed` and `error`. A definition not found and a definition with no references are different states; an empty page does not mean the symbol does not exist.
- `items` returns symbols or references; `page` contains offset, limit, total and nextOffset. `ambiguous` means the target has multiple definitions, and does not disappear just because pagination shows only one item.
- Positions use index rows and columns: lines start at 1 and Tree-sitter byte columns start at 0; these are not LSP UTF-16 coordinates. IDs are identifiers in the current index, and must not be assumed to stay stable after moving a file or changing line numbers; query again by name and path.
- References are graph relations rather than every textual occurrence; they may be incomplete or inferred. When there are no call-site coordinates, site stays null, and a function definition position is not used to fake a call site.
- Every symbol states `freshness`: current, changed, missing or unavailable. The check reuses the index's size/mtime fast check and compares content hashes when necessary; it is not one atomic disk snapshot. A missing watcher does not mean the data must be stale.
- `index.changes: null` means there was no full working-tree scan. The existing change detection is only invoked when status explicitly passes `checkFiles: true`, and it does not trigger sync. pendingFiles and each category of changes list at most 100 paths; the real counts are in pendingFileCount and changeCounts.
- Results go both into MCP `structuredContent` and into the complete JSON in text; no text banner is concatenated outside the JSON. Not indexed is a handleable state, while invalid arguments or permission errors still return a tool error; generic MCP request validation keeps its original error format.

## 意图词收束（explore）

`codegraph_explore` 同时接受符号名和自然语言。真实报告：查询 `runUpgrade` 很准确，查询 “runUpgrade 的定义、所有调用方和相关测试” 却会混入其他文件里名为 `run` 的函数。原因是“定义/所有/调用方/相关测试”没有被整体识别为意图，查询文本继续走 FTS；camelCase 标识符被切成 `run` + `upgrade` 片段，而 FTS 用的是前缀匹配，于是任何以 `run` 开头的符号（含文档字符串里出现 “runs” 的条目）都会成为入口节点。

现在的契约（`src/search/query-intent.ts` 是结构化意图的唯一来源）：

- 自然语言查询先用 `removeQueryIntentWords()` 删除意图词，只把剩余主题送进 FTS；点、斜杠和 `::` 等限定名结构保留。索引中确有同名非文件符号时（如名为 `search` 的函数），该词作为真实目标保留；
- 主题为空或全部未命中时返回 `No relevant code found`，不再用 `callers/related/code` 等意图词片段命中无关符号；
- 只有索引能**唯一**精确确认一个代码形状标识符（camelCase、PascalCase、snake_case 或限定名）时才会收束；
- 该符号之外的关系词先解析为 `definitions/callers/callees/references/tests/direct/all/related` 意图；“所有直接调用方和相关测试”不会再把“直接”作为第二个检索主题送进 FTS。剥离后还有真正的检索目标（第二个符号、主题名词、文件名）才保持完整探索路径；
- 收束后只展开目标符号、它的直接关系和直接测试：`traverse` 深度 1、默认 `maxFiles` 收敛到 4，测试文件仅在查询明确要求测试时参与排序与预算，且只作为直接调用者进入；定义、非测试直接调用方和测试会在 `Requested View` 中分类列出；
- 明确要求“相关测试”时，测试文件默认只输出**测试摘要**（文件、测试声明及其行号、每个声明实际调用的生产符号，长测试体只抽样并声明省略），不再整篇渲染测试源码；`includeTestSource: true` 才按普通源码渲染该文件，测试全文仍可通过再次 explore 该测试名（或结构化 `mode: tests`）取得；
- 直接关系不再依赖通用遍历恰好保留该节点，而是与结构化 `references`、rename 覆盖检查共同复用 `src/graph/incoming-relations.ts`。因此动态 namespace import 的成员调用（如 `up.runUpgrade()`）也会稳定进入直接调用方；已有对应 LSP 进程时会合并其引用并标出 `graph` / `lsp` 来源，显式 `backend:"both"` 可要求启动并合并，默认不会仅为自然语言 explore 冷启动语言服务器；
- 精确目标是覆盖文件大半的大型类/模块时，目标定义自身不再被通用“容器 envelope”过滤；预算不足可以裁剪，但不能只返回调用方而丢掉定义文件；
- 词表刻意不包含主题名词（缓存、索引、部署、`helper`、`method`、`read`…），因此“Session method helper”“DataService read load”这类多词查询不会被误收束成单符号查询。

意图词永不参与模糊匹配这一点与 `no-silent-fuzzy-symbol` 的契约一致：唯一精确符号之外没有可靠目标时，explore 不会用模糊命中冒充那个名字。

## Blast radius 依赖分类

`codegraph_explore` 的 blast radius 仍通过全部入边收集依赖，但展示时按真实语义分成 callers（calls/instantiates/navigates）、importers（imports）和 references。只导入模块的文件不再计为调用点；同一依赖节点存在多种边时按 caller、importer、reference 的优先级稳定归类，避免依赖数据库返回顺序。

真实报告：顶部写成 “2 callers in src/bin/codegraph.ts”，实际是 `main` 一个直接调用方加一个测试文件；原因是每个类别的**数量**取了该类别全部依赖，而**文件位置**只列非测试文件，两个口径不同。现在的契约：

- 每个类别先按“测试 / 非测试”切分，数量和文件位置都只从同一份切片计算，测试不进入生产调用方计数；
- 同一个文件被同时记为模块 import 依赖和其内部符号依赖时只算一个（有具体符号时取具体符号），因此计数不再高于其下列出的行；
- 行首给出两个不重叠的数字：生产依赖符号数与测试文件数，`uniq.length` 那种“总依赖数”不再作为唯一口径；
- `src/ui-server/api/wire.ts` 的调用方分组、`node.ts` 的 counts 与 UI 视图不在本次改动范围内，仍是各自独立的既有口径。

## Code ownership and upstream sync

| Entry point | Responsibility and reuse points |
| --- | --- |
| `CodeGraph.queryCode` in `src/index.ts` | Public library entry point; no separate parser/database is built |
| `src/graph/code-query.ts` | Unified contract and pagination for definitions, references, overview and status; reuses symbol-lookup and the existing graph queries |
| `src/search/query-intent.ts` | `parseQueryIntent` 的结构化意图、`removeQueryIntentWords` 的检索改写与 `stripQueryIntentWords` 的主题检查 |
| `src/graph/incoming-relations.ts` | 查询、explore 与 rename 共用的 Graph 入边解析及稳定排序 |
| `src/sync/file-freshness.ts` | On-disk freshness check for a given file; reuses the existing hash format |
| `handleCodeQuery` in `src/mcp/tools.ts` | Existing explore mode dispatch, keeping path checks and working-tree hints; the main connection reads watcher state |
| explore in `src/bin/codegraph.ts` | CLI argument mapping and invocation of the same MCP handler |
| `src/mcp/server-instructions.ts` | The single source for tool usage documentation |

The hash decision previously inside `ToolHandler.isFileStaleOnDisk` moved into indexedFileFreshness; the old text mode still keeps its short-lived cache and original error handling. When upstream changes the old location, migrate it into the shared function; two different freshness algorithms must not come back.

Incremental indexing remains the responsibility of the existing sync/orchestrator/watcher. This phase adds change status and query regressions; it does not rewrite the incremental algorithm, and it must not be claimed to add the incremental indexing capability that upstream already had. Large-scale references queries still have to enumerate the matching graph edges: pagination limits the number of returned items, not the database scan to a single page.

## Verification

`__tests__/code-query.test.ts` uses real TS, JS and Rust files plus SQLite, covering definition ambiguity, exact file qualification, hierarchy, graph references, cross-project, CLI/MCP consistency, real MCP handshake, watcher state, file modification/rename/deletion, and consistency of incremental and rebuild results after a Git branch switch.

`__tests__/explore-blast-radius.test.ts` 固定依赖分类与计数口径（测试调用方只计为测试文件、生产调用方数量与所列文件一致、纯导入文件仍单独归类），`__tests__/explore-test-summary.test.ts` 固定测试摘要契约（测试声明与 exercises 标注、测试体省略与抽样、`includeTestSource: true` 的全文路径、未请求测试时不受影响）。`__tests__/explore-intent-query-focus.test.ts` 继续覆盖意图词收束本身。

The shared freshness function also runs the original mcp-stale-slice and mcp-staleness-banner regressions. Complete build and full test results are recorded in the task handover/commit description; baseline failures of other tests must not be recorded as everything passing.
