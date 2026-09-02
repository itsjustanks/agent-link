#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deviceCode, stripTerminal, trustedAuthUrl } from "../apps/paseo/auth.logic.ts";

const claude = [
  "Opening browser to sign in…",
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=fresh-state",
  "Paste code here if prompted > ",
].join("\n");
assert.equal(trustedAuthUrl("claude", claude), "https://claude.com/cai/oauth/authorize?code=true&state=fresh-state");
assert.equal(trustedAuthUrl("codex", claude), null);
assert.equal(trustedAuthUrl("claude", "https://claude.com.evil.example/steal"), null);

const codex = [
  "\u001b[90mFollow these steps to sign in with ChatGPT using device code authorization:\u001b[0m",
  "\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m",
  "Enter this one-time code (expires in 15 minutes)",
  "\u001b[94mM7DM-4XN6Y\u001b[0m",
].join("\n");
assert.equal(trustedAuthUrl("codex", codex), "https://auth.openai.com/codex/device");
assert.equal(deviceCode(codex), "M7DM-4XN6Y");
assert.equal(deviceCode(codex.replace("one-time code", "ONE-TIME CODE")), "M7DM-4XN6Y");
assert.doesNotMatch(stripTerminal(codex), /\u001b/);
assert.equal(deviceCode("M7DM-4XN6Y before the prompt"), null);

const repo = resolve(import.meta.dirname, "..");
const server = readFileSync(resolve(repo, "apps/paseo/auth.server.ts"), "utf8");
const client = readFileSync(resolve(repo, "apps/paseo/agents.client.tsx"), "utf8");
assert.match(server, /\["login", "--device-auth"\]/);
assert.match(server, /session\.child\.stdin\.write\(`\$\{value\}\\n`\)/);
assert.match(server, /source !== "primary"/);
assert.doesNotMatch(server, /writeFileSync|writeTextAtomic|OAUTH_TOKEN/);
assert.match(client, /Connect and sign in/);
assert.match(client, /Complete sign-in/);
assert.match(client, /never stores it/);

console.log("PASS guided Claude and Codex plugin authentication contract");
