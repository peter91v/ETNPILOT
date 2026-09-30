import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { renderReviewPage } from "../src/ui/page.js";

// P5.1: the page was one 2,700-line template literal. It is text assembled
// from several files now, and this keeps it that way.

const root = new URL("../src/ui/", import.meta.url).pathname;

async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else if (entry.name.endsWith(".js")) found.push(path);
  }
  return found;
}

test("no file of the web surface is longer than 800 lines", async () => {
  const long = [];
  for (const path of await files(root)) {
    const lines = (await readFile(path, "utf8")).split("\n").length;
    if (lines > 800) long.push(`${path.slice(root.length)} (${lines})`);
  }
  assert.deepEqual(long, []);
});

test("the assembled page still parses as a script", () => {
  const html = renderReviewPage("token");
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /^\nconst TOKEN = "token";/);
});
