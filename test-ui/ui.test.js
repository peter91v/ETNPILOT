import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createReviewServer } from "../src/ui/server.js";

// Browser tests for the review page, run by 'npm run test:ui' in a real
// Chromium at a phone's width. They are separate from 'npm test' because they
// need a browser; where there is none they skip instead of failing.

let playwright;
let browser;
let skipReason;

before(async () => {
  try {
    playwright = await import("playwright");
    browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  } catch (error) {
    skipReason = `no browser to drive: ${error.message.split("\n")[0]}`;
  }
});

after(async () => {
  await browser?.close();
});

async function project({ lock = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-ui-test-"));
  await mkdir(join(root, ".etnpilot", "agents"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "agents", "worker.yaml"), "name: worker\ndescription: Does the work\nprompt: Do it.\n");
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1", "content:", "  provenance:", "    mode: enforce", "codegraph:", "  enabled: false", "observability:", "  enabled: false", "",
  ].join("\n"));
  return { root, lock };
}

async function open(setup, { width = 412, fetchImpl, locale, authorModel } = {}) {
  const home = await mkdtemp(join(tmpdir(), "etnpilot-ui-home-"));
  const server = await createReviewServer({ root: setup.root, env: { ...process.env, ETNPILOT_HOME: home }, fetchImpl, authorModel });
  const address = await server.listen({ port: 0 });
  const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 600, colorScheme: "dark", locale });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") problems.push(`console: ${message.text()}`); });
  await page.goto(address.url, { waitUntil: "networkidle" });
  return { page, problems, address, async close() { await context.close(); await server.close(); } };
}

const VIEWS = ["overview", "chat", "approvals", "agents", "queue", "runs", "content", "accounts", "worktrees", "merges", "checks", "settings"];

test("every view renders, without errors and without sideways scrolling at 412 px", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ui = await open(await project());
  try {
    for (const id of VIEWS) {
      await ui.page.evaluate((view) => show(view), id);
      await ui.page.waitForTimeout(250);
      const overflow = await ui.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `${id} is ${overflow}px wider than the screen`);
    }
    assert.deepEqual(ui.problems, []);
  } finally {
    await ui.close();
  }
});

test("the token leaves the address bar once the page has loaded", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ui = await open(await project());
  try {
    assert.doesNotMatch(ui.page.url(), /token=/);
  } finally {
    await ui.close();
  }
});

test("content that is not locked can be read and locked from the page", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ui = await open(await project());
  try {
    await ui.page.evaluate(() => show("content"));
    await ui.page.getByText(/item is not locked/).first().waitFor();
    await ui.page.getByRole("button", { name: "Lock what I reviewed" }).click();
    await ui.page.locator("#lock-confirm").click();
    await ui.page.getByText("Everything is locked", { exact: true }).waitFor();
    assert.deepEqual(ui.problems, []);
  } finally {
    await ui.close();
  }
});

test("an agent can be created from the page and shows up in the list", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ui = await open(await project());
  try {
    await ui.page.evaluate(() => show("agents"));
    await ui.page.getByText("worker").first().waitFor();
    await ui.page.getByRole("button", { name: "New agent" }).click();
    await ui.page.locator("#agent-name").fill("reviewer");
    await ui.page.locator("#agent-prompt").fill("Read and report.");
    await ui.page.locator("#agent-save").click();
    await ui.page.getByText("reviewer").first().waitFor();
    assert.deepEqual(ui.problems, []);
  } finally {
    await ui.close();
  }
});

test("a key can be saved on the Accounts page, and the page never shows it back", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const key = ["sk", "ui", "test", "key", "1234567890"].join("-");
  const ui = await open(await project(), { fetchImpl: async () => new Response("{}", { status: 200 }) });
  try {
    await ui.page.evaluate(() => show("accounts"));
    await ui.page.locator("#key-anthropic").fill(key);
    await ui.page.getByRole("button", { name: "Check and save" }).first().click();
    await ui.page.getByText("Key stored").first().waitFor();
    assert.equal((await ui.page.content()).includes(key), false);
    assert.deepEqual(ui.problems, []);
  } finally {
    await ui.close();
  }
});

