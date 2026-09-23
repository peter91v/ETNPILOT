import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const DEFAULT_TOOLS = Object.freeze(["codegraph_explore"]);
const MCP_TOOLS = new Set([
  "codegraph_explore",
  "codegraph_node",
  "codegraph_search",
  "codegraph_callers",
  "codegraph_callees",
  "codegraph_impact",
  "codegraph_files",
  "codegraph_status",
]);

export class CodeGraph {
  constructor(projectRoot = process.cwd(), { importer = importCodeGraph } = {}) {
    this.projectRoot = resolve(projectRoot);
    this.importer = importer;
    this.graph = undefined;
    this.api = undefined;
  }

  async open() {
    if (this.graph) return this;
    const api = await this.#loadApi();
    if (!api.CodeGraph.isInitialized(this.projectRoot)) {
      throw new Error(`CodeGraph is not initialized in ${this.projectRoot}. Run 'etnpilot graph build' first.`);
    }
    this.graph = await api.CodeGraph.open(this.projectRoot, { sync: false });
    return this;
  }

  async indexDirectory(root = this.projectRoot, { signal } = {}) {
    const projectRoot = resolve(root);
    if (projectRoot !== this.projectRoot) {
      this.close();
      this.projectRoot = projectRoot;
    }
    const api = await this.#loadApi();
    const initialized = api.CodeGraph.isInitialized(this.projectRoot);
    this.graph ??= initialized
      ? await api.CodeGraph.open(this.projectRoot, { sync: false })
      : await api.CodeGraph.init(this.projectRoot, { index: false });

    const operation = initialized
      ? await this.graph.sync({ signal })
      : await this.graph.indexAll({ signal });
    const stats = this.graph.getStats();
    const indexState = this.graph.getIndexState();
    if (operation.success === false || ["failed", "partial"].includes(indexState)) {
      throw new Error(`CodeGraph produced an incomplete index (state: ${indexState ?? "unknown"}).`);
    }
    return normalizeIndexResult(this.projectRoot, initialized, operation, stats);
  }

  dependencies(path) {
    const graph = this.#requireGraph();
    return graph.getFileDependencies(normalizePath(path)).map((targetPath) => ({
      target: targetPath,
      targetPath,
      kind: "imports",
      dangling: graph.getFile(targetPath) === null,
    }));
  }

  dependents(path) {
    const graph = this.#requireGraph();
    const targetPath = normalizePath(path);
    return graph.getFileDependents(targetPath).map((source) => ({
      source,
      target: targetPath,
      kind: "imports",
      dangling: graph.getFile(source) === null,
    }));
  }

  symbols(path) {
    const graph = this.#requireGraph();
    const normalized = normalizePath(path);
    const hash = graph.getFile(normalized)?.contentHash;
    return graph.getNodesInFile(normalized)
      .filter((node) => !["file", "import", "export"].includes(node.kind))
      .sort((left, right) => left.startLine - right.startLine || left.name.localeCompare(right.name))
      .map((node) => ({
        kind: node.kind,
        name: node.name,
        line: node.startLine,
        ...(hash ? { hash } : {}),
      }));
  }

  impact(paths, { maxDepth = 20 } = {}) {
    if (!Array.isArray(paths) || paths.length === 0) throw new TypeError("At least one changed path is required.");
    if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new TypeError("maxDepth must be a non-negative integer.");
    const graph = this.#requireGraph();
    const changed = paths.map(normalizePath);
    const queue = changed.map((path) => ({ path, depth: 0, via: null }));
    const impacted = new Map(queue.map((entry) => [entry.path, entry]));

    while (queue.length > 0) {
      const current = queue.shift();
      if (current.depth >= maxDepth) continue;
      for (const path of graph.getFileDependents(current.path).sort()) {
        if (impacted.has(path)) continue;
        const next = { path, depth: current.depth + 1, via: current.path, kind: "imports" };
        impacted.set(path, next);
        queue.push(next);
      }
    }

    const files = [...impacted.values()]
      .sort((left, right) => left.depth - right.depth || left.path.localeCompare(right.path))
      .map((entry) => ({ ...entry, dangling: graph.getFile(entry.path) === null }));
    return {
      changed,
      files,
      tests: files.filter((entry) => isTestPath(entry.path)),
      maxDepth,
    };
  }

