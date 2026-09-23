import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const OPERATION_EFFECTS = new Set(["allow", "human", "deny"]);
const PROVIDER_EFFECTS = new Set(["allow", "deny"]);
const EFFECT_PRIORITY = Object.freeze({ allow: 1, human: 2, deny: 3 });
const RULE_ID = /^[a-z0-9][a-z0-9._-]*$/i;

// macOS and Windows resolve 'secret.PEM' and 'secret.pem' to the same file, so
// a case-sensitive deny rule would be trivial to step around there.
const CASE_INSENSITIVE_FILESYSTEM = process.platform === "darwin" || process.platform === "win32";

export class PolicyEngine {
  constructor(config = {}, {
    caseInsensitivePaths = CASE_INSENSITIVE_FILESYSTEM,
    resolveSymlinks = true,
  } = {}) {
    this.caseInsensitivePaths = caseInsensitivePaths === true;
    this.resolveSymlinks = resolveSymlinks !== false;
    if (!config || Array.isArray(config) || typeof config !== "object") {
      throw new TypeError("Policy configuration must be an object.");
    }
    const unknown = Object.keys(config).find((key) => !["operations", "providers"].includes(key));
    if (unknown) throw new TypeError(`Policy configuration has unknown section '${unknown}'.`);
    this.operations = config.operations === undefined
      ? undefined
      : normalizeSection(config.operations, {
          name: "policy.operations",
          effects: OPERATION_EFFECTS,
          defaultEffect: "deny",
          matchers: ["kinds", "agents", "paths", "hosts"],
        });
    this.providers = config.providers === undefined
      ? undefined
      : normalizeSection(config.providers, {
          name: "policy.providers",
          effects: PROVIDER_EFFECTS,
          defaultEffect: "deny",
          matchers: ["providers", "agents"],
        });
  }

  evaluateOperation(request = {}, context = {}) {
    if (!this.operations) return undefined;
    const path = normalizeRequestPath(request.fileName ?? request.path, context.workspace, {
      resolveSymlinks: this.resolveSymlinks,
    });
    const host = request.url === undefined ? request.host : parseHost(request.url);
    const facts = {
      kinds: stringValue(request.kind),
      agents: stringValue(context.agent),
      paths: path.value,
      hosts: stringValue(host)?.toLowerCase(),
    };
    const match = selectDecision(this.operations, facts, {
      pathOutsideWorkspace: path.outside,
      caseInsensitivePaths: this.caseInsensitivePaths,
    });
    return operationDecision(match);
  }

  evaluateProvider(provider, context = {}) {
    if (!this.providers) return { allowed: true };
    const match = selectDecision(this.providers, {
      providers: stringValue(provider),
      agents: stringValue(context.agent),
    });
    return {
      allowed: match.effect === "allow",
      ...(match.effect === "deny" ? { reason: policyReason("Provider", match) } : {}),
      policy: policyEvidence("providers", match),
    };
  }
}

function normalizeSection(section, { name, effects, defaultEffect, matchers }) {
  if (!section || Array.isArray(section) || typeof section !== "object") {
    throw new TypeError(`${name} must be an object.`);
  }
  const unknownSectionKey = Object.keys(section).find((key) => !["default", "rules"].includes(key));
  if (unknownSectionKey) throw new TypeError(`${name} has unknown field '${unknownSectionKey}'.`);
  const effect = section.default ?? defaultEffect;
  if (!effects.has(effect)) throw new TypeError(`${name}.default has unsupported effect '${effect}'.`);
  if (section.rules !== undefined && !Array.isArray(section.rules)) {
    throw new TypeError(`${name}.rules must be an array.`);
  }
  const ids = new Set();
  const rules = (section.rules ?? []).map((rule, index) => {
    if (!rule || Array.isArray(rule) || typeof rule !== "object") {
      throw new TypeError(`${name}.rules[${index}] must be an object.`);
    }
    if (typeof rule.id !== "string" || !RULE_ID.test(rule.id)) {
      throw new TypeError(`${name}.rules[${index}] requires a valid id.`);
    }
    if (ids.has(rule.id)) throw new TypeError(`${name} contains duplicate rule '${rule.id}'.`);
    ids.add(rule.id);
    if (!effects.has(rule.effect)) {
      throw new TypeError(`${name} rule '${rule.id}' has unsupported effect '${rule.effect}'.`);
    }
    const allowedKeys = new Set(["id", "effect", ...matchers]);
    const unknown = Object.keys(rule).find((key) => !allowedKeys.has(key));
    if (unknown) throw new TypeError(`${name} rule '${rule.id}' has unknown field '${unknown}'.`);
    const normalized = { id: rule.id, effect: rule.effect };
    let matcherCount = 0;
    for (const matcher of matchers) {
      if (rule[matcher] === undefined) continue;
      normalized[matcher] = stringList(rule[matcher], `${name} rule '${rule.id}' ${matcher}`);
      matcherCount += 1;
    }
    if (matcherCount === 0) throw new TypeError(`${name} rule '${rule.id}' requires at least one matcher.`);
    return Object.freeze(normalized);
  });
  return Object.freeze({ default: effect, rules: Object.freeze(rules), matchers: Object.freeze(matchers) });
}