test("the guided setup connects GitLab from the overview and never shows the token back", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const token = ["glpat", "ui", "setup", "token", "123456"].join("-");
  const ui = await open(await project(), { fetchImpl: async () => new Response(JSON.stringify({ username: "peter" }), { status: 200 }) });
  try {
    await ui.page.getByText("Guided setup").first().waitFor();
    await ui.page.locator("#setup-host").fill("https://git.acme.test");
    await ui.page.locator("#setup-project").fill("varga/etnpilot-smoke");
    await ui.page.locator("#setup-user").fill("peter");
    await ui.page.locator("#setup-token").fill(token);
    await ui.page.getByRole("button", { name: "Connect GitLab" }).click();
    await ui.page.getByText("Stored the GitLab token for peter").first().waitFor();
    assert.equal((await ui.page.content()).includes(token), false);
    assert.deepEqual(ui.problems, []);
  } finally {
    await ui.close();
  }
});

test("an agent can be drafted with a model, read, and then written", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const answer = { agents: [{ name: "doc-writer", description: "writes docs", tools: ["read_file"], skills: [], prompt: "Write the docs." }], skills: [], instructions: [] };
  const setup = await project();
  const ui = await open(setup, { authorModel: async () => ({ text: JSON.stringify(answer), usage: {} }) });
  try {
    await ui.page.evaluate(() => show("agents"));
    await ui.page.locator("#view-agents").getByRole("button", { name: "Open", exact: true }).first().click();
    await ui.page.locator("#author-request").fill("an agent for docs");
    await ui.page.getByRole("button", { name: "Draft it" }).click();
    await ui.page.getByText("Write the docs.").first().waitFor();
    await ui.page.getByRole("button", { name: "Write this" }).click();
    await ui.page.getByText("It is not reviewed yet").first().waitFor();
    // Improving picks from what exists, and a new prompt is a kind of its own.
    await ui.page.locator("#author-mode").selectOption("improve");
    assert.ok((await ui.page.locator("#author-kind option").allTextContents()).includes("agent"), "an agent can be improved too");
    await ui.page.locator("#author-kind").selectOption("agent");
    await ui.page.locator("#author-name").waitFor();
    assert.ok((await ui.page.locator("#author-name option").allTextContents()).includes("doc-writer"));
    await ui.page.locator("#author-kind").selectOption("prompt");
    await ui.page.locator("#author-name").waitFor();
    assert.ok((await ui.page.locator("#author-name option").allTextContents()).includes("doc-writer"));
    await ui.page.locator("#author-mode").selectOption("new");
    assert.ok((await ui.page.locator("#author-kind option").allTextContents()).includes("prompt"));
    assert.deepEqual(ui.problems, []);
  } finally {
    await ui.close();
  }
});

test("a ladder can be built in the workflow builder and is drawn as a flow", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ui = await open(await project());
  try {
    await ui.page.evaluate(() => show("agents"));
    await ui.page.getByRole("button", { name: "New workflow" }).click();
    await ui.page.locator("#workflow-name").fill("tiered");
    await ui.page.locator("#step-type-0").selectOption("ladder");
    await ui.page.locator("#tier-model-0-2").waitFor();
    assert.equal(await ui.page.locator("#tier-model-0-0").inputValue(), "claude-haiku-4-5-20251001");
    assert.equal(await ui.page.locator("#workflow-body .ladder-flow").count(), 1, "the plan is drawn while editing");
    await ui.page.locator("#tier-model-0-0").fill("cheap-model");
    await ui.page.getByRole("button", { name: "Add a check" }).click();
    await ui.page.locator("#workflow-save").click();
    await ui.page.locator("#view-agents .ladder-flow").first().waitFor();
    assert.match(await ui.page.locator("#view-agents .ladder-flow").first().textContent(), /cheap-model/);
    assert.deepEqual(ui.problems, []);
  } finally {
    await ui.close();
  }
});

