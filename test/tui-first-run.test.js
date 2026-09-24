import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { stripAnsi } from "../src/tui/ansi.js";
import { createFirstRunApp, renderFirstRun } from "../src/tui/first-run.js";
import { createProject, describeProject, projectTemplates } from "../src/runtime/first-run.js";
import { git } from "../src/git/command.js";
import { openProjectState } from "../src/runtime/project-state.js";

test("an empty directory is described, not reported as a missing file", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-first-"));
  const status = await describeProject({ root });
  assert.equal(status.exists, false);
  assert.equal(status.configFile, join(root, ".etnpilot", "etnpilot.yaml"));
  // Not a checkout: a project can still be created, and this is the thing a
  // person hits next, so it is answered here rather than at the first run.
  assert.equal(status.checkout.inside, false);
  assert.deepEqual(status.templates.map((template) => template.id), ["default", "minimal", "regulated"]);

  await git(["init", "--initial-branch=main", "."], { cwd: root });
  assert.equal((await describeProject({ root })).checkout.inside, true);
});

test("a template's description is the settings it actually writes", async () => {
  const templates = projectTemplates();
  const minimal = templates.find((template) => template.id === "minimal");
  assert.deepEqual(minimal.changes.map((change) => change.path), [
    "codegraph.enabled",
    "observability.enabled",
    "content.provenance.mode",
  ]);
  assert.equal(minimal.about.length > 10, true);

  // And what it writes is what it said: read back out of the created file.
  const root = await mkdtemp(join(tmpdir(), "etnpilot-first-minimal-"));
  const created = await createProject({ root, template: "minimal" });
  assert.equal(created.template, "minimal");
  const config = YAML.parse(await readFile(created.configFile, "utf8"));
  assert.equal(config.codegraph.enabled, false);
  assert.equal(config.observability.enabled, false);
  assert.equal(config.content.provenance.mode, "off");

  // A name that is not one of the rows never reaches initializeProject.
  const other = await mkdtemp(join(tmpdir(), "etnpilot-first-bad-"));
  await assert.rejects(() => createProject({ root: other, template: "../../etc" }), /Unknown project template/);
  await assert.rejects(access(join(other, ".etnpilot")), /ENOENT/);
});

test("the screen offers the choice, and creating it hands back what it made", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-first-app-"));
  const app = createFirstRunApp({ root, output: fakeOutput(), input: new EventEmitter() });
  await app.refresh();
  let frame = stripAnsi(app.frame().join("\n"));
  assert.match(frame, /no project here yet/);
  assert.match(frame, /has no '\.etnpilot\/etnpilot\.yaml'/);
  assert.match(frame, /q leaves without touching anything/);
  // The selected row shows what it would change, so the choice is readable
  // rather than three words to be taken on trust.
  await app.handle("j");
  frame = stripAnsi(app.frame().join("\n"));
  assert.match(frame, /codegraph\.enabled\s+false/);

  // 'q' creates nothing at all.
  assert.equal(await app.handle("q"), false);
  assert.equal(app.created, undefined);
  await assert.rejects(access(join(root, ".etnpilot")), /ENOENT/);

  // Enter creates the selected one and closes the screen, so the caller can
  // open the real interface on what now exists.
  const second = createFirstRunApp({ root, output: fakeOutput(), input: new EventEmitter() });
  await second.refresh();
  await second.handle("j");
  assert.equal(await second.handle("\r"), false);
  assert.equal(second.created.template, "minimal");
  const state = await openProjectState({ root });
  try {
    assert.equal(state.config.codegraph.enabled, false);
  } finally {
    state.close();
  }
});

test("a refusal appears on the screen that asked, and creates nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-first-refuse-"));
  // A file where the directory has to go: the write fails, and the screen has
  // to say so rather than closing as though it had worked.
  await writeFile(join(root, ".etnpilot"), "not a directory\n");
  const app = createFirstRunApp({ root, output: fakeOutput(), input: new EventEmitter() });
  await app.refresh();
  assert.equal(await app.handle("\r"), true, "the screen stays open");
  assert.equal(app.created, undefined);
  assert.match(stripAnsi(app.frame().join("\n")), /ENOTDIR|EEXIST|not a directory/);
});

test("the view says when it is inside a checkout, and where", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-first-checkout-"));
  const inside = renderFirstRun(
    { root, configFile: "x", exists: false, directory: true, checkout: { inside: true, top: "/repo" }, templates: projectTemplates() },
    { width: 100, height: 30, color: false },
  ).join("\n");
  assert.match(inside, /Inside the checkout at \/repo/);
  assert.equal(/not a git checkout/.test(inside), false);

  const outside = renderFirstRun(
    { root, configFile: "x", exists: false, directory: true, checkout: { inside: false }, templates: projectTemplates() },
    { width: 100, height: 30, color: false },
  ).join("\n");
  assert.match(outside, /not a git checkout/);
});

function fakeOutput() {
  const output = new EventEmitter();
  output.columns = 100;
  output.rows = 30;
  output.isTTY = false;
  output.write = () => {};
  return output;
}
