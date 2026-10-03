// What a finished task costs: all spend, including attempts that failed on the
// way, over the runs that succeeded; split by the tier of a ladder that passed
// and by the router's difficulty, so strategies can be compared on this
// project's own work. Read from the receipts; shown only once there are runs.

let taskCosts;
let taskCostsRuns;

function taskCostPanel() {
  const total = state.runsTotal ?? state.runs.length;
  if (taskCostsRuns !== total) {
    taskCostsRuns = total;
    api("/api/usage/tasks").then((data) => { taskCosts = data; if (view === "overview") render(); }, () => {});
  }
  if (!taskCosts || taskCosts.runs === 0) return [];
  const money = (value) => (value === undefined ? "not priced" : (taskCosts.currency === "USD" ? "$" : taskCosts.currency + " ") + value.toFixed(value < 0.1 ? 4 : 2));
  const rows = [["All runs", taskCosts]]
    .concat(Object.entries(taskCosts.byTier).map(([label, entry]) => ["Passed on " + label, entry]))
    .concat(Object.entries(taskCosts.byDifficulty).map(([label, entry]) => ["Routed " + label, entry]));
  return [panel("Cost per finished task", {
    meta: money(taskCosts.perCompleted) + " each",
    open: true,
    body: [
      el("p", { class: "muted", text: "All spend, also on attempts that failed on the way, divided by the runs that finished." }),
      el("div", { class: "table-wrap" }, [el("table", {}, [
        el("thead", {}, [el("tr", {}, ["", "Finished", "Spent", "Per task"].map((head) => el("th", { text: head })))]),
        el("tbody", {}, rows.map(([label, entry]) => el("tr", {}, [
          el("td", { text: label }),
          el("td", { text: entry.completed + " of " + entry.runs }),
          el("td", { text: money(entry.priced > 0 ? entry.cost : undefined) }),
          el("td", { text: money(entry.perCompleted) }),
        ]))),
      ])]),
    ],
  })];
}