test("a run with a ladder shows the path it took, which tier passed and what it cost", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const setup = await project();
  const runs = join(setup.root, ".etnpilot", "state", "runs");
  await mkdir(runs, { recursive: true });
  const lines = [
    { mode: "execute", runId: "ladder-run", type: "run-start" },
    { type: "ladder-route", runId: "ladder-run", step: "build", difficulty: "medium", risk: "high", startTier: 1, verify: "full" },
    { type: "ladder-attempt", runId: "ladder-run", step: "build", tier: 1, model: "cheap-model", effort: "low", status: "failed", cost: 0.012 },
    { type: "ladder-attempt", runId: "ladder-run", step: "build", tier: 2, model: "strong-model", effort: "high", status: "passed", cost: 0.2 },
    { mode: "execute", runId: "ladder-run", terminal: true, status: "succeeded", hash: "h".repeat(64) },
  ];
  await writeFile(join(runs, "ladder-run.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const ui = await open(setup);
  try {
    await ui.page.evaluate(() => show("runs"));
    await ui.page.locator("#view-runs tbody tr button").first().click();
    await ui.page.getByText("passed on tier 2").first().waitFor();
    const picture = ui.page.locator("#view-runs .ladder-flow").first();
    assert.match(await picture.textContent(), /strong-model/);
    assert.equal(await picture.locator(".lf-tier.passed").count(), 1);
    assert.equal(await picture.locator(".lf-tier.failed").count(), 1);
    assert.deepEqual(ui.problems, []);
  } finally {
    await ui.close();
  }
});

test("the model shown follows the default provider, the agent and the provider chosen in the chat and the run dialog", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const setup = await project();
  await writeFile(join(setup.root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1", "defaultProvider: alpha", "providers:",
    "  alpha: { type: openai-compatible, baseUrl: 'http://127.0.0.1:9/v1', model: alpha-model }",
    "  beta: { type: openai-compatible, baseUrl: 'http://127.0.0.1:9/v1', model: beta-model }",
    "content:", "  provenance:", "    mode: enforce", "codegraph:", "  enabled: false", "observability:", "  enabled: false", "",
  ].join("\n"));
  const ui = await open(setup);
  try {
    await ui.page.evaluate(() => show("chat"));
    await ui.page.locator("#chat-provider option[value=beta]").waitFor({ state: "attached" });
    assert.equal(await ui.page.locator("#chat-model").getAttribute("placeholder"), "model: alpha-model");
    assert.match(await ui.page.locator("#chat-summary").textContent(), /alpha · alpha-model/);
    await ui.page.locator("#chat-summary").click();
    await ui.page.locator("#chat-provider").selectOption("beta");
    assert.equal(await ui.page.locator("#chat-model").getAttribute("placeholder"), "model: beta-model");
    assert.match(await ui.page.locator("#chat-summary").textContent(), /beta · beta-model/);
    await ui.page.locator("#chat-model").fill("typed-model");
    assert.match(await ui.page.locator("#chat-summary").textContent(), /beta · typed-model/);

    await ui.page.evaluate("startRunWith({})");
    await ui.page.getByText("the default agent answers with alpha · alpha-model").waitFor();
    assert.deepEqual(ui.problems.filter((problem) => !/Failed to load resource|ERR_/.test(problem)), []);
  } finally {
    await ui.close();
  }
});

test("a combobox offers its list from the chevron, filters while typing, and keeps any typed value", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ui = await open(await project());
  try {
    await ui.page.evaluate(`(() => {
      const host = document.createElement("div");
      host.id = "combo-host";
      host.append(combobox({ id: "combo-t", label: "Model", options: ["alpha-1", "alpha-2", "beta-1"], onInput: (value) => { window.comboValue = value; } }));
      document.body.prepend(host);
    })()`);
    const options = () => ui.page.locator("#combo-t-list .combo-option").allTextContents();
    await ui.page.locator("#combo-t").focus();
    assert.deepEqual(await options(), ["alpha-1", "alpha-2", "beta-1"]);
    await ui.page.locator("#combo-t").fill("beta");
    assert.deepEqual(await options(), ["beta-1"]);
    await ui.page.locator("#combo-t-list .combo-option").first().dispatchEvent("mousedown");
    assert.equal(await ui.page.locator("#combo-t").inputValue(), "beta-1");
    assert.equal(await ui.page.evaluate("window.comboValue"), "beta-1");
    // The chevron shows everything, whatever is typed.
    await ui.page.locator("#combo-host .combo-toggle").dispatchEvent("mousedown");
    assert.equal((await options()).length, 3);
    // A value the list does not have is kept.
    await ui.page.locator("#combo-t").fill("brand-new-model");
    assert.deepEqual(await options(), []);
    assert.equal(await ui.page.evaluate("window.comboValue"), "brand-new-model");
    assert.deepEqual(ui.problems, []);
  } finally {
    await ui.close();
  }
});

