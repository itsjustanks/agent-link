#!/usr/bin/env node

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";

const [binary, ...args] = process.argv.slice(2);
if (!binary) {
  process.stderr.write("usage: codex-app-server-proxy <codex> app-server [args...]\n");
  process.exit(64);
}

// Node's readline treats U+2028/U+2029 as record separators. They are valid
// inside JSON strings and Codex app-server can emit them unescaped when reading
// an older transcript, causing Paseo to split one JSON-RPC response into many
// invalid lines. Escape only those code points and leave every JSON value and
// ordinary byte unchanged.
const decoder = new StringDecoder("utf8");
const escapeJsonLineSeparators = (value) => value
  .replaceAll("\u2028", "\\u2028")
  .replaceAll("\u2029", "\\u2029");

const paseoAgentId = process.env.PASEO_AGENT_ID?.trim() ?? "";
const pendingResumes = new Map();
const rpcIdKey = (id) => `${typeof id}:${String(id)}`;

let requestBuffer = "";
const requestDecoder = new StringDecoder("utf8");
const observeRequestLine = (line) => {
  try {
    const message = JSON.parse(line);
    if (message?.method !== "thread/resume" || message.id === undefined) return;
    const threadId = message.params?.threadId;
    if (typeof threadId !== "string" || threadId.length === 0) return;
    pendingResumes.set(rpcIdKey(message.id), threadId);
  } catch {
    // The child remains the authority for malformed or unsupported requests.
  }
};
const observeRequests = (value) => {
  requestBuffer += value;
  for (;;) {
    const newline = requestBuffer.indexOf("\n");
    if (newline < 0) return;
    observeRequestLine(requestBuffer.slice(0, newline));
    requestBuffer = requestBuffer.slice(newline + 1);
  }
};

// Paseo's user-facing Reload agent currently opens the replacement Codex
// app-server before closing the existing one. Codex correctly rejects the
// replacement as a second writer, so let that one connection finish as a
// read-only history load. Paseo then closes the old session; before the next
// turn its normal thread/loaded/list check resumes the replacement as writer.
const rewritePaseoReloadConflict = (line) => {
  const sanitized = escapeJsonLineSeparators(line);
  let message;
  try {
    message = JSON.parse(sanitized);
  } catch {
    return sanitized;
  }
  if (message?.id === undefined) return sanitized;
  const key = rpcIdKey(message.id);
  const threadId = pendingResumes.get(key);
  if (!threadId) return sanitized;
  pendingResumes.delete(key);
  const error = typeof message.error?.message === "string" ? message.error.message : "";
  if (!paseoAgentId || !error.includes(threadId) || !error.includes("already has an active writer")) {
    return sanitized;
  }
  return JSON.stringify({
    ...(message.jsonrpc === undefined ? {} : { jsonrpc: message.jsonrpc }),
    id: message.id,
    result: {},
  });
};

const requestObserver = new Transform({
  transform(chunk, _encoding, callback) {
    observeRequests(requestDecoder.write(chunk));
    callback(null, chunk);
  },
  flush(callback) {
    observeRequests(requestDecoder.end());
    if (requestBuffer) observeRequestLine(requestBuffer);
    callback();
  },
});

let responseBuffer = "";
const responseSanitizer = new Transform({
  transform(chunk, _encoding, callback) {
    responseBuffer += decoder.write(chunk);
    let output = "";
    for (;;) {
      const newline = responseBuffer.indexOf("\n");
      if (newline < 0) break;
      output += `${rewritePaseoReloadConflict(responseBuffer.slice(0, newline))}\n`;
      responseBuffer = responseBuffer.slice(newline + 1);
    }
    callback(null, output);
  },
  flush(callback) {
    responseBuffer += decoder.end();
    callback(null, responseBuffer ? rewritePaseoReloadConflict(responseBuffer) : "");
  },
});

const child = spawn(binary, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

process.stdin.pipe(requestObserver).pipe(child.stdin);
child.stdout.pipe(responseSanitizer).pipe(process.stdout);
child.stderr.pipe(process.stderr);

const signalExitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("error", (error) => {
  process.stderr.write(`could not start Codex app-server: ${error.message}\n`);
  process.exitCode = 1;
});

child.on("close", (code, signal) => {
  process.exit(code ?? signalExitCodes[signal] ?? 1);
});
