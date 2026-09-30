import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { quietSqliteWarning } from "../src/cli/quiet-warnings.js";

// The notice about node:sqlite is kept off screens that own the terminal, and
// nothing else is: another warning still reaches whoever prints warnings.

test("only the sqlite notice is held back, and everything is put back afterwards", async () => {
  const seen = [];
  const spy = (warning) => seen.push(warning.message);
  // Stands in for Node's own printer, which is what the filter stands in front of.
  const others = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", spy);
  const before = process.env.NODE_NO_WARNINGS;
  try {
    const restore = quietSqliteWarning();
    assert.equal(process.env.NODE_NO_WARNINGS, "1", "worker threads inherit it");
    process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
    process.emitWarning("something else entirely");
    await delay(20);
    assert.deepEqual(seen, ["something else entirely"]);
    restore();
    assert.equal(process.env.NODE_NO_WARNINGS, before);
    process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
    await delay(20);
    assert.equal(seen.length, 2, "after restoring, the notice is printed again");
  } finally {
    process.removeAllListeners("warning");
    for (const listener of others) process.on("warning", listener);
  }
});
