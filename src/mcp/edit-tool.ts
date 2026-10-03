/**
 * `codegraph_edit` — the MCP face of phase 4 structured editing.
 *
 * Kept in its own module (rather than in the master `tools` array) because it is the one tool that is
 * **not** read-only: the read-only annotation contract (issue #1018) is asserted over every tool in
 * that array, and quietly loosening it there would weaken an upstream guarantee for all of them. The
 * two lists are merged by `allTools` in `tools.ts`, and the default surface lists both.
 */
import type { ToolAnnotations, ToolDefinition } from './tools';

const PROJECT_PATH_DESCRIPTION = 'Project path; uses the nearest parent .codegraph index.';

/** Editing mutates files, so it deliberately does NOT reuse the read-only annotations. */
export const EDIT_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  // It rewrites source files; the preview default is a safety measure, not a license to omit the hint.
  destructiveHint: true,
  // The default operation ID comes from stable request identity, so identical retries replay the terminal result.
  idempotentHint: true,
  openWorldHint: false,
};

export const editTools: ToolDefinition[] = [
  {
    name: 'codegraph_edit',
    // The description stays "what it is + when to use it" (P0 issue 2): how apply/previewHash/
    // operationId behave belongs to the schema, while "apply only when canApply is true and
    // blockers is empty" and the rename constraints (language server plus verified Graph
    // references) are stated once in the Editing section of the initialize instructions.
    description: 'Structured code write: rename, LSP code action, replace a definition, or insert code. Previews by default; writes are transactional.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description: 'rename, code-action, format, replace-body, insert-before, or insert-after.',
          enum: ['rename', 'code-action', 'format', 'replace-body', 'insert-before', 'insert-after'],
        },
        symbol: {
          type: 'string',
          description: 'Exact or qualified target name. Required except for position-based rename.',
        },
        file: {
          type: 'string',
          description: 'Exact project-relative file; disambiguates same-named definitions.',
        },
        line: {
          type: 'number',
          description: 'rename/code-action: 1-based line; pair with file.',
        },
        column: {
          type: 'number',
          description: 'rename/code-action: 0-based UTF-16 column.',
        },
        actionIndex: { type: 'number', description: 'code-action result index (default 0).' },
        tabSize: { type: 'number', description: 'format: indent width (default 2).' },
        insertSpaces: { type: 'boolean', description: 'format: spaces, not tabs (default true).' },
        newName: {
          type: 'string',
          description: 'rename only: new name without whitespace.',
        },
        content: {
          type: 'string',
          description: 'replace-body/insert only: replacement definition or inserted lines.',
        },
        apply: {
          type: 'boolean',
          description: 'false previews; true replans, verifies, and writes. IDs are optional.',
          default: false,
        },
        verbosePreview: {
          type: 'boolean',
          description: 'Show full JSON text.',
        },
        expectPreviewHash: {
          type: 'string',
          description: 'apply only, optional: bind the write to an earlier previewHash.',
        },
        operationId: {
          type: 'string',
          description: 'Optional idempotency key; reuse the preview ID for apply and retries.',
        },
        projectPath: {
          type: 'string',
          description: PROJECT_PATH_DESCRIPTION,
        },
      },
      required: ['operation'],
    },
    annotations: EDIT_TOOL_ANNOTATIONS,
    // Loaded from the first prompt in Claude Code, like `codegraph_explore`; otherwise the only write
    // path is hidden behind a ToolSearch step and never gets used.
    _meta: { 'anthropic/alwaysLoad': true },
  },
];

/** Short names (`edit`) and full names (`codegraph_edit`) both pass the CODEGRAPH_MCP_TOOLS allowlist. */
export const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set(editTools.map((tool) => tool.name));
