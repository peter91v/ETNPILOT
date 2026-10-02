// @ts-check
// A single self-contained page: no framework, no CDN, no build step. Every
// value from a run is inserted with textContent, never as markup, because all
// of it is text an agent controlled.
//
// It shows what the TUI shows and can do what the TUI can do: decide
// approvals, cancel and resume queue jobs, read a run's receipt, change
// settings against the same layers, start a run, and list the worktrees and
// the project's merge requests.
//
// The shape — a sidebar of views, a topbar that says where you are, panels,
// status pills, a command palette and toasts — follows the GUI draft. What it
// does not follow is the draft's screens for things that do not exist yet: a
// surface that shows an empty 'Plugins' page teaches the wrong thing.
import { renderChatMarkdown } from "./markdown.js";
import { readFileSync } from "node:fs";

// The page's script is written as ordinary JavaScript files under ./client/
// (so it can be read, linted and syntax-checked like the rest of the code) and
// joined here, in this order: later files use what earlier ones define.
const CLIENT_FILES = ["core", "chat", "runs", "run-list", "getting-started", "resume-plan", "worktrees", "project", "accounts", "shell"];
const STYLES = readFileSync(new URL("./client/styles.css", import.meta.url), "utf8");
const MARKUP = readFileSync(new URL("./client/markup.html", import.meta.url), "utf8");
const client = Object.fromEntries(CLIENT_FILES.map((name) => [name, readFileSync(new URL(`./client/${name}.js`, import.meta.url), "utf8")]));

export function renderReviewPage(token) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f5fbf8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1513" media="(prefers-color-scheme: dark)">
<title>ETNPilot Review</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon.svg">
<meta name="mobile-web-app-capable" content="yes">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%230b0f13'/%3E%3Cpath d='M16 18h32v8H25v8h20v8H25v4h23v8H16z' fill='%233ee6c1'/%3E%3C/svg%3E">
<style>
${STYLES}
</style>
${MARKUP}
<script>
const TOKEN = ${JSON.stringify(token)};
${client.core}
${renderChatMarkdown.toString()}
${client.chat}
${client.runs}
${client["run-list"]}
${client["getting-started"]}
${client["resume-plan"]}
${client.worktrees}
${client.project}
${client.accounts}
${client.shell}
</script>
</body>
</html>
`;
}
