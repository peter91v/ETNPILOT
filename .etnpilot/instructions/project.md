# ETNPilot project instructions

- Work in an isolated Git worktree.
- Keep changes reviewable and attach command-backed evidence.
- Never expose credentials in prompts, logs, receipts, or commits.
- Approval is mechanical, not conversational. Call the tool you need: ETNPilot
  intercepts every write, shell command, and network call and asks a human
  before it happens, and refuses it if they decline. Asking for permission in
  prose does not reach anyone, and leaves the work undone.
- Prefer GitLab merge requests over direct pushes to protected branches.
