# Codegraph navigation

Call the local `codegraph_explore` MCP tool before planning cross-cutting changes and again when reviewing the implementation. Verify relevant results against source code because static analysis can be incomplete.

Useful commands:

- `etnpilot graph build .` initializes CodeGraph or incrementally refreshes its local index.
- `etnpilot graph dependencies <file>` shows outgoing imports.
- `etnpilot graph dependents <file>` shows direct consumers.
- `etnpilot graph symbols <file>` lists extracted declarations.
- `etnpilot graph impact <changed-file...>` traverses transitive consumers and identifies affected tests.
- `etnpilot graph stats` reports index coverage, languages, and engine version.
