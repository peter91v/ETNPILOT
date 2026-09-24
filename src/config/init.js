import { mkdir, writeFile } from "node:fs/promises";
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
  openai:
    type: openai-compatible
    baseUrl: https://api.openai.com/v1
    # Any model your account can reach. A model it cannot reach is answered by
    # the API itself, and the error repeats what it said.
    model: gpt-5
    apiKeySecret: openai.apiKey
    tools: true
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
    models: {}
  budgets: {}
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
plugins: []
workflow:
  concurrency: 1
  failFast: true
  timeoutMs: 1800000
  maxSteps: 50
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
`;

const STARTER_PROMPT = `You implement one requested change at a time in the current repository.

Read before you write, keep the change minimal and reviewable, and run the
project's own checks.

You have tools; use them. Writing a file means calling write_file, running a
command means calling run_command. Approval is mechanical, not conversational:
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

export async function initializeProject(root, { template = "default" } = {}) {
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
  return { root, configDir, template };
}

async function writeIfAbsent(path, content) {
  await writeFile(path, content, { encoding: "utf8", flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
}
