import { mkdir, readFile, writeFile } from "node:fs/promises";
import { importExistingProject, importedAgentNames } from "./migrate.js";
import { chooseProvider, forgeProject } from "../forge/forge.js";
import { join } from "node:path";
import YAML from "yaml";

const DEFAULT_CONFIG = `version: 1
settings:
  # Which settings a user may change on their own machine. Changes land in
  # .etnpilot/etnpilot.local.yaml or ~/.config/etnpilot/config.yaml, are never
  # committed, and are applied on top of this file.
  #   open          the user decides
  #   stricter-only the user may narrow it, never widen it
  #   locked        only this committed file decides
  modes:
    "settings.**": locked
    "secrets.**": locked
    "content.provenance.**": locked
    "receipts.signing.**": locked
    "supplyChain.**": locked
    "hooks.**": locked
    "mcpServers.**": locked
    "policy.**": stricter-only
    "approval.allow": stricter-only
    "approval.requireHuman": stricter-only
    "checks.envAllow": stricter-only
    "sandbox.enabled": stricter-only
# Which provider a run uses when neither the agent nor 'routing.rules' names
# one. Change it on your own machine with 'etnpilot settings set
# defaultProvider anthropic' (or in the Settings view) — the change stays
# local and is never committed. Every provider below is configured; the one
# that is used is the one named here, and it needs its own credential:
#   github-copilot  a GitHub Copilot subscription, through the Copilot SDK.
#                   The SDK has no build for Android, so on a tablet or phone
#                   use 'anthropic' or 'openai'.
#   anthropic       ANTHROPIC_API_KEY, from console.anthropic.com
#   openai          OPENAI_API_KEY, from platform.openai.com
defaultProvider: github-copilot
providers:
  github-copilot:
    type: github-copilot
    model: auto
  anthropic:
    type: anthropic
    baseUrl: https://api.anthropic.com
    model: claude-opus-5
    # The provider reads and writes files and runs commands through the
    # harness's own tools, so every effect goes through the approval path.
    tools: true
    maxTokens: 8192
    # Read the answer as it is written, so a chat can show it forming. Not on
    # by default: it has been tested against stubs, not against the live API.
    # stream: true
  openai:
    type: openai-compatible
    baseUrl: https://api.openai.com/v1
    # Any model your account can reach. A model it cannot reach is answered by
    # the API itself, and the error repeats what it said.
    model: gpt-5
    apiKeySecret: openai.apiKey
    tools: true
    # Which OpenAI API is spoken. 'auto' starts on /chat/completions and switches
    # by itself, once, when a model says it needs /responses for tools (newer
    # models do). 'responses' always speaks it; 'chat' never does. 'stream: true'
    # applies to either.
    # api: auto
    # Uncomment for a reasoning model that refuses function tools on
    # /v1/chat/completions ("set reasoning_effort to 'none'"). It turns that
    # model's reasoning off, which is why it is not on by default.
    # reasoningEffort: none
routing:
  # Empty on purpose: with no list here the route is 'defaultProvider', so
  # changing that one setting is enough to switch provider. Name providers
  # here to try them in a fixed order instead.
  defaults: []
  fallback:
    enabled: true
    maxAttempts: 2
  rules: []
git:
  host: gitlab
  # Replace with your GitLab instance and project before publishing.
  baseUrl: https://gitlab.example.com
  remote: gitlab
  targetBranch: main
  committer:
    name: ETNPilot
    email: etnpilot@localhost
  mergeTrain:
    # Report which other open merge requests this run's branch would collide
    # with once they land. Needs gitlab.apiToken.
    enabled: false
    maxMergeRequests: 10
  webhook:
    path: /webhooks/gitlab
    host: 127.0.0.1
    port: 8787
    maxBodyBytes: 1048576
    timestampToleranceSeconds: 300
  issueTrigger:
    enabled: false
    labels: [etnpilot]
    actions: [open, reopen]
    # Required once enabled: only these GitLab users may start a run.
    allowedUsers: []
    fetchBeforeRun: true
    # Wait for the merge-request pipeline and report its verdict back.
    awaitPipeline: false
    pipelineTimeoutMs: 900000
    approvals:
      # 'inbox' decides through the CLI; 'gitlab' also accepts
      # '/etnpilot approve <id>' comments from allowedApprovers.
      source: inbox
      allowedApprovers: []
      pollIntervalMs: 5000
    allowConfidential: false
    publish: false
    syncStatus: true
    comment: false
queue:
  database: .etnpilot/state/workflows.sqlite
  # More workers let an issue proceed while another waits for approval.
  workers: 1
  pollIntervalMs: 500
  leaseMs: 30000
  retryDelayMs: 5000
  maxAttempts: 1
secrets:
  providers:
    env:
      type: env
      allow:
        - ETNPILOT_GITLAB_TOKEN
        - ETNPILOT_GITLAB_WEBHOOK_SIGNING_SECRET
        - ETNPILOT_GITLAB_WEBHOOK_TOKEN
        - ETNPILOT_GITHUB_TOKEN
        - ETNPILOT_PROVIDER_API_KEY
        - ANTHROPIC_API_KEY
        - OPENAI_API_KEY
        - ETNPILOT_OTLP_HEADERS
    local:
      type: file
      root: .etnpilot/secrets
      requireOwnerOnly: true
  values:
    gitlab.apiToken: { provider: env, key: ETNPILOT_GITLAB_TOKEN }
    gitlab.webhookSigningSecret: { provider: env, key: ETNPILOT_GITLAB_WEBHOOK_SIGNING_SECRET }
    gitlab.webhookToken: { provider: env, key: ETNPILOT_GITLAB_WEBHOOK_TOKEN }
    github.token: { provider: env, key: ETNPILOT_GITHUB_TOKEN }
    # 'provider.apiKey' is what every OpenAI-compatible provider reads unless
    # it names another with 'apiKeySecret'.
    provider.apiKey: { provider: env, key: ETNPILOT_PROVIDER_API_KEY }
    anthropic.apiKey: { provider: env, key: ANTHROPIC_API_KEY }
    openai.apiKey: { provider: env, key: OPENAI_API_KEY }
    observability.otlpHeaders: { provider: env, key: ETNPILOT_OTLP_HEADERS }
receipts:
  signing:
    enabled: false
    privateKeyFile: .etnpilot/keys/receipt-signing-private.pem
    publicKeyFile: .etnpilot/receipt-signing-public.pem
codegraph:
  enabled: true
  autoIndex: true
  maxImpactDepth: 20
  startupTimeoutMs: 30000
  tools: [codegraph_explore]
content:
  provenance:
    mode: enforce
    lockFile: .etnpilot/content-lock.json
    verifyAfterRun: true
    maxEntries: 1000
    maxFileBytes: 1048576
observability:
  enabled: true
  file: .etnpilot/state/telemetry.jsonl
  serviceName: etnpilot
  environment: development
  failureMode: ignore
  otlp:
    enabled: false
    endpoint: http://127.0.0.1:4318/v1/traces
    headersSecret: observability.otlpHeaders
    timeoutMs: 5000
  pricing:
    currency: USD
    # Rates come from a built-in table and, for newer models, from the public
    # OpenRouter catalog (a plain GET, refreshed daily; nothing of the project
    # is sent). 'models' below always wins over both.
    autoUpdate: true
    models: {}
  # A ceiling per workflow run, so a loop that goes wrong costs this much and
  # no more. Raise it for real work; the point of a default is that there is
  # one. Exceeding it stops the run with 'budget_exceeded' in the receipt.
  budgets:
    maxEstimatedCostPerWorkflow: 5
    maxInputTokensPerWorkflow: 2000000
    maxOutputTokensPerWorkflow: 200000
# A conversation as a whole ('etnpilot chat' and the Chat views). Each turn is a
# run with its own budget above; nothing else bounded the sum, so a long chat
# could spend without limit one affordable turn at a time. Tokens, input and
# output together, across turns and summaries. Raise it for real work.
chat:
  budget:
    maxTotalTokens: 1000000
approval:
  allow: [read]
  requireHuman: [write, shell, network]
  inbox:
    enabled: true
    database: .etnpilot/state/approvals.sqlite
    timeoutMs: 86400000
    pollIntervalMs: 500
    # Reviewers see the full command by default. Enable to mask
    # credential-looking text at the cost of showing less than was requested.
    redactSecrets: false
policy:
  operations:
    default: deny
    rules:
      - id: protect-credentials
        effect: deny
        kinds: [read, write]
        paths: [.env, .env.*, "**/.env", "**/.env.*", .npmrc, "**/.npmrc", .netrc, "**/.netrc", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa", "**/id_ed25519", .git, .git/**, .etnpilot/keys, .etnpilot/keys/**, .etnpilot/secrets, .etnpilot/secrets/**]
      - id: protect-etnpilot-governance
        effect: deny
        kinds: [write]
        paths: [.etnpilot, .etnpilot/**, .gitlab-ci.yml, .github/workflows/**, .git/hooks/**]
      - id: read-project
        effect: allow
        kinds: [read]
        paths: ["**"]
      - id: write-project
        effect: human
        kinds: [write]
        paths: ["**"]
      - id: shell-with-review
        effect: human
        kinds: [shell]
      # A tool from an MCP server is code this project did not write, so it
      # gets its own kind rather than passing as a file read. There is no rule
      # for it below, and 'default: deny' means an MCP tool is refused until a
      # project adds one — which is the right way round.
      #
      #   - id: mcp-tools
      #     effect: human
      #     kinds: [mcp]
      - id: approved-network-targets
        effect: human
        kinds: [network]
        hosts: [gitlab.example.com, github.com, api.github.com]
  providers:
    default: deny
    rules:
      - id: configured-providers
        effect: allow
        providers: [github-copilot, anthropic, openai]
checks:
  # Checks run agent-authored code. They inherit only these variables, so
  # repository and provider credentials stay out of their environment.
  envAllow: []
supplyChain:
  # Optional gates. With no licenses configured nothing is enforced.
  licenses:
    allow: []
    deny: []
  packages:
    deny: []
  secretScan:
    # Fingerprints of reviewed false positives, from 'etnpilot scan secrets'.
    allow: []
sandbox:
  # Runs checks and approved commands in a disposable container. Requires a
  # local container runtime; the run fails rather than silently using the host.
  enabled: false
  runtime: docker
  image: node:24-bookworm-slim
  network: none
  readOnlyRoot: true
  workdir: /workspace
  # Reuse the image a .devcontainer/devcontainer.json already names, and
  # optionally build it when the devcontainer defines a Dockerfile instead.
  useDevcontainerImage: false
  buildDevcontainerImage: false
workspace:
  mode: worktree
  cleanup: never
pluginIsolation:
  setupTimeoutMs: 10000
  callTimeoutMs: 30000
  shutdownTimeoutMs: 1000
  memoryMb: 128
  maxOutputBytes: 65536
  maxMessageBytes: 1048576
  maxPendingRequests: 32
  memoryPollIntervalMs: 100
  memoryMonitoring: required
plugins: []
# Tools from Model Context Protocol servers, offered to every provider. Each
# one is asked for under the 'mcp' operation kind, which 'policy.operations'
# denies until a rule allows it.
#
# mcpServers:
#   docs:
#     command: npx
#     args: [-y, some-mcp-server]
#     tools: [search]        # omit to offer every tool the server lists
mcpServers: {}
# Commands that run after something happened, watching and never deciding:
# a hook cannot stop a write, only the policy can. 'afterWrite' is an argv
# list run after every write_file / edit_file, with {path} replaced by the
# file; it is asked for like any run_command, so the policy and the approval
# see it, and its result is in the receipt. Locked: only this file decides.
# hooks:
#   afterWrite: [npx, prettier, --write, "{path}"]

workflow:
  concurrency: 1
  failFast: true
  timeoutMs: 1800000
  maxSteps: 50
  # With no steps, a run is one agent. Name steps to make it a workflow:
  # 'agent' runs one, 'check' runs a command, 'quorum' asks several and
  # compares, and 'gate' stops until a person approves what the step before
  # it produced. A gate is the cheapest place to stop a run that is about to
  # spend money on a plan nobody agreed with, and it cannot be waved through
  # by 'approval.allow' — a gate nobody answers is not a gate.
  #
  # steps:
  #   - id: plan
  #     type: agent
  #     agent: orchestrator
  #   - id: approve-plan
  #     type: gate
  #     needs: [plan]
  #   - id: build
  #     type: agent
  #     agent: orchestrator
  #     needs: [approve-plan]
  #     expect: tool-use
`;

