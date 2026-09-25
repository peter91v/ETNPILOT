import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReviewServer } from "../src/ui/server.js";
import { renderIcon, renderManifest, renderServiceWorker } from "../src/ui/app.js";
import { tokenFile } from "../src/ui/token.js";
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

test("what an installed app launches is what a browser would launch, and it opens", async () => {
  // The test this file was missing. It proved the manifest was served and the
  // worker registered; nothing ever followed 'start_url' the way a browser
  // does — against the manifest's own URL — and so nobody noticed that an
  // installed app opened '/' with no token and was answered with a 401.
  const root = await project();
  const review = await createReviewServer({ root });
  try {
    const address = await review.listen({ port: 0 });
    const base = `http://127.0.0.1:${address.port}`;
    const manifestUrl = `${base}/manifest.webmanifest`;
    const manifest = await (await fetch(manifestUrl)).json();
    const launch = new URL(manifest.start_url, manifestUrl).href;
    assert.equal(launch, `${base}/`, "start_url resolves against the manifest, not the page");

    // Opening the printed link is what leaves the cookie behind.
    const opened = await fetch(address.url);
    assert.equal(opened.status, 200);
    const setCookie = opened.headers.get("set-cookie");
    assert.match(setCookie, /^etnpilot_ui=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const jar = setCookie.split(";")[0];

    // And now the icon on a home screen opens the review page.
    const launched = await fetch(launch, { headers: { cookie: jar } });
    assert.equal(launched.status, 200);
    assert.match(await launched.text(), /ETNPilot Review/);

    // Without either, it is still refused: the cookie is the only thing that
    // changed, not who may look.
    assert.equal((await fetch(launch)).status, 401);
  } finally {
    await review.close();
  }
});

test("the cookie lets you read and never lets you change anything", async () => {
  const root = await project();
  const review = await createReviewServer({ root });
  try {
    const address = await review.listen({ port: 0 });
    const base = `http://127.0.0.1:${address.port}`;
    const jar = (await fetch(address.url)).headers.get("set-cookie").split(";")[0];

    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: jar } })).status, 200);

    // The custom header is the cross-site defence: a page on another origin
    // can make a browser send a cookie, but it cannot set this. So a cookie
    // alone must never be enough to decide an approval or start a run.
    for (const path of ["/api/runs/start", "/api/approvals/decide", "/api/settings/set"]) {
      const refused = await fetch(base + path, {
        method: "POST",
        headers: { cookie: jar, "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(refused.status, 401, path);
      assert.equal((await refused.json()).error, "unauthorized");
    }
  } finally {
    await review.close();
  }
});

test("the token survives a restart, and rotating it locks the old link out", async () => {
  const root = await project();
  const first = await createReviewServer({ root });
  await first.close();
  const second = await createReviewServer({ root });
  await second.close();
  assert.equal(second.token, first.token, "an installed app holds a link; it has to keep working");

  // It is a credential, so it is not world-readable and not committed.
  const stat = await lstat(tokenFile(root));
  assert.equal(stat.mode & 0o077, 0, "the token file is readable only by its owner");
  assert.match(tokenFile(root), /\.etnpilot\/state\//, "under the directory the generated .gitignore excludes");

  const rotated = await createReviewServer({ root, rotateToken: true });
  await rotated.close();
  assert.notEqual(rotated.token, first.token);
});

test("a directory with no project is not touched to store a token", async () => {
  // The setup page promises that nothing is written until a template is
  // chosen. A token file would have broken that promise before the page even
  // rendered — which is what the first-run test caught.
  const empty = await mkdtemp(join(tmpdir(), "etnpilot-app-empty-"));
  const review = await createReviewServer({ root: empty });
  try {
    const address = await review.listen({ port: 0 });
    await assert.rejects(lstat(join(empty, ".etnpilot")), /ENOENT/);

    // Creating the project is the moment the token gets somewhere to live,
    // so the link this page hands out survives the next restart.
    const created = await fetch(`http://127.0.0.1:${address.port}/api/project/create`, {
      method: "POST",
      headers: { "x-etnpilot-token": review.token, "content-type": "application/json" },
      body: JSON.stringify({ template: "minimal" }),
    });
    assert.equal(created.status, 201);
    assert.equal((await readFile(tokenFile(empty), "utf8")).trim(), review.token);
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
