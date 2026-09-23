# Phase 1: structured graph queries

This phase extends the existing graph queries: it does not start LSP, does not add a separate MCP service, and does not change the default source and call-chain output. Definitions and references come from the Tree-sitter/graph index and must not be treated as the complete semantic result of a language server.

## Usage entry point

Keep using `codegraph_explore`, selecting structured queries through `mode`:

| mode | query | Result |
| --- | --- | --- |
| `explore` (default) | Question or symbol name | Source and call-chain text; MCP returns one text representation, CLI `--json` and the library retain structured evidence |
| `definitions` | Symbol name or qualified name | Positions of matching definitions; definitions sharing a name are not merged on our own |
| `references` | Symbol name or qualified name | Grouped graph relationships with the first `site`, optional additional `sites`, provenance and confidence |
| `callers` / `callees` | Symbol name or qualified name | Paginated call and construction relationships with the first `site` and optional additional `sites` |
| `symbols` | Exact project-relative file path | File symbol overview, including parent symbol IDs |
| `status` | `status` | Runtime version/build identity, index freshness, watcher state, pending files and unfinished reference resolution |
| `text` | Literal text or configuration key | File-level paginated matches in indexed source, comments, scripts, documentation and configuration; first five matching line numbers per file |
| `source` | File path or basename | Current file lines; `offset` is the 1-based starting line and `limit` is the number of lines (at most 2000) |

索引状态与工作区差异的权威契约见[索引状态、局部刷新与生成版本](index-refresh-and-versioning.md)。

默认 `explore` 对“项目启动流程”类问题会优先选择根目录、`src/` 和 `bin`/`cmd` 中的常见入口，沿入口的调用/导入边向外展开；未识别入口时仍使用普通检索，不推断不存在的运行时边。蛇形模块名、带扩展名的文件名、`mod 模块名` 和完整路径会归一到已索引的同一文件；同名文件最多固定三个，避免把热词误认为唯一模块。空结果会给出文件、符号和索引状态的后续查询建议，可能的相近符号仅作为建议，不当作精确命中。

JSON 结构化模式接受 `offset`（从 0 开始，默认 0）和 `limit`（1–200，默认 50）；`file` 是精确项目相对路径，不能模糊匹配。`source` 复用现有当前磁盘文件读取及安全门，`offset` 从 1 开始，且配置文件仍按键摘要保护；分页提示只推荐继续调用默认 `codegraph_explore`，不会指向未暴露的隐藏工具。`text` 只支持 Graph 后端，按文件稳定分页，配置行只给行号、不返回值；每个命中还标记 `freshness`，已变化的文件省略旧片段。敏感 `.env`、私钥和二进制不进入文本索引。超过 256 KiB 的文本文件记录在 `file_text_skipped`，查询时按路径稳定补扫（每文件最多 2 MiB、每次最多 8 MiB 和 32 个文件），补扫结果标记 `source: disk`、`indexedAt: null`；超预算或不可读文件会报告未搜索数量，不能据此认定代码不存在。旧索引未记录覆盖范围时提示运行 `sync`。FTS5 使用 SQLite trigram tokenizer 支持标识符内部子串，不支持 FTS5 或少于三个 Unicode 字符时使用字面扫描；旧索引首次运行 `codegraph sync` 后才可用。`projectPath` 复用既有跨项目解析及路径校验。

MCP 默认 `explore` 在 session 传输边界只返回完整文本，避免客户端只展示结构化摘要而丢失源码。库的 `ToolHandler.execute()` 和 CLI `codegraph explore <query> --json` 保留结构化证据；其中 `rendered.text` 仍是最多 12,000 字符的便捷镜像，完整回答由返回值的 `content` 提供。显式 JSON 查询模式仍同时返回相同的 `structuredContent` 与 JSON 文本。

结构化 `references`、`callers`、`callees` 按源、目标、边类型和来源合并重复调用点，`site` 保留首个位置，重复关系的 `sites` 保留所有去重位置；`page.total` 统计关系而非原始边。`impact` 可直接用已索引的文件路径作为 `query`，保留 `rootId`，并先按距离再按生产代码、测试、fixture 和路径排序。定义与编辑歧义列表也把生产代码放在前面，保留全部候选；名称未精确匹配时提供最多三个建议，不自动改选目标。`diagnostics` 在 MCP、CLI 和 `queryCodeWithBackend` 未指定 `backend` 时使用 `auto`，未传 `file` 时从 `query` 解析路径；schema 不声明固定的后端默认值，以免客户端替用户注入 `graph`；显式选择后端仍按原契约校验。

