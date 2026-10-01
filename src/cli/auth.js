import { join, resolve } from "node:path";
import { allowHost, authStatus, loginWithDevice, logout, saveKey } from "../auth/login.js";
import { SERVICE_IDS, serviceFor } from "../auth/services.js";
import { loadConfig } from "../config/load.js";

// 'etnpilot login <service>', 'logout <service>' and 'auth status'. The web page
// offers the same through the same functions.

export const AUTH_USAGE = `  etnpilot login <anthropic|openai|github|gitlab> [--key-stdin] [--client-id id] [--host url] [--no-verify]
  etnpilot login <service> --allow-host name      let the stored login be sent to one more host (a proxy)
  etnpilot logout <anthropic|openai|github|gitlab>
  etnpilot auth status`;

export async function runAuthCommand(command, subcommand, values, { stdin = process.stdin, stdout = process.stdout, env = process.env, fetchImpl, sleep } = {}) {
  const say = (line = "") => stdout.write(`${line}\n`);

  if (command === "auth" || (command === "login" && !subcommand)) {
    if (command === "auth" && subcommand !== "status" && subcommand !== undefined) throw new Error("Use 'etnpilot auth status'.");
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
    return report(service, await saveKey(service.id, token, { ...options, host }), say);
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
  return `${name} connected      ${how}${who}${warn}`;
}

async function projectGitLabHost(root) {
  try {
    return (await loadConfig(join(resolve(root ?? "."), ".etnpilot", "etnpilot.yaml"))).git?.baseUrl;
  } catch {
    return undefined;
  }
}

// A key is typed without echo on a terminal and read whole from a pipe.
export async function readSecret(prompt, { stdin = process.stdin, stdout = process.stdout, hint } = {}) {
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
