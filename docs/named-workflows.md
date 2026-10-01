# Named workflows, and the Agents and Content views

A project has had one workflow: the `workflow.steps` in `etnpilot.yaml`. It can now also have any
number of **named workflows**, each a file in `.etnpilot/workflows/<name>.yaml`:

```yaml
name: careful
description: Plan, approve, build, then check.
steps:
  - { id: plan, type: agent, agent: planner }
  - { id: approve, type: gate, needs: [plan], prompt: Go ahead? }
  - { id: build, type: agent, agent: builder, needs: [approve], expect: tool-use }
  - { id: tests, type: check, command: [npm, test], needs: [build] }
```

Step types are the ones the engine runs: `agent`, `check` (a command), `gate` (a person approves what the
step before produced) and `quorum` (several agents compare). `expect: tool-use` makes an agent step fail if it
only describes the work.

A workflow is **project content**, like an agent or a prompt: `etnpilot content lock` pins it, a run refuses
one that is not locked, and a worktree gets it from the commit. That is deliberate. A workflow that anyone
could change locally could drop its gate; as a file under review it cannot do that unnoticed.

```bash
etnpilot run "add the export" --workflow careful
```

A run names the workflow in its sealed receipt (`workflow: careful`). `--agent` wins over `--workflow`; an
unknown name is refused with the names that exist.

## In the page

- **Agents** shows every agent with what it may do ("only reads", "can change files or run commands"), its
  provider, model and effort, its skills, who it can hand work to and who hands work to it, the prompt it is
  told, where it came from (imported, forged, created here) and whether it is locked. From there: read the
  manifest, or start a run with it.
- The same view lists the project's workflows as a step flow with their problems, if they have any, and a
  **New workflow** button. The builder offers steps of the four types, which agent, which command, what the gate
  asks, and which earlier steps a step waits for, with two starting patterns. What it saves is checked by the
  same function a run uses: unknown agents, a step waiting for itself, a circle, a missing command are
  refused with the step named. It writes the file; it does not lock it.
- **New agent** opens a form: name, one line of purpose, the prompt, what it may do (ticked in plain words: reads
  files, edits files, runs commands, reads web pages …), skills it can open, agents it can hand work to, and how
  hard it thinks. `tools` is always written out, so ticking nothing means "only answers", never "every tool";
  skills and handing work on add `load_skill` and `spawn_subagent` by themselves. Like a workflow it is written
  as unreviewed content, never over an existing one, and not locked.
- **Content** lists everything a run may use, grouped by type, with `locked`, `not reviewed yet` or `changed
  since the lock` on each and where it came from. Tapping one shows its text. **Lock what I reviewed** shows
  what will be locked and, on confirmation, locks exactly the content that was on screen: the request carries
  the digest the page showed, and content that moved in the meantime is refused ("Read it again before
  locking"). Files removed since the last lock are listed too.
- The overview says when content waits for review, and **Start a run** offers the named workflows.

Locking from the page is the same act as `etnpilot content lock`; it is not a way around it. Commit
`.etnpilot/` afterwards so a worktree run has it.
