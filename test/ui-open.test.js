import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { browserCandidates, openInBrowser } from "../src/ui/open-browser.js";
import { shouldOpenBrowser } from "../src/cli/commands.js";

// Starting a program outside ETNPilot is the one thing this module does, so
// what it starts, with what, and what happens when it is not there are all
// asserted rather than assumed.

test("the opener is chosen by platform, and BROWSER wins", () => {
  assert.deepEqual(browserCandidates({ platform: "darwin", env: {} }), [["open", []]]);
  assert.deepEqual(browserCandidates({ platform: "win32", env: {} }), [["cmd", ["/c", "start", ""]]]);
  const linux = browserCandidates({ platform: "linux", env: {} }).map(([command]) => command);
  // Android has no xdg-open, and a phone is a place this runs.
  assert.deepEqual(linux.slice(0, 2), ["termux-open-url", "xdg-open"]);
  assert.ok(linux.includes("wslview"));
  assert.deepEqual(browserCandidates({ platform: "linux", env: { BROWSER: "firefox" } }), [["firefox", []]]);
});

test("the URL is passed as an argument, never through a shell", async () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return runner({ exitCode: 0 });
  };
  const result = await openInBrowser("http://127.0.0.1:8788/?token=abc", { platform: "darwin", env: {}, spawn });
  assert.deepEqual(result, { opened: true, command: "open" });
  assert.deepEqual(calls[0].args, ["http://127.0.0.1:8788/?token=abc"]);
  assert.equal(calls[0].options.shell, false);
  // Detached and silent: the browser outlives the command and never writes
  // into the terminal the URL was printed on.
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");

  await assert.rejects(() => openInBrowser("file:///etc/passwd", { spawn }), TypeError);
  await assert.rejects(() => openInBrowser("not a url", { spawn }), TypeError);
});

test("an opener that is missing hands over to the next one", async () => {
  const tried = [];
  const spawn = (command) => {
    tried.push(command);
    if (command === "termux-open-url") return runner({ error: Object.assign(new Error("spawn"), { code: "ENOENT" }) });
    if (command === "xdg-open") return runner({ exitCode: 3 });
    return runner({ exitCode: 0 });
  };
  const result = await openInBrowser("http://127.0.0.1:1/?token=x", { platform: "linux", env: {}, spawn });
  assert.equal(result.opened, true);
  assert.equal(result.command, "wslview");
  assert.deepEqual(tried, ["termux-open-url", "xdg-open", "wslview"]);
});

test("no opener at all is an answer, not a crash", async () => {
  const spawn = () => runner({ error: Object.assign(new Error("spawn"), { code: "ENOENT" }) });
  const result = await openInBrowser("http://127.0.0.1:1/?token=x", { platform: "linux", env: {}, spawn });
  assert.equal(result.opened, false);
  assert.match(result.reason, /no browser opener worked/);
  assert.match(result.reason, /xdg-open: not installed/);

  // And a person who says 'never' is not asked again.
  const never = await openInBrowser("http://127.0.0.1:1/?token=x", {
    platform: "linux",
    env: { BROWSER: "none" },
    spawn: () => assert.fail("nothing should be started"),
  });
  assert.deepEqual(never, { opened: false, reason: "BROWSER is set to 'none'." });
});

test("an opener that keeps running has opened something", async () => {
  const child = runner({});
  const result = await openInBrowser("http://127.0.0.1:1/?token=x", {
    platform: "darwin",
    env: {},
    spawn: () => child,
    graceMs: 20,
  });
  assert.deepEqual(result, { opened: true, command: "open" });
  // It is released, so this command can exit while the browser stays open.
  assert.equal(child.unrefs, 1);
});

test("a browser is opened for a person at a terminal, and for nobody else", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };
  assert.equal(shouldOpenBrowser({}, {}, tty), true);
  assert.equal(shouldOpenBrowser({}, {}, pipe), false, "a pipe gets the URL and nothing else");
  assert.equal(shouldOpenBrowser({ "no-open": true }, {}, tty), false);
  assert.equal(shouldOpenBrowser({}, { BROWSER: "none" }, tty), false);
  assert.equal(shouldOpenBrowser({}, { CI: "true" }, tty), false);
  assert.equal(shouldOpenBrowser({}, { CI: "false" }, tty), true);
  // '--open' is how a service or a script asks for it anyway.
  assert.equal(shouldOpenBrowser({ open: true }, { CI: "true" }, pipe), true);
});

// A child process, near enough: it reports what it was told to report.
function runner({ error, exitCode }) {
  const child = new EventEmitter();
  child.unrefs = 0;
  child.unref = () => { child.unrefs += 1; };
  if (error) setImmediate(() => child.emit("error", error));
  else if (exitCode !== undefined) setImmediate(() => child.emit("exit", exitCode));
  return child;
}
