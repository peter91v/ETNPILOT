// @ts-check
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { storeFor } from "./login.js";
import { SERVICES } from "./services.js";

// git's credential helper protocol, for the stored GitLab login. Once the
// helper is installed in a repository, 'git push' asks it for the user name and
// token instead of the person, and the person is asked nothing. It answers only
// for the host the login was issued for, over https (see hostAllowed).

const run = promisify(execFile);
const SECRET = SERVICES.gitlab.secret;

/** @param {string} text */
export function parseCredentialInput(text) {
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of String(text).split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1);
  }
  return fields;
}

// The answer for 'get': the lines to print, or nothing when this helper has no
// opinion (git then asks the next helper, or the person).
export async function answerGet(fields, { env = process.env, fetchImpl } = /** @type {any} */ ({})) {
  if (!fields.host || (fields.protocol !== "https" && fields.protocol !== "http")) return undefined;
  const store = storeFor({ env, fetchImpl });
  const found = await store.resolve(SECRET, { baseUrl: `${fields.protocol}://${fields.host}` });
  if (!found || "refused" in found || !found.value) return undefined;
  const entry = (await store.read()).credentials[SECRET];
  return `username=${entry?.account || "oauth2"}\npassword=${found.value}\n`;
}

// 'etnpilot credential get|store|erase' reading git's request on stdin. Only
// 'get' does anything: the login is changed with 'etnpilot login', never by git.
export async function runCredentialCommand(action, { stdin = process.stdin, stdout = process.stdout, env = process.env, fetchImpl } = /** @type {any} */ ({})) {
  if (action !== "get" && action !== "store" && action !== "erase") throw new Error("Use 'etnpilot credential get|store|erase' (git calls it).");
  if (action !== "get") return 0;
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  let answer;
  try {
    answer = await answerGet(parseCredentialInput(Buffer.concat(chunks).toString("utf8")), { env, fetchImpl });
  } catch {
    answer = undefined; // a helper that fails must not break git; it just does not answer
  }
  if (answer) stdout.write(answer);
  return 0;
}

const quote = (path) => `"${path.replace(/\\/g, "/")}"`;

export function helperCommand({ node = process.execPath, script = fileURLToPath(new URL("../../bin/etnpilot.js", import.meta.url)) } = {}) {
  return `!${quote(node)} ${quote(script)} credential`;
}

// Installs the helper for one address in this repository's own git config, and
// puts it first (an empty helper resets those from the user's global config,
// so a credential manager does not ask before it). Returns the address.
export async function installCredentialHelper(root, baseUrl, { command = helperCommand() } = {}) {
  const origin = new URL(baseUrl).origin;
  const key = `credential.${origin}.helper`;
  const git = (...args) => run("git", ["-C", root, ...args]);
  try {
    await git("config", "--local", "--unset-all", key);
  } catch { /* nothing set yet: exit status 5 */ }
  await git("config", "--local", "--add", key, "");
  await git("config", "--local", "--add", key, command);
  return origin;
}

export async function credentialHelperInstalled(root, baseUrl) {
  try {
    const { stdout } = await run("git", ["-C", root, "config", "--local", "--get-all", `credential.${new URL(baseUrl).origin}.helper`]);
    return stdout.includes(" credential");
  } catch {
    return false;
  }
}
