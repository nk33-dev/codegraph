# Phase 2: LSP MVP

This phase wires real language servers into the existing `codegraph_explore`, covering definitions, references, diagnostics and file symbol overviews for **C, C++, JavaScript, TypeScript, Java, Rust, Go and Python**. Language servers start lazily per project, are reused in-process and exit when idle; no language server is **installed automatically**. Graph query (phase 1) behavior is unchanged.

## Python（2026-09-16 新增，未发布）

自动探测优先使用 `pyright-langserver --stdio`，其次使用 `pylsp`。可自行安装 `npm install -g pyright`，或在 `.codegraph/lsp.json` 的 `servers.python` 中指定 `{ "command": "pyright-langserver", "args": ["--stdio"] }`。环境变量为 `CODEGRAPH_LSP_PYTHON_COMMAND` 和 `CODEGRAPH_LSP_PYTHON_ARGS`。虚拟环境、额外导入路径等按 Pyright 的 `pyrightconfig.json` 配置。

Python 支持现有定义、引用、文件符号、诊断、auto/both 路由和 LSP 重命名。Windows / Node 24.16.0 / Pyright 1.1.414 已实测四种查询和跨文件重命名、重命名后再次查询；`pylsp` 仅登记发现与启动命令，本轮未实测。

复现：安装 Pyright 后设置 `CODEGRAPH_LSP_E2E=1`，运行 `npx vitest run __tests__/lsp-real-servers.test.ts -t "python:"`。没有服务时测试会标记 skipped；默认假服务回归位于 `__tests__/lsp-python.test.ts`。本地验证工具在被 Git 忽略的 `.codegraph/lsp-tools/python/`，运行时不会自动使用这个测试目录。

空闲退出从查询结束时计时；等待分析、请求执行和诊断等待期间不会被空闲清理杀掉。未收到分析完成通知时，轮询超时也会移除等待回调。

LSP 子进程关闭 stdin 时可能异步触发 `EPIPE`，连接层保留错误监听并拒绝未完成请求；即使已 dispose，迟到的错误也不会成为未捕获异常。

## Usage entry point

Keep using the same tool and the same CLI command, selecting the data source with `backend`:

| Capability | Call |
| --- | --- |
| find_definition | `codegraph_explore {mode:"definitions", backend:"lsp", query:"Name"}` or `{..., file:"a/b.ts", line:12, column:8}` |
| find_references | `codegraph_explore {mode:"references", backend:"lsp", query:"Name"}` or file+position |
| get_diagnostics | `codegraph_explore {mode:"diagnostics", backend:"lsp", file:"a/b.ts"}` |
| get_symbols | `codegraph_explore {mode:"symbols", backend:"lsp", file:"a/b.ts"}` |
| Server status | `codegraph_explore {mode:"status", backend:"lsp", query:"status"}` |

```sh
codegraph explore resolveProjectPath --mode definitions --backend lsp --file src/bin/codegraph.ts
codegraph explore widget --mode references --backend lsp
codegraph explore src/app.ts --mode diagnostics --backend lsp
codegraph explore src/app.ts --mode symbols --backend lsp
codegraph explore status --mode status --backend lsp
```

Library users get the same results through `CodeGraph.queryCodeWithBackend(request)`; `CodeGraph.queryCode(request)` is still the synchronous pure graph query (the phase 1 API is unchanged). When this phase landed, `backend` had only `graph` (default) and `lsp`, and the `auto` of that time was explicitly rejected; the **current** entry point also accepts `auto` (automatic routing) and `both` (two-source merging), see [Unified routing and impact analysis](unified-routing.md), and this document describes only these two phase 2 paths.

`line` is 1-based and `column` is 0-based; the unit of the column is self-described by the backend: just pass the `line`/`column` from the previous result back as-is (graph = UTF-8 byte column, LSP = UTF-16 code unit column).

## Configuring language servers

Commands come from only two places; a missing command means `unavailable`, and nothing is downloaded or installed automatically:

1. `.codegraph/lsp.json` (machine-local; `.codegraph/` is already ignored by its bundled `.gitignore`):

