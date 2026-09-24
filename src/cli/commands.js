import { access } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { CodeGraph } from "../codegraph/codegraph.js";
import { initializeProject } from "../config/init.js";
import { loadConfig } from "../config/load.js";
import {
  describeSettings,
  diffSettings,
  parseSettingValue,
  setSetting,
  unsetSetting,
} from "../config/settings.js";
import { verifyProjectContent, writeContentLock } from "../content/provenance.js";
import { ApprovalInbox, createInboxApprovalHandler } from "../core/approval-inbox.js";
import { ApprovalPolicy } from "../core/approval-policy.js";
import { Harness } from "../core/harness.js";
import { verifyReceiptFile } from "../core/receipt-store.js";
import { generateReceiptKeyPair, loadReceiptVerifiers } from "../core/receipt-signing.js";
import { createTerminalApprovalHandler } from "../core/terminal-approval.js";
import { copilotSdkAdvice, copilotSdkPlatformSupported } from "../providers/copilot.js";
import { routeFor } from "../providers/router.js";
import { WorktreeManager } from "../git/worktrees.js";
import { GitLabClient } from "../gitlab/client.js";
import { latestPipeline } from "../gitlab/pipelines.js";
import { createGitLabWebhookServer } from "../gitlab/webhook-server.js";
import { openInBrowser } from "../ui/open-browser.js";
import { createReviewServer } from "../ui/server.js";
import { createTuiApp } from "../tui/app.js";
import { agentRawResponses, openProjectState, readMergeRequests, readWorktrees } from "../runtime/project-state.js";
import { runProject } from "../runtime/project-runner.js";
import { replayRun } from "../runtime/replay.js";
import { WorkflowQueue } from "../workflow/queue.js";
import { createSecretResolver } from "../secrets/resolver.js";
import { PolicyEngine } from "../policy/engine.js";
import { loadPlugins } from "../plugins/load-plugin.js";
import { summarizeTelemetryFile } from "../observability/telemetry.js";
import { checkDependencyPolicy } from "../supply/dependencies.js";
import { readProjectPackages } from "../supply/ecosystems.js";
import { generateSbom } from "../supply/sbom.js";
import { scanForSecrets } from "../supply/secret-scan.js";
import { buildRunAttestation } from "../supply/attestation.js";

