import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defineSecretProvider } from "../src/secrets/provider.js";
import { createSecretResolver, SecretResolutionError } from "../src/secrets/resolver.js";

test("environment secrets resolve through named references without appearing in diagnostics", async () => {
  const resolver = createSecretResolver({
    env: { SERVICE_TOKEN: "top-secret-value" },
    config: { secrets: {
      providers: { environment: { type: "env", allow: ["SERVICE_TOKEN"] } },
      values: { "service.token": { provider: "environment", key: "SERVICE_TOKEN" } },
    } },
  });
  assert.equal(await resolver.get("service.token", { required: true }), "top-secret-value");
  const check = await resolver.check("service.token");
  assert.deepEqual(check, {
    name: "service.token",
    configured: true,
    available: true,
    provider: "environment",
  });
  assert.doesNotMatch(JSON.stringify(check), /top-secret-value/);
});

test("file secret provider confines paths and enforces owner-only files", async () => {
  const root = await mkdtemp(join(tmpdir(), "etnpilot-file-secrets-"));
  const secretRoot = join(root, "secrets");
  await mkdir(secretRoot, { mode: 0o700 });
  const secretPath = join(secretRoot, "token");
  await writeFile(secretPath, "file-secret\n", { mode: 0o600 });
  const resolver = createSecretResolver({
    root,
    config: { secrets: {
      providers: { local: { type: "file", root: "secrets" } },
      values: {
        "service.token": { provider: "local", key: "token" },
        "escape.token": { provider: "local", key: "../outside" },
      },
    } },
  });
  assert.equal(await resolver.get("service.token", { required: true }), "file-secret");
  await assert.rejects(
    resolver.get("escape.token", { required: true }),
    (error) => error instanceof SecretResolutionError
      && error.code === "provider_failed"
      && !error.message.includes("outside"),
  );

  if (process.platform !== "win32") {
    await chmod(secretPath, 0o644);
    await assert.rejects(
      resolver.get("service.token", { required: true }),
      (error) => error.code === "provider_failed" && !JSON.stringify(error).includes("file-secret"),
    );
  }
});

test("file secret provider rejects symlinks escaping its root", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "etnpilot-file-secret-link-"));
  const secretRoot = join(root, "secrets");
  await mkdir(secretRoot);
  const outside = join(root, "outside");
  await writeFile(outside, "outside-secret", { mode: 0o600 });
  await symlink(outside, join(secretRoot, "linked"));
  const resolver = createSecretResolver({
    root,
    config: { secrets: {
      providers: { local: { type: "file", root: "secrets" } },
      values: { linked: { provider: "local", key: "linked" } },
    } },
  });
  await assert.rejects(resolver.get("linked", { required: true }), (error) => error.code === "provider_failed");
});

test("custom secret provider factories use the versioned provider contract", async () => {
  const resolver = createSecretResolver({
    config: { secrets: {
      providers: { vault: { type: "mock-vault" } },
      values: { "service.token": { provider: "vault", key: "apps/service" } },
    } },
    factories: {
      "mock-vault": (name) => defineSecretProvider({
        apiVersion: 1,
        name,
        resolve: async (key) => key === "apps/service" ? "vault-value" : undefined,
      }),
    },
  });
  assert.equal(await resolver.get("service.token", { required: true }), "vault-value");
  assert.throws(
    () => defineSecretProvider({ apiVersion: 2, name: "future", resolve: async () => "value" }),
    /Unsupported secret provider apiVersion/,
  );
});
