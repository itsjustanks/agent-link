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
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    let response;
    if (request.method === "fixture/unicode") {
      response = { id: request.id, result: { text: "before\\u2028middle\\u2029after" } };
    } else if (request.method === "thread/resume") {
      response = {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: \`thread \${request.params.threadId} already has an active writer\` },
      };
    } else {
      response = { id: request.id, error: { code: -32603, message: "unrelated failure" } };
    }
    const bytes = Buffer.from(JSON.stringify(response) + "\\n");
    for (let offset = 0; offset < bytes.length; offset += 2) process.stdout.write(bytes.subarray(offset, offset + 2));
  }
});
`);

const startProxy = (env = {}) => spawn(
  process.execPath,
  [join(repo, "codex-app-server-proxy.mjs"), process.execPath, fixture],
  {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  },
);

const child = startProxy({ PASEO_AGENT_ID: "paseo-test-agent" });
const reader = readline.createInterface({ input: child.stdout });
const responses = [];
reader.on("line", (line) => responses.push({ raw: line, parsed: JSON.parse(line) }));
child.stdin.write(`${JSON.stringify({ id: 7, method: "fixture/unicode", params: {} })}\n`);
child.stdin.write(`${JSON.stringify({ id: 8, method: "thread/resume", params: { threadId: "thread-test" } })}\n`);
child.stdin.write(`${JSON.stringify({ id: 9, method: "fixture/error", params: {} })}\n`);
await new Promise((resolvePromise, reject) => {
  const timeout = setTimeout(() => reject(new Error("timed out waiting for proxy responses")), 2000);
  const poll = setInterval(() => {
    if (responses.length < 3) return;
    clearInterval(poll);
    clearTimeout(timeout);
    resolvePromise();
  }, 5);
});
child.stdin.end();
await new Promise((resolvePromise) => child.on("exit", resolvePromise));

assert.equal(responses.length, 3, "each JSON-RPC response must remain one line");
assert.equal(responses[0].parsed.result.text, "before\u2028middle\u2029after");
assert.match(responses[0].raw, /\\u2028/);
assert.match(responses[0].raw, /\\u2029/);
assert.deepEqual(responses[1].parsed, { jsonrpc: "2.0", id: 8, result: {} });
assert.equal(responses[2].parsed.error.message, "unrelated failure");

const standalone = startProxy();
const standaloneReader = readline.createInterface({ input: standalone.stdout });
const standaloneResponse = new Promise((resolvePromise) => standaloneReader.once("line", resolvePromise));
standalone.stdin.end(`${JSON.stringify({ id: 10, method: "thread/resume", params: { threadId: "thread-test" } })}\n`);
const standaloneLine = await standaloneResponse;
await new Promise((resolvePromise) => standalone.on("exit", resolvePromise));
assert.equal(
  JSON.parse(standaloneLine).error.message,
  "thread thread-test already has an active writer",
  "non-Paseo conflicts must remain errors",
);

console.log("PASS Codex app-server output and Paseo reload handover are safe");
