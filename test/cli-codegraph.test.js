import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { needsCodeGraphEngine } from "./helpers/codegraph-engine.js";

const execute = promisify(execFile);

test("graph CLI initializes and queries the local CodeGraph index", needsCodeGraphEngine, async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-codegraph-cli-"));
  await writeFile(join(root, "service.py"), "def service():\n    return 42\n");
  const cli = resolve("bin/etnpilot.js");

  const built = JSON.parse((await execute(process.execPath, [cli, "graph", "build", root])).stdout);
  assert.equal(built.initialized, true);
  assert.deepEqual(built.languages, ["python"]);

  const symbols = JSON.parse((await execute(process.execPath, [
    cli, "graph", "symbols", "service.py", "--root", root,
  ])).stdout);
  assert.ok(symbols.some((symbol) => symbol.name === "service"));

  const stats = JSON.parse((await execute(process.execPath, [
    cli, "graph", "stats", "--root", root,
  ])).stdout);
  assert.equal(stats.engine, "@colbymchenry/codegraph");
  assert.equal(stats.filesByLanguage.python, 1);
});
