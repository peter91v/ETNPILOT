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
