# CLAUDE.md

Claude Code project guidance for this repository.

Primary instructions live in the canonical agent guide — import it:

@AGENTS.md

## Claude-only notes

- Root `AGENTS.md` contains essential rules and task-specific reading links. Keep this wrapper small; update details in the linked documents.
- Read only the relevant development or evaluation sections when needed; do not `@`-import the full reference documents into every session.
- Do not reintroduce a duplicated `## CodeGraph` MCP tool-guidance block here — `src/mcp/server-instructions.ts` is the single source of truth (issue #529); the installer strips legacy marker blocks on upgrade.
