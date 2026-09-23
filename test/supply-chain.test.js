import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkDependencyPolicy, parseLicenseExpression, readInstalledPackages } from "../src/supply/dependencies.js";
import { generateSbom } from "../src/supply/sbom.js";
import { scanContent, scanForSecrets, shannonEntropy } from "../src/supply/secret-scan.js";
import { buildRunAttestation } from "../src/supply/attestation.js";
import { JsonlReceiptStore } from "../src/core/receipt-store.js";
import { git } from "../src/git/command.js";

test("dependency policy gates licenses and named packages", async () => {
  const root = await createModules([
    { name: "allowed", version: "1.0.0", license: "MIT" },
    { name: "@scope/dual", version: "2.0.0", license: "(MIT OR Apache-2.0)" },
    { name: "copyleft", version: "3.0.0", license: "AGPL-3.0-only" },
    { name: "mystery", version: "4.0.0" },
    { name: "banned-lib", version: "5.0.0", license: "MIT" },
  ]);
  const packages = await readInstalledPackages(root);
  assert.deepEqual(packages.map((entry) => entry.name), ["@scope/dual", "allowed", "banned-lib", "copyleft", "mystery"]);

  const report = checkDependencyPolicy(packages, {
    licenses: { allow: ["MIT", "Apache-2.0"], unknown: "deny" },
    packages: { deny: ["banned-*"] },
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.violations.map((violation) => [violation.package, violation.reason]).sort(), [
    ["banned-lib", "package-denied"],
    ["copyleft", "license-not-allowed"],
    ["mystery", "license-unknown"],
  ]);

  // SPDX semantics: an OR alternative may be chosen, an AND term may not.
  assert.deepEqual(parseLicenseExpression("(MIT OR Apache-2.0)"), [["MIT"], ["Apache-2.0"]]);
  assert.deepEqual(parseLicenseExpression("MIT AND AGPL-3.0-only"), [["MIT", "AGPL-3.0-only"]]);
  assert.equal(checkDependencyPolicy(packages, { licenses: { allow: ["MIT"], unknown: "allow" } })
    .violations.some((violation) => violation.package === "@scope/dual"), false);
  assert.equal(checkDependencyPolicy(
    [{ name: "combined", version: "1.0.0", license: "MIT AND AGPL-3.0-only" }],
    { licenses: { allow: ["MIT"] } },
  ).violations[0].reason, "license-not-allowed");

  // Without a configured policy the gate enforces nothing.
  assert.equal(checkDependencyPolicy(packages, {}).ok, true);
});

test("the SBOM lists installed components and stays stable", async () => {
  const root = await createModules([{ name: "allowed", version: "1.0.0", license: "MIT" }]);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0", license: "MIT" }));

  const first = await generateSbom(root, { timestamp: new Date("2026-01-01T00:00:00Z") });
  const second = await generateSbom(root, { timestamp: new Date("2026-06-01T00:00:00Z") });

  assert.equal(first.bomFormat, "CycloneDX");
  assert.equal(first.metadata.component.name, "fixture");
  assert.deepEqual(first.components.map((component) => component.purl), ["pkg:npm/allowed@1.0.0"]);
  assert.deepEqual(first.components[0].licenses, [{ license: { id: "MIT" } }]);
  // Same tree, same identity: a diff then means the dependencies changed.
  assert.equal(first.serialNumber, second.serialNumber);
});

test("secret scanning finds real tokens and ignores code and fixtures", () => {
  const findings = scanContent([
    "const token = 'glpat-ABCDEFGHIJKLMNOPQRSTU';", // etnpilot:allow-secret
    "export const SECRET_PROVIDER_VERSION = SECRET_PROVIDER_API_VERSION;",
    "process.env.TEST_SECRET = 'must-not-cross-boundary';",
    "const apiKey = 'AKIAIOSFODNN7EXAMPLE';", // etnpilot:allow-secret
    "const allowed = 'glpat-ABCDEFGHIJKLMNOPQRSTU'; // etnpilot:allow-secret",
  ].join("\n"));

  assert.deepEqual(findings.map((finding) => [finding.rule, finding.line]), [
    ["gitlab-pat", 1],
    ["aws-access-key", 4],
  ]);
  // The value itself is never echoed.
  assert.equal(findings[0].preview, "glpa…TU");
  assert.doesNotMatch(JSON.stringify(findings), /ABCDEFGHIJKLMNOPQRSTU/);
  assert.ok(shannonEntropy("aaaaaaaa") < shannonEntropy("f3Kq9zPx1LmV"));
});

test("this repository is free of detectable secrets", async () => {
  const report = await scanForSecrets(process.cwd());
  assert.deepEqual(report.findings, [], "unexpected secret findings in the repository");
  assert.ok(report.scanned > 50);
});

test("a run attestation restates the receipt as an in-toto statement", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-attest-"));
  await git(["init", "-b", "main"], { cwd: root });
  await writeFile(join(root, "generated.txt"), "artifact\n");
  const receiptPath = join(root, "run.jsonl");
  const store = new JsonlReceiptStore(receiptPath);
  await store.append({ type: "agent", runId: "run-1", status: "succeeded" });
  await store.append({
    type: "workflow",
    terminal: true,
    runId: "run-1",
    status: "succeeded",
    workspace: { path: root, branch: "etnpilot/run-1", managed: true },
    git: { head: "a".repeat(40), changedPaths: ["generated.txt"] },
  });

  const statement = await buildRunAttestation(receiptPath, { root });
  assert.equal(statement._type, "https://in-toto.io/Statement/v1");
  assert.equal(statement.predicateType, "https://slsa.dev/provenance/v1");
  assert.equal(statement.subject[0].name, "generated.txt");
  assert.match(statement.subject[0].digest.sha256, /^[a-f0-9]{64}$/);
  assert.equal(statement.predicate.buildDefinition.externalParameters.branch, "etnpilot/run-1");
  assert.deepEqual(statement.predicate.buildDefinition.resolvedDependencies, [
    { uri: "git+HEAD", digest: { sha1: "a".repeat(40) } },
  ]);
  assert.equal(statement.predicate.runDetails.metadata.invocationId, "run-1");

  // An unfinished run cannot be attested.
  const openPath = join(root, "open.jsonl");
  await new JsonlReceiptStore(openPath).append({ type: "agent", runId: "run-2" });
  await assert.rejects(() => buildRunAttestation(openPath, { root }), /no terminal entry/);
});

async function createModules(packages) {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-deps-"));
  for (const entry of packages) {
    const directory = join(root, "node_modules", entry.name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify(entry));
  }
  return root;
}
