import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { git } from "../git/command.js";

// What AgentsForge shows the model: a digest of the repository, built here and
// bounded. It is the only thing that leaves the machine, so it is also the
// thing that is careful: files that hold credentials are not read at all, text
// that looks like a secret is blanked, and the list of what was included goes
// back to the person who ran it.

const SKIP_DIRECTORIES = new Set([
  ".git", ".etnpilot", "node_modules", "dist", "build", "out", "vendor", ".venv", "venv", "target",
  ".next", ".nuxt", ".angular", ".gradle", ".idea", ".vscode", "coverage", "__pycache__", ".cache", "bower_components",
]);

// The same files the generated policy's 'protect-credentials' rule denies, and
// a few more that are credentials by name. They are not read, not summarised,
// and not named in the digest beyond the fact that they were left out.
const SENSITIVE = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.pypirc$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)(secrets?|credentials?)(\.[a-z]+)?$/i,
  /(^|\/)(secrets?|\.secrets?|private)\//i,
  /\.tfstate(\.backup)?$/i,
  /(^|\/)terraform\.tfvars$/i,
  /service-?account.*\.json$/i,
];

const TEXT_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".json", ".yaml", ".yml", ".toml", ".md", ".mdx", ".txt", ".html", ".css", ".scss",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".cs", ".php", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp",
  ".sh", ".bash", ".sql", ".vue", ".svelte", ".gradle", ".xml", ".proto", ".graphql", ".tf", ".dart", ".ex", ".exs", ".lua",
]);

const KEY_FILES = [
  "package.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "go.mod", "Cargo.toml", "pom.xml", "build.gradle",
  "build.gradle.kts", "Gemfile", "composer.json", "pubspec.yaml", "mix.exs", "Makefile", "justfile", "Dockerfile", "docker-compose.yml",
  "compose.yaml", "angular.json", "tsconfig.json", "vite.config.ts", "vite.config.js", "next.config.js", "nx.json", "turbo.json",
  ".gitlab-ci.yml", "tox.ini", "pytest.ini", "jest.config.js", "vitest.config.ts", ".eslintrc.json", "CONTRIBUTING.md",
];
const ENTRY_NAMES = /^(index|main|app|server|cli|routes?|router|handler|program|application)\.[a-z]+$/i;

const LIMITS = Object.freeze({
  totalBytes: 80 * 1024,
  keyFileBytes: 6 * 1024,
  sampleBytes: 2 * 1024,
  maxKeyFiles: 14,
  maxSamples: 14,
  maxTreeEntries: 220,
  maxFiles: 20_000,
  maxFileBytes: 512 * 1024,
});

export function isSensitivePath(path) {
  return SENSITIVE.some((pattern) => pattern.test(path));
}

// Text that looks like a credential is blanked before it is sent anywhere.
// This is a net, not a promise: the files most likely to hold secrets are not
// read at all (above); this catches the one that was pasted into a script.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*)(["']?)[^\s"',;]{8,}\2/gi,
];

export function redactSecrets(text) {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix) => (typeof prefix === "string" && match.startsWith(prefix) && prefix !== match ? `${prefix}[redacted]` : "[redacted]"));
  }
  return out;
}

