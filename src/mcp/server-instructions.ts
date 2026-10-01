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

- Call \`codegraph_explore\` first for indexed source or flows. Ask a question or name symbols/files; for a flow, name its endpoints. If the project has no \`.codegraph/\`, stop using Codegraph for it and use built-in tools instead — indexing is the user's decision, so do not run \`codegraph init\` yourself (you may mention it).
- Default explore returns current, line-numbered source, flow evidence and blast radius. MCP exploration returns text only so clients receive the source. Treat displayed lines as already read. Gap/truncation markers mean omitted code; query the missing symbol or range before editing it. Use \`mode:"source"\` with file, startLine and limit for ranges.
- Structured JSON modes cover definitions/types/implementations, references, symbols/hover/hierarchies, diagnostics/code-actions, impact/tests/status/text. Graph is the default; LSP-only modes route automatically. Ask for \`backend:"lsp"\` when compiler-accurate types, diagnostics, or fixes matter.
- If an answer is empty or incomplete, call explore again with the uncovered exact names; an empty result reports the lexical matches it checked and may name indexed candidates to retry with.

## Editing

- \`codegraph_edit\` supports rename, LSP code-action, replace-body, insert-before and insert-after; it previews by default. Code actions may apply text fixes such as imports, but refuse file operations and command-only actions. Apply only when \`canApply:true\` and \`blockers\` is empty.
- Direct \`apply:true\` needs no IDs: it replans, verifies current bytes, and writes transactionally. For a reviewed two-step write, pass the preview's \`previewHash\` as \`expectPreviewHash\` and reuse its \`operationId\`; reuse that ID after a timeout to avoid a duplicate write.
- Rename and code-action use a configured language server. Rename completes only AST-verified Graph references; code-action applies only reviewed text edits inside the project. Ambiguous, stale, or unsafe targets are refused.

## Boundaries

- Graph edges are static evidence; LSP/compiler/tests govern correctness. Vue/React props/emits and runtime candidates are labelled as inferred; computed bindings and events may be missing.
- Heed index warnings: callers/impact may miss results. Revision separates verified HEAD, unchanged files without commit provenance, stale and unverified. Verify disk-drift flags against files.
- Use \`projectPath\` for another indexed project or when this session has no default project.
`;

/** Initialize guidance when no indexed project can be selected as the session default. */
export const SERVER_INSTRUCTIONS_NO_ROOT_INDEX = `# Codegraph — no default indexed project

The tools remain available. Pass \`projectPath\` to \`codegraph_explore\` or \`codegraph_edit\` for a project that already has a \`.codegraph/\` index; this supports monorepos with indexed sub-projects and querying multiple repositories.

For a project without an index, use built-in Read/Grep/Glob tools. Indexing is the user's decision: do not run it yourself, but you may mention that the user can enable it with \`codegraph init\`.
`;
