import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { countRuns, readRuns } from "../src/runtime/project-state.js";

// The run list showed 20 and the badge said 20 'on disk', as if that were all
// of them. The list is a window; the count is the count.
test("the window is the newest receipts and the total is every receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "etnpilot-window-"));
  for (let index = 0; index < 25; index += 1) {
    const name = `20260930${String(index).padStart(6, "0")}-aaaa`;
    await writeFile(join(directory, `${name}.jsonl`), JSON.stringify({ terminal: true, status: "succeeded", runId: name }) + "\n");
  }
  assert.equal(await countRuns(directory), 25);
  assert.equal((await readRuns(directory, { limit: 20 })).length, 20);
  assert.equal((await readRuns(directory, { limit: 70 })).length, 25);
  assert.equal(await countRuns(join(directory, "missing")), 0);
});
