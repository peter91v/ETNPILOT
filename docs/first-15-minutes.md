# The first 15 minutes

From a fresh checkout to a run you watched, in the order that avoids surprises.

1. **Install.** `npm install` then `npm link` in the checkout (the `etnpilot` command). Node 22.13+.
   On Termux/Android: the Copilot SDK has no build there, so use `openai`, `anthropic` or `github-models`.
2. **Sign in once.** `etnpilot login openai` (or `anthropic`): paste the key, it is checked with one harmless
   request and kept in `~/.config/etnpilot/credentials.json` (mode 0600). Not wanting to keep it:
   `export OPENAI_API_KEY=…` works and wins. → [login.md](login.md)
3. **Make a project.** In the repository: `etnpilot init .`. It imports agents/skills/instructions the
   repository already has, and — with a key — **AgentsForge** reads the repository and proposes what is missing.
   `etnpilot forge --preview` shows a proposal before anything is written. → [init-import.md](init-import.md),
   [agents-forge.md](agents-forge.md)
4. **Check it end to end.** `etnpilot smoke` (a few cents): key, an answer, a tool call, a stream. A red line
   names the reason and the command that fixes it. → [first-real-run.md](first-real-run.md)
5. **Read and lock what an agent will be told.** `etnpilot ui` → *Content* shows what is new or changed;
   *Lock what I reviewed* approves exactly that. (Terminal: `etnpilot content lock`.) Commit `.etnpilot/`
   so a worktree has it. → [content-provenance.md](content-provenance.md)
6. **Run something small.** `etnpilot run "Add a health check"`, or use *Start a run* in the page. Approvals
   come to the page, the terminal screen (`etnpilot tui`) or the terminal that started the run.
   → [approval-inbox.md](approval-inbox.md)
7. **Look at what it cost.** (It counts what runs, chats and the page recorded, not `smoke` or `forge`, so the provider's dashboard shows more.) `etnpilot usage` — tokens, requests and cost by model and by day, in the terms of the
   provider's dashboard.
8. **Build a workflow.** *Agents* in the page: pick agents, put them in order, run it by name
   (`etnpilot run --workflow <name>`). → [named-workflows.md](named-workflows.md)

When something is red: `etnpilot doctor` says whether a run could start and warns about what does not stop
one; `ETNPILOT_DEBUG=1` shows failures that are otherwise carried on from.
