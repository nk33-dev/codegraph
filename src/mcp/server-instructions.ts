/**
 * Short agent guidance sent during MCP initialization.
 *
 * Parameter details live only in the tools/list schemas. This text keeps tool choice,
 * trust boundaries, and write safety without injecting a second manual into every session.
 */
export const SERVER_INSTRUCTIONS = `# Codegraph

Codegraph reads an indexed local code graph. Its default MCP surface has two tools:
\`codegraph_explore\` for understanding code and \`codegraph_edit\` for constrained symbol edits.

## How to use

- Call \`codegraph_explore\` first for indexed source or flows. Ask a question or name symbols/files; for a flow, name its endpoints.
- Default explore returns current, line-numbered source, flow evidence and blast radius. Small responses also expose \`structuredContent.rendered.text\`. Treat displayed lines as already read. Gap/truncation markers mean omitted code; query the missing symbol or range before editing it. Use \`mode:"source"\` with file, offset and limit for ranges.
- Structured modes return versioned JSON for definitions, references, file symbols, diagnostics, impact, tests, status, and file text. Use \`mode:"text"\` for literal strings or configuration keys; Graph is the default backend, while diagnostics auto-routes to LSP.
- If an answer is incomplete, call explore again with the uncovered exact names.

## Editing

- \`codegraph_edit\` supports rename, replace-body, insert-before, and insert-after. It resolves targets through the index and previews by default. Apply only when \`canApply:true\` and \`blockers\` is empty.
- Direct \`apply:true\` needs no IDs: it replans, verifies current bytes, and writes transactionally. For a reviewed two-step write, pass the preview's \`previewHash\` as \`expectPreviewHash\` and reuse its \`operationId\`; reuse that ID after a timeout to avoid a duplicate write.
- Rename uses a configured language server and completes only AST-verified Graph references. Ambiguous, stale, or known unverified targets are refused.

## Boundaries

- Graph relationships are best-effort static evidence; LSP/compiler/tests remain the authority for language correctness. Runtime candidates and inferred edges are labelled, not presented as confirmed calls.
- Heed pending, stale, or degraded-index warnings. Unflagged displayed source is current; a flagged file may require sync or a direct read.
- Use \`projectPath\` for another indexed project or when this session has no default project.
- If a project has no \`.codegraph/\`, stop using Codegraph for it and use built-in tools. Indexing is the user's decision; do not run \`codegraph init\` yourself.
`;

/** Initialize guidance when no indexed project can be selected as the session default. */
export const SERVER_INSTRUCTIONS_NO_ROOT_INDEX = `# Codegraph — no default indexed project

The tools remain available. Pass \`projectPath\` to \`codegraph_explore\` or \`codegraph_edit\` for a project that already has a \`.codegraph/\` index; this supports monorepos with indexed sub-projects and querying multiple repositories.

For a project without an index, use built-in Read/Grep/Glob tools. Indexing is the user's decision: do not run it yourself, but you may mention that the user can enable it with \`codegraph init\`.
`;
