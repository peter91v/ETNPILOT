import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { renderReviewPage } from "../src/ui/page.js";

// The page's script is the client files joined in a fixed list. A file that
// exists but is missing from the list is a function that is not defined in
// the browser, which no server-side test would otherwise notice.
test("every file under src/ui/client is part of the page", async () => {
  const page = renderReviewPage("t");
  const directory = new URL("../src/ui/client/", import.meta.url);
  for (const name of (await readdir(directory)).filter((file) => file.endsWith(".js"))) {
    const source = await readFile(new URL(name, directory), "utf8");
    assert.ok(page.includes(source.trim().slice(0, 200)), `${name} is not in the page`);
  }
});

// The German texts are keyed by the exact English text. A key that is no
// longer in the page translates nothing, and says so here.
test("every German text is for an English text the page can show", async () => {
  const directory = new URL("../src/ui/client/", import.meta.url);
  const source = (await Promise.all((await readdir(directory)).filter((file) => file !== "i18n-de.js" && !file.endsWith(".css")).map((file) => readFile(new URL(file, directory), "utf8")))).join("\n");
  const catalog = (await readFile(new URL("i18n-de.js", directory), "utf8")).split("\n").map((line) => /^ {2}"((?:[^"\\]|\\.)*)": "/.exec(line)?.[1]).filter(Boolean);
  const dead = catalog.filter((key) => !source.includes(JSON.stringify(key).slice(1, -1)) && !source.includes(key.replaceAll("'", "\\'")) && !source.includes(key));
  assert.deepEqual(dead, []);
  assert.equal(new Set(catalog).size, catalog.length, "a text is translated twice");
});