const DEFAULT_IGNORE = `# Generated by ETNPilot. Run state, worktrees, and local settings
# are never committed. Only the default configuration is.
etnpilot.local.yaml
state/
worktrees/
keys/
secrets/
*.sqlite
*.sqlite-shm
*.sqlite-wal
`;

// No 'provider' and no 'model': the agent follows the project's
// 'defaultProvider' and that provider's own model, so switching provider is
// one setting and not an edit to every manifest.
const STARTER_AGENT = `name: orchestrator
promptRef: orchestrator
skills: []
requires: [chat]
subagents: []
# Which tools this agent may use. Leaving it out means all of them, which is
# rarely what you want: an agent that only has to read should not be able to
# write, and the refusal is mechanical rather than a line in its prompt.
# Known tools: read_file, list_files, search_files, write_file, edit_file,
# run_command, fetch_url, load_skill, propose_instruction, spawn_subagent,
# ask_human. 'propose_instruction' suggests a lasting instruction for review; it
# is never applied. Add
# 'load_skill' if this agent has skills: they are then listed by name and
# opened on request instead of all being sent every time. 'fetch_url' is left out below on purpose: it reads
# text nobody here wrote, so add it to the agent that needs it rather than
# to all of them, and see 'policy.operations' for which hosts it may reach.
tools: [read_file, list_files, search_files, codegraph.codegraph_explore, write_file, edit_file, run_command]
# How hard the model thinks: low, medium or high. Leave it out for the
# provider's own default. A planner or reviewer usually earns 'high'; a builder
# that follows a plan often does not. Anthropic models older than the 4.6
# generation refuse adaptive thinking, so set it only where the model allows.
# effort: medium
`;