```json
{
  "idleTimeoutMs": 300000,
  "requestTimeoutMs": 20000,
  "warmupTimeoutMs": 15000,
  "disabled": [],
  "servers": {
    "cpp": { "command": "/path/to/clangd", "args": ["--background-index"] },
    "typescript": { "command": "typescript-language-server", "args": ["--stdio"] },
    "rust": { "command": "rust-analyzer" },
    "go": { "command": "gopls", "args": ["serve"] },
    "java": {
      "command": "/path/to/java",
      "args": ["-Declipse.application=org.eclipse.jdt.ls.core.id1", "-jar", "/path/to/launcher.jar", "-configuration", "/path/to/config_win"],
      "env": { "JAVA_HOME": "/path/to/jdk21" }
    }
  }
}
```

2. Environment variable overrides: `CODEGRAPH_LSP_<FAMILY>_COMMAND`, `CODEGRAPH_LSP_<FAMILY>_ARGS` (JSON array), `CODEGRAPH_LSP_DISABLED`, `CODEGRAPH_LSP_IDLE_TIMEOUT_MS`, `CODEGRAPH_LSP_INIT_TIMEOUT_MS`, `CODEGRAPH_LSP_REQUEST_TIMEOUT_MS`, `CODEGRAPH_LSP_DIAGNOSTICS_TIMEOUT_MS`, `CODEGRAPH_LSP_WARMUP_TIMEOUT_MS`. Family values are `CPP` (c+cpp), `TYPESCRIPT` (ts/tsx/js/jsx), `RUST`, `GO`, `JAVA` and `PYTHON`.

A config mistake only warns and skips that entry (the same convention as `codegraph.json`), and does not make a query throw. After the file's mtime changes, the next query rebuilds the servers already started for that project.

`.codegraph/lsp.json` and `CODEGRAPH_LSP_*` are trusted input: they decide which process is started.

## Return contract

An **additive** extension of the phase 1 contract; the graph result fields are unchanged:

- `backend: "lsp"`; `coordinates.columnEncoding: "utf-16"` (graph queries are still `"utf-8"`).
- `status` gains `"unavailable"`: **not installed, not configured, disabled by `disabled`, or restarts paused inside the crash window**. It is not a tool failure (`isError` is not set), and `warnings` gives the remedy. `error` is used only for protocol failures and timeouts.
- `items` gains four LSP item kinds: position (`LspSymbolItem`), reference (`LspReferenceItem`, `target`+`site`), file symbol (`LspDocumentSymbolItem`, where `parentIndex` indexes the **unpaginated** list and `qualifiedName` is joined from the parent chain with `.`), and diagnostic (`LspDiagnosticItem`).
- Position item fields align with graph results: `filePath` / `startLine` / `endLine` / `startColumn` / `endColumn` / `name` / `kind` / `language`. A language server returns only positions and no names, so **when it matches the index, name, kind and `symbolId` are filled in, and when it does not, they stay `null`** — no guessing.
- `source` distinguishes the origin: `"lsp"` = server response; `"index"` = the server returned empty because "that position is itself the definition", and the position recorded in the index is returned as-is (rust-analyzer is such a server), with `warnings` stating how many items there are.
- Positions outside the project root (standard library, dependencies, `jdt://` virtual documents) keep the absolute path or URI and set `external: true`.
- A new `lsp` block: the matched server (family, command, pid, state, capabilities, whether it is still indexing, and the stderr tail on error), the number of open documents, and the effective idle and request timeouts. `backend:"lsp"` with `mode:"status"` returns the status table for all language families and **starts no process**.
- Pagination, `ambiguous` (a name resolving to multiple candidate definitions) and `warnings` have the same semantics as graph queries.

## Lifecycle

