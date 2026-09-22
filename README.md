# ETNPilot

ETNPilot is a GitLab-first, provider-neutral harness for auditable software-engineering agents. It combines isolated Git worktrees, explicit human approvals, content-addressed receipts, reusable agents, skills, prompts, plugins, and an embedded SQLite code graph.

## Status

The repository is in early development. The first runnable vertical slice provides:

- a composable harness for providers, plugins, agents, and subagents;
- a GitHub Copilot SDK provider that uses an existing Copilot login or token;
- an OpenAI-compatible provider adapter;
- conservative approval policy hooks and proof-carrying JSONL receipts;
- isolated Git worktrees without shell interpolation;
- a client for self-hosted GitLab projects, branches, merge requests, notes, and pipelines;
- an embedded SQLite code graph for JavaScript and TypeScript;
- `.etnpilot/` project initialization and GitHub/GitLab CI.
- a dependency-aware workflow scheduler with retries, timeouts, concurrency limits, and fail-fast handling;
- `etnpilot run` for isolated agent/check workflows with chained receipts;
- an explicit `--publish` path for reviewed GitLab draft merge requests.

## Quick start

```bash
npm install
npm install @github/copilot-sdk
npm run etnpilot -- init .
npm run etnpilot -- graph build .
npm test
```

Run the configured workflow in an isolated worktree:

```bash
npm run etnpilot -- run "Implement the requested change"
```

Worktree use is configurable and can be selected per run:

```bash
# Explicit isolated worktree
npm run etnpilot -- run "Implement the change" --worktree

# Work directly in the current checkout
npm run etnpilot -- run "Implement the change" --no-worktree

# Request cleanup after success
npm run etnpilot -- run "Inspect the project" --worktree --cleanup-worktree
```

The default comes from `workspace.mode` in `.etnpilot/etnpilot.yaml`. Cleanup defaults to `never`. Requested cleanup only removes a clean worktree; a worktree containing uncommitted changes is retained and reported as `dirty-worktree`. Use `etnpilot worktree list` and `etnpilot worktree cleanup <name>` for manual housekeeping.

Operations such as writes, shell commands, and network access require confirmation in an interactive terminal and are rejected when no terminal is available. Publishing is never implicit. Once the GitLab remote and `ETNPILOT_GITLAB_TOKEN` are configured, `--publish` commits the reviewed work, pushes its run branch, and opens a draft merge request. Setting `workspace.cleanup` to `after-publish` removes the clean linked worktree after a successful publication while retaining its branch.

For GitHub Copilot, authenticate with the Copilot CLI/SDK-supported GitHub login. ETNPilot never auto-approves writes, shell commands, or network access by default.

## Repository strategy

GitHub is the initial development remote. The canonical GitLab target is:

`https://gitlab.metropol-it.at/varga.pter91/etnpilot`

Both repositories may keep their existing initial commits. Synchronization is performed through explicit branches and reviewed merges, never by rewriting `main`.

## Upstream

The design starts from `peter91v/agentwerk` at commit `87ea7e669b8cc5b24462c297817eb8f139b3eeea`. See [UPSTREAM.md](UPSTREAM.md) and [docs/architecture.md](docs/architecture.md).