export const CLI_OPTIONS = Object.freeze({
  help: { type: "boolean", short: "h" },
  depth: { type: "string" },
  root: { type: "string", short: "r", default: "." },
  agent: { type: "string", short: "a" },
  "in-place": { type: "boolean", default: false },
  worktree: { type: "boolean", default: false },
  "no-worktree": { type: "boolean", default: false },
  "cleanup-worktree": { type: "boolean", default: false },
  publish: { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  // 'etnpilot ui' opens a browser; both spellings the help names must parse.
  open: { type: "boolean", default: false },
  "no-open": { type: "boolean", default: false },
  host: { type: "string" },
  port: { type: "string" },
  status: { type: "string" },
  limit: { type: "string" },
  actor: { type: "string" },
  approvals: { type: "string" },
  reason: { type: "string" },
  force: { type: "boolean", default: false },
  "private-key": { type: "string" },
  "public-key": { type: "string", multiple: true },
  "require-signatures": { type: "boolean", default: false },
  "allow-unsigned": { type: "boolean", default: false },
  "require-terminal": { type: "boolean", default: false },
  "allow-incomplete": { type: "boolean", default: false },
  kind: { type: "string" },
  path: { type: "string" },
  url: { type: "string" },
  provider: { type: "string" },
  out: { type: "string", short: "o" },
  template: { type: "string", short: "t" },
  global: { type: "boolean", default: false },
  changed: { type: "boolean", default: false },
  "record-fixtures": { type: "string" },
  raw: { type: "boolean", default: false },
  fixtures: { type: "string" },
});

export const USAGE = `ETNPilot

Usage:
  etnpilot init [directory] [--template default|minimal|regulated]
  etnpilot run <task> [--agent name] [--root directory] [--approvals terminal|inbox]
    [--worktree | --no-worktree] [--cleanup-worktree] [--publish] [--dry-run]
    [--record-fixtures file | --fixtures file]
  etnpilot replay <receipt-file> [--root directory] [--public-key path]
    [--require-signatures]
  etnpilot worktree list [--root directory]
  etnpilot worktree cleanup <name> [--root directory]
  etnpilot merge list [--status opened|merged|closed|all] [--root directory]
  etnpilot graph build [directory]
  etnpilot graph dependencies <file> [--root directory]
  etnpilot graph dependents <file> [--root directory]
  etnpilot graph symbols <file> [--root directory]
  etnpilot graph impact <file...> [--depth number] [--root directory]
  etnpilot graph stats [--root directory]
  etnpilot config list [--path prefix] [--changed] [--root directory]
  etnpilot config set <path> <value> [--global] [--root directory]
  etnpilot config unset <path> [--global] [--root directory]
  etnpilot config diff [--root directory]
  etnpilot content lock [--root directory]
  etnpilot content verify [--root directory]
  etnpilot webhook serve [--root directory] [--host address] [--port number]
  etnpilot ui [--root directory] [--host address] [--port number] [--no-open]
  etnpilot tui [--root directory]
  etnpilot approval list [--status pending|approved|rejected|expired|all] [--limit number]
  etnpilot approval show <id>
  etnpilot approval approve <id> [--actor name] [--reason text]
  etnpilot approval reject <id> [--actor name] [--reason text]
  etnpilot queue list [--status status] [--limit number]
  etnpilot queue show <id>
  etnpilot queue resume <id> [--force]
  etnpilot queue cancel <id> [--actor name] [--reason text]
  etnpilot receipt keygen [--private-key path] [--public-key path]
  etnpilot receipt show [file] [--root directory] [--raw]
  etnpilot receipt verify <file> [--public-key path]
    [--require-signatures | --allow-unsigned] [--require-terminal | --allow-incomplete]
  etnpilot secret check <name> [--root directory]
  etnpilot policy check (--kind kind [--path path | --url url] | --provider name)
    [--agent name] [--root directory]
  etnpilot pipeline status [ref] [--root directory]
  etnpilot deps check [--root directory]
  etnpilot sbom [--out file] [--root directory]
  etnpilot scan secrets [--root directory]
  etnpilot attest <receipt-file> [--out file] [--root directory]
  etnpilot telemetry summary [workflow-run-id] [--root directory]
  etnpilot doctor [--root directory]

Exit codes:
  0  the command succeeded
  1  the command failed, or a run, verification, or policy check was rejected
`;

export async function runCli(positionals, values, { waitForShutdown = defaultWaitForShutdown } = {}) {
  const [command, subcommand, ...rest] = positionals;

  if (values.help || !command) {
    console.log(USAGE);
    return 0;
  }

  if (command === "init") {
    const result = await initializeProject(resolve(subcommand ?? "."), { template: values.template });
    console.log(`Initialized ETNPilot in ${result.root} (template: ${result.template}).`);
    console.log("Next: review '.etnpilot/', commit it, then run 'etnpilot run \"<task>\"'.");
  } else if (command === "run") {
    if (values.worktree && (values["no-worktree"] || values["in-place"])) {
      throw new Error("Choose either --worktree or --no-worktree, not both.");
    }
    if (values["record-fixtures"] && values.fixtures) {
      throw new Error("Choose either --record-fixtures or --fixtures, not both.");
    }
    const task = [subcommand, ...rest].filter(Boolean).join(" ");
    const worktree = values.worktree ? true : (values["no-worktree"] || values["in-place"]) ? false : undefined;
    const result = await runProject({
      root: resolve(values.root),
      input: task,
      agent: values.agent,
      worktree,
      cleanupPolicy: values["cleanup-worktree"] ? "on-success" : undefined,
      publish: values.publish,
      dryRun: values["dry-run"],
      recordFixtures: values["record-fixtures"],
      fixtures: values.fixtures,
      approvalHandler: await createRunApprovalHandler(resolve(values.root), values.approvals),
    });
    console.log(JSON.stringify(result, null, 2));
    return result.summary?.status === "succeeded" ? 0 : 1;
  } else if (command === "replay") {
    if (!subcommand) throw new Error("A receipt file is required.");
    const root = resolve(values.root);
    const publicKeyPaths = await resolveReceiptPublicKeys(root, values["public-key"] ?? []);
    const report = await replayRun(resolve(subcommand), {
      root,
      verifiers: await loadReceiptVerifiers(publicKeyPaths),
      requireSignatures: values["require-signatures"] || publicKeyPaths.length > 0,
    });
    console.log(JSON.stringify(report, null, 2));
    return report.receiptValid && report.drifted.length === 0 ? 0 : 1;
  } else if (command === "worktree" && subcommand === "list") {
    // The same description the TUI shows: which branch each worktree holds,
    // which ones a run made, and what removing one would throw away.
    const root = resolve(values.root);
    const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml")).catch(ignoreMissing);
    console.log(JSON.stringify(await readWorktrees({ root, config: config ?? {} }), null, 2));
  } else if (command === "worktree" && subcommand === "cleanup") {
    if (!rest[0]) throw new Error("A worktree name is required.");
    const manager = new WorktreeManager(resolve(values.root));
    console.log(JSON.stringify(await manager.removeIfClean(rest[0]), null, 2));
  } else if (command === "merge" && (subcommand === "list" || subcommand === undefined)) {
    const root = resolve(values.root);
    const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
    const merges = await readMergeRequests({ root, config, env: process.env }, { state: values.status ?? "opened" });
    console.log(JSON.stringify(merges, null, 2));
    // Nothing to say is success; being unable to ask is not.
    return merges.configured === false || merges.available === false ? 1 : 0;
  } else if (command === "graph" && subcommand === "build") {
    const root = resolve(rest[0] ?? ".");
    const graph = new CodeGraph(root);
    try {
      const result = await graph.indexDirectory(root);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      graph.close();
    }
  } else if (command === "graph" && subcommand === "dependencies") {
    if (!rest[0]) throw new Error("A file path is required.");
    const graph = new CodeGraph(resolve(values.root));
    try {
      await graph.open();
      console.log(JSON.stringify(graph.dependencies(rest[0]), null, 2));
    } finally {
      graph.close();
    }
  } else if (command === "graph" && subcommand === "dependents") {
    if (!rest[0]) throw new Error("A file path is required.");
    const graph = new CodeGraph(resolve(values.root));
    try {
      await graph.open();
      console.log(JSON.stringify(graph.dependents(rest[0]), null, 2));
    } finally {
      graph.close();
    }
  } else if (command === "graph" && subcommand === "symbols") {
    if (!rest[0]) throw new Error("A file path is required.");
    const graph = new CodeGraph(resolve(values.root));
    try {
      await graph.open();
      console.log(JSON.stringify(graph.symbols(rest[0]), null, 2));
    } finally {
      graph.close();
    }
  } else if (command === "graph" && subcommand === "impact") {
    if (rest.length === 0) throw new Error("At least one changed file is required.");
    const maxDepth = values.depth === undefined ? 20 : Number.parseInt(values.depth, 10);
    const graph = new CodeGraph(resolve(values.root));
    try {
      await graph.open();
      console.log(JSON.stringify(graph.impact(rest, { maxDepth }), null, 2));
    } finally {
      graph.close();
    }
  } else if (command === "graph" && subcommand === "stats") {
    const graph = new CodeGraph(resolve(values.root));
    try {
      await graph.open();
      console.log(JSON.stringify(graph.stats(), null, 2));
    } finally {
      graph.close();
    }
  } else if (command === "config" && (subcommand === "list" || subcommand === undefined)) {
    const root = resolve(values.root);
    const { entries, layers, overrides, refusals } = await describeSettings({ root });
    const shown = entries
      .filter((entry) => (values.path ? entry.path === values.path || entry.path.startsWith(`${values.path}.`) : true))
      .filter((entry) => (values.changed ? overrides.includes(entry.path) : true));
    console.log(JSON.stringify({ layers, overrides, refusals, settings: shown }, null, 2));
    // A refused setting stops the next run, so listing must not report success.
    if (refusals.length > 0) return 1;
  } else if (command === "config" && subcommand === "set") {
    const [path, ...valueParts] = rest;
    if (!path || valueParts.length === 0) throw new Error("Usage: etnpilot config set <path> <value>");
    const scope = values.global ? "global" : "local";
    const result = await setSetting(path, parseSettingValue(valueParts.join(" ")), { root: resolve(values.root), scope });
    console.log(`${result.path} = ${briefValue(result.effective)} (${scope}, ${result.mode})`);
    console.log(`Written to ${result.file}. This file is yours and is never committed.`);
  } else if (command === "config" && subcommand === "unset") {
    const [path] = rest;
    if (!path) throw new Error("Usage: etnpilot config unset <path>");
    const scope = values.global ? "global" : "local";
    const result = await unsetSetting(path, { root: resolve(values.root), scope });
    console.log(`${result.path} = ${briefValue(result.effective)} (back to the project default)`);
    console.log(`Written to ${result.file}.`);
  } else if (command === "config" && subcommand === "diff") {
    const changes = await diffSettings({ root: resolve(values.root) });
    if (changes.length === 0) console.log("No local settings. This project behaves as it was committed.");
    else console.log(JSON.stringify(changes, null, 2));
  } else if (command === "content" && subcommand === "lock") {
    const root = resolve(values.root);
    const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
    console.log(JSON.stringify(await writeContentLock(root, config), null, 2));
  } else if (command === "content" && subcommand === "verify") {
    const root = resolve(values.root);
    const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
    const result = await verifyProjectContent(root, config);
    console.log(JSON.stringify(result, null, 2));
    return result.verified ? 0 : 1;
  } else if (command === "webhook" && subcommand === "serve") {
    const port = values.port === undefined ? undefined : Number.parseInt(values.port, 10);
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
      throw new Error("--port must be an integer between 0 and 65535.");
    }
    const webhookServer = await createGitLabWebhookServer({ root: resolve(values.root) });
    const address = await webhookServer.listen({ host: values.host, port });
    const displayHost = typeof address === "object" ? address.address : values.host;
    const displayPort = typeof address === "object" ? address.port : port;
    console.log(`ETNPilot GitLab webhook receiver listening on http://${displayHost}:${displayPort}`);
    await waitForShutdown();
    await webhookServer.close();
  } else if (command === "tui") {
    const state = await openProjectState({ root: resolve(values.root) });
    if (!process.stdin.isTTY) {
      state.close();
      throw new Error("The TUI needs an interactive terminal. Use 'etnpilot ui' or the plain commands instead.");
    }
    const app = createTuiApp({ state, actor: values.actor });
    try {
      await app.start();
    } finally {
      app.stop();
      state.close();
    }
  } else if (command === "ui") {
    const port = values.port === undefined ? undefined : Number.parseInt(values.port, 10);
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
      throw new Error("--port must be an integer between 0 and 65535.");
    }
    const review = await createReviewServer({ root: resolve(values.root) });
    const address = await review.listen({ host: values.host, port });
    console.log(`ETNPilot review UI: ${address.url}`);
    console.log("The link contains a one-time token. Anyone who has it can approve operations,");
    console.log("change local settings, and start runs.");
    if (address.exposed) {
      // Binding away from loopback drops the guarantee the rest of this
      // surface is built on, so it is said plainly rather than left to the
      // documentation.
      console.log("");
      console.log("This port is open to your network, not just this machine. Everyone who can reach");
      console.log("it and has the token has that same power. An SSH tunnel keeps it on loopback:");
      console.log(`  ssh -N -L ${address.port}:127.0.0.1:${address.port} <user>@<this-machine>`);
    }
    // The point of this command is to look at the page, so it opens where
    // there is a person to look: an interactive terminal, unless they said
    // otherwise. Nothing here can fail the server that is already listening.
    if (shouldOpenBrowser(values, process.env, process.stdout)) {
      const opened = await openInBrowser(address.url).catch((error) => ({ opened: false, reason: error.message }));
      console.log(opened.opened
        ? `Opened it with '${opened.command}'. Use --no-open to keep it in the terminal.`
        : `Could not open a browser (${opened.reason}) — copy the link above.`);
    }
    await waitForShutdown();
    await review.close();
  } else if (command === "approval" && subcommand === "list") {
    const limit = values.limit === undefined ? 100 : Number.parseInt(values.limit, 10);
    await withApprovalInbox(resolve(values.root), async (inbox) => {
      console.log(JSON.stringify(inbox.list({ status: values.status ?? "pending", limit }), null, 2));
    });
  } else if (command === "approval" && subcommand === "show") {
    if (!rest[0]) throw new Error("An approval ID is required.");
    await withApprovalInbox(resolve(values.root), async (inbox) => {
      const approval = inbox.get(rest[0]);
      if (!approval) throw new Error(`Unknown approval '${rest[0]}'.`);
      console.log(JSON.stringify(approval, null, 2));
    });
  } else if (command === "approval" && (subcommand === "approve" || subcommand === "reject")) {
    if (!rest[0]) throw new Error("An approval ID is required.");
    await withApprovalInbox(resolve(values.root), async (inbox) => {
      const decision = subcommand === "approve" ? "approved" : "rejected";
      const result = inbox.decide(rest[0], decision, {
        actor: values.actor ?? process.env.USER ?? "cli",
        reason: values.reason,
      });
      console.log(JSON.stringify(result, null, 2));
    });
  } else if (command === "queue" && subcommand === "list") {
    const limit = values.limit === undefined ? 100 : Number.parseInt(values.limit, 10);
    await withWorkflowQueue(resolve(values.root), async (queue) => {
      console.log(JSON.stringify(queue.list({ status: values.status ?? "all", limit }), null, 2));
    });
  } else if (command === "queue" && subcommand === "show") {
    if (!rest[0]) throw new Error("A workflow job ID is required.");
    await withWorkflowQueue(resolve(values.root), async (queue) => {
      const job = queue.get(rest[0]);
      if (!job) throw new Error(`Unknown workflow job '${rest[0]}'.`);
      console.log(JSON.stringify(job, null, 2));
    });
  } else if (command === "queue" && subcommand === "resume") {
    if (!rest[0]) throw new Error("A workflow job ID is required.");
    await withWorkflowQueue(resolve(values.root), async (queue) => {
      console.log(JSON.stringify(queue.resume(rest[0], { force: values.force }), null, 2));
    });
  } else if (command === "queue" && subcommand === "cancel") {
    if (!rest[0]) throw new Error("A workflow job ID is required.");
    await withWorkflowQueue(resolve(values.root), async (queue) => {
      console.log(JSON.stringify(queue.requestCancel(rest[0], {
        actor: values.actor ?? process.env.USER ?? "cli",
        reason: values.reason,
      }), null, 2));
    });
  } else if (command === "receipt" && subcommand === "keygen") {
    const publicKeys = values["public-key"] ?? [];
    if (publicKeys.length > 1) throw new Error("Receipt key generation accepts one --public-key path.");
    const root = resolve(values.root);
    const result = await generateReceiptKeyPair({
      privateKeyPath: resolve(root, values["private-key"] ?? ".etnpilot/keys/receipt-signing-private.pem"),
      publicKeyPath: resolve(root, publicKeys[0] ?? ".etnpilot/receipt-signing-public.pem"),
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "receipt" && subcommand === "show") {
    // The same answer the review page and the terminal interface give, from
    // the same reader: a run explained in one place and not the others is a
    // run explained differently depending on where you look.
    const root = resolve(values.root);
    const state = await openProjectState({ root });
    try {
      const runs = await state.collect().then((snapshot) => snapshot.runs ?? []);
      const file = rest[0] ? basename(rest[0]) : runs[0]?.receiptFile;
      if (!file) throw new Error("No receipt to show: this project has recorded no runs yet.");
      // A path printed by 'etnpilot run' is the natural thing to paste, so the
      // directory part is dropped rather than refused; what is read is always
      // this project's own runs directory.
      const receipt = await state.readReceipt(file).catch((error) => {
        if (error.code === "ENOENT") {
          throw new Error(`No receipt named '${file}' in .etnpilot/state/runs. 'etnpilot receipt show' with no file takes the newest.`);
        }
        throw error instanceof TypeError ? new Error(`${error.message} Receipts live in .etnpilot/state/runs.`) : error;
      });
      const run = runs.find((candidate) => candidate.receiptFile === file);
      const outcome = receipt.outcome;
      console.log(JSON.stringify({
        receipt: file,
        ...(run ? { runId: run.runId, mode: run.mode, sealed: run.terminal, signed: run.signed, durationMs: run.durationMs } : {}),
        status: outcome.status,
        entries: receipt.entries.length,
        // Why it ended, first: that is what someone opening a failed run is
        // asking. The step's whole result belongs in the file, not in an
        // answer read on a phone.
        why: outcome.reasons.map((reason) => (reason.step ? `${reason.step}: ` : "") + reason.text),
        steps: outcome.steps.map((step) => ({
          id: step.id,
          status: step.status,
          ...(step.attempts > 1 ? { attempts: step.attempts } : {}),
          ...(step.error ? { error: step.error } : {}),
        })),
        // Where the files are, and what it did to them.
        ...(outcome.workspace ? { workspace: outcome.workspace } : {}),
        ...(outcome.tools ? { tools: outcome.tools } : {}),
        ...(outcome.agents.length > 0 ? { agents: outcome.agents } : {}),
        ...(outcome.rehearsal ? { mergeRehearsal: outcome.rehearsal } : {}),
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        ...(outcome.cleanup ? { cleanup: outcome.cleanup } : {}),
        // The provider's own response body, exactly as it arrived — not shown
        // by default, because it is one payload per call and belongs to
        // whoever asked for it by name with '--raw'.
        ...(values.raw ? { raw: agentRawResponses(receipt) } : {}),
      }, null, 2));
      return receipt.outcome.status === "succeeded" ? 0 : 1;
    } finally {
      state.close();
    }
  } else if (command === "receipt" && subcommand === "verify") {
    if (!rest[0]) throw new Error("A receipt file is required.");
    if (values["require-signatures"] && values["allow-unsigned"]) {
      throw new Error("Choose either --require-signatures or --allow-unsigned, not both.");
    }
    if (values["require-terminal"] && values["allow-incomplete"]) {
      throw new Error("Choose either --require-terminal or --allow-incomplete, not both.");
    }
    const publicKeyPaths = await resolveReceiptPublicKeys(resolve(values.root), values["public-key"] ?? []);
    const verifiers = await loadReceiptVerifiers(publicKeyPaths);
    const requireSignatures = values["require-signatures"]
      || (publicKeyPaths.length > 0 && !values["allow-unsigned"]);
    const requireTerminal = values["require-terminal"]
      || (publicKeyPaths.length > 0 && !values["allow-incomplete"]);
    const result = await verifyReceiptFile(resolve(rest[0]), {
      verifiers,
      requireSignatures,
      requireTerminal,
    });
    console.log(JSON.stringify(result, null, 2));
    return result.valid ? 0 : 1;
  } else if (command === "secret" && subcommand === "check") {
    if (!rest[0]) throw new Error("A configured secret name is required.");
    const root = resolve(values.root);
    const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
    const resolver = createSecretResolver({ root, config });
    const policy = new PolicyEngine(config.policy);
    const harness = new Harness({
      approvalPolicy: new ApprovalPolicy(config.approval, { policy }),
      approvalHandler: createTerminalApprovalHandler(),
      policy,
      secrets: resolver,
    });
    try {
      await loadPlugins((config.plugins ?? []).filter(isBootstrapPlugin), harness, root, {
        isolation: config.pluginIsolation,
        secretResolver: resolver,
        bootstrap: true,
      });
      const result = await resolver.check(rest[0]);
      console.log(JSON.stringify(result, null, 2));
      return result.available ? 0 : 1;
    } finally {
      await harness.close();
    }
  } else if (command === "policy" && subcommand === "check") {
    if (Boolean(values.kind) === Boolean(values.provider)) {
      throw new Error("Specify either --kind or --provider.");
    }
    if (values.path && values.url) throw new Error("Choose either --path or --url.");
    const root = resolve(values.root);
    const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
    const policy = new PolicyEngine(config.policy);
    const result = values.provider
      ? policy.evaluateProvider(values.provider, { agent: values.agent })
      : policy.evaluateOperation({
          kind: values.kind,
          ...(values.path ? { fileName: values.path } : {}),
          ...(values.url ? { url: values.url } : {}),
        }, { agent: values.agent, workspace: root });
    const report = result ?? { configured: false, reason: "No policy section is configured." };
    console.log(JSON.stringify(report, null, 2));
    const denied = values.provider ? result?.allowed === false : result?.kind === "reject";
    return denied || !result ? 1 : 0;
  } else if (command === "deps" && subcommand === "check") {
    const root = resolve(values.root);
    const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml")).catch(ignoreMissing);
    const inventory = await readProjectPackages(root, config?.supplyChain ?? {});
    const report = checkDependencyPolicy(inventory.packages, config?.supplyChain ?? {});
    console.log(JSON.stringify({ ecosystems: inventory.ecosystems, ...report }, null, 2));
    return report.ok ? 0 : 1;
  } else if (command === "sbom") {
    const root = resolve(values.root);
    const document = await generateSbom(root);
    await writeOrPrint(values.out ? resolve(root, values.out) : undefined, document);
  } else if (command === "scan" && (subcommand === "secrets" || subcommand === undefined)) {
    const root = resolve(values.root);
    const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml")).catch(ignoreMissing);
    const report = await scanForSecrets(root, { allow: config?.supplyChain?.secretScan?.allow ?? [] });
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  } else if (command === "attest") {
    if (!subcommand) throw new Error("A receipt file is required.");
    const root = resolve(values.root);
    const publicKeyPaths = await resolveReceiptPublicKeys(root, values["public-key"] ?? []);
    const statement = await buildRunAttestation(resolve(subcommand), {
      root,
      verifiers: await loadReceiptVerifiers(publicKeyPaths),
    });
    await writeOrPrint(values.out ? resolve(root, values.out) : undefined, statement);
  } else if (command === "pipeline" && subcommand === "status") {
    const root = resolve(values.root);
    const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
    if (!config.git?.project) throw new Error("'git.project' is required to query pipelines.");
    const resolver = createSecretResolver({ root, config });
    const token = await resolver.get("gitlab.apiToken", {
      fallback: { provider: "env", key: "ETNPILOT_GITLAB_TOKEN" },
      required: true,
    });
    const client = new GitLabClient({ baseUrl: config.git.baseUrl, token });
    const ref = rest[0] ?? config.git.targetBranch ?? "main";
    const pipeline = latestPipeline(await client.pipelines(config.git.project, ref));
    console.log(JSON.stringify(pipeline ?? { ref, status: "none" }, null, 2));
    return pipeline === undefined || pipeline.status === "failed" ? 1 : 0;
  } else if (command === "telemetry" && subcommand === "summary") {
    const root = resolve(values.root);
    const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
    const path = resolve(root, config.observability?.file ?? ".etnpilot/state/telemetry.jsonl");
    console.log(JSON.stringify(await summarizeTelemetryFile(path, { workflowRunId: rest[0] }), null, 2));
  } else if (command === "doctor") {
    const report = await diagnose(resolve(values.root));
    console.log(JSON.stringify(report, null, 2));
    return report.ready ? 0 : 1;
  } else {
    throw new Error(`Unknown command: ${positionals.join(" ")}`);
  }
  return 0;
}

// A list of policy rules is unreadable on one line; the point of the echo is
// to confirm what took effect, not to reprint the configuration.
function briefValue(value) {
  if (Array.isArray(value) && value.some((entry) => entry && typeof entry === "object")) {
    return `${value.length} entries`;
  }
  const text = JSON.stringify(value);
  return text !== undefined && text.length > 120 ? `${text.slice(0, 117)}...` : String(text);
}

// Who answers a run's approval requests. The terminal asks the person who
// started the run, which needs that terminal to stay in front of them. The
// inbox lets anyone decide from anywhere — the TUI, the page, another window —
// which is also the only way to answer a run that nobody is sitting in front of.
async function createRunApprovalHandler(root, source = "terminal") {
  if (source === "terminal") return createTerminalApprovalHandler();
  if (source !== "inbox") throw new Error(`Unknown approval source '${source}'. Use 'terminal' or 'inbox'.`);
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml")).catch(ignoreMissing);
  const inboxConfig = config?.approval?.inbox ?? {};
  const inbox = new ApprovalInbox(
    resolve(root, inboxConfig.database ?? ".etnpilot/state/approvals.sqlite"),
    { redact: inboxConfig.redactSecrets === true },
  );
  const handler = createInboxApprovalHandler({
    inbox,
    timeoutMs: inboxConfig.timeoutMs ?? 24 * 60 * 60_000,
    pollIntervalMs: inboxConfig.pollIntervalMs ?? 500,
    onPending: (record) => {
      console.error(`Waiting for a decision on ${record.operationKind} ${record.id} — 'etnpilot tui' or 'etnpilot approval approve'.`);
    },
  });
  return handler;
}

async function writeOrPrint(path, document) {
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (!path) {
    process.stdout.write(serialized);
    return;
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, serialized, "utf8");
  console.log(`Wrote ${path}`);
}

// Opening a browser is for a person at a terminal. A pipe, a service manager,
// or CI gets the URL and nothing else, and '--open' asks for it anyway.
export function shouldOpenBrowser(values = {}, env = process.env, stdout = process.stdout) {
  if (values["no-open"]) return false;
  if (values.open) return true;
  if (typeof env.BROWSER === "string" && env.BROWSER.trim().toLowerCase() === "none") return false;
  if (env.CI !== undefined && env.CI !== "" && env.CI !== "false") return false;
  return stdout?.isTTY === true;
}

function ignoreMissing(error) {
  if (error.code === "ENOENT") return undefined;
  throw error;
}

export async function diagnose(root) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const checks = {
    node: process.versions.node,
    // node:sqlite backs the durable queue and the approval inbox.
    nodeSupported: major > 22 || (major === 22 && minor >= 13),
    git: await commandExists("git"),
    sqlite: await import("node:sqlite").then(() => true, () => false),
    copilotSdk: await import("@github/copilot-sdk").then(() => true, () => false),
    copilotSdkAvailableForPlatform: copilotSdkPlatformSupported(),
    project: await access(join(root, ".etnpilot", "etnpilot.yaml")).then(() => true, () => false),
  };
  // Whether a run could actually start here. 'ready' that ignores the route
  // says yes on a machine where the configured provider cannot run at all —
  // which is what 'etnpilot run' then reports, one command too late.
  const routing = checks.project ? await diagnoseRoute(root, checks) : undefined;
  return {
    ...checks,
    ...(routing ? { routing } : {}),
    ready: checks.nodeSupported && checks.git && checks.sqlite && (routing ? routing.usable !== null : true),
    hints: [
      checks.nodeSupported ? undefined : "Node.js 22.13 or newer is required for node:sqlite.",
      checks.git ? undefined : "Install git; ETNPilot runs every repository operation through it.",
      checks.copilotSdk ? undefined : copilotSdkAdvice(),
      checks.project ? undefined : "No '.etnpilot/etnpilot.yaml' found. Run 'etnpilot init' first.",
      ...(routing?.hints ?? []),
    ].filter(Boolean),
  };
}

