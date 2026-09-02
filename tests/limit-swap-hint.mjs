#!/usr/bin/env node

// Two things this pins down about an explicitly chosen AgentLink account:
// a fresh chat lands on a real account rather than the automatic route, and a
// turn lost to a usage limit names the accounts you could switch to instead of
// dead-ending. A failure that is not a limit must stay quiet, because swapping
// accounts would not fix it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const repo = resolve(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "agent-link-limit-test-"));
const home = join(root, "home");
const agentLinkHome = join(root, "agent-link");
const bin = join(root, "bin");
const workspace = join(root, "workspace");
const slot = join(agentLinkHome, "accounts", "claude", "spare@example.com");
for (const path of [home, agentLinkHome, bin, workspace, slot, join(home, ".codex"), join(home, ".paseo")]) {
  mkdirSync(path, { recursive: true });
}

writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "primary@example.com" }, projects: {} }));
writeFileSync(join(slot, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "spare@example.com" }, projects: {} }));
writeFileSync(join(home, ".paseo", "config.json"), JSON.stringify({ agents: { providers: {} } }));

// Claude Code reports an exhausted account through an assistant message it
// stamps as an API error, so the fake speaks the same shape.
writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
let input = "";
for await (const chunk of process.stdin) input += chunk;
const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\\n");
const text = input.includes("BREAK_OTHER")
  ? "Edit failed: file not found"
  : "You've reached your usage limit. Try again later.";
process.stdout.write(JSON.stringify({ type: "assistant", session_id: sessionId, isApiErrorMessage: true, message: { content: [{ type: "text", text }] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", session_id: sessionId, is_error: true, result: text }) + "\\n");
process.exit(1);
`, { mode: 0o755 });

class RpcClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.child = spawn(process.execPath, [join(repo, "agent-link-acp.mjs")], {
      cwd: repo,
      env: { ...process.env, HOME: home, AGENT_LINK_HOME: agentLinkHome, PATH: `${bin}:${process.env.PATH ?? ""}` },
      stdio: ["pipe", "pipe", "inherit"],
    });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return void this.notifications.push(message);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const result = new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return result;
  }

  texts() {
    return this.notifications
      .filter((entry) => entry.method === "session/update")
      .map((entry) => entry.params.update.content?.text)
      .filter(Boolean);
  }

  close() {
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }
}

const rpc = new RpcClient();
try {
  await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const created = await rpc.request("session/new", { cwd: workspace, mcpServers: [] });
  const names = new Map(created.models.availableModels.map((model) => [model.name, model.modelId]));

  const router = names.get("AgentRouter · Automatic route");
  assert.ok(router, "the automatic route stays available as a choice");
  assert.notEqual(created.models.currentModelId, router, "a fresh chat must not default to the automatic route");
  assert.equal(
    created.models.currentModelId,
    names.get("Claude Fable 5.1 · primary@example.com"),
    "a fresh chat defaults to the primary sign-in",
  );
  assert.equal(
    created.models.availableModels.at(-1).modelId,
    router,
    "the automatic route sorts last, behind the explicit accounts",
  );

  const before = rpc.texts().length;
  await rpc.request("session/prompt", {
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "do the thing" }],
  });
  const limitRefusal = rpc.texts().slice(before).join("\n");
  assert.match(limitRefusal, /usage limit/i, "the provider's own reason survives");
  assert.match(limitRefusal, /Switch account in the model picker/, "a limit names the way out");
  assert.match(limitRefusal, /Claude Fable 5\.1 · spare@example\.com/, "the same model on another account is offered first");
  assert.doesNotMatch(limitRefusal, /primary@example\.com\n/, "the account that just failed is not offered back");

  const beforeOther = rpc.texts().length;
  await rpc.request("session/prompt", {
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "BREAK_OTHER" }],
  });
  const plainRefusal = rpc.texts().slice(beforeOther).join("\n");
  assert.match(plainRefusal, /file not found/, "the real error still shows");
  assert.doesNotMatch(plainRefusal, /Switch account in the model picker/, "a non-limit failure gets no swap hint");

  console.log("PASS explicit accounts default over auto-routing, and a limit names the accounts you can switch to");
} finally {
  rpc.close();
}
