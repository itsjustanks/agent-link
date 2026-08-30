#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const source = readFileSync(join(repo, "agent-link"), "utf8");
const plugin = readFileSync(join(repo, "apps", "paseo", "index.ts"), "utf8");
const client = readFileSync(join(repo, "apps", "paseo", "agents.client.tsx"), "utf8");
const handlers = readFileSync(join(repo, "apps", "paseo", "handlers.server.ts"), "utf8");
const runtime = readFileSync(join(repo, "agent-link-acp.mjs"), "utf8");
const watchdog = readFileSync("/Users/ankit/.local/bin/paseo-watchdog.py", "utf8");

function functionBody(name, nextName) {
  const start = source.indexOf(`${name}()`);
  const end = source.indexOf(`\n${nextName}()`, start + 1);
  assert.ok(start >= 0 && end > start, `could not isolate ${name}`);
  return source.slice(start, end);
}

assert.doesNotMatch(functionBody("autopark", "slot_available"), /cmd_evict/);
assert.doesNotMatch(functionBody("cmd_refused", "cmd_nearing"), /enqueue_paseo_recovery/);
assert.doesNotMatch(functionBody("cmd_auto", "cmd_exec_auto"), /write_recovery_helper/);
assert.doesNotMatch(functionBody("write_auto_launcher", "cmd_auto"), /resume-target[^\n]*--go|continue-target[^\n]*--go/);
assert.doesNotMatch(source.slice(source.lastIndexOf("main()")), /\b(recover|rescue|handoff|switch)\)/);
assert.doesNotMatch(source, /\n(?:write_recovery_helper|cmd_recover|cmd_rescue|cmd_handoff|cmd_evict|cmd_switch|cmd_fix)\(\)/);
assert.doesNotMatch(plugin, /limitsStatus|limitsResume|agentContinue|contributeModelPills|AgentRoutingPanel/);
assert.doesNotMatch(client, /New-chat account selection|callWireAuto|routerPending/);
assert.match(client, /Authentication required/);
assert.match(client, /agent-link login \$\{provider\} primary/);
assert.match(client, /AgentLink never opens a terminal or handles your password/);
assert.match(client, /Paseo-native subagents/);
assert.doesNotMatch(handlers, /ensureLimitSentry/);
assert.doesNotMatch(handlers, /agent-link-continuation|agents\.create\(|\.archive\(\)|paseo\.parent-agent-id/);
assert.match(handlers, /Deliberately do NOT spawn the login here/);
assert.doesNotMatch(watchdog, /process_agent_recovery|agent-link[^\n]*recover/);
assert.doesNotMatch(runtime, /paseo\s+(run|send|archive|delete)|PASEO_AGENT_ID/);
for (const retired of ["limits.server.ts", "limits.shared.ts", "model-pill.client.tsx"]) {
  assert.equal(existsSync(join(repo, "apps", "paseo", retired)), false, `${retired} should be removed`);
}

const temp = mkdtempSync(join(tmpdir(), "agent-link-install-test-"));
const home = join(temp, "home");
const agentLinkHome = join(temp, "agent-link");
const bin = join(temp, "bin");
mkdirSync(join(home, ".paseo"), { recursive: true });
mkdirSync(join(agentLinkHome, "bin"), { recursive: true });
mkdirSync(join(agentLinkHome, "state"), { recursive: true });
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "paseo"), "#!/bin/sh\ncase \"$*\" in *'provider models'*) printf '[]\\n';; esac\nexit 0\n", { mode: 0o755 });
writeFileSync(join(agentLinkHome, "bin", "paseo-recover"), "obsolete recovery helper\n", { mode: 0o755 });
writeFileSync(join(agentLinkHome, "state", "paseo-limit-sentry.json"), JSON.stringify({ auto: true, events: [] }));
writeFileSync(join(home, ".paseo", "config.json"), JSON.stringify({
  version: 1,
  agents: {
    providers: {
      "claude-auto": { extends: "claude", label: "old claude", command: ["/old/claude-auto"] },
      "codex-auto": { extends: "codex", label: "old codex", command: ["/old/codex-auto"] },
    },
  },
}, null, 2));

execFileSync(join(repo, "agent-link"), ["auto"], {
  cwd: repo,
  env: { ...process.env, HOME: home, AGENT_LINK_HOME: agentLinkHome, PATH: `${bin}:${process.env.PATH ?? ""}` },
  encoding: "utf8",
  timeout: 30_000,
});

const config = JSON.parse(readFileSync(join(home, ".paseo", "config.json"), "utf8"));
const providers = config.agents.providers;
assert.equal(providers["agent-link"].extends, "acp");
assert.deepEqual(providers["agent-link"].command, [join(agentLinkHome, "bin", "agent-link-acp")]);
assert.match(providers["claude-auto"].label, /Legacy/);
assert.match(providers["codex-auto"].label, /Legacy/);
assert.doesNotMatch(readFileSync(join(agentLinkHome, "bin", "claude-auto"), "utf8"), /resume-target[^\n]*--go|continue-target[^\n]*--go/);
assert.equal(JSON.parse(readFileSync(join(agentLinkHome, "state", "paseo-limit-sentry.json"), "utf8")).auto, false);
assert.equal(existsSync(join(agentLinkHome, "bin", "paseo-recover")), false);
assert.equal(existsSync(join(agentLinkHome, "state", "retired", "paseo-recover-v0.5")), true);
execFileSync(process.execPath, ["--check", join(agentLinkHome, "bin", "agent-link-acp")], { timeout: 10_000 });

console.log("PASS automatic continuation, tab replacement and recovery process control are inactive");
