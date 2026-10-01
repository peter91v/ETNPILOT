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

async function open(setup, { width = 412, fetchImpl } = {}) {
  const home = await mkdtemp(join(tmpdir(), "etnpilot-ui-home-"));
  const server = await createReviewServer({ root: setup.root, env: { ...process.env, ETNPILOT_HOME: home }, fetchImpl });
  const address = await server.listen({ port: 0 });
  const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 600, colorScheme: "dark" });
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
