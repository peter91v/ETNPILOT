# AgentsForge

`etnpilot init` can read the repository and write the agents, skills, instructions and prompts that
fit it. It happens when there is an API key it can use (`ANTHROPIC_API_KEY` for `anthropic`, or the
key of an `openai-compatible` provider such as `OPENAI_API_KEY`) and is skipped with a line saying so
when there is none. It is also a command for a project that already exists:

```bash
etnpilot forge --dry-run   # builds the digest and shows what would be sent; sends nothing
etnpilot forge             # asks the model and writes the result
etnpilot init --no-forge   # init without it
```

The web setup page and the terminal first-run screen show a switch for it (`f` in the terminal) when
a key is found, and name the provider before anything is sent.

## What is sent

One request, to the project's own provider (its default if that has a key, otherwise the first that
has), with no tools offered. The request holds a **digest**, built locally and capped at 80 KiB:

- the layout (top three levels with file counts) and the file types;
- build, test and CI files (`package.json`, `pyproject.toml`, `go.mod`, `Makefile`, workflows, …);
- the README, and one or two entry-point source files per area, each cut to 2 KiB;
- the list of test files and of documentation files;
- the names of agents, skills and instructions already in `.etnpilot/`, so it does not repeat them.

Files that hold credentials are **never read**: `.env*`, `.npmrc`, `.netrc`, `*.pem`, `*.key`,
`*.p12`, `id_rsa`/`id_ed25519`, `secrets/`, `*.tfstate`, service-account files. Text that looks like a
key, token or password in the files that are read is blanked before it is sent. This is a net, not a
guarantee; `--dry-run` lists every file that would be read. Only the digest leaves the machine, and the
run reports how many files, how many KiB and which provider.

## What comes back

The model is asked for one JSON object. Nothing else is accepted, and each part is checked here:

- an **agent** gets a name, a one-line description (the orchestrator is shown it), a prompt and tools
  chosen from `read_file, list_files, search_files, write_file, edit_file, run_command`. Anything else
  is dropped, `fetch_url` and `spawn_subagent` included. An agent that names no tool gets the three
  read-only ones, not all of them. Skills it names must be skills defined in the same answer.
- a **skill** is a `SKILL.md`; an **instruction** is a Markdown file, optionally scoped to a directory
  that exists in the repository (`../` and `.etnpilot` are refused).
- the model cannot set a provider, a model, hooks or servers. There is no field for them.

Limits: 6 agents, 6 skills, 5 instructions, and a size cap on each text. The repository's own text is
treated as data in the request, not as instructions to follow.

## What is written

Into `.etnpilot/agents`, `prompts`, `skills`, `instructions`, never over an existing file (a name that
is taken is reported). Every file says on its first line that it was forged. If the project has the
untouched starter orchestrator, it is given the forged and imported agents as `subagents` and
`spawn_subagent`, and its prompt gains a short paragraph on when to delegate.

**The output is generated text.** It is unreviewed until you have read it and run
`etnpilot content lock`; with `content.provenance.mode: enforce` a run refuses it before that. A failing
model, a missing key or an unusable answer never fails `init`: the project is created and the report
says what happened.

## It adds what is missing, not what is there

The model is told what the project already has: every agent and skill with its
one-line description, and the instruction files. It is asked to add only what
is missing and may answer with empty lists. Without the descriptions it only
saw names and wrote near-duplicates of agents that were imported.

When many agents exist that the orchestrator may not hand work to yet, the
note is one sentence with a count, pointing to **Who may hand work to it** in
the Agents view, instead of a list to type back.
