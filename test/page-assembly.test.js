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
