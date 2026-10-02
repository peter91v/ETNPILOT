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
  // The page also shows texts that come from the server (a check's description,
  // a service's help), so the whole of src/ is searched.
  const { readdir: list } = await import("node:fs/promises");
  const names = (await list(new URL("../src/", import.meta.url), { recursive: true })).filter((file) => /\.(js|html)$/.test(file) && !file.endsWith("i18n-de.js"));
  const source = (await Promise.all(names.map((file) => readFile(new URL(`../src/${file}`, import.meta.url), "utf8")))).join("\n");
  const catalog = (await readFile(new URL("i18n-de.js", directory), "utf8")).split("\n").map((line) => /^ {2}"((?:[^"\\]|\\.)*)": "/.exec(line)?.[1]).filter(Boolean);
  const dead = catalog.filter((key) => !source.includes(JSON.stringify(key).slice(1, -1)) && !source.includes(key.replaceAll("'", "\\'")) && !source.includes(key));
  assert.deepEqual(dead, []);
  assert.equal(new Set(catalog).size, catalog.length, "a text is translated twice");
});

test("German patterns turn built texts into German, and leave other text alone", async () => {
  const directory = new URL("../src/ui/client/", import.meta.url);
  const source = `${await readFile(new URL("i18n-de.js", directory), "utf8")}\n${(await readFile(new URL("i18n.js", directory), "utf8")).split("const TRANSLATED_ATTRIBUTES")[0].split("const LANG")[0]}`;
  const translate = new Function(`${source}\n${(await readFile(new URL("i18n.js", directory), "utf8")).match(/function translateText[\s\S]*?\n}\n/)[0]}\nreturn translateText;`)();
  assert.equal(translate("5m ago"), "5m ago".replace("5m ago", "vor 5m"));
  assert.equal(translate("  3 open "), "  3 offen ");
  assert.equal(translate("12 of 40 loaded"), "12 von 40 geladen");
  assert.equal(translate("Signed out of GitHub."), "Von GitHub abgemeldet.");
  assert.equal(translate("1 change is unsaved work; removing is refused while they are here."), "1 Änderung ist ungesicherte Arbeit; Entfernen wird abgelehnt, solange sie da sind.");
  assert.equal(translate("a text nobody translated"), "a text nobody translated");
  assert.equal(translate("fix: the parser"), "fix: the parser", "a commit title or any free text is not touched");
});
