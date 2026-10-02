// @ts-check
import { join, resolve } from "node:path";
import { allowHost, authStatus, loginWithDevice, logout, saveKey, storeFor } from "../auth/login.js";
import { SERVICE_IDS, normalizeAuthHost, serviceFor } from "../auth/services.js";
import { loadConfig } from "../config/load.js";
import { setSetting } from "../config/settings.js";

// 'etnpilot login <service>', 'logout <service>' and 'auth status'. The web page
// offers the same through the same functions.

export const AUTH_USAGE = `  etnpilot login <anthropic|openai|github|gitlab> [--key-stdin] [--client-id id] [--host url] [--no-verify]
  etnpilot login <service> --allow-host name      let the stored login be sent to one more host (a proxy)
  etnpilot logout <anthropic|openai|github|gitlab>
  etnpilot auth status
  etnpilot auth vault [system|file]               where the secrets of stored logins are kept`;

export async function runAuthCommand(command, subcommand, values, { stdin = process.stdin, stdout = process.stdout, env = process.env, fetchImpl, sleep, rest = [] } = /** @type {any} */ ({})) {
  const say = (line = "") => stdout.write(`${line}\n`);

  if (command === "auth" && subcommand === "vault") return await runVaultCommand(rest[0], { say, env });

  if (command === "auth" || (command === "login" && !subcommand)) {
    if (command === "auth" && subcommand !== "status" && subcommand !== undefined) throw new Error("Use 'etnpilot auth status' or 'etnpilot auth vault'.");
    const entries = await authStatus({ env });
    for (const entry of entries) say(describeStatus(entry));
    const problem = entries.find((entry) => entry.storeProblem)?.storeProblem;
    if (problem) say(`\nWarning: ${problem}`);
    if (command === "login") say(`\nSign in with: etnpilot login <${SERVICE_IDS.join("|")}>`);
    return 0;
  }

  const service = serviceFor(subcommand);

  if (command === "login" && values["allow-host"]) {
    const result = await allowHost(service.id, values["allow-host"], { env });
    say(`The stored ${service.label} login may now also be sent to: ${result.hosts.join(", ")}.`);
    return 0;
  }

  if (command === "logout") {
    const { removed } = await logout(service.id, { env });
    say(removed ? `Signed out of ${service.label}. The stored login is removed.` : `No stored ${service.label} login.`);
    if (env[service.env]) say(`${service.env} is still set in the environment and is still used.`);
    return 0;
  }

  const verify = !values["no-verify"];
  const options = { env, fetchImpl, verify };
  let host = values.host;
  if (service.id === "gitlab" && !host) host = await projectGitLabHost(values.root);

  if (service.method === "device") {
    const clientId = values["client-id"];
    const wantsKey = values["key-stdin"];
    if (!wantsKey) {
      try {
        const result = await loginWithDevice(service.id, {
          env, fetchImpl, sleep, clientId, host,
          onCode: (flow) => {
            say(`Open ${flow.verificationUri} on any device and enter the code:`);
            say();
            say(`    ${flow.userCode}`);
            say();
            if (flow.verificationUriComplete) say(`(or open ${flow.verificationUriComplete})`);
            say("Waiting for you to confirm… (Ctrl+C to stop)");
          },
        });
        say(`Signed in to ${service.label}${result.account ? ` as ${result.account}` : ""}.`);
        await rememberHost(service, values.host, { root: values.root, env, say });
        return 0;
      } catch (error) {
        if (error.code !== "client_id_required") throw error;
        say(error.message);
        if (!stdin.isTTY) {
          say(`Or pipe a token: etnpilot login ${service.id} --key-stdin`);
          return 1;
        }
        say("\nOr paste a token instead.");
      }
    }
    const token = await readSecret(`${service.label} token: `, { stdin, stdout });
    const saved = report(service, await saveKey(service.id, token, { ...options, host }), say);
    await rememberHost(service, values.host, { root: values.root, env, say });
    return saved;
  }

  const key = await readSecret(`${service.label} API key: `, { stdin, stdout, hint: service.keyHelp });
  return report(service, await saveKey(service.id, key, options), say);
}

