#!/usr/bin/env node
// Parses every shipped module so a syntax error fails fast, before the test
// run spends minutes on unrelated work.
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const roots = ["bin", "src", "test", "scripts"];

const files = (await Promise.all(roots.map((root) => collect(root)))).flat();
const failures = [];
await Promise.all(files.map(async (file) => {
  try {
    await run(process.execPath, ["--check", file]);
  } catch (error) {
    failures.push(`${file}: ${String(error.stderr ?? error.message).trim().split("\n")[0]}`);
  }
}));

if (failures.length > 0) {
  console.error(`Syntax check failed for ${failures.length} file(s):`);
  for (const failure of failures.sort()) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`Syntax check passed for ${files.length} files.`);

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collect(path);
    return entry.name.endsWith(".js") || entry.name.endsWith(".mjs") ? [path] : [];
  }));
  return found.flat();
}
