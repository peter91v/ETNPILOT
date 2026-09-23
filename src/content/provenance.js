import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";

export const CONTENT_PROVENANCE_VERSION = 1;
export const CONTENT_DIGEST_ALGORITHM = "sha256";

const DEFAULT_LOCK_FILE = ".etnpilot/content-lock.json";
const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const MAX_LOCK_BYTES = 4 * 1024 * 1024;

export class ContentProvenanceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ContentProvenanceError";
    this.code = code;
    this.details = details;
  }
}

export async function captureProjectContent(root, options = {}) {
  const projectRoot = resolve(root);
  const etnRoot = join(projectRoot, ".etnpilot");
  const limits = normalizeLimits(options);
  await assertDirectory(etnRoot, projectRoot, { optional: false });

  const items = [
    ...await captureFlatDirectory(etnRoot, "instructions", ".md", "instruction", limits),
    ...await captureFlatDirectory(etnRoot, "prompts", ".md", "prompt", limits),
    ...await captureSkills(etnRoot, limits),
    ...await captureFlatDirectory(etnRoot, "agents", ".yaml", "agent", limits),
  ].sort(compareItems);

  if (items.length > limits.maxEntries) {
    throw new ContentProvenanceError(
      "content-limit-exceeded",
      `Project content has ${items.length} entries; the configured limit is ${limits.maxEntries}.`,
    );
  }

  const entries = items.map(({ content: _content, absolutePath: _absolutePath, ...entry }) => entry);
  const manifest = createManifest(entries);
  return { root: projectRoot, items, manifest };
}

