// @ts-check
// The experimental notice for node:sqlite, kept out of an interactive screen.
//
// Node prints it once, the first time the module is loaded, and here that is
// over the top of a conversation or a full-screen interface. It is a true
// statement about the runtime and every non-interactive command still prints
// it; only the two screens that own the terminal filter it, and only this one
// message. Any other warning is printed exactly as before.
const MESSAGE = /SQLite is an experimental feature/;

export function quietSqliteWarning() {
  // The code index runs its store in a worker thread of its own, which has its
  // own process object and prints for itself; a listener here cannot reach it.
  // A worker reads the environment it was created with, so this is set first.
  const hadNoWarnings = process.env.NODE_NO_WARNINGS;
  process.env.NODE_NO_WARNINGS = "1";
  const printers = process.listeners("warning");
  process.removeAllListeners("warning");
  const filter = (warning) => {
    if (MESSAGE.test(String(warning?.message ?? warning))) return;
    for (const printer of printers) printer.call(process, warning);
  };
  process.on("warning", filter);
  return () => {
    if (hadNoWarnings === undefined) delete process.env.NODE_NO_WARNINGS;
    else process.env.NODE_NO_WARNINGS = hadNoWarnings;
    process.off("warning", filter);
    for (const printer of printers) process.on("warning", printer);
  };
}

// Run before anything else is imported, because the notice is raised while the
// project's modules are loaded, not when a command starts.
export function quietForInteractiveCommand(argv = process.argv) {
  const command = argv.slice(2).find((argument) => !argument.startsWith("-"));
  if (command === "chat" || command === "tui") return quietSqliteWarning();
  return undefined;
}
