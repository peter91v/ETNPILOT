// @ts-check
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

// Where the secret part of a stored login can live instead of the credentials
// file: the system's own store. No native module is involved (the project has
// one runtime dependency and stays that way); the system's command-line tool
// does the work, and the secret is handed to it on standard input wherever the
// tool allows that.
//
//   macOS    the login keychain, through `security`
//   Linux    the Secret Service (GNOME Keyring, KWallet), through `secret-tool`
//   Windows  DPAPI for the current user, through PowerShell: the file then
//            holds ciphertext only this Windows account can open
//   Termux   none, so the file stays as it was
//
// The credentials file keeps everything that is not a secret (who, which
// host, when it expires). A secret in it is replaced by a reference of the
// form 'vault:<scheme>:<payload>', which only this module understands.

const SERVICE = "etnpilot";
export const VAULT_PREFIX = "vault:";

export function isVaultReference(value) {
  return typeof value === "string" && value.startsWith(VAULT_PREFIX);
}

/** @typedef {(command: string, args: string[], options?: { input?: string }) => Promise<{ code: number, stdout: string, stderr: string }>} Run */

/** @type {Run} */
export function runCommand(command, args, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { encoding: "utf8", timeout: 15_000, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 127) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

function mustSucceed(result, what) {
  if (result.code !== 0) throw new Error(`${what} failed${result.stderr.trim() ? `: ${result.stderr.trim().split("\n")[0]}` : ` (exit ${result.code})`}`);
  return result;
}

/** @param {Run} run */
function macKeychain(run) {
  return {
    id: "keychain",
    label: "the macOS keychain",
    async available() { return (await run("security", ["help"])).code !== 127; },
    // `security` takes the password as an argument, so it is visible to this
    // user's other processes for the moment the command runs; it is not
    // written anywhere. That is the tool's only way in.
    async seal(plain) {
      const id = randomUUID();
      mustSucceed(await run("security", ["add-generic-password", "-a", id, "-s", SERVICE, "-w", plain, "-U"]), "Saving to the keychain");
      return `${VAULT_PREFIX}keychain:${id}`;
    },
    async open(payload) {
      return mustSucceed(await run("security", ["find-generic-password", "-a", payload, "-s", SERVICE, "-w"]), "Reading from the keychain").stdout.replace(/\r?\n$/, "");
    },
    async forget(payload) { await run("security", ["delete-generic-password", "-a", payload, "-s", SERVICE]); },
  };
}

/** @param {Run} run */
function secretService(run) {
  return {
    id: "secret-service",
    label: "the system keyring (Secret Service)",
    async available() { return (await run("secret-tool", ["--version"])).code !== 127; },
    async seal(plain) {
      const id = randomUUID();
      mustSucceed(await run("secret-tool", ["store", "--label=ETNPilot login", "service", SERVICE, "account", id], { input: plain }), "Saving to the keyring");
      return `${VAULT_PREFIX}secret-service:${id}`;
    },
    async open(payload) {
      return mustSucceed(await run("secret-tool", ["lookup", "service", SERVICE, "account", payload]), "Reading from the keyring").stdout;
    },
    async forget(payload) { await run("secret-tool", ["clear", "service", SERVICE, "account", payload]); },
  };
}

const POWERSHELL = ["-NoProfile", "-NonInteractive", "-Command"];
const PROTECT = "Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s),$null,'CurrentUser'))";
const UNPROTECT = "Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd().Trim(); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s),$null,'CurrentUser'))";

/** @param {Run} run */
function windowsDpapi(run) {
  return {
    id: "dpapi",
    label: "Windows data protection (this Windows account only)",
    async available() { return (await run("powershell", [...POWERSHELL, "$PSVersionTable.PSVersion.Major"])).code === 0; },
    async seal(plain) {
      const out = mustSucceed(await run("powershell", [...POWERSHELL, PROTECT], { input: plain }), "Protecting the secret").stdout.trim();
      return `${VAULT_PREFIX}dpapi:${out}`;
    },
    async open(payload) {
      return mustSucceed(await run("powershell", [...POWERSHELL, UNPROTECT], { input: payload }), "Opening the secret").stdout.replace(/\r?\n$/, "");
    },
    async forget() { /* ciphertext lives in the file; nothing else to remove */ },
  };
}

/**
 * The system store for this machine, or undefined when there is none.
 * @param {{ platform?: string, env?: Record<string, string | undefined>, run?: Run }} [options]
 */
export async function detectVault({ platform = process.platform, env = process.env, run = runCommand } = {}) {
  // Termux reports "android"; a Linux box without a desktop session has no
  // Secret Service to talk to either, and `secret-tool` would only hang.
  const candidate = platform === "darwin" ? macKeychain(run)
    : platform === "win32" ? windowsDpapi(run)
      : platform === "linux" && (env.DBUS_SESSION_BUS_ADDRESS || env.XDG_RUNTIME_DIR) ? secretService(run)
        : undefined;
  return candidate && await candidate.available() ? candidate : undefined;
}

/** Which backend handles a reference, by its scheme. */
export function vaultScheme(reference) {
  return /^vault:([a-z-]+):/.exec(reference)?.[1];
}

export function vaultPayload(reference) {
  return reference.slice(VAULT_PREFIX.length + (vaultScheme(reference)?.length ?? 0) + 1);
}
