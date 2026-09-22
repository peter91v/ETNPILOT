import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { Telemetry, telemetryProviderAttributes } from "../src/observability/telemetry.js";

const execute = promisify(execFile);

test("telemetry CLI summarizes one workflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-telemetry-cli-"));
  await mkdir(join(root, ".etnpilot", "state"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1",
    "observability:",
    "  file: .etnpilot/state/telemetry.jsonl",
    "",
  ].join("\n"));
  const telemetry = new Telemetry({ file: join(root, ".etnpilot", "state", "telemetry.jsonl") });
  const accounting = telemetry.recordProviderUsage({
    workflowRunId: "workflow-cli",
    model: "unpriced",
    usage: { inputTokens: 12, outputTokens: 3 },
  });
  const span = telemetry.startSpan("provider", { attributes: {
    "gen_ai.operation.name": "chat",
    "etnpilot.workflow.run_id": "workflow-cli",
  } });
  await span.end({ attributes: telemetryProviderAttributes(accounting) });

  const executed = await execute(process.execPath, [
    resolve("bin/etnpilot.js"), "telemetry", "summary", "workflow-cli", "--root", root,
  ]);
  const summary = JSON.parse(executed.stdout);
  assert.equal(summary.spans, 1);
  assert.equal(summary.inputTokens, 12);
  assert.equal(summary.outputTokens, 3);
  assert.equal(summary.unpricedInvocations, 1);
});
