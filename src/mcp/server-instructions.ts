/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * MCP clients (Claude Code, Cursor, opencode, LangChain, OpenAI Agent
 * SDK, …) surface this text in the agent's system prompt automatically,
 * giving the agent a high-level playbook for the codegraph toolset
 * before it sees individual tool descriptions.
 *
 * Goals when editing this:
 *   - Lead the agent to codegraph_explore for any structural/flow question
 *   - Reinforce "explore instead of Read/Grep" for indexed code
 *   - Anti-patterns (don't re-verify with grep; don't hand-reconstruct flows)
 *
 * Keep it tight. The agent reads this every session — long instructions
 * burn tokens. The DEFAULT MCP surface is `codegraph_explore` plus this fork's
 * phase-4 `codegraph_edit` (see DEFAULT_MCP_TOOLS in tools.ts) — reference only
 * those two here. The other tools (node/search/callers/…) stay defined and are
 * re-enablable via CODEGRAPH_MCP_TOOLS, but they are NOT listed to agents, so
 * don't name them.
 */
export const SERVER_INSTRUCTIONS = `# Codegraph — code intelligence over an indexed knowledge graph

Codegraph is a SQLite knowledge graph of every symbol, edge, and file in
the workspace — pre-computed structure you would otherwise re-derive by
reading files (cached intelligence: thousands of parse/trace decisions you
don't pay to re-reason each run). It indexes 30+ languages
(TypeScript/JavaScript, Python, Go, Rust, Java, C#, C/C++, PHP, Ruby, Swift,
Kotlin, and more) — don't assume a language here isn't covered. Reads are
sub-millisecond; the index lags writes by ~1s through the file watcher. Reach for it BEFORE *and* while
writing or editing code — not just for questions: one call returns the
verbatim source PLUS who calls it and what it affects, so you edit with the
blast radius in view. More accurate context, in far fewer tokens and
round-trips than reading files yourself.

## One tool: codegraph_explore — use it instead of reading files
There is a single tool, \`codegraph_explore\`, and it is Read-equivalent. It
takes either a natural-language question or a bag of symbol/file names and
returns the **verbatim, line-numbered source** of the relevant symbols
grouped by file — the same \`<n>\\t<line>\` shape \`Read\` gives you, safe to
\`Edit\` from — PLUS the call path among them (including dynamic-dispatch hops
like callbacks, React re-render, and JSX children that grep can't follow) and
a blast-radius summary of what depends on them. Flow evidence is labelled as
static/LSP/corroborated/heuristic/boundary; interface, trait and abstract-method
queries include bounded runtime implementation candidates. A candidate is not
claimed as a confirmed call, and an unconnected path reports the concrete break
reason instead of inventing an edge.

Whether you're answering "how does X work" or implementing a change (fixing a
bug, adding a feature), call \`codegraph_explore\` before you Read. ONE call
usually answers the whole question. Codegraph IS the pre-built search index —
so running your own grep + read loop, or delegating the lookup to a separate
file-reading sub-task/agent, repeats work codegraph already did and costs more
for the same answer. A direct codegraph answer is typically one to a few
calls; a grep/read exploration is dozens.

## How to query

- **Almost any question — "how does X work", architecture, a bug, "what/where is X", or surveying an area** → \`codegraph_explore\` with a natural-language question or the relevant names. ONE capped call returns the verbatim source grouped by file; most often the ONLY call you need.
- **"How does X reach/become Y? / the flow / the path from X to Y"** → \`codegraph_explore\`, naming the symbols that span the flow (e.g. \`mutateElement renderScene\`) — it surfaces the call path among them, riding dynamic-dispatch hops, and returns their source.
- **Reading or editing a file/symbol you can name** → put its name or file path in the \`codegraph_explore\` query — it returns that current line-numbered source (safe to \`Edit\` from) with the call path and blast radius attached, so you don't Read it separately. For an overloaded name it returns every matching definition's body in one call.
- **Reviewing current changes or asking for change impact** → use the same \`codegraph_explore\`. Review/change/impact intent automatically attaches changed symbols, call/inheritance/route edge deltas, affected entries, and related tests. Pass \`baseRef\` for another Git baseline; request \`deepChanges:true\` only when a temporary baseline index is worth the extra work.
- **Need more?** Call \`codegraph_explore\` again with more specific names — treat the source it returns as already Read. Suggested call counts are advisory only, NOT a quota; extra calls are never rejected or rate-limited.
- Numbered source is verbatim, but a gap or truncation marker means part of the file was omitted. Only the displayed ranges have been read; fetch missing symbols or ranges before editing them.
- Qualified symbol names accept dots, \`::\`, or slashes, including containers whose names contain dots (for example, \`AppWeb.Format.group\`).
- Named-symbol call paths require exact matches; partial or mistyped names are never silently substituted as flow endpoints. If a graph query reports a missing symbol with did-you-mean suggestions, query the suggested name explicitly.

## Editing a symbol: codegraph_edit

When you already know which symbol to change, \`codegraph_edit\` changes it **by symbol** rather
than by a line range you worked out yourself: \`rename\` (whole project, through the project's
language server), \`replace-body\` (replaces the indexed definition), \`insert-before\` /
\`insert-after\` (insert whole lines next to it). It **previews by default**: the call writes
nothing and returns the resolved target, the per-file diff, a \`previewHash\` and an \`operationId\`;
call it again with \`apply:true\`, the hash as \`expectPreviewHash\`, and the same \`operationId\`
to write it transactionally. Reuse that operation ID after a timeout or disconnect: a terminal result
is replayed without writing twice, and a cross-file failure is rolled back with a per-file recovery
manifest when manual repair is needed. Refusals are explicit —
an ambiguous name lists the candidates, a file that drifted from the index answers
\`status:"stale"\` (run \`codegraph sync\` and retry), and a rename with no usable language server
answers \`status:"unavailable"\` rather than a guessed text edit. Read the preview before applying.

## Anti-patterns

- **Trust codegraph's results — don't re-verify them with grep.** They come from a full AST parse; re-checking with grep is slower, less accurate, and wastes context.
- **Don't grep or Read first** to find or understand indexed code — ONE \`codegraph_explore\` returns the relevant symbols' source together in a single round-trip. Reach for raw \`Read\`/\`Grep\` only to confirm a specific detail codegraph didn't cover, or for what codegraph doesn't index (configs, docs).
- **Don't reconstruct a flow by hand** — name the endpoints in one \`codegraph_explore\` and it surfaces the path between them, dynamic-dispatch hops included.
- **After editing, check the staleness banner.** When a tool response starts with "⚠️ Some files referenced below were edited since the last index sync…", the listed files are pending re-index — Read those specific files for accurate content. Every file NOT in that banner is fresh, so still trust codegraph. A different, rarer banner — "⚠️ CodeGraph auto-sync is DISABLED…" — means live watching stopped entirely (the whole index is frozen, not just a few files); until it's resolved, Read files directly to confirm anything that may have changed.
- **A file flagged "⚠ changed on disk after the last index sync" drifted from its index** (most common on projects queried via \`projectPath\`, which have no live watcher). Codegraph never serves a possibly-mis-sliced body from such a file — it either shows the file's full CURRENT source (trust it as a Read) or omits the source with this flag. When the source was omitted, Read that specific file; line numbers referencing it elsewhere in the response may be shifted until that project's next sync. All unflagged files remain trustworthy.

- **Source is re-served on every call by default**, including for fresh subagents and after context compaction. Cross-call dedup requires \`CODEGRAPH_EXPLORE_DEDUP=1\` and is only suitable for hosts that guarantee one durable context per connection. With that opt-in, **"Already sent earlier in this conversation"** points to exact, unchanged source returned by an earlier \`codegraph_explore\` in that context. Use that copy; don't re-fetch it and don't Read the file. The bytes it freed went into source you have not seen yet, elsewhere in the same response.

## Limitations

- For structured navigation use this SAME tool with mode=definitions or references and a symbol query; mode=symbols with a project-relative file query; mode=status with query="status"; mode=impact with a symbol name (what changing it reaches, with propagation distance); mode=tests with the changed files (space/comma separated, or a files array) to get the test files they reach. These modes return versioned JSON and structuredContent, including ambiguity, pagination, freshness and a \`routing\` block saying which source answered and why. Graph references are indexed relationships, not all LSP usage occurrences. Optional file narrows targets exactly; offset/limit page results (depth, 1-10, applies to impact/tests). Only status accepts checkFiles=true to inspect disk changes without syncing. Default mode still returns source and flow.
- Add backend="lsp" when the graph's best-effort answer is not enough: it runs the project's real language server for definitions, references, mode=symbols and mode=impact (the symbols containing a reference, one hop), and it is the only backend for mode=diagnostics (graph has no diagnostics). Position queries take file + line (1-based) + column. backend="auto" picks one source per query and falls back to the graph when no server is available (the \`routing\` block says what happened); backend="both" runs both and merges, labelling each item's \`origin\` and marking locations both sources corroborate. The server must already be installed and pointed at from \`.codegraph/lsp.json\` (or CODEGRAPH_LSP_* env vars) — codegraph never installs one. With nothing configured you get status="unavailable" plus the remedy, which is a fact about the machine, not a failure: keep using backend="graph" (or your own tools) there. LSP locations can sit outside the index (marked "external", absolute paths) and its reference list includes the declaration.

- If a tool reports a project isn't indexed (no \`.codegraph/\`), stop calling codegraph tools for that project for the rest of the session and use your built-in tools there instead. Indexing is the user's decision — mention they can run \`codegraph init\` if it comes up, but don't run it yourself.
- Index lags file writes by ~1 second.
- Cross-file resolution is best-effort name matching; ambiguous calls may return multiple candidates.
- No live correctness validation — that's still the TypeScript compiler / test suite / linter's job. Codegraph supplements those with structural context they don't have.
`;