// The provider a run would reach, and whether it can run here. Everything it
// reports is read the same way the run reads it.
async function diagnoseRoute(root, checks) {
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml")).catch(() => undefined);
  if (!config) return { error: "The project configuration could not be read.", route: [], usable: null, hints: [] };
  const state = await openProjectState({ root }).catch(() => undefined);
  const described = await state?.agents().catch(() => undefined);
  state?.close?.();
  // The same agent a run would take: 'defaultAgent', or 'orchestrator', which
  // is what the workflow falls back to.
  const name = described?.defaultAgent ?? config.defaultAgent ?? "orchestrator";
  const agent = described?.agents?.find((entry) => entry.name === name);
  const { providers } = routeFor(
    { name: name ?? "the default agent", ...(agent?.provider ? { provider: agent.provider } : {}) },
    { rules: config.routing?.rules ?? [], defaults: [...(config.routing?.defaults ?? []), ...(config.defaultProvider ? [config.defaultProvider] : [])] },
  );
  const resolver = createSecretResolver({ root, config, env: process.env });
  const policy = config.policy ? new PolicyEngine(config.policy) : undefined;
  const route = [];
  for (const provider of providers) {
    route.push(await diagnoseProvider(provider, config, resolver, checks, policy));
  }
  const usable = route.find((entry) => entry.usable)?.name ?? null;
  // A way out beats a diagnosis: where the routed provider cannot run but
  // another configured one can, name it and the setting that switches.
  const alternatives = [];
  if (!usable) {
    for (const other of Object.keys(config.providers ?? {})) {
      if (route.some((entry) => entry.name === other)) continue;
      if ((await diagnoseProvider(other, config, resolver, checks, policy)).usable) alternatives.push(other);
    }
  }
  return {
    agent: name,
    route,
    usable,
    ...(alternatives.length > 0 ? { alternatives } : {}),
    hints: usable
      ? []
      : [
        route.length === 0
          ? "No provider is routed: set 'defaultProvider', or name one in the agent manifest."
          : `No routed provider can run here: ${route.map((entry) => `'${entry.name}' ${entry.reason}`).join("; ")}.`,
        ...(alternatives.length > 0
          ? [`Ready to use instead: ${alternatives.map((one) => `'${one}'`).join(", ")}.`
            + ` Switch with 'etnpilot config set defaultProvider ${alternatives[0]}' — that stays local.`]
          : []),
      ],
  };
}