| Behavior | Rule |
| --- | --- |
| Startup | spawn only on the first query that actually needs that language family; `initialize` carries `rootUri`, workspaceFolders and `general.positionEncodings:["utf-16"]` |
| Reuse | one process per `(project root, language family)`; in daemon mode all MCP clients of the same project share one ToolHandler → one set of servers |
| Idle exit | after 5 minutes without a request by default: `shutdown` → `exit` → kill if necessary; `idleTimeoutMs: 0` means resident |
| Document sync | `didOpen`/`didChange`/`didClose` only for files that have been queried, LRU cap 64; a full `didChange` only on disk changes |
| Index wait | wait first while the server reports that it is still indexing (`$/progress` or rust-analyzer's `quiescent`); if an empty result occurs inside the startup window or while the server calls itself busy, **retry once** after indexing ends, and explain it in `warnings` |
| Transient errors | `ContentModified(-32801)`/`ServerCancelled(-32802)` are retried automatically (at most 2 times) |
| Crash | a single failed request reports `error`; after 3 crashes within 60 seconds, restarts are paused and `unavailable` is returned (with the stderr tail and the remedy) |
| Process cleanup | if `shutdown`/`exit` does not get through, kill; the process exit hook kills all child processes as a fallback; stdin EOF lets the server exit on its own |
| Reverse requests | `workspace/configuration` (returning a null array matching the items length), `workspace/workspaceFolders`, `client/registerCapability` and `window/workDoneProgress/create` must be answered, otherwise many servers wait forever |

## Code ownership

| Entry point | Responsibility |
| --- | --- |
| `src/lsp/protocol.ts` | stdio framing and JSON-RPC: `Content-Length` parsing, id correlation, timeouts, reverse request responses, rejecting in-flight requests on exit |
| `src/lsp/servers.ts` | language family registry, `languageId`, executable discovery (on Windows only `.exe/.com/.cmd/.bat` are recognized and `.ps1` is skipped), cross-platform launch plan |
| `src/lsp/config.ts` | `.codegraph/lsp.json` + environment variables, mtime cache, degraded on malformed input |
| `src/lsp/manager.ts` | one manager per project: lazy startup, reuse, document sync, diagnostics cache (pull/push), idle cleanup, crash suppression, status snapshot; phase 4 adds `rename` (`textDocument/rename`, refusing a server without `renameProvider`) and `normalizeWorkspaceEdit` |
| `src/lsp/code-query-lsp.ts` | unified contract adaptation: name→position (graph index + UTF-8→UTF-16 column conversion, landing on the symbol name), result mapping, pagination and warnings |
| `src/graph/code-query.ts` | contract and shared validation/status blocks (`buildIndexBlock`, `validateCodeQueryRequest`, `assertBackendFields`), shared by the graph and lsp paths |
| `src/index.ts` | `CodeGraph.queryCodeWithBackend`; `close()` shuts down this project's manager |
| `src/mcp/tools.ts` | `handleCodeQuery` dispatches by `backend` and is still on the main thread (not through a query-pool worker) |
| `src/bin/codegraph.ts` | `explore`'s `--backend/--line/--column/--severity/--exclude-declaration` |

## Verification

Default suite (fake language server, deterministic): `__tests__/lsp-protocol.test.ts` (framing, id correlation, reverse requests, exit), `lsp-config.test.ts` (config and environment variable degradation), `lsp-position.test.ts` (column conversion, kind mapping, URI normalization, executable discovery), `lsp-manager.test.ts` (lazy startup, reuse, idle exit, crash suppression, timeouts, document sync, pull/push diagnostics, restart on config change, unavailable), `lsp-code-query.test.ts` (contracts of the four modes, pagination, CLI/MCP consistency, real MCP handshake, graph backend regression). Fixtures: `__tests__/fixtures/fake-lsp-server.js` and `__tests__/fixtures/lsp-<language>/`.

Real servers (skipped by default, must be enabled explicitly):

```sh
CODEGRAPH_LSP_E2E=1 npx vitest run __tests__/lsp-real-servers.test.ts
```

The servers are installed under the git-ignored `.codegraph/lsp-tools/`, and the install script `.codegraph/lsp-tools/install-lsp-tools.mjs` (the clangd 22.1.6 zip / rustup's rust-analyzer component / gopls from `go install` / the jdt.ls snapshot) is kept locally for rebuilding; rerunning that script restores these four sets of servers, while verification itself uses only the command above and depends on no temporary script.

That directory is a local verification convenience, not an LSP or CodeGraph layout requirement. The executables may instead live in one user-level/global tool cache and be shared by every project. What remains project-specific is `.codegraph/lsp.json` (command, arguments, environment and working directory) and the running server session, because each session is initialized with one project's root, dependencies and build configuration.

Measured locally (2026-09-15, Windows):

| Language | Server | Version/source | Definition | Reference | Overview | Diagnostics |
| --- | --- | --- | --- | --- | --- | --- |
| Rust | rust-analyzer | rustup component 1.95.0 | ✓ | ✓ | ✓ | ✓ (pull, E0308) |
| TypeScript | typescript-language-server | 5.3.0 (bundled TS 6.0.3) | ✓ | ✓ | ✓ | ✓ (push, TS2322) |
| JavaScript | typescript-language-server | same as above | ✓ | ✓ | ✓ | no deliberate error set |
| C | clangd | 22.1.6 (GitHub release) | ✓ | ✓ | ✓ | ✓ (push, pointer to integer) |
| C++ | clangd | same as above | ✓ | ✓ | ✓ | ✓ (push, incompatible types) |
| Go | gopls | v0.23.0 (`go install`) | ✓ | ✓ | ✓ | ✓ (push, cannot convert) |
| Java | eclipse.jdt.ls | 1.62.0 snapshot + JDK 21 | ✓ | ✓ | ✓ | ✓ (push, type mismatch) |

The end-to-end cases for all seven languages pass (`__tests__/lsp-real-servers.test.ts`, 7 passed). The C/C++ fixtures generate a `compile_commands.json` with absolute paths after being copied to a temporary directory.

Full suite (`npm test`, Windows): `Test Files 20 failed | 231 passed | 22 skipped`, `Tests 44 failed | 4396 passed | 233 skipped`. The failing files are unrelated to this phase: 28 of them are `fs.rmSync` reporting `EPERM` while deleting a temporary directory on Windows (arkts/frameworks/mcp-initialize/mcp-roots/resolution and others), and the rest are existing cases such as writer-lock (treating pid 1 as a live external process), the `codegraph_callers` grouping wording, explore factory closure selection, Steps/Prisma effects and the `ui-server-api` 100ms budget. These files fail the same way when run on their own and without any LSP code involved (reviewed separately). Running this phase's five new suites together with the phase 1 regression `code-query.test.ts` gives `Test Files 6 passed / Tests 58 passed`.

## Limitations and known deviations

- **No language server installation**: without an executable the result is `unavailable`. C/C++ needs clangd (a `compile_commands.json` is recommended; when missing, cross-file results are incomplete and a warning is emitted); jdt.ls needs a complete launch command and JDK 21+.
- **Indexing not finished vs. "does not exist"**: the window has already been minimized with "wait for indexing + retry an empty result once", but very large projects can still time out on the first query and return empty, in which case `lsp.server.indexing` is true and `warnings` suggests retrying.
- **Content outside the index**: LSP reads the working tree, so files excluded from the index also appear in results (marked `external`, or with no node in the index and `null` fields); graph references and LSP references are two different concepts, and the latter includes the declaration itself by default.
- **Java without build files**: jdt.ls imports a plain directory as an invisible project, so package-structure-related diagnostics may be inaccurate; projects with `pom.xml`/`build.gradle` go through normal import. jdt.ls's workspace data directory is placed at `~/.codegraph/lsp/jdtls/<project hash>` — it cannot be placed inside the project root, otherwise Eclipse refuses to mount the project as a linked resource.
- **Multi-window sharing**: in this phase the sharing scope is only the same MCP service process (naturally across clients under the daemon); across processes (each `codegraph explore` being a new process) each started its own language server at the time. Phase 3 has filled in that half: when a daemon exists, CLI structured queries reuse it directly, see [Unified routing and impact analysis](unified-routing.md).
- **readOnlyHint is still true**: the tool does not modify user source code; language servers themselves write cache/index directories (such as rust-analyzer's target and jdt.ls's workspace).
- When this phase landed, `backend:"auto"`, graph and LSP result merging, impact analysis and test association were all unimplemented; the first three have been completed in phase 3 (see [Unified routing and impact analysis](unified-routing.md)). Symbol rename/replace/insert have since been completed in phase 4 (see [Structured editing](structured-edits.md)): rename uses this phase's `textDocument/rename` path (a server without `renameProvider` is reported `unavailable`), while the other three operations are graph-native and need no server.
