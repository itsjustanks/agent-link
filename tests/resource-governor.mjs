import assert from "node:assert/strict";
import { paseoTypechecks, planGovernorActions } from "../apps/paseo/resources.logic.ts";

const row = (pid, ppid, command, elapsedSeconds, rssKb = 1_024, state = "S") => ({
  pid,
  ppid,
  command,
  elapsedSeconds,
  rssKb,
  state,
});

const rows = [
  row(1, 0, "/Applications/Paseo.app/daemon-worker.js", 1_000),
  row(2, 1, "/Users/test/.local/bin/claude --provider", 900),
  row(10, 2, "/bin/zsh -c pnpm exec tsc --noEmit", 120),
  row(11, 10, "node pnpm.cjs exec tsc --noEmit", 119, 80_000),
  row(12, 11, "node node_modules/typescript/bin/tsc --noEmit", 118, 700_000),
  row(20, 2, "/bin/zsh -c tsc --noEmit -p second.json", 60),
  row(21, 20, "node node_modules/typescript/bin/tsc --noEmit -p second.json", 59, 600_000),
  row(30, 999, "/bin/zsh -c tsc --noEmit -p terminal.json", 200),
  row(31, 30, "node node_modules/typescript/bin/tsc --noEmit -p terminal.json", 199, 900_000),
];

const candidates = paseoTypechecks(rows);
assert.deepEqual(candidates.map(({ pid }) => pid), [12, 21]);

const plan = planGovernorActions(candidates, new Set(), 50, {
  maxActive: 1,
  pauseAtPercent: 15,
  resumeAtPercent: 25,
  pressureMinRssKb: 512 * 1_024,
});
assert.deepEqual(plan.pause.map(({ pid }) => pid), [21]);
assert.equal(plan.reason, "concurrency");

console.log("resource governor fixture passed");