async function diagnoseProvider(name, config, resolver, checks, policy) {
  const configured = config.providers?.[name];
  if (!configured) return { name, usable: false, reason: "is not configured under 'providers'" };
  // Policy first: a denied provider cannot run however well it is configured,
  // and 'policy.**' is stricter-only, so no local file can allow it.
  const decision = policy?.evaluateProvider(name);
  if (decision && decision.allowed === false) {
    return {
      name,
      type: configured.type,
      usable: false,
      reason: "is denied by policy.providers, which only the committed file can change",
    };
  }
  const type = configured.type;
  if (type === "github-copilot") {
    return checks.copilotSdk
      ? { name, type, usable: true }
      : { name, type, usable: false, reason: "needs '@github/copilot-sdk', which is not installed here" };
  }
  if (type === "openai-compatible" || type === "anthropic") {
    const secret = configured.apiKeySecret ?? (type === "anthropic" ? "anthropic.apiKey" : "provider.apiKey");
    const key = configured.apiKey ? { available: true } : await resolver.check(secret);
    if (key.available) return { name, type, usable: true, key: secret };
    // A model server on this machine is the one endpoint that needs no key.
    if (type === "openai-compatible" && isLoopbackUrl(configured.baseUrl)) return { name, type, usable: true };
    return { name, type, usable: false, key: secret, reason: `has no key: ${describeMissingKey(secret, config)}` };
  }
  // A provider type this command does not know about is not a provider that
  // cannot run; saying so would be a guess.
  return { name, type, usable: true, checked: false };
}

