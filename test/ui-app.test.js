import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReviewServer } from "../src/ui/server.js";
import { renderIcon, renderManifest, renderServiceWorker } from "../src/ui/app.js";
import { renderReviewPage } from "../src/ui/page.js";

// UI-3: the app is the page, installed. These hold the three decisions that
// made it one — one surface, loopback only, and no claim to know who you are —
// and the rule the service worker exists to keep: the shell is cached, the
// evidence never is.

test("the shell is served, and it is the only thing served without the token", async () => {
  const root = await project();
  const review = await createReviewServer({ root });
  try {
    const address = await review.listen({ port: 0 });
    const base = `http://127.0.0.1:${address.port}`;
    for (const path of ["/manifest.webmanifest", "/icon.svg", "/icon-maskable.svg", "/sw.js"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("cache-control"), "no-store", path);
    }
    // A manifest and a worker are fetched by the browser itself, sometimes
    // without the page's credentials — but they carry no evidence. Everything
    // that does still needs the token.
    assert.equal((await fetch(`${base}/`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);

    const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.scope, "/");
    assert.deepEqual(manifest.icons.map((entry) => entry.purpose), ["any", "maskable"]);
    // The worker's own scope has to reach the page it controls.
    assert.equal((await fetch(`${base}/sw.js`)).headers.get("service-worker-allowed"), "/");
  } finally {
    await review.close();
  }
});

test("the worker caches the shell and never the evidence", () => {
  const worker = renderServiceWorker("abcd1234");
  // Named by the session's token, so one session cannot be served the shell
  // another one cached.
  assert.match(worker, /const CACHE = "etnpilot-shell-abcd1234"/);
  assert.match(worker, /const SHELL = \["\/icon\.svg", "\/icon-maskable\.svg"\]/);
  // The two rules that matter, in the file itself.
  assert.match(worker, /if \(url\.pathname\.startsWith\("\/api\/"\)\) return;/);
  assert.match(worker, /if \(!SHELL\.includes\(url\.pathname\)\) return;/);
  // A navigation is answered from the network or not at all; nothing is kept
  // to show while the machine is out of reach.
  assert.match(worker, /event\.request\.mode === "navigate"/);
  assert.match(worker, /No connection to this project/);
  assert.equal(/caches\.put/.test(worker), false, "nothing is written to the cache after install");
});

test("the icons are drawn here, and the maskable one survives being cropped", () => {
  const plain = renderIcon();
  const maskable = renderIcon({ maskable: true });
  for (const icon of [plain, maskable]) {
    assert.match(icon, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 512 512"/);
    // Drawn, not fetched: the thing on a home screen loads nothing either.
    assert.equal(/<image|href="http/.test(icon), false);
  }
  // The maskable one keeps its mark inside the safe area and bleeds its
  // background to the edge, which is what being cropped to a circle needs.
  assert.match(plain, /rx="96"/);
  assert.equal(/rx=/.test(maskable), false);
  const scale = (icon) => Number(/scale\(([\d.]+)\)/.exec(icon)[1]);
  assert.equal(scale(maskable) < scale(plain), true);
});

test("the page installs itself, and the policy allows exactly that much", async () => {
  const page = renderReviewPage("token");
  assert.match(page, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(page, /navigator\.serviceWorker\.register\("\/sw\.js", \{ scope: "\/" \}\)/);
  // The install button only appears where the browser offers one.
  assert.match(page, /id="install" hidden/);
  assert.match(page, /addEventListener\("beforeinstallprompt"/);

  const root = await project();
  const review = await createReviewServer({ root });
  try {
    const address = await review.listen({ port: 0 });
    const response = await fetch(address.url);
    const policy = response.headers.get("content-security-policy");
    // Still nothing from anywhere else — the three additions are this
    // server's own shell, and a service worker is refused without them.
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /worker-src 'self'/);
    assert.match(policy, /manifest-src 'self'/);
    assert.equal(/https?:\/\//.test(policy), false);
  } finally {
    await review.close();
  }
});

test("the reviewer names themselves, and the page says that is all it knows", () => {
  const page = renderReviewPage("token");
  // Kept on the device, sent with the decision, recorded as self-asserted.
  assert.match(page, /localStorage\.getItem\("etnpilot\.reviewer"\)/);
  assert.match(page, /this page never checked who you are/);
  // And the manifest module carries the reasoning, so a later 'add a login'
  // has something to argue with.
  assert.match(renderManifest().description, /on the machine that runs it/);
});

async function project() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-app-"));
  await mkdir(join(root, ".etnpilot", "state", "runs"), { recursive: true });
  await writeFile(join(root, ".etnpilot", "etnpilot.yaml"), "version: 1\n");
  return root;
}