  stats() {
    const graph = this.#requireGraph();
    const stats = graph.getStats();
    const build = graph.getIndexBuildInfo();
    const lastIndexed = graph.getLastIndexedAt();
    return {
      engine: "@colbymchenry/codegraph",
      version: build.version,
      extractionVersion: build.extractionVersion,
      files: stats.fileCount,
      nodes: stats.nodeCount,
      edges: stats.edgeCount,
      nodesByKind: stats.nodesByKind,
      edgesByKind: stats.edgesByKind,
      filesByLanguage: stats.filesByLanguage,
      databaseBytes: stats.dbSizeBytes,
      walBytes: stats.walSizeBytes,
      lastIndexedAt: lastIndexed === null ? null : new Date(lastIndexed).toISOString(),
      indexState: graph.getIndexState(),
    };
  }

  close() {
    this.graph?.close();
    this.graph = undefined;
  }

  async #loadApi() {
    if (this.api) return this.api;
    const imported = await this.importer();
    const api = imported?.CodeGraph ? imported : imported?.default;
    if (!api?.CodeGraph) {
      throw new Error("The installed @colbymchenry/codegraph package does not expose its CodeGraph API.");
    }
    this.api = api;
    return api;
  }

  #requireGraph() {
    if (!this.graph) throw new Error("CodeGraph is not open. Call open() or indexDirectory() first.");
    return this.graph;
  }
}

export function createCodeGraphMcpServer(projectRoot, config = {}) {
  const tools = normalizeTools(config.tools);
  const launcher = bundledLauncher();
  return {
    type: "local",
    command: launcher.command,
    args: [...launcher.args, "serve", "--mcp", "--path", resolve(projectRoot)],
    cwd: resolve(projectRoot),
    tools,
    timeout: positiveInteger(config.startupTimeoutMs, 30_000, "codegraph.startupTimeoutMs"),
    env: {
      CODEGRAPH_TELEMETRY: "0",
      CODEGRAPH_NO_UPDATE_CHECK: "1",
    },
  };
}

export function isCodeGraphSourcePath(path) {
  return /\.(?:app|app\.src|astro|c|cbl|cob|cc|cfc|cfm|cfs|cjs|cpp|cpy|cs|cu|cuh|dart|dpk|dpr|erl|escript|ets|go|h|hh|hpp|hrl|hxx|java|js|jsx|kt|kts|liquid|lpr|lua|luau|m|metal|mjs|mm|nix|pas|php|properties|py|r|razor|rb|rs|scala|sc|sol|svelte|swift|tf|tfvars|tofu|ts|tsx|vb|vue|twig|xml|yaml|yml)$/i.test(String(path));
}

async function importCodeGraph() {
  return import("@colbymchenry/codegraph");
}

// The upstream package keeps its compiled library in per-platform optional
// dependencies and throws this when none matches the host — on Android, for
// instance, where no bundle is published. It is a statement about the machine,
// not about the project, so callers may treat it differently from a real fault.
export function isCodeGraphUnavailable(error) {
  return /programmatic API is unavailable because the platform bundle/i.test(String(error?.message ?? ""));
}

function bundledLauncher() {
  const packageJson = require.resolve("@colbymchenry/codegraph/package.json");
  return {
    command: process.execPath,
    args: [resolve(dirname(packageJson), "npm-shim.js")],
  };
}

function normalizeTools(value) {
  if (value === undefined) return [...DEFAULT_TOOLS];
  if (!Array.isArray(value) || value.length === 0 || value.some((tool) => !MCP_TOOLS.has(tool))) {
    throw new TypeError("codegraph.tools must be a non-empty array of CodeGraph MCP tool names.");
  }
  return [...new Set(value)];
}

function positiveInteger(value, fallback, field) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive integer.`);
  return value;
}

function normalizeIndexResult(root, wasInitialized, operation, stats) {
  const sync = Object.hasOwn(operation, "filesChecked");
  return {
    root,
    operation: sync ? "sync" : "index",
    initialized: !wasInitialized,
    files: stats.fileCount,
    indexed: sync ? operation.filesAdded + operation.filesModified : operation.filesIndexed,
    unchanged: sync
      ? Math.max(0, operation.filesChecked - operation.filesAdded - operation.filesModified - operation.filesRemoved)
      : operation.filesSkipped,
    deleted: sync ? operation.filesRemoved : 0,
    errors: sync ? 0 : operation.filesErrored,
    nodes: stats.nodeCount,
    edges: stats.edgeCount,
    languages: Object.entries(stats.filesByLanguage)
      .filter(([, count]) => count > 0)
      .map(([language]) => language)
      .sort(),
    durationMs: operation.durationMs,
  };
}

function normalizePath(path) {
  return String(path).replaceAll("\\", "/").replace(/^\.\//, "");
}

function isTestPath(path) {
  return /(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\.[^.]+$|(?:^|\/)test_[^/]+\.py$|_test\.go$|(?:^|\/)[^/]+Tests?\.(?:java|kt|cs)$/i.test(path);
}
