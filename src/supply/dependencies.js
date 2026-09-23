import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Reads what is actually installed rather than what the manifest asks for:
// a lockfile says what should be there, node_modules says what is.
export async function readInstalledPackages(root, { directory = "node_modules" } = {}) {
  const base = resolve(root, directory);
  const entries = await readdir(base, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".bin" || entry.name === ".cache") continue;
    if (entry.name.startsWith("@")) {
      const scoped = await readdir(join(base, entry.name), { withFileTypes: true }).catch(() => []);
      for (const child of scoped) {
        if (child.isDirectory()) packages.push(await describePackage(join(base, entry.name, child.name)));
      }
      continue;
    }
    packages.push(await describePackage(join(base, entry.name)));
  }
  return packages.filter(Boolean).sort((left, right) => left.name.localeCompare(right.name));
}

export function checkDependencyPolicy(packages, config = {}) {
  const licenses = config.licenses ?? {};
  const allow = new Set(licenses.allow ?? []);
  const deny = new Set(licenses.deny ?? []);
  const configured = allow.size > 0 || deny.size > 0;
  // With no license policy the gate enforces nothing; once one exists, an
  // unrecognised license is treated as a finding rather than waved through.
  const unknownEffect = licenses.unknown ?? (configured ? "deny" : "allow");
  const deniedPackages = config.packages?.deny ?? [];

  const violations = [];
  let unlicensedEcosystem = 0;
  for (const entry of packages) {
    if (deniedPackages.some((pattern) => matchesName(pattern, entry.name))) {
      violations.push({
        package: entry.name,
        version: entry.version,
        ...(entry.ecosystem ? { ecosystem: entry.ecosystem } : {}),
        reason: "package-denied",
      });
      continue;
    }
    const alternatives = entry.license === undefined ? [] : parseLicenseExpression(entry.license);
    if (alternatives.length === 0) {
      // Go modules and Cargo lockfiles carry no license data at all. Counting
      // that as a violation would be a finding nobody can act on, so it is
      // reported as a number instead.
      if (entry.licenseAvailable === false) {
        unlicensedEcosystem += 1;
        continue;
      }
      if (unknownEffect === "deny") {
        violations.push({
          package: entry.name,
          version: entry.version,
          ...(entry.ecosystem ? { ecosystem: entry.ecosystem } : {}),
          reason: "license-unknown",
        });
      }
      continue;
    }
    if (!configured) continue;
    // SPDX semantics: an OR alternative may be chosen, an AND term may not.
    const acceptable = alternatives.some((terms) => terms.every((identifier) => isAcceptable(identifier, allow, deny)));
    if (!acceptable) {
      violations.push({
        package: entry.name,
        version: entry.version,
        ...(entry.ecosystem ? { ecosystem: entry.ecosystem } : {}),
        license: entry.license,
        reason: alternatives.flat().some((identifier) => deny.has(identifier))
          ? "license-denied"
          : "license-not-allowed",
      });
    }
  }
  return {
    checked: packages.length,
    violations,
    ok: violations.length === 0,
    ...(unlicensedEcosystem > 0 ? { unlicensedEcosystem } : {}),
    ...(allow.size > 0 ? { allowedLicenses: [...allow].sort() } : {}),
  };
}

// Returns the OR alternatives, each a list of identifiers joined by AND.
export function parseLicenseExpression(expression) {
  if (typeof expression !== "string" || expression.trim() === "") return [];
  const alternatives = expression
    .replaceAll(/[()]/g, " ")
    .split(/\s+OR\s+/i)
    .map((alternative) => alternative
      .split(/\s+(?:AND|WITH)\s+/i)
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && part.toUpperCase() !== "SEE"))
    .filter((alternative) => alternative.length > 0);
  return alternatives;
}

function isAcceptable(identifier, allow, deny) {
  if (deny.has(identifier)) return false;
  return allow.size === 0 || allow.has(identifier);
}

async function describePackage(directory) {
  try {
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (!manifest.name) return undefined;
    return {
      name: manifest.name,
      version: manifest.version ?? "0.0.0",
      license: normalizeLicense(manifest),
      ...(manifest.repository ? { repository: repositoryUrl(manifest.repository) } : {}),
    };
  } catch {
    return undefined;
  }
}

function normalizeLicense(manifest) {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license?.type) return manifest.license.type;
  // Deprecated but still in older packages.
  if (Array.isArray(manifest.licenses)) {
    return manifest.licenses.map((entry) => entry?.type ?? entry).filter(Boolean).join(" OR ") || undefined;
  }
  return undefined;
}

function repositoryUrl(repository) {
  const url = typeof repository === "string" ? repository : repository.url;
  return typeof url === "string" ? url.replace(/^git\+/, "").replace(/\.git$/, "") : undefined;
}

function matchesName(pattern, name) {
  if (pattern === name) return true;
  if (!pattern.includes("*")) return false;
  const source = pattern.split("*").map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`).test(name);
}
