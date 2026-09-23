import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readInstalledPackages } from "./dependencies.js";

const SPEC_VERSION = "1.5";

// A CycloneDX document describing what is installed, so a reviewer can answer
// "what shipped" without trusting the agent's summary of it.
export async function generateSbom(root, { packages, serialNumber, timestamp = new Date() } = {}) {
  const projectRoot = resolve(root);
  const manifest = await readJson(join(projectRoot, "package.json"));
  const installed = packages ?? await readInstalledPackages(projectRoot);
  const components = installed.map((entry) => ({
    type: "library",
    "bom-ref": `pkg:npm/${entry.name}@${entry.version}`,
    name: entry.name,
    version: entry.version,
    purl: `pkg:npm/${encodeURIComponent(entry.name).replaceAll("%40", "@").replaceAll("%2F", "/")}@${entry.version}`,
    ...(entry.license ? { licenses: [{ license: { id: entry.license } }] } : {}),
    ...(entry.repository ? { externalReferences: [{ type: "vcs", url: entry.repository }] } : {}),
  }));

  return {
    bomFormat: "CycloneDX",
    specVersion: SPEC_VERSION,
    serialNumber: serialNumber ?? `urn:uuid:${deterministicUuid(projectRoot, components)}`,
    version: 1,
    metadata: {
      timestamp: timestamp.toISOString(),
      tools: [{ vendor: "ETNPilot", name: "etnpilot", version: await toolVersion() }],
      ...(manifest ? {
        component: {
          type: "application",
          "bom-ref": `pkg:npm/${manifest.name}@${manifest.version}`,
          name: manifest.name,
          version: manifest.version,
          ...(manifest.license ? { licenses: [{ license: { id: manifest.license } }] } : {}),
        },
      } : {}),
    },
    components,
  };
}

async function toolVersion() {
  const manifest = await readJson(new URL("../../package.json", import.meta.url).pathname);
  return manifest?.version ?? "0.0.0";
}

// Stable across runs with identical input, so an unchanged tree produces an
// unchanged document and diffs stay meaningful.
function deterministicUuid(root, components) {
  const digest = createHash("sha256")
    .update(root)
    .update(components.map((component) => component["bom-ref"]).join("\n"))
    .digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    ((Number.parseInt(digest.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0") + digest.slice(18, 20),
    digest.slice(20, 32),
  ].join("-");
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}
