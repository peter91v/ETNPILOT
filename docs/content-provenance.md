# Content provenance

ETNPilot can pin every project-owned agent, instruction, prompt, and skill to a reviewed SHA-256
manifest. The committed lock is the authorization boundary: changing content does not update the lock
implicitly.

## Workflow

Generate or deliberately update the lock after reviewing content changes:

```bash
etnpilot content lock --root .
git diff -- .etnpilot/content-lock.json
```

Verify it without changing any file:

```bash
etnpilot content verify --root .
```

The lock is deterministic and contains a stable type, logical name, repository-relative source path,
byte length, and SHA-256 digest for each entry. Its top-level digest covers the ordered entry list.
Commit `.etnpilot/content-lock.json` with the reviewed content change.

## Configuration

New projects enable enforcement explicitly:

```yaml
content:
  provenance:
    mode: enforce
    lockFile: .etnpilot/content-lock.json
    verifyAfterRun: true
    maxEntries: 1000
    maxFileBytes: 1048576
```

Projects created before this feature remain compatible when the section is absent. Set `mode: enforce`
and create the lock to adopt the boundary. `mode: off` is an explicit migration setting and still
captures the content digest for evidence, but it does not claim that a reviewed lock was verified.

`lockFile` must remain inside the project. `maxEntries` and `maxFileBytes` bound manifest discovery and
individual content files.

## Run guarantees

An enforced run:

1. captures regular files from `.etnpilot/agents`, `.etnpilot/instructions`, `.etnpilot/prompts`, and
   `.etnpilot/skills/*/SKILL.md`;
2. rejects symbolic links, path escapes, missing locks, malformed locks, unreviewed files, removals,
   and digest mismatches;
3. constructs the harness from the already hashed in-memory snapshot;
4. verifies both content and the exact lock again after workflow execution; and
5. includes the manifest digest, lock digest, entries, and final verification result in the terminal
   workflow receipt.

When receipt signing is enabled, this evidence is covered by the existing hash chain and Ed25519
signature. A content or lock change during execution fails the workflow even if both were replaced
with a newly matching pair.

Runtime-generated guidance and plugin registrations are outside this project-content lock. Their
evidence remains governed by the provider, plugin, policy, and receipt boundaries documented
elsewhere.
