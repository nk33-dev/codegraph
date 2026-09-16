/**
 * `codegraph_edit` — the MCP face of phase 4 structured editing.
 *
 * Kept in its own module (rather than in the master `tools` array) because it is the one tool that is
 * **not** read-only: the read-only annotation contract (issue #1018) is asserted over every tool in
 * that array, and quietly loosening it there would weaken an upstream guarantee for all of them. The
 * two lists are merged by `allTools` in `tools.ts`, and the default surface lists both.
 */
import type { ToolAnnotations, ToolDefinition } from './tools';

const PROJECT_PATH_DESCRIPTION = 'Absolute path to the project to edit (or any directory inside it) — codegraph uses the nearest .codegraph/ index at or above that path. Omit to use this session\'s default project.';

/** Editing mutates files, so it deliberately does NOT reuse the read-only annotations. */
export const EDIT_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  // It rewrites source files; the preview default is a safety measure, not a license to omit the hint.
  destructiveHint: true,
  // 默认 operation ID 来自稳定请求身份；同参数重试会重放终态，不会再次写入。
  idempotentHint: true,
  openWorldHint: false,
};

export const editTools: ToolDefinition[] = [
  {
    name: 'codegraph_edit',
    description: 'Structured symbol editing — rename a symbol, replace a symbol body, or insert code before/after a symbol. PREVIEWS BY DEFAULT: with apply:false (the default) it writes NOTHING and returns the per-file diff, resolved target, previewHash and operationId. Pass apply:true with both ids to write transactionally; retries with the same operationId return the persisted result without writing twice. Cross-file failure rolls committed files back, retaining a per-file recovery manifest if rollback cannot finish. Operations: rename (whole-project, uses the project\'s language server — textDocument/rename; with no server installed you get status="unavailable", never a textual guess), replace-body (replaces the indexed definition including its signature), insert-before / insert-after (insert whole lines relative to the definition). Targets resolve through the index by symbol name plus an optional exact file, or by file + line for rename. A stale file is refused. After commit the index and live language servers are synchronized. Prefer codegraph_explore first to see the symbol and its blast radius.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description: 'rename (symbol → newName, whole project, needs a language server); replace-body (replace the definition of symbol with content); insert-before / insert-after (insert content as whole lines before/after the definition of symbol).',
          enum: ['rename', 'replace-body', 'insert-before', 'insert-after'],
        },
        symbol: {
          type: 'string',
          description: 'The target symbol: an exact name or qualified name resolved through the index (e.g. "run", "View.render", "CodeGraph.queryCode"). Required for replace-body/insert-* and for a name-based rename.',
        },
        file: {
          type: 'string',
          description: 'Exact project-relative file (e.g. "src/a.ts"): pins the target when a name matches several definitions, and narrows a rename when several modules define the same name.',
        },
        line: {
          type: 'number',
          description: 'rename only: 1-based line of the symbol, for a position-based rename instead of a name (pair with file).',
        },
        column: {
          type: 'number',
          description: 'rename only: 0-based column in UTF-16 code units for the line above (default 0).',
        },
        newName: {
          type: 'string',
          description: 'rename only: the new symbol name (no whitespace).',
        },
        content: {
          type: 'string',
          description: 'replace-body/insert-*: the text to put in place (replace-body replaces the whole definition) or insert as whole lines. Written with the file\'s own line ending; for replace-body leading indentation is stripped because the declaration\'s own indentation stays in the file.',
        },
        apply: {
          type: 'boolean',
          description: 'false (default) = preview only, write nothing. true = write the files after re-verifying each one against the bytes the preview was computed from.',
          default: false,
        },
        expectPreviewHash: {
          type: 'string',
          description: 'apply only: the previewHash returned by an earlier preview of the same change; a mismatch refuses to write (status="conflict").',
        },
        operationId: {
          type: 'string',
          description: 'Stable idempotency key returned by preview. Reuse it for apply and every retry; a completed operation returns its recorded result without writing again.',
        },
        projectPath: {
          type: 'string',
          description: PROJECT_PATH_DESCRIPTION,
        },
      },
      required: ['operation'],
    },
    annotations: EDIT_TOOL_ANNOTATIONS,
  },
];

/** Short names (`edit`) and full names (`codegraph_edit`) both pass the CODEGRAPH_MCP_TOOLS allowlist. */
export const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set(editTools.map((tool) => tool.name));