const DELEGATION_PROMPT = `
Other agents are available to you through spawn_subagent, each with a
description of what it is for. Plan first. Hand a piece of work to the agent
whose job it is, and give it the whole task, because it cannot see this
conversation. Read what it reports back before you rely on it: it reports its
own work, and checking is yours. Do the small things yourself rather than
delegating them.
`;

const STARTER_PROMPT = `You implement one requested change at a time in the current repository.

Read before you write, keep the change minimal and reviewable, and run the
project's own checks.

You have tools; use them. Use search_files to find things rather than listing
directories and reading everything. Change an existing file with edit_file,
giving the exact text to replace — write_file rewrites the whole file, which
costs more, hides the change from the person approving it, and loses things
you were not asked to touch. Running a command means calling run_command.

Approval is mechanical, not conversational:
ETNPilot asks a human before every write, shell command, and network call, and
tells you if they declined. So do not ask for permission in prose — nobody
receives it, and the work is left undone. If a tool was refused, say so and
stop.

Report what you verified and what remains uncertain; never claim a check
passed that you did not run, or a file you did not write.
`;

// Templates are overrides on the documented default, applied through the YAML
// document so the explanatory comments survive.
export const PROJECT_TEMPLATES = Object.freeze({
  default: {},
  minimal: {
    "codegraph.enabled": false,
    "observability.enabled": false,
    "content.provenance.mode": "off",
  },
  regulated: {
    "receipts.signing.enabled": true,
    "sandbox.enabled": true,
    "workspace.cleanup": "after-publish",
    "queue.workers": 2,
    "git.issueTrigger.approvals.source": "gitlab",
    "git.issueTrigger.awaitPipeline": true,
    "supplyChain.licenses.allow": ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"],
  },
});