test("the run list can be narrowed by text and by status", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const setup = await project();
  const runs = join(setup.root, ".etnpilot", "state", "runs");
  await mkdir(runs, { recursive: true });
  const receipt = (runId, status, terminal) => `${JSON.stringify({ mode: "execute", runId, ...(terminal ? { terminal: true, status, hash: "h".repeat(64) } : {}) })}\n`;
  await writeFile(join(runs, "alpha-run.jsonl"), receipt("alpha-run", "succeeded", true));
  await writeFile(join(runs, "beta-run.jsonl"), receipt("beta-run", "failed", true));
  await writeFile(join(runs, "gamma-run.jsonl"), receipt("gamma-run", undefined, false));
  const ui = await open(setup);
  try {
    await ui.page.evaluate(() => show("runs"));
    const rows = () => ui.page.locator("#view-runs tbody tr").count();
    await ui.page.locator("#view-runs tbody tr").first().waitFor();
    assert.equal(await rows(), 3);
    await ui.page.locator("#run-filter").fill("beta");
    assert.equal(await rows(), 1);
    assert.equal(await ui.page.locator("#run-filter").inputValue(), "beta", "typing does not rebuild the box");
    await ui.page.locator("#run-filter").fill("");
    await ui.page.locator("#run-status").selectOption("failed");
    assert.equal(await rows(), 1);
    await ui.page.locator("#run-status").selectOption("unsealed");
    assert.equal(await rows(), 1);
    assert.match(await ui.page.locator("#view-runs tbody").innerText(), /gamma-run/);
    await ui.page.locator("#run-filter").fill("nothing-like-this");
    await ui.page.getByText("No loaded run matches").waitFor();
    assert.deepEqual(ui.problems, []);
  } finally {
    await ui.close();
  }
});

// axe-core checks what a person using a screen reader or a keyboard would run
// into: names, roles, contrast, labels. The views are visited with data in
// them where a project can have it, in both colour schemes.
test("no view has an accessibility violation axe can find", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { readFile } = await import("node:fs/promises");
  const axeSource = await readFile(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
  const ui = await open(await project());
  try {
    await ui.page.addScriptTag({ content: axeSource });
    const found = [];
    for (const scheme of ["light", "dark"]) {
      await ui.page.emulateMedia({ colorScheme: scheme });
      for (const id of VIEWS) {
        await ui.page.evaluate((view) => show(view), id);
        await ui.page.waitForTimeout(250);
        const result = await ui.page.evaluate(() => globalThis.axe.run(document, { resultTypes: ["violations"] }));
        for (const violation of result.violations) {
          found.push(`${scheme}/${id}: ${violation.id} (${violation.impact}) ${violation.nodes.slice(0, 2).map((node) => node.target.join(" ")).join(" | ")}`);
        }
      }
    }
    assert.deepEqual(found, []);
  } finally {
    await ui.close();
  }
});

test("a project with no runs shows what is left before the first one, and the list goes once there is a run", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const setup = await project();
  const ui = await open(setup);
  try {
    await ui.page.evaluate(() => show("overview"));
    await ui.page.getByText("Getting started").first().waitFor();
    await ui.page.getByText("Give ETNPilot a provider key").first().waitFor();
    assert.deepEqual(ui.problems, []);
  } finally {
    await ui.close();
  }
  const runs = join(setup.root, ".etnpilot", "state", "runs");
  await mkdir(runs, { recursive: true });
  await writeFile(join(runs, "done.jsonl"), `${JSON.stringify({ mode: "execute", runId: "done", terminal: true, status: "succeeded", hash: "h".repeat(64) })}\n`);
  const later = await open(setup);
  try {
    await later.page.evaluate(() => show("overview"));
    await later.page.waitForTimeout(400);
    assert.equal(await later.page.getByText("Getting started").count(), 0);
  } finally {
    await later.close();
  }
});