`tests` 模式传入 `files` 时可以省略 `query`；MCP schema 用 `query`/`files` 条件必填表达该契约，运行时仍拒绝其他模式缺少 query。测试候选先按 Graph 置信度，再按 `priority: focused | related`、距离和路径排序：`focused` 只表示测试文件名与改动路径有主题交集，不改变依赖证据。没有依赖边但文件名主题相关的测试另列于 `filenameCandidates`，最多 20 个，标记 `reason: filename`、`confidence: low`、`distance: null`，不混入可执行的 `items`。共享核心文件仍可能有很多真实直接依赖，结果会明确提示剩余 `related` 候选可能较宽。

```json
{"mode":"definitions","query":"CodeGraph.queryCode","file":"src/index.ts","limit":20}
```

The CLI is used through explore as well, and structured modes output JSON directly:

```sh
codegraph explore CodeGraph.queryCode --mode definitions --file src/index.ts
codegraph explore queryCode --mode references --limit 20
codegraph explore src/index.ts --mode symbols
codegraph explore status --mode status --check-files
codegraph explore api.timeout --mode text --limit 20
codegraph explore run --mode callers --offset 0 --limit 20
codegraph explore src/main.ts --mode source --offset 100 --limit 40
```

Development verification must invoke the local `node dist/bin/codegraph.js`; a globally installed old version must not stand in for the current implementation. Library users get the same results through `CodeGraph.queryCode(request)`.

## Return contract

- `schemaVersion: 1`, `backend: "graph"`, `mode`, `query` and `projectRoot` identify the query source.
- `status` distinguishes `ok`, `not_found`, `not_indexed` and `error`. A definition not found and a definition with no references are different states; an empty page does not mean the symbol does not exist.
- `items` returns symbols or references; `page` contains offset, limit, total and nextOffset. `ambiguous` means the target has multiple definitions, and does not disappear just because pagination shows only one item.
- `callers` / `callees` 只返回调用与构造边；`provenance: heuristic` 标记推断，旧索引没有来源信息时 `confidence: unknown`，不能宣称是静态直接调用。完整跨多跳路径仍由默认 explore 的独立 Flow 段呈现。
- `text` 的 `page.total` 是命中文件数，不是行数；每个文件最多列五个命中行，并报告 `occurrences`。短词与不支持 FTS5 的运行时退回 SQLite 内容匹配，索引范围以文件大小和排除规则为界。
- Positions use index rows and columns: lines start at 1 and Tree-sitter byte columns start at 0; these are not LSP UTF-16 coordinates. IDs are identifiers in the current index, and must not be assumed to stay stable after moving a file or changing line numbers; query again by name and path.
- References are graph relations rather than every textual occurrence; they may be incomplete or inferred. When there are no call-site coordinates, site stays null, and a function definition position is not used to fake a call site.
- Every symbol states `freshness`: current, changed, missing or unavailable. The check reuses the index's size/mtime fast check and compares content hashes when necessary; it is not one atomic disk snapshot. A missing watcher does not mean the data must be stale.
- `index.changes: null` means there was no full working-tree scan. The existing change detection is only invoked when status explicitly passes `checkFiles: true`, and it does not trigger sync. pendingFiles and each category of changes list at most 100 paths; the real counts are in pendingFileCount and changeCounts.
- `status` 模式的 `runtime` 返回当前服务进程实际加载的版本、发行渠道和 `build-info.json` 中的提交、dirty 标志与 build ID；源码未构建时 `build` 为 null，不用索引 commit 冒充服务版本。
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

`__tests__/query-paths.test.ts` 覆盖模块别名；`__tests__/explore-intent-topic-query.test.ts` 覆盖启动链和空结果建议；`__tests__/flow-evidence.test.ts` 覆盖宽泛问题不产生普通词的伪断链；`__tests__/code-query.test.ts` 覆盖跨提交前后的索引 commit 状态。
`__tests__/file-text-search.test.ts` 覆盖全文命中、分页、配置值隐藏、漂移、同步、旧数据库升级与重复打开；`__tests__/node-file-view.test.ts` 覆盖 `source` 行范围；`__tests__/server-instructions.test.ts` 守护固定表面预算。

最新本地验证与发布边界见[开发验证记录](test-repairs.md)。
