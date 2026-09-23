# Sandboxed execution

An approved shell command is the widest hole in ETNPilot's policy: it runs with
the operator's privileges and can reach whatever that process can reach,
including the credentials in its environment. Path rules do not constrain it.
The sandbox closes that hole by running checks and approved commands inside a
disposable container.

```yaml
sandbox:
  enabled: true
  runtime: docker          # or podman
  image: node:24-bookworm-slim
  network: none            # none | bridge | host
  readOnlyRoot: true
  workdir: /workspace
  useDevcontainerImage: false
  # memory: 2g
  # cpus: "2"
  # user: "1000:1000"
  # tmpfs: [/tmp]
  # extraArgs: []
```

Each command runs as `docker run --rm --init`, with the workspace mounted at
`workdir` and nothing else. The container root filesystem is read-only, `/tmp`
is a tmpfs, and the default network is `none`.

## What the sandbox contains, and what it does not

- **Contained:** filesystem access outside the workspace, the host network
  (with `network: none`), the host process table, and the environment of the
  ETNPilot process.
- **Not contained:** anything the workspace itself allows. A command can still
  modify the files the run is meant to modify — that is the point of the run.
- **Not contained:** the model. The sandbox limits the blast radius of an
  approved command; it does not decide whether the command should have been
  approved.

## Environment variables

Only the allow-listed check environment reaches the container, and it is passed
by name (`--env PATH`) rather than by value, so no secret appears in the host's
process list. Add what a check genuinely needs through `checks.envAllow`.

## Availability

When `sandbox.enabled` is true and the runtime is missing, the run fails before
its first step:

```
Sandbox runtime 'docker' is not available: ENOENT.
Install it, or set sandbox.enabled to false to accept host execution.
```

Containment is never downgraded silently. An operator who asked for a sandbox
and got host execution instead would be worse off than one who never asked.

## Devcontainers

Projects that already describe their toolchain in
`.devcontainer/devcontainer.json` can reuse its image:

```yaml
sandbox:
  enabled: true
  useDevcontainerImage: true
```

Only a prebuilt `image` is reused. A devcontainer that builds from a Dockerfile
is rejected with a message asking you to prebuild it and name it in
`sandbox.image`; building images is a job ETNPilot does not take on.

## Receipts

Every sandboxed check records the runtime, image, network mode, and the
declared command alongside the wrapped one, so a reviewer can see both what was
asked for and what actually ran.
