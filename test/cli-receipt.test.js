import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { initializeProject } from "../src/config/init.js";
import { JsonlReceiptStore } from "../src/core/receipt-store.js";
import { createReceiptSigner } from "../src/core/receipt-signing.js";

const execute = promisify(execFile);

test("receipt CLI generates keys and strictly verifies a sealed signed chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-receipt-cli-"));
  await initializeProject(root);
  const cli = resolve("bin/etnpilot.js");
  const generated = await execute(process.execPath, [cli, "receipt", "keygen", "--root", root]);
  const key = JSON.parse(generated.stdout);
  assert.match(key.keyId, /^sha256:/);

  const receiptPath = join(root, ".etnpilot", "state", "runs", "signed.jsonl");
  const signer = createReceiptSigner(await readFile(key.privateKeyPath, "utf8"));
  const store = new JsonlReceiptStore(receiptPath, { signer });
  await store.append({ type: "agent", status: "succeeded" });
  await store.append({ type: "workflow", status: "succeeded", terminal: true });

  const verified = await execute(process.execPath, [cli, "receipt", "verify", receiptPath, "--root", root]);
  const report = JSON.parse(verified.stdout);
  assert.equal(report.valid, true);
  assert.equal(report.signed, 2);
  assert.equal(report.terminal, true);

  const lines = (await readFile(receiptPath, "utf8")).trim().split("\n");
  await writeFile(receiptPath, `${lines[0]}\n`);
  await assert.rejects(
    execute(process.execPath, [cli, "receipt", "verify", receiptPath, "--root", root]),
    (error) => error.code === 1 && JSON.parse(error.stdout).reason === "terminal-receipt-required",
  );
});