export function renderProjectConfig(template = "default") {
  const overrides = PROJECT_TEMPLATES[template];
  if (!overrides) {
    throw new Error(`Unknown project template '${template}'. Available: ${Object.keys(PROJECT_TEMPLATES).join(", ")}.`);
  }
  if (Object.keys(overrides).length === 0) return DEFAULT_CONFIG;
  const document = YAML.parseDocument(DEFAULT_CONFIG);
  for (const [path, value] of Object.entries(overrides)) {
    document.setIn(path.split("."), value);
  }
  return String(document);
}

export async function initializeProject(root, { template = "default", importExisting = true, forge = "auto", env = process.env, onProgress } = {}) {
  const config = renderProjectConfig(template);
  const configDir = join(root, ".etnpilot");
  await Promise.all([
    mkdir(join(configDir, "agents"), { recursive: true }),
    mkdir(join(configDir, "instructions"), { recursive: true }),
    mkdir(join(configDir, "plugins"), { recursive: true }),
    mkdir(join(configDir, "prompts"), { recursive: true }),
    mkdir(join(configDir, "skills"), { recursive: true }),
    mkdir(join(configDir, "state"), { recursive: true }),
    mkdir(join(configDir, "worktrees"), { recursive: true }),
  ]);
  await Promise.all([
    writeIfAbsent(join(configDir, "etnpilot.yaml"), config),
    writeIfAbsent(join(configDir, ".gitignore"), DEFAULT_IGNORE),
    // A runnable starting point: without an agent manifest the first run has
    // nothing to execute.
    writeIfAbsent(join(configDir, "agents", "orchestrator.yaml"), STARTER_AGENT),
    writeIfAbsent(join(configDir, "prompts", "orchestrator.md"), STARTER_PROMPT),
  ]);
  // A project that already has instructions, agents or skills for another
  // coding agent keeps them: they are copied in, never over anything here.
  const imported = importExisting ? await importExistingProject(root, { configDir }) : undefined;
  const forged = await runForge(root, configDir, { forge, env, onProgress });
  // Agents that were imported or forged are only reachable if something may
  // hand work to them; what that changed is said where the person is reading.
  const wiring = { notes: [] };
  await wireOrchestrator(configDir, wiring);
  (imported ?? forged ?? { notes: [] }).notes.push(...wiring.notes);
  return { root, configDir, template, ...(imported ? { imported } : {}), ...(forged ? { forged } : {}) };
}

