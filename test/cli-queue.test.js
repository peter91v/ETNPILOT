import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { WorkflowQueue } from "../src/workflow/queue.js";

const execute = promisify(execFile);

test("queue CLI lists, cancels, and resumes a durable job", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-queue-cli-"));
  const configRoot = join(root, ".etnpilot");
  const database = join(configRoot, "state", "workflows.sqlite");
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(configRoot, "etnpilot.yaml"), [
    "version: 1",
    "queue:",
    "  database: .etnpilot/state/workflows.sqlite",
    "",
  ].join("\n"));
  const queue = new WorkflowQueue(database);
  const { job } = queue.enqueue({ kind: "test", payload: { task: "one" } });
  queue.close();

  const cli = resolve("bin/etnpilot.js");
  const listed = await execute(process.execPath, [cli, "queue", "list", "--root", root]);
  assert.equal(JSON.parse(listed.stdout)[0].id, job.id);
  const canceled = await execute(process.execPath, [
    cli, "queue", "cancel", job.id, "--root", root, "--actor", "maintainer", "--reason", "Superseded",
  ]);
  assert.equal(JSON.parse(canceled.stdout).status, "canceled");
  const resumed = await execute(process.execPath, [cli, "queue", "resume", job.id, "--root", root]);
  assert.equal(JSON.parse(resumed.stdout).status, "queued");
});
