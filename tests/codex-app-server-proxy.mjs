#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";

const repo = resolve(import.meta.dirname, "..");
const fixtureRoot = mkdtempSync(join(tmpdir(), "agent-link-codex-proxy-"));
const fixture = join(fixtureRoot, "fixture.mjs");
writeFileSync(fixture, `
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const payload = JSON.stringify({ id: 7, result: { text: "before\\u2028middle\\u2029after", input } });
  const bytes = Buffer.from(payload + "\\n");
  for (let offset = 0; offset < bytes.length; offset += 2) process.stdout.write(bytes.subarray(offset, offset + 2));
});
`);

const child = spawn(process.execPath, [join(repo, "codex-app-server-proxy.mjs"), process.execPath, fixture], {
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdin.end("request-body\n");

const lines = [];
const reader = readline.createInterface({ input: child.stdout });
for await (const line of reader) lines.push(line);
const exitCode = await new Promise((resolvePromise) => child.on("exit", resolvePromise));

assert.equal(exitCode, 0);
assert.equal(lines.length, 1, "Unicode line separators must not split one JSON-RPC response");
const parsed = JSON.parse(lines[0]);
assert.equal(parsed.result.text, "before\u2028middle\u2029after");
assert.equal(parsed.result.input, "request-body\n");
assert.match(lines[0], /\\u2028/);
assert.match(lines[0], /\\u2029/);

console.log("PASS Codex app-server Unicode line separators remain one JSON-RPC line");
