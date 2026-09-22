import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodeGraph } from "../src/codegraph/codegraph.js";

test("embedded codegraph indexes files, symbols, and imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-graph-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.js"), "import { b } from './b.js';\nexport function a() { return b; }\n");
  await writeFile(join(root, "src", "b.js"), "export const b = 42;\n");
  const graph = new CodeGraph(join(root, ".etnpilot", "state", "graph.sqlite"));
  try {
    const result = await graph.indexDirectory(root);
    assert.equal(result.files, 2);
    assert.equal(result.edges, 1);
    assert.deepEqual(graph.dependencies("src/a.js"), [{ target: "./b.js", kind: "imports" }]);
  } finally {
    graph.close();
  }
});
