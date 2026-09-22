# Codegraph navigation

Query the embedded code graph before cross-cutting changes. Inspect both dependencies and dependents, then verify results against source code because static extraction can be incomplete.

Useful commands:

- `etnpilot graph build .` updates only changed files in the index.
- `etnpilot graph dependencies <file>` shows outgoing imports.
- `etnpilot graph dependents <file>` shows direct consumers.
- `etnpilot graph symbols <file>` lists extracted declarations.
- `etnpilot graph impact <changed-file...>` traverses transitive consumers and identifies affected tests.
- `etnpilot graph stats` reports index coverage and schema version.
