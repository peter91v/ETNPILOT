import assert from "node:assert/strict";
import { mkdtemp, mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CodeGraph } from "../src/codegraph/codegraph.js";

test("codegraph indexes symbols and resolves internal imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-graph-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.js"), "import { b } from './b.js';\nexport function a() { return b; }\n");
  await writeFile(join(root, "src", "b.js"), "export const b = 42;\n");
  const graph = new CodeGraph(join(root, ".etnpilot", "state", "graph.sqlite"));
  try {
    const result = await graph.indexDirectory(root);
    assert.equal(result.files, 2);
    assert.equal(result.indexed, 2);
    assert.equal(result.resolvedEdges, 1);
    assert.deepEqual(graph.dependencies("src/a.js"), [{
      target: "./b.js",
      targetPath: "src/b.js",
      kind: "imports",
      dangling: false,
    }]);
    assert.deepEqual(graph.dependents("src/b.js"), [{
      source: "src/a.js",
      target: "./b.js",
      kind: "imports",
      dangling: false,
    }]);
    assert.equal(graph.symbols("src/a.js")[0].name, "a");
    assert.equal(graph.stats().schemaVersion, 2);
  } finally {
    graph.close();
  }
});

test("codegraph updates only changed files and calculates transitive test impact", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-impact-"));
  await Promise.all([
    mkdir(join(root, "src"), { recursive: true }),
    mkdir(join(root, "test"), { recursive: true }),
  ]);
  await writeFile(join(root, "src", "c.ts"), "export const c = 1;\n");
  await writeFile(join(root, "src", "b.ts"), "import { c } from './c.js';\nexport const b = c;\n");
  await writeFile(join(root, "src", "a.ts"), "import { b } from './b';\nexport const a = b;\n");
  await writeFile(join(root, "test", "a.test.ts"), "import { a } from '../src/a';\nvoid a;\n");
  const graph = new CodeGraph(join(root, ".etnpilot", "state", "graph.sqlite"));
  try {
    const first = await graph.indexDirectory(root);
    assert.equal(first.indexed, 4);
    assert.equal(first.resolvedEdges, 3);

    const second = await graph.indexDirectory(root);
    assert.equal(second.indexed, 0);
    assert.equal(second.unchanged, 4);

    await writeFile(join(root, "src", "c.ts"), "export const c = 1000;\n");
    const third = await graph.indexDirectory(root);
    assert.equal(third.indexed, 1);
    assert.equal(third.unchanged, 3);

    const impact = graph.impact(["src/c.ts"]);
    assert.deepEqual(impact.files.map(({ path, depth }) => ({ path, depth })), [
      { path: "src/c.ts", depth: 0 },
      { path: "src/b.ts", depth: 1 },
      { path: "src/a.ts", depth: 2 },
      { path: "test/a.test.ts", depth: 3 },
    ]);
    assert.deepEqual(impact.tests.map((entry) => entry.path), ["test/a.test.ts"]);
    assert.deepEqual(
      graph.impact(["src/c.ts"], { maxDepth: 1 }).files.map((entry) => entry.path),
      ["src/c.ts", "src/b.ts"],
    );

    await unlink(join(root, "src", "c.ts"));
    const fourth = await graph.indexDirectory(root);
    assert.equal(fourth.deleted, 1);
    assert.equal(graph.dependencies("src/b.ts")[0].targetPath, "src/c.ts");
    assert.equal(graph.stats().brokenEdges, 1);
    assert.deepEqual(graph.impact(["src/c.ts"]).tests.map((entry) => entry.path), ["test/a.test.ts"]);

    // The edge to a deleted file is retained so impact analysis still answers
    // "who depended on this?", but every query must mark it as dangling.
    assert.equal(graph.dependencies("src/b.ts")[0].dangling, true);
    assert.equal(graph.dependents("src/c.ts")[0].dangling, true);
    const afterDelete = graph.impact(["src/c.ts"]);
    assert.deepEqual(
      afterDelete.files.map(({ path, dangling }) => ({ path, dangling })),
      [
        { path: "src/c.ts", dangling: true },
        { path: "src/b.ts", dangling: false },
        { path: "src/a.ts", dangling: false },
        { path: "test/a.test.ts", dangling: false },
      ],
    );
  } finally {
    graph.close();
  }
});

test("codegraph migrates the legacy edge schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-graph-migration-"));
  const databasePath = join(root, "graph.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE edges (
      source_path TEXT NOT NULL,
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      UNIQUE(source_path, target, kind)
    );
  `);
  legacy.close();
  const graph = new CodeGraph(databasePath);
  try {
    const columns = graph.database.prepare("PRAGMA table_info(edges)").all().map((column) => column.name);
    assert.ok(columns.includes("target_path"));
    assert.equal(graph.stats().schemaVersion, 2);
  } finally {
    graph.close();
  }
});
