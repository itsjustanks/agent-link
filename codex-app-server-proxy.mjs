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

const sanitizer = new Transform({
  transform(chunk, _encoding, callback) {
    callback(null, escapeJsonLineSeparators(decoder.write(chunk)));
  },
  flush(callback) {
    callback(null, escapeJsonLineSeparators(decoder.end()));
  },
});

const child = spawn(binary, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

process.stdin.pipe(child.stdin);
child.stdout.pipe(sanitizer).pipe(process.stdout);
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