export async function writeContentLock(root, config = {}) {
  const settings = normalizeContentProvenance(config, { defaultMode: "enforce" });
  const lockPath = resolveLockPath(root, settings.lockFile);
  const snapshot = await captureProjectContent(root, settings);
  const serialized = `${JSON.stringify(snapshot.manifest, null, 2)}\n`;
  const existing = await lstat(lockPath).catch(missingOnly);
  if (existing?.isSymbolicLink()) {
    throw new ContentProvenanceError("unsafe-content-lock", "The content lock file may not be a symbolic link.");
  }
  if (existing && !existing.isFile()) {
    throw new ContentProvenanceError("unsafe-content-lock", "The content lock path must be a regular file.");
  }
  await ensureSafeDirectoryTree(resolve(root), dirname(lockPath));
  const temporary = join(dirname(lockPath), `.${basename(lockPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o644 });
    await rename(temporary, lockPath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return createEvidence(snapshot.manifest, settings, serialized, { verified: true });
}

export async function verifyProjectContent(root, config = {}, expected) {
  const settings = normalizeContentProvenance(config);
  if (settings.mode === "off") {
    return { version: CONTENT_PROVENANCE_VERSION, mode: "off", verified: false };
  }
  const snapshot = await captureProjectContent(root, settings);
  const lockPath = resolveLockPath(root, settings.lockFile);
  const serialized = await readSafeLock(lockPath, resolve(root));
  const locked = parseLock(serialized);
  assertManifestMatches(snapshot.manifest, locked);
  const evidence = createEvidence(snapshot.manifest, settings, serialized, { verified: true });
  if (expected && (
    evidence.digest !== expected.digest
    || evidence.lockDigest !== expected.lockDigest
  )) {
    throw new ContentProvenanceError(
      "content-changed-during-run",
      "Pinned project content or its lock changed during the run.",
      { expectedDigest: expected.digest, actualDigest: evidence.digest },
    );
  }
  return evidence;
}

export async function loadPinnedProjectContent(root, config = {}) {
  const settings = normalizeContentProvenance(config);
  const snapshot = await captureProjectContent(root, settings);
  if (settings.mode === "off") {
    return {
      snapshot,
      evidence: {
        version: CONTENT_PROVENANCE_VERSION,
        mode: "off",
        verified: false,
        digest: snapshot.manifest.digest,
        entries: snapshot.manifest.entries,
      },
    };
  }
  const lockPath = resolveLockPath(root, settings.lockFile);
  const serialized = await readSafeLock(lockPath, resolve(root));
  const locked = parseLock(serialized);
  assertManifestMatches(snapshot.manifest, locked);
  return {
    snapshot,
    evidence: createEvidence(snapshot.manifest, settings, serialized, { verified: true }),
  };
}

export function normalizeContentProvenance(config = {}, { defaultMode = "off" } = {}) {
  const value = config.content?.provenance;
  const mode = value?.mode ?? defaultMode;
  if (!["off", "enforce"].includes(mode)) {
    throw new ContentProvenanceError(
      "invalid-content-provenance-config",
      `Unsupported content provenance mode: '${mode}'.`,
    );
  }
  return {
    mode,
    lockFile: value?.lockFile ?? DEFAULT_LOCK_FILE,
    verifyAfterRun: value?.verifyAfterRun ?? true,
    maxEntries: positiveInteger(value?.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries"),
    maxFileBytes: positiveInteger(value?.maxFileBytes, DEFAULT_MAX_FILE_BYTES, "maxFileBytes"),
  };
}

function normalizeLimits(options) {
  return {
    maxEntries: positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries"),
    maxFileBytes: positiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, "maxFileBytes"),
  };
}

async function captureFlatDirectory(etnRoot, directoryName, extension, type, limits) {
  const directory = join(etnRoot, directoryName);
  const entries = await readDirectory(directory, etnRoot);
  const items = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new ContentProvenanceError(
        "unsafe-content-path",
        `Symbolic links are not allowed in .etnpilot/${directoryName}.`,
      );
    }
    if (!entry.isFile() || extname(entry.name) !== extension) continue;
    const absolutePath = join(directory, entry.name);
    const content = await readSafeContentFile(absolutePath, etnRoot, limits.maxFileBytes);
    const name = type === "agent"
      ? agentName(content, entry.name)
      : basename(entry.name, extension);
    items.push(contentItem(type, name, absolutePath, etnRoot, content));
  }
  return items;
}

async function captureSkills(etnRoot, limits) {
  const directory = join(etnRoot, "skills");
  const entries = await readDirectory(directory, etnRoot);
  const items = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new ContentProvenanceError(
        "unsafe-content-path",
        "Symbolic links are not allowed in .etnpilot/skills.",
      );
    }
    if (!entry.isDirectory()) continue;
    const skillDirectory = join(directory, entry.name);
    await assertDirectory(skillDirectory, etnRoot, { optional: false });
    const skillEntries = await readdir(skillDirectory, { withFileTypes: true });
    const unexpectedLink = skillEntries.find((child) => child.isSymbolicLink());
    if (unexpectedLink) {
      throw new ContentProvenanceError(
        "unsafe-content-path",
        `Symbolic links are not allowed in skill '${entry.name}'.`,
      );
    }
    const skillPath = join(skillDirectory, "SKILL.md");
    const content = await readSafeContentFile(skillPath, etnRoot, limits.maxFileBytes);
    items.push(contentItem("skill", entry.name, skillPath, etnRoot, content));
  }
  return items;
}

async function readDirectory(path, root) {
  const exists = await assertDirectory(path, root, { optional: true });
  if (!exists) return [];
  return (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
}

async function assertDirectory(path, root, { optional }) {
  const stat = await lstat(path).catch((error) => {
    if (optional && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ContentProvenanceError("unsafe-content-path", `${relativePath(root, path)} must be a regular directory.`);
  }
  await assertRealPathConfined(path, root);
  return true;
}

async function readSafeContentFile(path, root, maxFileBytes) {
  const pathStat = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") {
      throw new ContentProvenanceError("missing-content-file", `Missing required content file: ${relativePath(root, path)}.`);
    }
    throw error;
  });
  if (pathStat.isSymbolicLink()) {
    throw new ContentProvenanceError("unsafe-content-path", `Symbolic links are not allowed: ${relativePath(root, path)}.`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error) => {
    if (error.code === "ENOENT") {
      throw new ContentProvenanceError("missing-content-file", `Missing required content file: ${relativePath(root, path)}.`);
    }
    if (error.code === "ELOOP") {
      throw new ContentProvenanceError("unsafe-content-path", `Symbolic links are not allowed: ${relativePath(root, path)}.`);
    }
    throw error;
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new ContentProvenanceError("unsafe-content-path", `${relativePath(root, path)} must be a regular file.`);
    }
    if (stat.size > maxFileBytes) {
      throw new ContentProvenanceError(
        "content-limit-exceeded",
        `${relativePath(root, path)} exceeds the configured ${maxFileBytes}-byte content limit.`,
      );
    }
    await assertRealPathConfined(path, root);
    return handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function readSafeLock(path, root) {
  await assertRealPathConfined(dirname(path), root);
  const pathStat = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") {
      throw new ContentProvenanceError(
        "content-lock-missing",
        "The content lock is missing. Run 'etnpilot content lock' after reviewing project content.",
      );
    }
    throw error;
  });
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new ContentProvenanceError("unsafe-content-lock", "The content lock path must be a regular file.");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error) => {
    if (error.code === "ENOENT") {
      throw new ContentProvenanceError("content-lock-missing", "The content lock disappeared during verification.");
    }
    if (error.code === "ELOOP") {
      throw new ContentProvenanceError("unsafe-content-lock", "The content lock file may not be a symbolic link.");
    }
    throw error;
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new ContentProvenanceError("unsafe-content-lock", "The content lock path must be a regular file.");
    }
    if (stat.size > MAX_LOCK_BYTES) {
      throw new ContentProvenanceError("content-limit-exceeded", "The content lock exceeds the size limit.");
    }
    return handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function agentName(content, fileName) {
  let manifest;
  try {
    manifest = YAML.parse(content);
  } catch (error) {
    throw new ContentProvenanceError("invalid-agent-manifest", `Invalid agent manifest '${fileName}': ${error.message}`);
  }
  if (!manifest || typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new ContentProvenanceError("invalid-agent-manifest", `Agent manifest '${fileName}' requires a name.`);
  }
  return manifest.name;
}

function contentItem(type, name, absolutePath, etnRoot, content) {
  return {
    type,
    name,
    path: `.etnpilot/${relative(etnRoot, absolutePath).split(sep).join("/")}`,
    digest: digest(content),
    bytes: Buffer.byteLength(content),
    absolutePath,
    content,
  };
}

function createManifest(entries) {
  const payload = {
    version: CONTENT_PROVENANCE_VERSION,
    algorithm: CONTENT_DIGEST_ALGORITHM,
    entries,
  };
  return { ...payload, digest: digest(JSON.stringify(payload)) };
}

function createEvidence(manifest, settings, serializedLock, extra) {
  return {
    version: manifest.version,
    mode: settings.mode,
    algorithm: manifest.algorithm,
    lockFile: settings.lockFile,
    lockDigest: digest(serializedLock),
    digest: manifest.digest,
    entries: manifest.entries,
    verifyAfterRun: settings.verifyAfterRun,
    ...extra,
  };
}

function parseLock(serialized) {
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new ContentProvenanceError("invalid-content-lock", "The content lock is not valid JSON.");
  }
  if (
    !value
    || Array.isArray(value)
    || value.version !== CONTENT_PROVENANCE_VERSION
    || value.algorithm !== CONTENT_DIGEST_ALGORITHM
    || !Array.isArray(value.entries)
    || typeof value.digest !== "string"
  ) {
    throw new ContentProvenanceError("invalid-content-lock", "The content lock has an unsupported schema.");
  }
  const expected = createManifest(value.entries);
  if (expected.digest !== value.digest) {
    throw new ContentProvenanceError("invalid-content-lock", "The content lock digest is invalid.");
  }
  return value;
}

function assertManifestMatches(actual, locked) {
  if (actual.digest === locked.digest && JSON.stringify(actual.entries) === JSON.stringify(locked.entries)) return;
  const lockedByPath = new Map(locked.entries.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.entries.map((entry) => [entry.path, entry]));
  const changed = actual.entries
    .filter((entry) => lockedByPath.has(entry.path) && lockedByPath.get(entry.path).digest !== entry.digest)
    .map((entry) => entry.path);
  const missing = locked.entries.filter((entry) => !actualByPath.has(entry.path)).map((entry) => entry.path);
  const added = actual.entries.filter((entry) => !lockedByPath.has(entry.path)).map((entry) => entry.path);
  throw new ContentProvenanceError(
    "content-lock-mismatch",
    "Project content does not match the reviewed content lock. Run 'etnpilot content lock' only after reviewing the changes.",
    { changed, missing, added },
  );
}

function resolveLockPath(root, configuredPath) {
  if (typeof configuredPath !== "string" || configuredPath.length === 0) {
    throw new ContentProvenanceError("invalid-content-provenance-config", "content.provenance.lockFile must be a path.");
  }
  const projectRoot = resolve(root);
  const path = resolve(projectRoot, configuredPath);
  assertLexicallyConfined(path, projectRoot, "content.provenance.lockFile");
  return path;
}

async function assertRealPathConfined(path, root) {
  const [resolvedPath, resolvedRoot] = await Promise.all([realpath(path), realpath(root)]);
  assertLexicallyConfined(resolvedPath, resolvedRoot, relativePath(root, path));
}

async function ensureSafeDirectoryTree(root, target) {
  assertLexicallyConfined(target, root, "content lock directory");
  const relation = relative(root, target);
  let current = root;
  for (const segment of relation.split(sep).filter(Boolean)) {
    current = join(current, segment);
    let stat = await lstat(current).catch(missingOnly);
    if (!stat) {
      await mkdir(current);
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ContentProvenanceError("unsafe-content-lock", "Content lock directories must not use symbolic links.");
    }
    await assertRealPathConfined(current, root);
  }
}

function assertLexicallyConfined(path, root, label) {
  const relation = relative(root, path);
  if (relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) return;
  throw new ContentProvenanceError("unsafe-content-path", `${label} must remain inside the project root.`);
}

function positiveInteger(value, fallback, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new ContentProvenanceError("invalid-content-provenance-config", `${label} must be a positive integer.`);
  }
  return result;
}

function digest(value) {
  return `sha256:${createHash(CONTENT_DIGEST_ALGORITHM).update(value).digest("hex")}`;
}

function compareItems(left, right) {
  return left.type.localeCompare(right.type) || left.path.localeCompare(right.path);
}

function relativePath(root, path) {
  return relative(root, path).split(sep).join("/") || ".";
}

function missingOnly(error) {
  if (error.code === "ENOENT") return undefined;
  throw error;
}