test("a run that did not succeed can be checked for whether it could be resumed, and the page says why not", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { JsonlReceiptStore } = await import("../src/core/receipt-store.js");
  const setup = await project();
  const runs = join(setup.root, ".etnpilot", "state", "runs");
  await mkdir(runs, { recursive: true });
  const store = new JsonlReceiptStore(join(runs, "broken-run.jsonl"));
  await store.append({ type: "run-start", runId: "broken-run", mode: "execute", configDigest: "sha256:x", request: { input: "do both" }, plan: [{ id: "first", type: "agent", needs: [] }, { id: "second", type: "agent", needs: ["first"] }], workspace: { path: join(setup.root, "gone"), branch: "b", managed: true }, workspaceDigest: { digest: "git:a:b" } });
  // The first agent's own receipt, which is where a carried-over result comes from.
  await store.append({ runId: "broken-run", agent: "worker", workflowStep: "first", status: "succeeded", result: { text: "first done" }, approvals: [] });
  await store.append({ type: "step", runId: "broken-run", step: "first", stepType: "agent", status: "succeeded", effect: "workspace", workspaceDigest: { digest: "git:a:c" } });
  await store.append({ type: "workflow", terminal: true, runId: "broken-run", status: "failed", mode: "execute" });
  const ui = await open(setup);
  try {
    await ui.page.evaluate(() => show("runs"));
    await ui.page.getByRole("button", { name: "broken-run" }).first().click();
    await ui.page.getByRole("button", { name: "Check", exact: true }).click();
    await ui.page.getByText("cannot be resumed").waitFor();
    await ui.page.getByText("can no longer be read (the directory does not exist)").waitFor();
    assert.match(await ui.page.locator("#view-runs").innerText(), /first[\s\S]*reuse|reuse[\s\S]*first/);
    assert.deepEqual(ui.problems, []);
  } finally {
    await ui.close();
  }
});

test("a run that failed in its second step can be resumed from the page, after the plan has been shown", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { runProject } = await import("../src/runtime/project-runner.js");
  const { git } = await import("../src/git/command.js");
  const root = await mkdtemp(join(tmpdir(), "etnpilot-ui-resume-"));
  await mkdir(join(root, ".etnpilot", "agents"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n.codegraph/\n");
  await writeFile(join(root, ".etnpilot", "agents", "worker.yaml"), "name: worker\nprovider: fake\nprompt: Do it.\n");
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1", "defaultAgent: worker", "providers:", "  fake:", "    type: fake", "content:", "  provenance:", "    mode: off",
    "codegraph:", "  enabled: false", "observability:", "  enabled: false",
    "workflow:", "  steps:", "    - id: first", "      type: agent", "      agent: worker", "    - id: second", "      type: agent", "      agent: worker", "      needs: [first]", "",
  ].join("\n"));
  for (const args of [["init", "-b", "main"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "t"], ["add", "."], ["commit", "-m", "initial"]]) await git(args, { cwd: root });
  let calls = 0;
  await runProject({ root, input: "do both", providerFactories: { fake: (name) => ({ name, invoke: async () => { calls += 1; if (calls === 1) return { text: "first done" }; throw new Error("the second step broke"); } }) } }).then(() => assert.fail("meant to fail"), () => {});

  const ui = await open({ root });
  try {
    await ui.page.evaluate(() => show("runs"));
    await ui.page.locator("#view-runs tbody tr").first().waitFor();
    await ui.page.locator("#view-runs tbody tr button").first().click();
    await ui.page.getByRole("button", { name: "Check", exact: true }).click();
    await ui.page.getByText("could be resumed").first().waitFor();
    await ui.page.getByText("It stopped in 'second': the second step broke").waitFor();
    assert.equal(await ui.page.getByRole("button", { name: "Resume", exact: true }).count(), 1);
    await ui.page.getByRole("button", { name: "Resume", exact: true }).click();
    await ui.page.getByText(/Resuming .*: it appears under working now/).waitFor();
    assert.deepEqual(ui.problems, []);
  } finally {
    await ui.close();
  }
});