function report(service, result, say) {
  say(`Saved the ${service.label} ${service.method === "key" ? "key" : "token"}${result.account ? ` for ${result.account}` : ""}.`);
  if (!result.verified) say(`Not verified: ${result.note ?? "the check was skipped"}`);
  return 0;
}

export function describeStatus(entry) {
  const name = entry.label.padEnd(10);
  if (!entry.connected) return `${name} not connected   (etnpilot login ${entry.id})`;
  if (entry.source === "environment") return `${name} connected      from ${entry.environmentVariable} in the environment`;
  const stored = entry.stored;
  if (stored.needsSignIn) return `${name} sign-in expired  (etnpilot login ${entry.id})`;
  const who = stored.account ? ` as ${stored.account}` : "";
  const how = stored.kind === "oauth" ? "signed in" : "key stored";
  const warn = stored.verified ? "" : "  (not verified)";
  return `${name} connected      ${how}${who}${warn}${stored.inSystemStore ? "  (system store)" : ""}`;
}

// A self-hosted GitLab was named on the command line ('--host'). The project
// needs the same address as 'git.baseUrl' to use the login, so when it has none
// it is set now, in this person's own settings (never the committed file), and
// said. A project that already has an address is left alone.
async function rememberHost(service, host, { root, env, say }) {
  if (service.id !== "gitlab" || !host) return;
  const projectRoot = resolve(root ?? ".");
  let config;
  try {
    config = await loadConfig(join(projectRoot, ".etnpilot", "etnpilot.yaml"));
  } catch {
    return; // not inside an ETNPilot project: nothing to set
  }
  if (config.git?.baseUrl) return;
  const address = normalizeAuthHost(host);
  await setSetting("git.baseUrl", address, { root: projectRoot, env, scope: "local" });
  say(`This project had no git.baseUrl; it is now ${address} (your own settings, not committed).`);
}

async function projectGitLabHost(root) {
  try {
    return (await loadConfig(join(resolve(root ?? "."), ".etnpilot", "etnpilot.yaml"))).git?.baseUrl;
  } catch {
    return undefined;
  }
}

// A key is typed without echo on a terminal and read whole from a pipe.
export async function readSecret(prompt, { stdin = process.stdin, stdout = process.stdout, hint } = /** @type {any} */ ({})) {
  if (!stdin.isTTY) {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  if (hint) stdout.write(`${hint}\n`);
  stdout.write(prompt);
  return new Promise((resolvePromise, reject) => {
    let text = "";
    const finish = (error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdout.write("\n");
      if (error) reject(error); else resolvePromise(text.trim());
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n" || character === "\u0004") return finish();
        if (character === "\u0003") return finish(new Error("Cancelled."));
        if (character === "\u007f" || character === "\b") text = text.slice(0, -1);
        else if (character >= " ") text += character;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

// Where the secrets of stored logins live. With no argument: where they are now
// and what this machine offers. With 'system' or 'file': move them, all or none.
async function runVaultCommand(choice, { say, env }) {
  const store = storeFor({ env });
  if (choice === undefined) {
    const { mode, store: found } = await store.vaultMode();
    say(mode === "system" ? `Secrets of stored logins are kept in ${found?.label ?? "the system store (not available here)"}.` : "Secrets of stored logins are kept in the credentials file (owner-only).");
    say(found ? `This machine offers ${found.label}: 'etnpilot auth vault system' moves them there.` : "This machine offers no system store; the file is used.");
    return 0;
  }
  const moved = await store.useVault(choice);
  say(`${moved} stored login(s) now ${choice === "system" ? "keep their secrets in the system store" : "keep their secrets in the credentials file"}.`);
  return 0;
}
