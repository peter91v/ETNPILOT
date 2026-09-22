import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execute = promisify(execFile);

test("policy CLI explains decisions without echoing request targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-policy-cli-"));
  await mkdir(join(root, ".etnpilot"));
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1",
    "policy:",
    "  operations:",
    "    default: deny",
    "    rules:",
    "      - { id: source-read, effect: allow, kinds: [read], paths: ['src/**'] }",
    "  providers:",
    "    default: deny",
    "    rules:",
    "      - { id: primary-model, effect: allow, providers: [primary] }",
    "",
  ].join("\n"));
  const cli = resolve("bin/etnpilot.js");
  const allowed = await execute(process.execPath, [
    cli, "policy", "check", "--kind", "read", "--path", "src/private-name.js", "--root", root,
  ]);
  const report = JSON.parse(allowed.stdout);
  assert.equal(report.kind, "approve-once");
  assert.equal(report.policy.rule, "source-read");
  assert.doesNotMatch(allowed.stdout, /private-name/);

  await assert.rejects(
    execute(process.execPath, [cli, "policy", "check", "--provider", "backup", "--root", root]),
    (error) => error.code === 1 && JSON.parse(error.stdout).allowed === false,
  );
});