test("in a German browser the page speaks German in every view, still fits 412 px, and the switch brings English back", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const ui = await open(await project(), { locale: "de-DE" });
  try {
    assert.equal(await ui.page.evaluate(() => document.documentElement.lang), "de");
    assert.match(await ui.page.locator("#nav").innerText(), /Übersicht/);
    for (const id of VIEWS) {
      await ui.page.evaluate((view) => show(view), id);
      await ui.page.waitForTimeout(250);
      const overflow = await ui.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `${id} is ${overflow}px wider than the screen`);
    }
    await ui.page.evaluate(() => show("runs"));
    await ui.page.waitForTimeout(250);
    assert.match(await ui.page.locator("#view-runs").innerText(), /Es wurden noch keine Läufe aufgezeichnet/);
    await ui.page.selectOption("#language", "en");
    await ui.page.waitForLoadState("networkidle");
    assert.match(await ui.page.locator("#nav").innerText(), /Overview/);
    assert.deepEqual(ui.problems, []);
  } finally {
    await ui.close();
  }
});

test("the page for a directory with no project speaks German in a German browser, and still creates the project", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const root = await mkdtemp(join(tmpdir(), "etnpilot-ui-empty-"));
  const ui = await open({ root }, { locale: "de-DE" });
  try {
    assert.match(await ui.page.locator("h1").innerText(), /Hier gibt es noch kein Projekt/);
    assert.match(await ui.page.locator("body").innerText(), /Wähle, was angelegt werden soll/);
    assert.equal(await ui.page.title(), "ETNPilot — hier gibt es noch kein Projekt");
    const overflow = await ui.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `the page is ${overflow}px wider than the screen`);
    await ui.page.selectOption("#language", "en");
    await ui.page.waitForLoadState("networkidle");
    assert.match(await ui.page.locator("h1").innerText(), /No project here yet/);
    assert.deepEqual(ui.problems, []);
  } finally {
    await ui.close();
  }
});

test("a run whose step left half-written files can be resumed from the page once the person agrees to discard them", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { runProject } = await import("../src/runtime/project-runner.js");
  const { git } = await import("../src/git/command.js");
  const root = await mkdtemp(join(tmpdir(), "etnpilot-ui-reset-"));
  await mkdir(join(root, ".etnpilot", "agents"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".etnpilot/state/\n.etnpilot/worktrees/\n.codegraph/\n");
  await writeFile(join(root, ".etnpilot", "agents", "worker.yaml"), "name: worker\nprovider: fake\nprompt: Do it.\n");
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), [
    "version: 1", "defaultAgent: worker", "providers:", "  fake:", "    type: fake", "content:", "  provenance:", "    mode: off",
    "codegraph:", "  enabled: false", "observability:", "  enabled: false",
    "workflow:", "  steps:", "    - id: first", "      type: agent", "      agent: worker", "    - id: second", "      type: agent", "      agent: worker", "      needs: [first]", "",
  ].join("\n"));
  for (const args of [["init", "-b", "main"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "t"], ["add", "."], ["commit", "-m", "initial"]]) await git(args, { cwd: root });
  let calls = 0;
  await runProject({ root, input: "do both", providerFactories: { fake: (name) => ({ name, invoke: async ({ metadata }) => {
    calls += 1;
    if (calls === 1) return { text: "first done" };
    await writeFile(join(metadata.workspace, "half.txt"), "half\n");
    throw new Error("the second step broke");
  } }) } }).then(() => assert.fail("meant to fail"), () => {});

  const ui = await open({ root });
  try {
    await ui.page.evaluate(() => show("runs"));
    await ui.page.locator("#view-runs tbody tr").first().waitFor();
    await ui.page.locator("#view-runs tbody tr button").first().click();
    await ui.page.getByRole("button", { name: "Check", exact: true }).click();
    await ui.page.getByText("cannot be resumed").first().waitFor();
    await ui.page.getByText("1 files were left by the step that stopped.").waitFor();
    await ui.page.getByRole("button", { name: "Discard them and resume", exact: true }).click();
    await ui.page.getByText("removed half.txt").waitFor();
    await ui.page.getByRole("button", { name: "Discard and resume", exact: true }).click();
    await ui.page.getByText(/Resuming .*: it appears under working now/).waitFor();
    assert.deepEqual(ui.problems, []);
  } finally {
    await ui.close();
  }
});
