import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, posix, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SOURCE_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"];
const SOURCE_EXTENSION_SET = new Set(SOURCE_EXTENSIONS);
const IGNORED = new Set([".git", ".etnpilot", "node_modules", "dist", "coverage"]);

export class CodeGraph {
  constructor(databasePath) {
    mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.#initialize();
  }

  #initialize() {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS graph_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nodes (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        line INTEGER,
        hash TEXT,
        UNIQUE(path, kind, name, line)
      );
      CREATE TABLE IF NOT EXISTS edges (
        source_path TEXT NOT NULL,
        target TEXT NOT NULL,
        target_path TEXT,
        kind TEXT NOT NULL,
        UNIQUE(source_path, target, kind)
      );
      CREATE INDEX IF NOT EXISTS nodes_path ON nodes(path);
      CREATE INDEX IF NOT EXISTS edges_source ON edges(source_path);
      CREATE INDEX IF NOT EXISTS edges_target ON edges(target);
      INSERT OR REPLACE INTO graph_meta(key, value) VALUES ('schema_version', '2');
    `);
    this.#migrateLegacyEdges();
    this.database.exec("CREATE INDEX IF NOT EXISTS edges_target_path ON edges(target_path)");
  }

  #migrateLegacyEdges() {
    const columns = this.database.prepare("PRAGMA table_info(edges)").all();
    if (!columns.some((column) => column.name === "target_path")) {
      this.database.exec("ALTER TABLE edges ADD COLUMN target_path TEXT");
    }
  }

  async indexDirectory(root) {
    const absoluteRoot = resolve(root);
    const discovered = await walk(absoluteRoot);
    const existing = new Map(this.database.prepare(
      "SELECT path, hash, size, mtime_ms FROM files",
    ).all().map((row) => [row.path, row]));
    const seen = new Set();
    const changed = [];
    let unchanged = 0;

    for (const absolutePath of discovered) {
      const path = normalizePath(relative(absoluteRoot, absolutePath));
      const metadata = await stat(absolutePath);
      const previous = existing.get(path);
      seen.add(path);
      if (previous && Number(previous.size) === metadata.size && Number(previous.mtime_ms) === metadata.mtimeMs) {
        unchanged += 1;
        continue;
      }
      const content = await readFile(absolutePath, "utf8");
      const hash = createHash("sha256").update(content).digest("hex");
      if (previous?.hash === hash) {
        this.database.prepare(
          "UPDATE files SET size = ?, mtime_ms = ?, indexed_at = ? WHERE path = ?",
        ).run(metadata.size, metadata.mtimeMs, new Date().toISOString(), path);
        unchanged += 1;
        continue;
      }
      changed.push({ path, content, hash, size: metadata.size, mtimeMs: metadata.mtimeMs });
    }

    const deleted = [...existing.keys()].filter((path) => !seen.has(path));
    const insertFile = this.database.prepare(`
      INSERT OR REPLACE INTO files(path, hash, size, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const deleteFile = this.database.prepare("DELETE FROM files WHERE path = ?");
    const deleteNodes = this.database.prepare("DELETE FROM nodes WHERE path = ?");
    const deleteEdges = this.database.prepare("DELETE FROM edges WHERE source_path = ?");
    const insertNode = this.database.prepare(
      "INSERT OR REPLACE INTO nodes(path, kind, name, line, hash) VALUES (?, ?, ?, ?, ?)",
    );
    const insertEdge = this.database.prepare(
      "INSERT OR REPLACE INTO edges(source_path, target, target_path, kind) VALUES (?, ?, NULL, ?)",
    );

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const path of deleted) {
        deleteFile.run(path);
        deleteNodes.run(path);
        deleteEdges.run(path);
      }
      for (const file of changed) {
        deleteNodes.run(file.path);
        deleteEdges.run(file.path);
        insertFile.run(file.path, file.hash, file.size, file.mtimeMs, new Date().toISOString());
        insertNode.run(file.path, "file", file.path, 1, file.hash);
        for (const symbol of symbols(file.content)) {
          insertNode.run(file.path, symbol.kind, symbol.name, symbol.line, file.hash);
        }
        for (const dependency of dependencies(file.content)) {
          insertEdge.run(file.path, dependency, "imports");
        }
      }
      this.#resolveEdges();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    return {
      root: absoluteRoot,
      files: discovered.length,
      indexed: changed.length,
      unchanged,
      deleted: deleted.length,
      nodes: this.#count("nodes"),
      edges: this.#count("edges"),
      resolvedEdges: Number(this.database.prepare(
        "SELECT COUNT(*) count FROM edges WHERE target_path IS NOT NULL",
      ).get().count),
      brokenEdges: this.#brokenEdgeCount(),
    };
  }

  #resolveEdges() {
    const files = new Set(this.database.prepare("SELECT path FROM files").all().map((row) => row.path));
    const unresolved = this.database.prepare("SELECT rowid, source_path, target, target_path FROM edges").all();
    const update = this.database.prepare("UPDATE edges SET target_path = ? WHERE rowid = ?");
    for (const edge of unresolved) {
      const resolved = resolveDependency(edge.source_path, edge.target, files);
      update.run(resolved ?? edge.target_path, edge.rowid);
    }
  }

  dependencies(path) {
    return this.database.prepare(`
      SELECT edges.target, edges.target_path AS targetPath, edges.kind,
        CASE WHEN edges.target_path IS NOT NULL AND files.path IS NULL THEN 1 ELSE 0 END AS dangling
      FROM edges LEFT JOIN files ON files.path = edges.target_path
      WHERE edges.source_path = ? ORDER BY edges.target
    `).all(normalizePath(path)).map(markDangling);
  }

  dependents(path) {
    return this.database.prepare(`
      SELECT edges.source_path AS source, edges.target, edges.kind,
        CASE WHEN files.path IS NULL THEN 1 ELSE 0 END AS dangling
      FROM edges LEFT JOIN files ON files.path = edges.target_path
      WHERE edges.target_path = ? ORDER BY edges.source_path
    `).all(normalizePath(path)).map(markDangling);
  }

  symbols(path) {
    return this.database.prepare(`
      SELECT kind, name, line, hash
      FROM nodes WHERE path = ? AND kind != 'file' ORDER BY line, name
    `).all(normalizePath(path)).map((row) => ({ ...row }));
  }

  impact(paths, { maxDepth = 20 } = {}) {
    if (!Array.isArray(paths) || paths.length === 0) throw new TypeError("At least one changed path is required.");
    if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new TypeError("maxDepth must be a non-negative integer.");
    const queue = paths.map((path) => ({ path: normalizePath(path), depth: 0, via: null }));
    const impacted = new Map(queue.map((entry) => [entry.path, entry]));
    const findDependents = this.database.prepare(`
      SELECT source_path AS path, kind FROM edges
      WHERE target_path = ? ORDER BY source_path
    `);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current.depth >= maxDepth) continue;
      for (const row of findDependents.all(current.path)) {
        if (impacted.has(row.path)) continue;
        const next = { path: row.path, depth: current.depth + 1, via: current.path, kind: row.kind };
        impacted.set(row.path, next);
        queue.push(next);
      }
    }
    const isKnownFile = this.database.prepare("SELECT 1 FROM files WHERE path = ?");
    const files = [...impacted.values()]
      .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
      .map((entry) => ({ ...entry, dangling: isKnownFile.get(entry.path) === undefined }));
    return {
      changed: paths.map(normalizePath),
      files,
      tests: files.filter((entry) => isTestPath(entry.path)),
      maxDepth,
    };
  }

  stats() {
    return {
      files: this.#count("files"),
      nodes: this.#count("nodes"),
      edges: this.#count("edges"),
      resolvedEdges: Number(this.database.prepare(
        "SELECT COUNT(*) count FROM edges WHERE target_path IS NOT NULL",
      ).get().count),
      brokenEdges: this.#brokenEdgeCount(),
      schemaVersion: Number(this.database.prepare(
        "SELECT value FROM graph_meta WHERE key = 'schema_version'",
      ).get().value),
    };
  }

  #count(table) {
    return Number(this.database.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count);
  }

  #brokenEdgeCount() {
    return Number(this.database.prepare(`
      SELECT COUNT(*) count FROM edges
      WHERE target_path IS NOT NULL
        AND target_path NOT IN (SELECT path FROM files)
    `).get().count);
  }

  close() {
    this.database.close();
  }
}

