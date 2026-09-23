import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CodeGraph,
  createCodeGraphMcpServer,
  isCodeGraphSourcePath,
  isCodeGraphUnavailable,
} from "../src/codegraph/codegraph.js";
import { git } from "../src/git/command.js";
import { needsCodeGraphEngine } from "./helpers/codegraph-engine.js";
import { runProject } from "../src/runtime/project-runner.js";


test("CodeGraph indexes multiple languages through the upstream engine", needsCodeGraphEngine, async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-codegraph-languages-"));
  await Promise.all([
    writeFile(join(root, "service.py"), "def python_service():\n    return 1\n"),
    writeFile(join(root, "service.go"), "package sample\nfunc GoService() int { return 1 }\n"),
    writeFile(join(root, "Service.java"), "final class Service { int javaService() { return 1; } }\n"),
    writeFile(join(root, "Service.cs"), "class Service { int CSharpService() { return 1; } }\n"),
  ]);

  const graph = new CodeGraph(root);
  try {
    const result = await graph.indexDirectory();
    assert.equal(result.initialized, true);
    assert.equal(result.files, 4);
    assert.deepEqual(result.languages, ["csharp", "go", "java", "python"]);
    assert.ok(graph.symbols("service.py").some((symbol) => symbol.name === "python_service"));
    assert.ok(graph.symbols("service.go").some((symbol) => symbol.name === "GoService"));
    assert.ok(graph.symbols("Service.java").some((symbol) => symbol.name === "Service"));
    assert.ok(graph.symbols("Service.cs").some((symbol) => symbol.name === "CSharpService"));
    assert.equal(graph.stats().engine, "@colbymchenry/codegraph");
  } finally {
    graph.close();
  }
});

test("CodeGraph syncs changes and calculates transitive test impact", needsCodeGraphEngine, async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-codegraph-impact-"));
  await Promise.all([
    mkdir(join(root, "src"), { recursive: true }),
    mkdir(join(root, "test"), { recursive: true }),
  ]);
  await writeFile(join(root, "src", "c.ts"), "export const c = 1;\n");
  await writeFile(join(root, "src", "b.ts"), "import { c } from './c';\nexport const b = c;\n");
  await writeFile(join(root, "src", "a.ts"), "import { b } from './b';\nexport const a = b;\n");
  await writeFile(join(root, "test", "a.test.ts"), "import { a } from '../src/a';\nvoid a;\n");

  const graph = new CodeGraph(root);
  try {
    const first = await graph.indexDirectory();
    assert.equal(first.indexed, 4);
    assert.deepEqual(graph.dependencies("src/a.ts"), [{
      target: "src/b.ts",
      targetPath: "src/b.ts",
      kind: "imports",
      dangling: false,
    }]);
    assert.deepEqual(graph.dependents("src/b.ts"), [{
      source: "src/a.ts",
      target: "src/b.ts",
      kind: "imports",
      dangling: false,
    }]);

    const second = await graph.indexDirectory();
    assert.equal(second.operation, "sync");
    assert.equal(second.indexed, 0);

    await writeFile(join(root, "src", "c.ts"), "export const c = 1000;\n");
    const third = await graph.indexDirectory();
    assert.equal(third.indexed, 1);

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
  } finally {
    graph.close();
  }
});

test("CodeGraph MCP configuration is local, bounded, and read-only by default", () => {
  const root = "/tmp/project";
  const server = createCodeGraphMcpServer(root, { startupTimeoutMs: 1234 });
  assert.equal(server.type, "local");
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args.slice(-4), ["serve", "--mcp", "--path", root]);
  assert.deepEqual(server.tools, ["codegraph_explore"]);
  assert.equal(server.timeout, 1234);
  assert.deepEqual(server.env, {
    CODEGRAPH_TELEMETRY: "0",
    CODEGRAPH_NO_UPDATE_CHECK: "1",
  });
  assert.throws(
    () => createCodeGraphMcpServer(root, { tools: ["filesystem_read"] }),
    /CodeGraph MCP tool names/,
  );
});

test("CodeGraph source detection covers the supported workflow languages", () => {
  for (const path of ["a.py", "a.go", "A.java", "A.cs", "a.rs", "a.php", "a.swift", "a.tsx"]) {
    assert.equal(isCodeGraphSourcePath(path), true, path);
  }
  assert.equal(isCodeGraphSourcePath("README.md"), false);
});

test("a machine with no CodeGraph bundle loses the index, not the run", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-codegraph-absent-"));
  await mkdir(join(root, ".etnpilot", "agents"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n.codegraph/\n");
  await writeFile(join(root, ".etnpilot", "agents", "worker.yaml"), "name: worker\nprovider: fake\nprompt: Do it.\n");
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1",
    "defaultAgent: worker",
    "providers:",
    "  fake:",
    "    type: fake",
    "content:",
    "  provenance:",
    "    mode: off",
    "observability:",
    "  enabled: false",
    // Left at the committed default, which enables CodeGraph.
    "",
  ].join("\n"));
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "ETNPilot Test"],
    ["add", "."],
    ["commit", "-m", "initial"],
  ]) await git(args, { cwd: root });

  const absent = () => {
    throw new Error(
      "codegraph: the programmatic API is unavailable because the platform bundle\n"
      + "(@colbymchenry/codegraph-android-arm64) is not installed.",
    );
  };
  const result = await runProject({
    root,
    input: "do the work",
    codegraphImporter: absent,
    providerFactories: { fake: (name) => ({ name, invoke: () => ({ text: "done" }) }) },
  });

  assert.equal(result.summary.status, "succeeded", "an absent index must not cost the run");
  // But the receipt says so, or a later reader would assume the index was used.
  assert.equal(result.codegraph.available, false);
  assert.match(result.codegraph.reason, /platform bundle/);
  assert.equal(result.codegraph.after, undefined);

  const receipt = await readFile(result.receiptPath, "utf8");
  assert.match(receipt, /"available":false/);
});

test("an indexing failure that is not about the platform still stops the run", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-codegraph-broken-"));
  await mkdir(join(root, ".etnpilot", "agents"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n.codegraph/\n");
  await writeFile(join(root, ".etnpilot", "agents", "worker.yaml"), "name: worker\nprovider: fake\nprompt: Do it.\n");
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1",
    "defaultAgent: worker",
    "providers:",
    "  fake:",
    "    type: fake",
    "content:",
    "  provenance:",
    "    mode: off",
    "observability:",
    "  enabled: false",
    "",
  ].join("\n"));
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "ETNPilot Test"],
    ["add", "."],
    ["commit", "-m", "initial"],
  ]) await git(args, { cwd: root });

  await assert.rejects(
    runProject({
      root,
      input: "do the work",
      codegraphImporter: () => { throw new Error("the index database is corrupt"); },
      providerFactories: { fake: (name) => ({ name, invoke: () => ({ text: "done" }) }) },
    }),
    /the index database is corrupt/,
  );
});

test("the platform-bundle failure is told apart from every other one", () => {
  assert.equal(isCodeGraphUnavailable(new Error(
    "codegraph: the programmatic API is unavailable because the platform bundle (x) is not installed.",
  )), true);
  assert.equal(isCodeGraphUnavailable(new Error("CodeGraph produced an incomplete index (state: failed).")), false);
  assert.equal(isCodeGraphUnavailable(new Error("Cannot find module '@colbymchenry/codegraph'")), false);
  assert.equal(isCodeGraphUnavailable(undefined), false);
});
