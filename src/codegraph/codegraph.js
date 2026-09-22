import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);
const IGNORED = new Set([".git", ".etnpilot", "node_modules", "dist", "coverage"]);

export class CodeGraph {
  constructor(databasePath) {
    mkdirSyncParent(databasePath);
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
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
        kind TEXT NOT NULL,
        UNIQUE(source_path, target, kind)
      );
      CREATE INDEX IF NOT EXISTS edges_source ON edges(source_path);
      CREATE INDEX IF NOT EXISTS edges_target ON edges(target);
    `);
  }

  async indexDirectory(root) {
    const absoluteRoot = resolve(root);
    const files = await walk(absoluteRoot);
    const insertNode = this.database.prepare(
      "INSERT OR REPLACE INTO nodes(path, kind, name, line, hash) VALUES (?, ?, ?, ?, ?)",
    );
    const insertEdge = this.database.prepare(
      "INSERT OR IGNORE INTO edges(source_path, target, kind) VALUES (?, ?, ?)",
    );
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec("DELETE FROM nodes; DELETE FROM edges;");
      for (const file of files) {
        const path = relative(absoluteRoot, file).replaceAll("\\", "/");
        const content = await readFile(file, "utf8");
        const hash = createHash("sha256").update(content).digest("hex");
        insertNode.run(path, "file", path, 1, hash);
        for (const symbol of symbols(content)) insertNode.run(path, symbol.kind, symbol.name, symbol.line, hash);
        for (const dependency of dependencies(content)) insertEdge.run(path, dependency, "imports");
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      root: absoluteRoot,
      files: files.length,
      nodes: Number(this.database.prepare("SELECT COUNT(*) count FROM nodes").get().count),
      edges: Number(this.database.prepare("SELECT COUNT(*) count FROM edges").get().count),
    };
  }

  dependencies(path) {
    return this.database.prepare(
      "SELECT target, kind FROM edges WHERE source_path = ? ORDER BY target",
    ).all(path).map((row) => ({ ...row }));
  }

  dependents(target) {
    return this.database.prepare(
      "SELECT source_path AS source, kind FROM edges WHERE target = ? ORDER BY source_path",
    ).all(target).map((row) => ({ ...row }));
  }

  close() {
    this.database.close();
  }
}

function mkdirSyncParent(path) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
}

async function walk(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) result.push(path);
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
