/**
 * Short agent guidance sent during MCP initialization.
 *
 * Parameter details live only in the tools/list schemas. This text keeps tool choice,
 * trust boundaries, and write safety without injecting a second manual into every session.
 */
export const SERVER_INSTRUCTIONS = `# Codegraph

Use \`codegraph_explore\` for indexed code and \`codegraph_edit\` for constrained edits.

## How to use

- Call \`codegraph_explore\` first for source or flows; name symbols/files and flow endpoints. If the project has no \`.codegraph/\`, use built-in tools; do not run \`codegraph init\` yourself. Indexing is the user's decision.
- Explore returns source and flow evidence. “Only the main/primary call chain” collapses side branches/source; \`expand:true\` opens them. Treat displayed lines as already read. Gaps: query the missing symbol or range before editing it. Use \`mode:"source"\`, file, startLine and limit for ranges.
- JSON modes cover definitions, references, symbols, diagnostics, completion, LSP actions, impact, tests, status, text and documents. Omit \`backend\` for auto Graph/LSP. Positions use \`file\` + 1-based \`line\`, optional 0-based \`column\`; invalid combinations return a correction. Use \`backend:"lsp"\` for compiler-accurate types, definitions/references, completion, diagnostics or fixes.
- Serialized names retain field types/direction. Registered literal bridges carry evidence; dynamic keys stay partial. Generated hits show input → artifact; drift keeps artifact coordinates. \`mode:"documents"\` finds Markdown mentions; lexical fallback yields candidates.
- Same-name definitions: \`file\` or \`file#qualifiedName\` selects; \`contextFile\` ranks and retains alternatives.
- LSP cold starts wait where possible; provisional empty results say indexing. Zero callers/callees and missing targets are distinct. Empty/incomplete answers list checked matches and candidates; query the uncovered exact names.

## Editing

- Rename, LSP code-action, whole-file format, replace-body, insert-before and insert-after preview by default. Apply only when \`canApply:true\` and \`blockers\` is empty.
- Direct \`apply:true\` needs no IDs; replans and verifies bytes. Reviewed apply passes \`previewHash\` as \`expectPreviewHash\` and reuses \`operationId\`.
- Rename needs a configured language server and AST-verified references. Code-action applies text edits within the project; file operations and command execution are refused. Ambiguous/stale targets are refused.

## Boundaries

- Relations label static/inferred/candidate evidence and partial coverage. Vue/React props/emits, reflection, DI and string registrations may lack edges; empty results do not prove absence. LSP/compiler/tests govern correctness.
- Heed incomplete, pending, stale and degraded-index warnings: callers/impact may miss results. Revision separates verified HEAD, files-current without commit provenance, stale and unverified. Check disk-drift flags against files.
- Use \`projectPath\` to select another indexed project.
`;

/** Initialize guidance when no indexed project can be selected as the session default. */
export const SERVER_INSTRUCTIONS_NO_ROOT_INDEX = `# Codegraph — no default indexed project

The tools remain available. Pass \`projectPath\` to \`codegraph_explore\` or \`codegraph_edit\` for a project that already has a \`.codegraph/\` index; this supports monorepos with indexed sub-projects and querying multiple repositories.

For a project without an index, use built-in Read/Grep/Glob tools. Indexing is the user's decision: do not run it yourself, but you may mention that the user can enable it with \`codegraph init\`.
`;
