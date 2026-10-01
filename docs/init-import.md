# `etnpilot init` in a project that already has agents

`etnpilot init` does not start from nothing when the project already works with another coding
agent. It copies what is there into `.etnpilot/` and tells you what it did and what it left out.

| Found | Becomes |
| --- | --- |
| `CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.cursorrules`, `.cursor/rules/*` | `.etnpilot/instructions/imported-<tool>.md` |
| the same files in a subdirectory (`src/ui/CLAUDE.md`) | `.etnpilot/instructions/src/ui/imported-<tool>.md`, which applies only to runs that work under `src/ui` |
| `.claude/agents/*.md`, `.opencode/agent(s)/*.md`, `.github/agents/*.md` | `.etnpilot/agents/<name>.yaml` plus `.etnpilot/prompts/<name>.md` |
| `.claude/skills/*/`, `.agents/skills/*/`, `.opencode/skill(s)/*/` | `.etnpilot/skills/<name>/`, files included |

Rules it keeps:

- **Nothing is overwritten.** A file that already exists in `.etnpilot/` stays; the summary says so.
  Running `init` again imports only what is new.
- **Identical text is imported once** (an `AGENTS.md` that repeats `CLAUDE.md`).
- **Personal files stay out:** `CLAUDE.local.md`, anything under `node_modules`.
- **Tools are mapped, not guessed.** `Read`→`read_file`, `Grep`→`search_files`, `Glob`→`list_files`,
  `Write`→`write_file`, `Edit`→`edit_file`, `Bash`→`run_command`, `WebFetch`→`fetch_url`, `Task`→
  `spawn_subagent`. An agent whose source named no tools gets none either. A tool with no counterpart
  (an MCP tool, web search) is left out and named in the summary. An agent that listed only such tools
  ends up with an empty list, not with everything.
- **Models are not copied.** `sonnet` or `opus` mean nothing to another provider; the original is kept
  as a comment in the manifest.
- **Not imported on purpose:** slash commands (a run is not interactive) and hooks, MCP servers and
  permissions in `.claude/settings.json`, `.mcp.json`, `opencode.json`. Those are locked settings here
  and are set deliberately in `.etnpilot/etnpilot.yaml`.

Imported content is unreviewed. With `content.provenance.mode: enforce` (the default) a run refuses it
until you have read it and run `etnpilot content lock`; the lock is the point where you take
responsibility for it.

`etnpilot init --no-import` starts empty.
