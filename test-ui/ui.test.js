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
