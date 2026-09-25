import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkspaceTools, WORKSPACE_TOOL_DEFINITIONS } from "../src/providers/workspace-tools.js";
import { git } from "../src/git/command.js";

// P1.3: finding something without reading everything. Without it, 'where is
// this called' meant listing directories and reading each file, which is
// impossible on a real project and ruinous on a metered provider.

const approve = (recorder) => ({
  approve: async (request) => {
    recorder?.push(request);
    return { kind: "approve-once" };
  },
});

test("a symbol in three files is found three times, with its lines", async () => {
  const root = await repository({
    "src/a.js": "import { helper } from './helper.js';\nhelper();\n",
    "src/deep/b.js": "// helper is used here too\nexport const b = helper;\n",
    "src/helper.js": "export function helper() {\n  return 1;\n}\n",
    "docs/notes.md": "nothing relevant\n",
  });
  const tools = createWorkspaceTools({ workingDirectory: root });

  const found = await tools.invoke("search_files", { pattern: "helper" }, approve());
  assert.equal(found.ok, true);
  const paths = [...new Set(found.matches.map((match) => match.path))].sort();
  assert.deepEqual(paths, ["src/a.js", "src/deep/b.js", "src/helper.js"]);
  for (const match of found.matches) {
    assert.equal(Number.isInteger(match.line) && match.line >= 1, true);
    assert.match(match.text, /helper/);
  }
  // A file with no match is not reported, and the count says how many were read.
  assert.equal(found.matches.some((match) => match.path === "docs/notes.md"), false);
  assert.equal(found.files, 4);
});

test("a glob answers a question about names without opening anything", async () => {
  const root = await repository({
    "src/a.js": "a\n",
    "src/deep/b.js": "b\n",
    "src/deep/c.md": "c\n",
    "top.js": "t\n",
  });
  const tools = createWorkspaceTools({ workingDirectory: root });

  // '**' crosses directories and also matches none, so this finds both.
  const all = await tools.invoke("search_files", { glob: "src/**/*.js" }, approve());
  assert.deepEqual(all.files.sort(), ["src/a.js", "src/deep/b.js"]);
  // A single star does not cross a directory boundary.
  const shallow = await tools.invoke("search_files", { glob: "src/*.js" }, approve());
  assert.deepEqual(shallow.files, ["src/a.js"]);
  const everywhere = await tools.invoke("search_files", { glob: "**/*.js" }, approve());
  assert.deepEqual(everywhere.files.sort(), ["src/a.js", "src/deep/b.js", "top.js"]);
});

test("a glob and a pattern together search only the matching paths", async () => {
  const root = await repository({
    "src/code.js": "const secret = 1;\n",
    "docs/text.md": "const secret = 2;\n",
  });
  const tools = createWorkspaceTools({ workingDirectory: root });
  const found = await tools.invoke("search_files", { glob: "src/**/*.js", pattern: "secret" }, approve());
  assert.deepEqual(found.matches.map((match) => match.path), ["src/code.js"]);
});

test("it reads what git tracks, and says so where there is no git", async () => {
  const root = await repository({ "tracked.js": "findme\n" });
  // Present on disk, never added: out of scope, and silently so would be
  // worse than not finding it.
  await writeFile(join(root, "untracked.js"), "findme\n");
  const tools = createWorkspaceTools({ workingDirectory: root });
  const found = await tools.invoke("search_files", { pattern: "findme" }, approve());
  assert.deepEqual(found.matches.map((match) => match.path), ["tracked.js"]);

  const loose = await mkdtemp(join(tmpdir(), "etnpilot-search-nogit-"));
  await writeFile(join(loose, "a.js"), "findme\n");
  const outside = createWorkspaceTools({ workingDirectory: loose });
  const refused = await outside.invoke("search_files", { pattern: "findme" }, approve());
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not a git checkout/);
});

test("it is a read, it is bounded, and a bad pattern is the model's to fix", async () => {
  const root = await repository(Object.fromEntries(
    Array.from({ length: 30 }, (_, index) => [`f${index}.js`, "needle\n"]),
  ));
  const tools = createWorkspaceTools({ workingDirectory: root });

  // The policy sees it as a read, so 'approval.allow: [read]' covers it and
  // 'protect-credentials' still refuses what it refuses.
  const requests = [];
  await tools.invoke("search_files", { pattern: "needle" }, approve(requests));
  assert.equal(requests[0].kind, "read");
  assert.equal(requests[0].toolName, "search_files");

  const limited = await tools.invoke("search_files", { pattern: "needle", maxResults: 5 }, approve());
  assert.equal(limited.matches.length, 5);
  assert.equal(limited.truncated, true, "a cut result says it was cut");

  const bad = await tools.invoke("search_files", { pattern: "(" }, approve());
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not a valid regular expression/);

  const empty = await tools.invoke("search_files", {}, approve());
  assert.equal(empty.ok, false);
  assert.match(empty.error, /'pattern'.*'glob'/);

  // A refused decision searches nothing at all.
  const denied = await tools.invoke("search_files", { pattern: "needle" }, {
    approve: async () => ({ kind: "reject", reason: "no" }),
  });
  assert.equal(denied.ok, false);
});

test("the tool describes itself well enough to be chosen over listing", () => {
  const search = WORKSPACE_TOOL_DEFINITIONS.find((definition) => definition.name === "search_files");
  assert.ok(search);
  assert.match(search.description, /cheaper than listing/);
  assert.match(search.description, /git tracks/);
});

async function repository(files) {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-search-"));
  await git(["init", "--initial-branch=main", "."], { cwd: root });
  await git(["config", "user.email", "tests@etnpilot.local"], { cwd: root });
  await git(["config", "user.name", "ETNPilot tests"], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await git(["add", "-A"], { cwd: root });
  await git(["commit", "-m", "fixture"], { cwd: root });
  return root;
}
