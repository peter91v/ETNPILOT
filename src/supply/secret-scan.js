import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { git } from "../git/command.js";

// High-signal patterns only. A scanner that cries wolf gets switched off, and
// a switched-off scanner protects nothing.
const RULES = Object.freeze([
  { id: "gitlab-pat", description: "GitLab personal access token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: "gitlab-webhook-secret", description: "GitLab webhook signing secret", pattern: /\bwhsec_[A-Za-z0-9+/=]{16,}\b/g },
  { id: "github-token", description: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { id: "aws-access-key", description: "AWS access key ID", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "private-key", description: "Private key block", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { id: "slack-token", description: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: "google-api-key", description: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "npm-token", description: "npm access token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    id: "generic-assignment",
    description: "Credential-looking assignment with a high-entropy literal",
    // Only quoted literals: an assignment from another identifier is code,
    // not a secret. The value must also look like a token rather than a
    // hyphenated phrase, which is what test fixtures usually contain.
    pattern: /\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Za-z0-9_]*\s*[:=]\s*["'`]([A-Za-z0-9+/_=-]{20,})["'`]/gi,
    valueGroup: 1,
    minEntropy: 3.5,
    requireDigit: true,
    rejectPattern: /^[A-Za-z]+(?:[-_][A-Za-z]+)+$/,
  },
]);

const SKIPPED_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar",
  ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mp3", ".wasm", ".node", ".sqlite",
]);

export async function scanForSecrets(root, {
  paths,
  maxFileBytes = 1024 * 1024,
  rules = RULES,
  allow = [],
} = {}) {
  const projectRoot = resolve(root);
  const candidates = paths ?? await trackedFiles(projectRoot);
  const allowed = new Set(allow);
  const findings = [];
  let scanned = 0;

  for (const relativePath of candidates) {
    if (SKIPPED_EXTENSIONS.has(extname(relativePath).toLowerCase())) continue;
    const absolute = join(projectRoot, relativePath);
    const details = await stat(absolute).catch(() => undefined);
    if (!details?.isFile() || details.size > maxFileBytes) continue;
    const content = await readFile(absolute, "utf8").catch(() => undefined);
    if (content === undefined || content.includes("\0")) continue;
    scanned += 1;
    for (const finding of scanContent(content, rules)) {
      if (allowed.has(finding.fingerprint)) continue;
      findings.push({ path: relativePath, ...finding });
    }
  }
  return { scanned, findings, ok: findings.length === 0 };
}

export function scanContent(content, rules = RULES) {
  const findings = [];
  const lines = content.split("\n");
  for (const rule of rules) {
    for (const [index, line] of lines.entries()) {
      if (line.includes("etnpilot:allow-secret")) continue;
      for (const match of line.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))) {
        const value = match[rule.valueGroup ?? 0];
        if (rule.minEntropy !== undefined && shannonEntropy(value) < rule.minEntropy) continue;
        if (rule.requireDigit && !/\d/.test(value)) continue;
        if (rule.rejectPattern?.test(value)) continue;
        findings.push({
          rule: rule.id,
          description: rule.description,
          line: index + 1,
          // The secret itself is never echoed: a fingerprint is enough to
          // recognise it again and to allow-list a known false positive.
          fingerprint: fingerprint(value),
          preview: `${value.slice(0, 4)}…${value.slice(-2)}`,
        });
      }
    }
  }
  return findings;
}

export function shannonEntropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

async function trackedFiles(root) {
  const { stdout } = await git(["ls-files", "-z"], { cwd: root });
  return stdout.split("\0").filter(Boolean);
}

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
