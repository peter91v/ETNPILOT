import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSandboxCommand, createSandbox } from "../src/runtime/sandbox.js";
import { createWorkspaceTools } from "../src/providers/workspace-tools.js";

test("a sandboxed command runs in a disposable container without a network", () => {
  const sandbox = createSandbox({
    enabled: true,
    image: "node:24-bookworm-slim",
    memory: "2g",
    cpus: "2",
    user: "1000:1000",
  }, { workspace: "/srv/run-1", probe: async () => ({ available: true }) });

  assert.deepEqual(sandbox.wrap(["npm", "test"], { env: { PATH: "/usr/bin", ETNPILOT_CHECK: "1" } }), [
    "docker", "run", "--rm", "--init",
    "--network=none",
    "--workdir", "/workspace",
    "--volume", "/srv/run-1:/workspace",
    "--read-only",
    "--tmpfs", "/tmp",
    "--user", "1000:1000",
    "--memory=2g",
    "--cpus=2",
    // Names only: values are inherited, never placed in the process list.
    "--env", "PATH",
    "--env", "ETNPILOT_CHECK",
    "node:24-bookworm-slim",
    "npm", "test",
  ]);
  assert.deepEqual(sandbox.describe(), {
    runtime: "docker",
    image: "node:24-bookworm-slim",
    network: "none",
    readOnlyRoot: true,
    memory: "2g",
    cpus: "2",
  });
});

test("sandbox configuration is validated and containment is never silently dropped", async () => {
  assert.equal(createSandbox({ enabled: false }, { workspace: "/srv/run" }), undefined);
  assert.throws(
    () => createSandbox({ enabled: true, runtime: "chroot" }, { workspace: "/srv/run" }),
    /Unsupported sandbox runtime 'chroot'/,
  );
  assert.throws(
    () => createSandbox({ enabled: true, network: "vpn" }, { workspace: "/srv/run" }),
    /Unsupported sandbox network 'vpn'/,
  );
  assert.throws(() => buildSandboxCommand("npm test", { runtime: "docker" }), /non-empty array of strings/);

  const unavailable = createSandbox({ enabled: true }, {
    workspace: "/srv/run",
    probe: async () => ({ available: false, reason: "ENOENT" }),
  });
  await assert.rejects(
    () => unavailable.assertAvailable(),
    /Sandbox runtime 'docker' is not available: ENOENT\..*set sandbox\.enabled to false/s,
  );

  const escaping = createSandbox({ enabled: true }, { workspace: "/srv/run" });
  assert.throws(() => escaping.wrap(["ls"], { cwd: "/etc" }), /must stay inside the workspace/);
  assert.deepEqual(
    escaping.wrap(["ls"], { cwd: "/srv/run/src" }).slice(0, 6),
    ["docker", "run", "--rm", "--init", "--network=none", "--workdir"],
  );
  assert.equal(escaping.wrap(["ls"], { cwd: "/srv/run/src" })[6], "/workspace/src");
});

