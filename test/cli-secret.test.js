import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execute = promisify(execFile);

test("secret CLI reports availability without printing the value", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-secret-cli-"));
  await mkdir(join(root, ".etnpilot"));
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1",
    "secrets:",
    "  providers:",
    "    env: { type: env, allow: [CLI_TEST_SECRET] }",
    "  values:",
    "    service.token: { provider: env, key: CLI_TEST_SECRET }",
    "",
  ].join("\n"));
  const cli = resolve("bin/etnpilot.js");
  const checked = await execute(process.execPath, [cli, "secret", "check", "service.token", "--root", root], {
    env: { ...process.env, CLI_TEST_SECRET: "never-print-this" },
  });
  const result = JSON.parse(checked.stdout);
  assert.equal(result.available, true);
  assert.doesNotMatch(checked.stdout, /never-print-this/);

  await assert.rejects(
    execute(process.execPath, [cli, "secret", "check", "unknown", "--root", root]),
    (error) => error.code === 1 && JSON.parse(error.stdout).configured === false,
  );
});