async function walk(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile() && SOURCE_EXTENSION_SET.has(extname(entry.name))) result.push(path);
  }
  return result.sort();
}

function dependencies(content) {
  const result = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) result.add(match[1]);
  }
  return [...result].sort();
}

function symbols(content) {
  const result = [];
  const pattern = /\b(?:export\s+)?(?:async\s+)?(class|function)\s+([A-Za-z_$][\w$]*)|\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/g;
  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    result.push({
      kind: match[1] === "class" ? "class" : match[1] === "function" ? "function" : "constant",
      name: match[2] ?? match[3],
      line: content.slice(0, index).split("\n").length,
    });
  }
  return result;
}

function resolveDependency(sourcePath, target, files) {
  if (!target.startsWith(".")) return null;
  const joined = posix.normalize(posix.join(posix.dirname(sourcePath), target));
  const extension = posix.extname(joined);
  const withoutExtension = extension ? joined.slice(0, -extension.length) : joined;
  const candidates = new Set([
    joined,
    ...SOURCE_EXTENSIONS.map((item) => `${withoutExtension}${item}`),
    ...SOURCE_EXTENSIONS.map((item) => posix.join(joined, `index${item}`)),
  ]);
  for (const candidate of candidates) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

function markDangling(row) {
  return { ...row, dangling: row.dangling === 1 };
}

function normalizePath(path) {
  return String(path).replaceAll("\\", "/").replace(/^\.\//, "");
}

function isTestPath(path) {
  return /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/i.test(path);
}
