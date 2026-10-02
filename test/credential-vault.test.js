import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CredentialStore } from "../src/auth/credential-store.js";
import { detectVault } from "../src/auth/vault.js";

// The system store is stood in for by a map. What is checked is what the file
// holds and what the store is asked to do, not any one operating system.

function fakeVault(id = "fake") {
  const items = new Map();
  let counter = 0;
  return {
    id, label: "a fake store", items,
    async seal(plain) { const key = `k${++counter}`; items.set(key, plain); return `vault:${id}:${key}`; },
    async open(payload) { if (!items.has(payload)) throw new Error("gone"); return items.get(payload); },
    async forget(payload) { items.delete(payload); },
  };
}

async function store(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "etnpilot-vault-"));
  const path = join(dir, "credentials.json");
  return { path, make: (extra = {}) => new CredentialStore({ path, ...options, ...extra }) };
}

const SECRET = "gho_supersecret";

test("with the system store chosen, no secret reaches the file, and the login still works", async () => {
  const vault = fakeVault();
  const { path, make } = await store({ vault });
  const credentials = make();
  await credentials.save("github.token", { value: SECRET, kind: "oauth", account: "peter", host: "https://github.com" });
  assert.equal(await credentials.get("github.token"), SECRET, "a plain login is read as before");
  await credentials.useVault("system");
  assert.equal(await credentials.get("github.token"), SECRET);
  const text = await readFile(path, "utf8");
  assert.doesNotMatch(text, /supersecret/);
  assert.match(text, /"vault": "system"/);
  assert.equal((await credentials.describe("github.token")).inSystemStore, true);
  assert.equal(vault.items.size, 1);
});

test("a login saved after the choice goes straight to the system store, and replacing it leaves nothing behind", async () => {
  const vault = fakeVault();
  const { path, make } = await store({ vault });
  const credentials = make();
  await credentials.useVault("system");
  await credentials.save("github.token", { value: "one", refreshToken: "r1", kind: "oauth" });
  await credentials.save("github.token", { value: "two", refreshToken: "r2", kind: "oauth" });
  assert.deepEqual([...vault.items.values()].sort(), ["r2", "two"]);
  assert.doesNotMatch(await readFile(path, "utf8"), /"(one|two|r1|r2)"/);
  assert.equal(await credentials.get("github.token"), "two");
  await credentials.remove("github.token");
  assert.equal(vault.items.size, 0, "signing out removes the secrets from the system store too");
});

test("a renewal keeps the new secrets in the system store", async () => {
  const vault = fakeVault();
  const now = 1_000_000;
  const refresher = async (entry) => ({ ...entry, value: `renewed-of-${entry.refreshToken}`, refreshToken: "r2", expiresAt: now + 3_600_000 });
  const { path, make } = await store({ vault, refresher, now: () => now });
  const credentials = make();
  await credentials.useVault("system");
  await credentials.save("github.token", { value: "old", refreshToken: "r1", expiresAt: now + 10_000, kind: "oauth", host: "https://github.com" });
  assert.equal(await credentials.get("github.token"), "renewed-of-r1", "the refresher is handed the real refresh token, not the reference");
  assert.doesNotMatch(await readFile(path, "utf8"), /renewed-of|"r2"/);
  assert.deepEqual([...vault.items.values()].sort(), ["r2", "renewed-of-r1"]);
});

test("moving back to the file returns the secrets and empties the system store", async () => {
  const vault = fakeVault();
  const { path, make } = await store({ vault });
  const credentials = make();
  await credentials.useVault("system");
  await credentials.save("github.token", { value: SECRET, kind: "oauth" });
  assert.equal(await credentials.useVault("file"), 1);
  assert.equal(vault.items.size, 0);
  assert.match(await readFile(path, "utf8"), /supersecret/);
  assert.doesNotMatch(await readFile(path, "utf8"), /"vault"/);
  assert.equal(await credentials.get("github.token"), SECRET);
});

test("a machine without the store cannot choose it, and a copied file is refused rather than guessed at", async () => {
  const vault = fakeVault();
  const { make } = await store({ vault });
  const credentials = make();
  await credentials.useVault("system");
  await credentials.save("github.token", { value: SECRET, kind: "oauth", host: "https://github.com" });

  const elsewhere = make({ vault: () => undefined });
  const answer = await elsewhere.resolve("github.token");
  assert.match(answer.refused, /another machine's system store/);
  await assert.rejects(() => elsewhere.useVault("system"), /no system store/);
});

test("a move that fails half way changes nothing", async () => {
  const vault = fakeVault();
  const { path, make } = await store({ vault });
  const credentials = make();
  await credentials.save("github.token", { value: SECRET, kind: "oauth" });
  await credentials.save("openai.apiKey", { value: "sk-other", kind: "key" });
  let calls = 0;
  const original = vault.seal;
  vault.seal = async (plain) => { if (++calls === 2) throw new Error("keyring locked"); return original(plain); };
  await assert.rejects(() => credentials.useVault("system"), /keyring locked/);
  assert.equal(vault.items.size, 0, "what was already sealed is taken back");
  assert.match(await readFile(path, "utf8"), /supersecret/);
  assert.doesNotMatch(await readFile(path, "utf8"), /"vault"/);
});

test("the system tools get the secret on standard input where they allow it, and Termux gets no store", async () => {
  const seen = [];
  const run = async (command, args, options = {}) => {
    seen.push({ command, args, input: options.input });
    return { code: 0, stdout: "x\n", stderr: "" };
  };
  const linux = await detectVault({ platform: "linux", env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" }, run });
  const reference = await linux.seal("topsecret");
  assert.match(reference, /^vault:secret-service:/);
  const store = seen.find((call) => call.args[0] === "store");
  assert.equal(store.input, "topsecret");
  assert.ok(!JSON.stringify(store.args).includes("topsecret"), "not in the argument list");

  seen.length = 0;
  const windows = await detectVault({ platform: "win32", env: {}, run });
  assert.match(await windows.seal("topsecret"), /^vault:dpapi:/);
  assert.equal(seen.at(-1).input, "topsecret");
  assert.ok(!JSON.stringify(seen.at(-1).args).includes("topsecret"));

  assert.equal(await detectVault({ platform: "android", env: {}, run }), undefined);
  assert.equal(await detectVault({ platform: "linux", env: {}, run }), undefined, "no desktop session, no Secret Service");
  assert.equal(await detectVault({ platform: "darwin", env: {}, run: async () => ({ code: 127, stdout: "", stderr: "" }) }), undefined, "tool not installed");
});
