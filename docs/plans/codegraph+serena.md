Develop **CodeGraph**; Serena serves only as a reference, and the Serena project is not modified.

The previously planned features fall into several categories:

1. **CodeGraph core improvements**
   - incremental indexing;
   - index version and cache invalidation;
   - handling of branches, renames and deleted files;
   - query results with stable paths, line numbers and symbol kinds;
   - unified CLI/MCP output.
2. **LSP capabilities modeled on Serena**
   - find definition;
   - find references;
   - find implementations;
   - get diagnostics;
   - file symbol overview;
   - symbol rename;
   - insert or replace code by symbol.
3. **CodeGraph extended capabilities**
   - a unified MCP entry point for graph queries and LSP queries;
   - automatic routing;
   - change impact analysis;
   - Git awareness;
   - test association;
   - code health checks;
   - diagnostics for the index, queries and background services;
   - multi-window sharing of the index and LSP services.

I suggest developing in this order first:

**Phase 1: build the unified foundation first, without wiring in LSP immediately**

- unify the MCP return structure;
- add CodeGraph implementations of definition, reference and symbol overview;
- improve incremental indexing and index status;
- add regression tests against real projects.

**Phase 2: wire in the LSP MVP**

Support only Rust, TypeScript and JavaScript, which are the most needed right now:

- `find_definition`
- `find_references`
- `get_diagnostics`
- `get_symbols`

Implement per-project lazy startup, reuse and idle exit first, and do not install language servers automatically.

**Phase 3: unified routing and impact analysis**

- MCP automatically decides whether to use graph query or LSP;
- merge the two kinds of results;
- add change impact scope and related test queries;
- add the multi-window shared service.

**Phase 4: structured editing**

- symbol rename;
- replace symbol body;
- insert code before and after a symbol;
- reuse CodeGraph's existing edit flow after generating a change preview.

The most recommended first real feature is: **implement definition, reference and diagnostics for Rust/TypeScript/JavaScript first, and expose them through the existing MCP**. That validates fastest whether the architecture is sound, and it does not get bogged down at the start in the complexity of multi-language LSP management and automatic installation.