export async function surveyRepository(root, { limits = {} } = {}) {
  const bounds = { ...LIMITS, ...limits };
  const paths = await listFiles(root, bounds);
  const sensitive = paths.filter(isSensitivePath);
  const files = paths.filter((path) => !isSensitivePath(path));

  const extensions = new Map();
  for (const path of files) {
    const extension = extname(path).toLowerCase();
    if (extension) extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
  }
  const included = [];
  let used = 0;
  const sections = [];
  const add = (title, body, path) => {
    const room = bounds.totalBytes - used;
    if (room <= 200) return false;
    const text = body.length > room ? `${body.slice(0, room)}\n[cut]` : body;
    sections.push(`### ${title}\n${text}`);
    used += text.length + title.length + 8;
    if (path) included.push(path);
    return true;
  };

  add("Overview", [
    `files: ${files.length}${paths.length >= bounds.maxFiles ? " (listing cut)" : ""}`,
    `left out as credentials: ${sensitive.length}`,
    `by extension: ${[...extensions].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([ext, count]) => `${ext} ${count}`).join(", ")}`,
  ].join("\n"));
  add("Directory tree (top levels, with file counts)", directoryTree(files, bounds.maxTreeEntries));

  // Files that say what the project is and how it is built and tested.
  const keyFiles = pickKeyFiles(files).slice(0, bounds.maxKeyFiles);
  for (const path of keyFiles) {
    const text = await readBounded(root, path, bounds.keyFileBytes, bounds.maxFileBytes);
    if (text !== undefined) add(path, text, path);
  }
  // A handful of source files, one or two per area, to show the real style.
  const samples = pickSamples(files, new Set(keyFiles)).slice(0, bounds.maxSamples);
  for (const path of samples) {
    const text = await readBounded(root, path, bounds.sampleBytes, bounds.maxFileBytes);
    if (text !== undefined) add(path, text, path);
  }
  const tests = files.filter((path) => /(^|\/)(tests?|__tests__|spec|e2e)\//i.test(path) || /\.(test|spec)\.[a-z]+$/i.test(path));
  add("Tests", `${tests.length} test files; examples:\n${tests.slice(0, 12).join("\n")}`);
  const docs = files.filter((path) => /^(docs?|documentation)\//i.test(path) && /\.mdx?$/i.test(path));
  if (docs.length > 0) add("Documentation files", docs.slice(0, 30).join("\n"));

  return {
    text: sections.join("\n\n"),
    files: files.length,
    bytes: used,
    included,
    leftOut: sensitive.length,
  };
}

// ---------------------------------------------------------------------- listing

async function listFiles(root, bounds) {
  const tracked = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, trim: false }).then(
    (result) => result.stdout.split("\0").filter(Boolean),
    () => undefined,
  );
  const list = tracked ?? await walk(root, bounds);
  return list.filter((path) => !path.split("/").some((part) => SKIP_DIRECTORIES.has(part))).slice(0, bounds.maxFiles).sort();
}

async function walk(root, bounds, directory = root, found = [], depth = 0) {
  if (depth > 8 || found.length >= bounds.maxFiles) return found;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (found.length >= bounds.maxFiles) break;
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) await walk(root, bounds, join(directory, entry.name), found, depth + 1);
    } else if (entry.isFile()) {
      found.push(relative(root, join(directory, entry.name)));
    }
  }
  return found;
}

function directoryTree(files, maxEntries) {
  const counts = new Map();
  for (const path of files) {
    const parts = path.split("/").slice(0, -1);
    for (let depth = 1; depth <= Math.min(3, parts.length); depth += 1) {
      const key = parts.slice(0, depth).join("/");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const rootFiles = files.filter((path) => !path.includes("/")).slice(0, 40);
  const lines = [...counts].sort((a, b) => a[0].localeCompare(b[0])).slice(0, maxEntries).map(([directory, count]) => `${directory}/  (${count})`);
  return `${lines.join("\n")}\n\nfiles at the top level: ${rootFiles.join(", ")}`;
}

function pickKeyFiles(files) {
  const found = [];
  for (const wanted of KEY_FILES) {
    const hits = files.filter((path) => basename(path) === wanted).sort((a, b) => a.split("/").length - b.split("/").length);
    // The root one first, then at most one more per name (a monorepo's package).
    found.push(...hits.slice(0, wanted === "package.json" ? 3 : 1));
  }
  found.push(...files.filter((path) => /^README(\.md)?$/i.test(path)).slice(0, 1));
  found.push(...files.filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)).slice(0, 2));
  return [...new Set(found)];
}

function pickSamples(files, skip) {
  const source = files.filter((path) => TEXT_EXTENSIONS.has(extname(path).toLowerCase())
    && ![".json", ".md", ".mdx", ".txt", ".yaml", ".yml", ".toml", ".xml", ".css", ".scss", ".html"].includes(extname(path).toLowerCase())
    && !skip.has(path) && !/\.(test|spec)\.[a-z]+$/i.test(path) && !/(^|\/)(tests?|__tests__|spec|e2e)\//i.test(path));
  const byArea = new Map();
  for (const path of source) {
    const area = path.split("/").slice(0, Math.min(2, path.split("/").length - 1)).join("/");
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(path);
  }
  const picked = [];
  for (const [, paths] of [...byArea].sort((a, b) => b[1].length - a[1].length)) {
    const entries = paths.filter((path) => ENTRY_NAMES.test(basename(path)));
    picked.push(...(entries.length > 0 ? entries : paths).slice(0, 1));
  }
  return picked;
}

async function readBounded(root, path, bytes, maxFileBytes) {
  const full = join(root, path);
  const details = await lstat(full).catch(() => undefined);
  if (!details || !details.isFile() || details.size > maxFileBytes) return undefined;
  const text = await readFile(full, "utf8").catch(() => undefined);
  if (text === undefined || text.includes("\0")) return undefined;
  return redactSecrets(text.length > bytes ? `${text.slice(0, bytes)}\n[cut]` : text);
}