test("workspace tools route approved commands through the sandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-sandbox-tools-"));
  await writeFile(join(root, "file.txt"), "data\n");
  const wrapped = [];
  const sandbox = {
    describe: () => ({ runtime: "docker", image: "test-image", network: "none", readOnlyRoot: true }),
    wrap: (command) => {
      wrapped.push(command);
      // Stand in for the container: prove the real command was wrapped.
      return [process.execPath, "-e", `process.stdout.write(${JSON.stringify(JSON.stringify(command))})`];
    },
  };
  const tools = createWorkspaceTools({ workingDirectory: root, sandbox });
  const approved = [];
  const result = await tools.invoke("run_command", { command: ["npm", "test"] }, {
    approve: async (request) => (approved.push(request), { kind: "approve-once" }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(wrapped, [["npm", "test"]]);
  assert.deepEqual(JSON.parse(result.stdout), ["npm", "test"]);
  assert.deepEqual(result.sandbox.image, "test-image");
  // The human still approves the command the model asked for.
  assert.equal(approved[0].fullCommandText, "npm test");
});

test("a devcontainer image is reused when the project already declares one", async () => {
  const { readDevcontainerImage } = await import("../src/runtime/sandbox.js");
  const { mkdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "etnpilot-devcontainer-"));
  await mkdir(join(root, ".devcontainer"), { recursive: true });

  // devcontainer.json is JSONC: comments and trailing commas are legal.
  await writeFile(join(root, ".devcontainer", "devcontainer.json"), [
    "{",
    '  // The team image, with the full toolchain.',
    '  "name": "team", /* inline */',
    '  "image": "registry.example.invalid/team/dev:2026.01",',
    '  "note": "a // slash inside a string stays",',
    "}",
    "",
  ].join("\n"));
  assert.deepEqual(await readDevcontainerImage(root), {
    image: "registry.example.invalid/team/dev:2026.01",
    source: join(".devcontainer", "devcontainer.json"),
  });

  await writeFile(join(root, ".devcontainer", "devcontainer.json"), JSON.stringify({
    name: "built",
    build: { dockerfile: "Dockerfile", args: { NODE_VERSION: "24" } },
  }));
  const building = await readDevcontainerImage(root);
  assert.equal(building.image, undefined);
  assert.equal(building.reason, "build-required");
  assert.deepEqual(building.build, {
    dockerfile: join(".devcontainer", "Dockerfile"),
    context: join(".devcontainer", "."),
    args: { NODE_VERSION: "24" },
  });

  const empty = await mkdtemp(join(tmpdir(), "etnpilot-no-devcontainer-"));
  assert.deepEqual(await readDevcontainerImage(empty), { image: undefined, reason: "no-devcontainer" });
});

test("a devcontainer image is built once and reused by content", async () => {
  const { buildDevcontainerImage } = await import("../src/runtime/sandbox.js");
  const { mkdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "etnpilot-devcontainer-build-"));
  await mkdir(join(root, ".devcontainer"), { recursive: true });
  await writeFile(join(root, ".devcontainer", "Dockerfile"), "FROM node:24-bookworm-slim\n");
  const build = { dockerfile: join(".devcontainer", "Dockerfile"), context: ".devcontainer", args: { NODE_VERSION: "24" } };

  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    // The first inspect misses, later ones find the tag we just built.
    const isInspect = args[0] === "image";
    return { code: isInspect && calls.filter(([, verb]) => verb === "build").length === 0 ? 1 : 0 };
  };

  const first = await buildDevcontainerImage(root, { build, run });
  assert.equal(first.built, true);
  assert.match(first.image, /^etnpilot-devcontainer:[a-f0-9]{16}$/);
  assert.deepEqual(calls[0].slice(0, 3), ["docker", "image", "inspect"]);
  assert.deepEqual(calls[1].slice(0, 2), ["docker", "build"]);
  assert.ok(calls[1].includes("--build-arg"));
  assert.ok(calls[1].includes("NODE_VERSION=24"));

  // An unchanged definition reuses the image instead of rebuilding it.
  const second = await buildDevcontainerImage(root, { build, run });
  assert.deepEqual(second, { image: first.image, built: false, reason: "cached" });

  // A changed Dockerfile cannot be served from the old tag.
  await writeFile(join(root, ".devcontainer", "Dockerfile"), "FROM node:24-bookworm\n");
  const changed = await buildDevcontainerImage(root, { build, run: async () => ({ code: 0 }) });
  assert.notEqual(changed.image, first.image);

  // A build that fails is reported rather than returning an unusable tag.
  await assert.rejects(
    () => buildDevcontainerImage(root, { build, run: async (_c, args) => ({ code: args[0] === "build" ? 2 : 1 }) }),
    /Building the devcontainer image failed \(docker build exited with 2\)/,
  );

  // The build must stay inside the project.
  await assert.rejects(
    () => buildDevcontainerImage(root, { build: { dockerfile: "../escape/Dockerfile" }, run }),
    /must stay inside the project/,
  );
});
