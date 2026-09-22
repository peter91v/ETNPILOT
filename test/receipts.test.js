import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlReceiptStore } from "../src/core/receipt-store.js";

test("receipt store serializes concurrent writes into a verifiable hash chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-receipts-"));
  const path = join(root, "receipts.jsonl");
  const store = new JsonlReceiptStore(path);
  await Promise.all([
    store.append({ sequence: 1 }),
    store.append({ sequence: 2 }),
    store.append({ sequence: 3 }),
  ]);
  const entries = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].previousHash, null);
  for (let index = 0; index < entries.length; index += 1) {
    const { hash, ...payload } = entries[index];
    assert.equal(hash, createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
    if (index > 0) assert.equal(entries[index].previousHash, entries[index - 1].hash);
  }
});