function selectDecision(section, facts, { pathOutsideWorkspace = false, caseInsensitivePaths = false } = {}) {
  const matches = section.rules.filter((rule) => section.matchers.every((matcher) => {
    if (rule[matcher] === undefined) return true;
    if (facts[matcher] === undefined) return false;
    if (matcher === "paths" && pathOutsideWorkspace) return false;
    const ignoreCase = matcher === "hosts" || (matcher === "paths" && caseInsensitivePaths);
    return rule[matcher].some((pattern) => globMatch(pattern, facts[matcher], ignoreCase));
  }));
  if (matches.length === 0) return { effect: section.default, default: true };
  return matches.reduce((selected, candidate) => (
    EFFECT_PRIORITY[candidate.effect] > EFFECT_PRIORITY[selected.effect] ? candidate : selected
  ));
}

function operationDecision(match) {
  const policy = policyEvidence("operations", match);
  if (match.effect === "allow") return { kind: "approve-once", policy };
  if (match.effect === "human") return { kind: "human-required", policy };
  return { kind: "reject", reason: policyReason("Operation", match), policy };
}

function policyEvidence(section, match) {
  return Object.freeze({
    section,
    effect: match.effect,
    ...(match.default ? { default: true } : { rule: match.id }),
  });
}

function policyReason(subject, match) {
  return match.default
    ? `${subject} is denied by the default policy.`
    : `${subject} is denied by policy rule '${match.id}'.`;
}

function normalizeRequestPath(value, workspace, { resolveSymlinks = true } = {}) {
  if (typeof value !== "string" || value.length === 0) return { value: undefined, outside: false };
  const root = workspace ? resolve(workspace) : undefined;
  if (isAbsolute(value)) {
    if (!root) return { value: undefined, outside: true };
    return relativePath(root, value, resolveSymlinks);
  }
  if (!root) {
    const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
    return normalized === ".." || normalized.startsWith("../")
      ? { value: undefined, outside: true }
      : { value: normalized, outside: false };
  }
  return relativePath(root, resolve(root, value), resolveSymlinks);
}

function relativePath(root, path, resolveSymlinks = true) {
  // A link inside the workspace can point anywhere, so rules are matched
  // against the real target. A target outside the workspace matches no path
  // rule and therefore falls through to the section default.
  const realRoot = resolveSymlinks ? realPath(root) : root;
  const realPathValue = resolveSymlinks ? realPath(path) : path;
  const candidate = relative(realRoot, resolve(realPathValue)).replaceAll("\\", "/");
  const outside = candidate === ".." || candidate.startsWith("../") || isAbsolute(candidate);
  return { value: outside ? undefined : (candidate || "."), outside };
}

// Resolves the deepest existing ancestor, so a path that does not exist yet
// (a file about to be written) is still checked through its real parents.
function realPath(path) {
  const segments = [];
  let current = resolve(path);
  for (;;) {
    try {
      return segments.length === 0 ? realpathSync(current) : join(realpathSync(current), ...segments);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return path;
      const parent = dirname(current);
      if (parent === current) return path;
      segments.unshift(basename(current));
      current = parent;
    }
  }
}

function parseHost(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function globMatch(pattern, value, caseInsensitive = false) {
  const source = globSource(pattern);
  return new RegExp(`^${source}$`, caseInsensitive ? "i" : "").test(value);
}

function globSource(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return source;
}

function stringList(value, field) {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values) || values.length === 0 || values.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError(`${field} must be a non-empty string or array of non-empty strings.`);
  }
  return Object.freeze([...new Set(values)]);
}

function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
