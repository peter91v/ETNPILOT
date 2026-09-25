// The smallest thing a run can be asked to do, and the one that failed for a
// week: 'succeeded' over a workspace where nothing was written.
export default {
  task: "Create a file called notes.txt containing the word ready.",
  files: {
    "README.md": "# fixture\n",
  },
  // Against the scripted provider this is the harness under test: the policy
  // allowed it, a human approved it, the receipt recorded it, and the file is
  // on disk. Against a real provider the same checks measure the agent.
  scripted: [
    { tool: "write_file", arguments: { path: "notes.txt", content: "ready\n" } },
  ],
  expect: [
    { kind: "fileExists", path: "notes.txt" },
    { kind: "fileContains", path: "notes.txt", pattern: "ready" },
    { kind: "onlyTouched", paths: ["notes.txt"] },
  ],
};
