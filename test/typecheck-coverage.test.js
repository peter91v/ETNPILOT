import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

// `tsc` only looks at files that opt in with `// @ts-check`, so a new file that
// forgets the header is silently unchecked. The page's browser scripts are
// the one exception: they share a scope and are exercised by the UI tests.
async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.name.endsWith(".js")) yield path;
  }
}

test("every source file is type-checked", async () => {
  const missing = [];
  for await (const path of files(new URL("../src/", import.meta.url).pathname)) {
    if (path.includes("/src/ui/client/")) continue;
    if (!(await readFile(path, "utf8")).startsWith("// @ts-check\n")) missing.push(path.replace(/.*\/src\//, "src/"));
  }
  assert.deepEqual(missing, []);
});