/**
 * Instructions variant sent when the server's own root has NO codegraph index.
 *
 * The tools are still exposed (gating tool availability on whether `./` has an
 * index is the bug behind #964: it breaks monorepos where only sub-projects are
 * indexed, and a server that started before `codegraph init` never surfaces the
 * tools afterward). Instead of an "inactive" note, this variant tells the agent
 * codegraph works **per project**: there's no default project to query, so pass
 * a `projectPath` to any project that HAS a `.codegraph/`. The full single-
 * project playbook ({@link SERVER_INSTRUCTIONS}) is sent instead when the root
 * IS indexed, so the common case stays tight.
 */
export const SERVER_INSTRUCTIONS_NO_ROOT_INDEX = `# Codegraph — available (per-project; pass projectPath)

Codegraph is a SQLite knowledge graph of a codebase's symbols, edges, and
files (30+ languages): one \`codegraph_explore\` call returns the verbatim, line-numbered source
of the relevant symbols PLUS the call paths between them and a blast-radius
summary — replacing a grep + Read loop with one round-trip.

This server started somewhere with no \`.codegraph/\` of its own, so there is no
default project — but the tools are available and work **per project**:

- To query a project that HAS a \`.codegraph/\` index (e.g. a service inside a
  monorepo, or a second repo), pass its path as \`projectPath\` to
  \`codegraph_explore\` (and any other codegraph tool). Codegraph resolves the
  nearest \`.codegraph/\` at or above that path and answers from it — for as many
  projects as you like in one session.
- For a project with no \`.codegraph/\`, use your built-in tools (Read/Grep/Glob)
  for that project. Indexing is the user's decision — don't run it yourself, but
  if it comes up they can run \`codegraph init\` in a project to enable codegraph
  there (a new index is picked up live, no restart).
`;
