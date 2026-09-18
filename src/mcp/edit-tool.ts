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
  // The default operation ID comes from stable request identity, so identical retries replay the terminal result.
  idempotentHint: true,
  openWorldHint: false,
};

export const editTools: ToolDefinition[] = [
  {
    name: 'codegraph_edit',
    // 工具描述保持「一句话定位 + 何时使用」（P0 问题 2）：apply/previewHash/operationId 的用法
    // 属于参数行为，写在 schema 里；「canApply 为真且 blockers 为空才应用」以及重命名只认
    // 语言服务器 + 已核实 Graph 引用的约束，在初始化说明的 Editing 段声明一次。
    description: 'Structured write to indexed code: rename a symbol, replace its definition, or insert code. Previews by default; a direct apply replans, verifies, and writes transactionally.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          description: 'rename (LSP), replace-body (full indexed definition), insert-before, or insert-after.',
          enum: ['rename', 'replace-body', 'insert-before', 'insert-after'],
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
          description: 'rename only: 1-based target line; pair with file.',
        },
        column: {
          type: 'number',
          description: 'rename only: 0-based UTF-16 column.',
        },
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
  },
];

/** Short names (`edit`) and full names (`codegraph_edit`) both pass the CODEGRAPH_MCP_TOOLS allowlist. */
export const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set(editTools.map((tool) => tool.name));