function describeMissingKey(secret, config) {
  const reference = config.secrets?.values?.[secret];
  if (reference?.provider === "env") return `set ${reference.key}`;
  if (reference) return `secret '${secret}' is not available from '${reference.provider}'`;
  return `secret '${secret}' is not mapped under 'secrets.values'`;
}

function isLoopbackUrl(value) {
  try {
    const { hostname } = new URL(value);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

async function resolveReceiptPublicKeys(root, explicitPaths) {
  if (explicitPaths.length > 0) return explicitPaths.map((path) => resolve(path));
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml")).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const configured = config?.receipts?.signing?.publicKeyFile;
  if (!configured) return [];
  const path = resolve(root, configured);
  return access(path).then(() => [path], (error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

async function withWorkflowQueue(root, operation) {
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
  const database = resolve(root, config.queue?.database ?? ".etnpilot/state/workflows.sqlite");
  const queue = new WorkflowQueue(database);
  try {
    return await operation(queue);
  } finally {
    queue.close();
  }
}

async function withApprovalInbox(root, operation) {
  const config = await loadConfig(join(root, ".etnpilot", "etnpilot.yaml"));
  const database = resolve(root, config.approval?.inbox?.database ?? ".etnpilot/state/approvals.sqlite");
  const inbox = new ApprovalInbox(database);
  try {
    return await operation(inbox);
  } finally {
    inbox.close();
  }
}

function defaultWaitForShutdown() {
  return new Promise((resolveShutdown) => {
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      resolveShutdown();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function isBootstrapPlugin(entry) {
  return entry && typeof entry === "object" && entry.bootstrap === true;
}

async function commandExists(commandName) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolveResult) => {
    const child = spawn(commandName, ["--version"], { stdio: "ignore" });
    child.once("error", () => resolveResult(false));
    child.once("exit", (code) => resolveResult(code === 0));
  });
}
