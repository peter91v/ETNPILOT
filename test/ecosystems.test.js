import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ecosystemPurl, readProjectPackages } from "../src/supply/ecosystems.js";
import { checkDependencyPolicy } from "../src/supply/dependencies.js";
import { generateSbom } from "../src/supply/sbom.js";

test("dependencies are read from each ecosystem where its truth lives", async () => {
  const root = await createPolyglotProject();
  const { ecosystems, packages } = await readProjectPackages(root);

  assert.deepEqual(ecosystems, [
    { id: "npm", packages: 1, licensesAvailable: true },
    { id: "pypi", packages: 2, licensesAvailable: true },
    { id: "golang", packages: 2, licensesAvailable: false },
    { id: "cargo", packages: 2, licensesAvailable: false },
  ]);

  const byName = Object.fromEntries(packages.map((entry) => [entry.name, entry]));
  assert.equal(byName["left-pad"].license, "MIT");
  // A License-Expression wins over the deprecated classifier.
  assert.equal(byName.requests.license, "Apache-2.0");
  // …and a classifier is used when that is all there is.
  assert.equal(byName.flask.license, "BSD-3-Clause");
  assert.equal(byName["github.com/pkg/errors"].version, "v0.9.1");
  assert.equal(byName.serde.version, "1.0.210");
  assert.equal(byName.serde.licenseAvailable, false);

  assert.equal(ecosystemPurl(byName.requests), "pkg:pypi/requests@2.32.3");
  assert.equal(ecosystemPurl(byName["github.com/pkg/errors"]), "pkg:golang/github.com/pkg/errors@v0.9.1");
});

test("ecosystems without license data are counted, not reported as violations", async () => {
  const root = await createPolyglotProject();
  const { packages } = await readProjectPackages(root);
  const report = checkDependencyPolicy(packages, {
    licenses: { allow: ["MIT", "Apache-2.0", "BSD-3-Clause"] },
  });

  // Go and Rust carry no license metadata, so there is nothing to act on.
  assert.equal(report.ok, true);
  assert.equal(report.unlicensedEcosystem, 4);

  // A Python package with a disallowed license is still a finding.
  const withCopyleft = checkDependencyPolicy(
    [...packages, { name: "copyleft", version: "1.0", license: "AGPL-3.0-only", ecosystem: "pypi", licenseAvailable: true }],
    { licenses: { allow: ["MIT"] } },
  );
  assert.equal(withCopyleft.ok, false);
  assert.deepEqual(
    withCopyleft.violations.map((violation) => [violation.package, violation.ecosystem, violation.reason]).sort(),
    [["copyleft", "pypi", "license-not-allowed"], ["flask", "pypi", "license-not-allowed"], ["requests", "pypi", "license-not-allowed"]],
  );
});

test("the SBOM spans every ecosystem it found", async () => {
  const root = await createPolyglotProject();
  const document = await generateSbom(root, { timestamp: new Date("2026-01-01T00:00:00Z") });
  const purls = document.components.map((component) => component.purl).sort();
  assert.deepEqual(purls, [
    "pkg:cargo/serde@1.0.210",
    "pkg:cargo/tokio@1.40.0",
    "pkg:golang/github.com/pkg/errors@v0.9.1",
    "pkg:golang/golang.org/x/sync@v0.8.0",
    "pkg:npm/left-pad@1.3.0",
    "pkg:pypi/flask@3.0.3",
    "pkg:pypi/requests@2.32.3",
  ]);
});

async function createPolyglotProject() {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-polyglot-"));
  await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
  await writeFile(
    join(root, "node_modules", "left-pad", "package.json"),
    JSON.stringify({ name: "left-pad", version: "1.3.0", license: "MIT" }),
  );

  const site = join(root, ".venv", "lib", "python3.13", "site-packages");
  await mkdir(join(site, "requests-2.32.3.dist-info"), { recursive: true });
  await writeFile(join(site, "requests-2.32.3.dist-info", "METADATA"), [
    "Metadata-Version: 2.4",
    "Name: requests",
    "Version: 2.32.3",
    "License-Expression: Apache-2.0",
    "Classifier: License :: OSI Approved :: MIT License",
    "",
    "The long description follows the header block.",
  ].join("\n"));
  await mkdir(join(site, "flask-3.0.3.dist-info"), { recursive: true });
  await writeFile(join(site, "flask-3.0.3.dist-info", "METADATA"), [
    "Metadata-Version: 2.1",
    "Name: flask",
    "Version: 3.0.3",
    "Classifier: License :: OSI Approved :: BSD License",
    "",
  ].join("\n"));

  await writeFile(join(root, "go.mod"), [
    "module example.com/app",
    "",
    "go 1.23",
    "",
    "require (",
    "\tgithub.com/pkg/errors v0.9.1",
    "\tgolang.org/x/sync v0.8.0 // indirect",
    ")",
    "",
  ].join("\n"));

  await writeFile(join(root, "Cargo.lock"), [
    'version = 3',
    "",
    "[[package]]",
    'name = "serde"',
    'version = "1.0.210"',
    "",
    "[[package]]",
    'name = "tokio"',
    'version = "1.40.0"',
    "",
  ].join("\n"));

  return root;
}
