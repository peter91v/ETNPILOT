import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readInstalledPackages } from "./dependencies.js";

// Each ecosystem is read where its truth lives. Some of them can report a
// license and some cannot; that difference is carried through the report
// rather than papered over, because a violation an operator cannot fix is
// noise, and noise gets gates switched off.
const ECOSYSTEMS = Object.freeze([
  { id: "npm", purl: "pkg:npm/", licenses: true, read: readNpm },
  { id: "pypi", purl: "pkg:pypi/", licenses: true, read: readPython },
  { id: "golang", purl: "pkg:golang/", licenses: false, read: readGo },
  { id: "cargo", purl: "pkg:cargo/", licenses: false, read: readCargo },
]);

export function ecosystemPurl(entry) {
  const definition = ECOSYSTEMS.find((candidate) => candidate.id === entry.ecosystem);
  const name = encodeURIComponent(entry.name).replaceAll("%40", "@").replaceAll("%2F", "/");
  return `${definition?.purl ?? "pkg:generic/"}${name}@${entry.version}`;
}

export async function readProjectPackages(root, config = {}) {
  const projectRoot = resolve(root);
  const collected = [];
  const ecosystems = [];
  for (const definition of ECOSYSTEMS) {
    const entries = await definition.read(projectRoot, config[definition.id] ?? {});
    if (entries.length === 0) continue;
    ecosystems.push({ id: definition.id, packages: entries.length, licensesAvailable: definition.licenses });
    for (const entry of entries) {
      collected.push({ ...entry, ecosystem: definition.id, licenseAvailable: definition.licenses });
    }
  }
  return {
    ecosystems,
    packages: collected.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

async function readNpm(root, config) {
  return readInstalledPackages(root, config);
}

// Installed distributions carry their metadata; a requirements file only
// carries intentions.
async function readPython(root, config) {
  const roots = config.sitePackages ? [config.sitePackages] : await findSitePackages(root);
  const packages = [];
  for (const relative of roots) {
    const base = resolve(root, relative);
    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith(".dist-info")) continue;
      const metadata = await readFile(join(base, entry.name, "METADATA"), "utf8").catch(() => undefined);
      if (metadata === undefined) continue;
      const fields = parseMetadata(metadata);
      if (!fields.name) continue;
      packages.push({ name: fields.name, version: fields.version ?? "0.0.0", license: fields.license });
    }
  }
  return packages;
}

async function findSitePackages(root) {
  const found = [];
  for (const environment of [".venv", "venv"]) {
    const libraries = await readdir(join(root, environment, "lib"), { withFileTypes: true }).catch(() => []);
    for (const entry of libraries) {
      if (entry.isDirectory()) found.push(join(environment, "lib", entry.name, "site-packages"));
    }
  }
  return found;
}

function parseMetadata(content) {
  const fields = {};
  const classifiers = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") break;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "name") fields.name = value;
    else if (key === "version") fields.version = value;
    else if (key === "license-expression") fields.license = value;
    else if (key === "license" && value && value !== "UNKNOWN") fields.license ??= value;
    else if (key === "classifier" && value.startsWith("License ::")) classifiers.push(value);
  }
  fields.license ??= licenseFromClassifiers(classifiers);
  return fields;
}

function licenseFromClassifiers(classifiers) {
  const known = new Map([
    ["MIT License", "MIT"],
    ["Apache Software License", "Apache-2.0"],
    ["BSD License", "BSD-3-Clause"],
    ["ISC License (ISCL)", "ISC"],
    ["GNU General Public License v3 (GPLv3)", "GPL-3.0-only"],
    ["GNU Lesser General Public License v3 (LGPLv3)", "LGPL-3.0-only"],
    ["Mozilla Public License 2.0 (MPL 2.0)", "MPL-2.0"],
  ]);
  for (const classifier of classifiers) {
    const label = classifier.split("::").at(-1).trim();
    if (known.has(label)) return known.get(label);
  }
  return undefined;
}

// go.mod names every module in the build list. Licenses are not part of it,
// so Go packages are inventoried and never license-gated.
async function readGo(root) {
  const content = await readFile(join(root, "go.mod"), "utf8").catch(() => undefined);
  if (content === undefined) return [];
  const packages = [];
  let inBlock = false;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (line === "require (") { inBlock = true; continue; }
    if (inBlock && line === ")") { inBlock = false; continue; }
    const match = inBlock
      ? /^(\S+)\s+(\S+)/.exec(line)
      : /^require\s+(\S+)\s+(\S+)/.exec(line);
    if (match) packages.push({ name: match[1], version: match[2] });
  }
  return packages;
}

async function readCargo(root) {
  const content = await readFile(join(root, "Cargo.lock"), "utf8").catch(() => undefined);
  if (content === undefined) return [];
  const packages = [];
  let current;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "[[package]]") {
      if (current?.name) packages.push(current);
      current = {};
      continue;
    }
    if (!current) continue;
    const match = /^(name|version)\s*=\s*"(.*)"$/.exec(line);
    if (match) current[match[1]] = match[2];
  }
  if (current?.name) packages.push(current);
  return packages.map((entry) => ({ name: entry.name, version: entry.version ?? "0.0.0" }));
}
