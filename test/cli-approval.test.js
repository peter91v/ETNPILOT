import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { ApprovalInbox } from "../src/core/approval-inbox.js";

const execute = promisify(execFile);

test("approval CLI lists and resolves a pending request", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-approval-cli-"));
  const configRoot = join(root, ".etnpilot");
  const database = join(configRoot, "state", "approvals.sqlite");
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(configRoot, "etnpilot.yaml"), [
    "version: 1",
    "approval:",
    "  inbox:",
    "    database: .etnpilot/state/approvals.sqlite",
    "",
  ].join("\n"));
  const inbox = new ApprovalInbox(database);
  const pending = inbox.create({ kind: "write", fileName: "src/result.js" }, { runId: "run-cli" });
  inbox.close();

  const cli = resolve("bin/etnpilot.js");
  const listed = await execute(process.execPath, [cli, "approval", "list", "--root", root]);
  assert.equal(JSON.parse(listed.stdout)[0].id, pending.id);
  const approved = await execute(process.execPath, [
    cli, "approval", "approve", pending.id, "--root", root, "--actor", "maintainer", "--reason", "Reviewed",
  ]);
  assert.equal(JSON.parse(approved.stdout).status, "approved");

  const verify = new ApprovalInbox(database);
  try {
    assert.equal(verify.get(pending.id).decidedBy, "maintainer");
  } finally {
    verify.close();
  }
});
