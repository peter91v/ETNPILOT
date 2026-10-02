# Writing agents, prompts, skills and instructions with a model's help

`etnpilot author` drafts one thing at a time and writes nothing until you say yes.

```
etnpilot author                                   # asks: new agent / skill / instruction, or improve one
etnpilot author agent "reviews merge requests, read-only"
etnpilot author skill "how we cut a release"
etnpilot author instruction "conventions for the api/ directory"
etnpilot author improve prompt orchestrator "shorter, and always list the files it will touch"
```

- A **new agent** comes with its prompt (`.etnpilot/agents/<name>.yaml` and `.etnpilot/prompts/<name>.md`).
  Tools are limited to the ones an agent may have; a tool the model invents is dropped.
- **improve** works on an **agent** (its prompt, and its description if wrong; never tools, skills or providers), a prompt, a skill or an instruction. It shows a diff (`-` removed, `+` added) of a prompt, skill or instruction that exists, and replaces exactly
  that file if you accept and it has not changed in the meantime. A skill keeps its front matter.
- Nothing existing is overwritten by a *new* draft. `--dry-run` shows the draft and stops; `--yes` accepts without asking
  (for scripts).
- What is written is unreviewed: read it, run `etnpilot content lock`, commit `.etnpilot/`, and your team gets the same
  agents through the merge request.

On the review page the same thing is under **Agents → Draft with AI**: you see the draft (or the diff) first and press
"Write this". The page can only accept a draft the server kept, by its id.

## Which model drafts

AgentsForge (`etnpilot forge`, also run by `init`) and `etnpilot author` use the same two settings:

| Setting | Meaning |
| --- | --- |
| `forge.provider` | the provider (from `providers`) that drafts; new projects start with `anthropic` |
| `forge.model` | the model for that provider only; new projects start with `claude-opus-5-5` |

```
etnpilot settings set forge.model claude-fable-5-1
etnpilot settings set forge.provider openai
```

If the named provider has no key, the next one with a key answers, an Anthropic provider first, then your default
provider, and the report says so. The model name is only ever sent to the provider it was set for. Projects created
before these settings existed have none; they prefer an Anthropic provider when it has a key.