// Imported agents are only reachable if some agent may hand work to them, and
// the starter orchestrator lists none. When that file is still exactly what
// 'init' wrote it, it is ours to complete: it gets the imported agents as
// subagents and the tool to call them. A file anyone has touched is theirs;
// the summary says what to add instead.
// AgentsForge, when there is a key for it. It never fails the init: whatever
// goes wrong is a line in the report, and the project is created regardless.
async function runForge(root, configDir, { forge, env, onProgress }) {
  if (forge === false) return undefined;
  const explicit = forge !== "auto";
  // The test runner stays offline by itself; a test that wants the forge says so.
  if (!explicit && process.env.NODE_TEST_CONTEXT) return undefined;
  try {
    const { loadConfig } = await import("./load.js");
    const config = await loadConfig(join(configDir, "etnpilot.yaml"), env);
    const options = typeof forge === "object" && forge !== null ? forge : {};
    if (!options.runModel && !(await chooseProvider(config, root, env))) {
      return { agents: [], skills: [], instructions: [], skipped: [], notes: ["AgentsForge did not run: no API key found (ANTHROPIC_API_KEY or OPENAI_API_KEY). Set one and run 'etnpilot forge'."] };
    }
    return await forgeProject(root, { config, env, configDir, onProgress, ...options });
  } catch (error) {
    return { agents: [], skills: [], instructions: [], skipped: [], notes: [`AgentsForge failed: ${error.message}. The project was created without it; 'etnpilot forge' tries again.`] };
  }
}

export async function wireOrchestrator(configDir, report) {
  const names = await importedAgentNames(configDir);
  if (names.length === 0) return;
  const path = join(configDir, "agents", "orchestrator.yaml");
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (current === STARTER_AGENT) {
    const wired = STARTER_AGENT
      .replace("subagents: []", `subagents: [${names.join(", ")}]`)
      .replace("write_file, edit_file, run_command]", "write_file, edit_file, run_command, spawn_subagent]");
    await writeFile(path, wired, "utf8");
    // The prompt says "you implement"; with agents to hand work to it also needs
    // to say when. Only when it is still the starter's own text.
    const promptPath = join(configDir, "prompts", "orchestrator.md");
    if (await readFile(promptPath, "utf8").catch(() => undefined) === STARTER_PROMPT) {
      await writeFile(promptPath, `${STARTER_PROMPT}${DELEGATION_PROMPT}`, "utf8");
    }
    report.notes.push(`The starter orchestrator can now hand work to: ${names.join(", ")}.`);
  } else if (current !== undefined) {
    const listed = YAML.parse(current)?.subagents ?? [];
    const missing = names.filter((name) => !listed.includes(name));
    if (missing.length > 0) {
      report.notes.push(`.etnpilot/agents/orchestrator.yaml was left as it is. To let it use ${missing.join(", ")}, add them under 'subagents' and 'spawn_subagent' under 'tools'.`);
    }
  }
}

async function writeIfAbsent(path, content) {
  await writeFile(path, content, { encoding: "utf8", flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
}
