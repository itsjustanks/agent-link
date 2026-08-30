#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "agent-link-acp-test-"));
const home = join(root, "home");
const agentLinkHome = join(root, "agent-link");
const bin = join(root, "bin");
const workspace = join(root, "workspace");
const invocationLog = join(root, "invocations.jsonl");
const acpInvocationLog = join(root, "acp-invocations.jsonl");
for (const path of [home, agentLinkHome, bin, workspace, join(home, ".codex"), join(home, ".paseo"), join(home, ".agents", "skills", "test-skill"), join(agentLinkHome, "router")]) mkdirSync(path, { recursive: true });

writeFileSync(join(home, ".agents", "skills", "test-skill", "SKILL.md"), "---\nname: test-skill\n---\n\nFollow the test skill.\n");

writeFileSync(join(home, ".claude.json"), JSON.stringify({
  oauthAccount: { emailAddress: "claude@example.com" },
  projects: {},
}));

function jwt(email) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ email })}.signature`;
}

writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: jwt("codex@example.com") } }));

const fakeProvider = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
const provider = basename(process.argv[1]);
const args = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
appendFileSync(process.env.FAKE_PROVIDER_LOG, JSON.stringify({ provider, args, input }) + "\\n");
if (input.includes("SLOW_TURN")) await new Promise((resolve) => setTimeout(resolve, 10_000));
const valueAfter = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : ""; };
const model = valueAfter("--model") || valueAfter("-m");
if (provider === "claude") {
  const sessionId = valueAfter("--resume") || valueAfter("--session-id") || "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\\n");
  const bridged = input.includes("CODEX(") ? "BRIDGED" : "DIRECT";
  const text = "CLAUDE(" + model + ") " + bridged;
  process.stdout.write(JSON.stringify({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", session_id: sessionId, is_error: false, result: text }) + "\\n");
} else {
  const resumeIndex = args.indexOf("resume");
  const resumed = resumeIndex >= 0 ? args[resumeIndex + 1] : "";
  const sessionId = resumed || "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: sessionId }) + "\\n");
  const bridged = input.includes("CLAUDE(") ? "BRIDGED" : "DIRECT";
  const text = "CODEX(" + model + ") " + bridged;
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "answer", type: "agent_message", text } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
}
`;

for (const provider of ["claude", "codex"]) {
  const path = join(bin, provider);
  writeFileSync(path, fakeProvider, { mode: 0o755 });
}

const fakeAcpPath = join(bin, "fake-kimi-acp");
writeFileSync(fakeAcpPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
let model = "kimi-default";
let mode = "auto";
const limitedModes = process.argv.includes("--limited-modes");
const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const models = () => ({ currentModelId: model, availableModels: [{ modelId: "kimi-k3", name: "Kimi K3", description: "fake connected ACP" }] });
const configOptions = () => [{ id: "model", category: "model", type: "select", currentValue: model, options: [
  { value: "kimi-default", name: "Kimi Default" },
  { value: "kimi-k3", name: "Kimi K3" },
] }];
const modes = () => ({ currentModeId: mode, availableModes: [{ id: "auto", name: "Auto" }, { id: "plan", name: "Plan" }, ...(limitedModes ? [] : [{ id: "yolo", name: "YOLO" }])] });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(message) + "\\n");
  if (message.id === undefined) return;
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } }, authMethods: [] } });
  else if (["session/new", "session/load", "session/resume"].includes(message.method)) send({ id: message.id, result: { sessionId, models: models(), configOptions: configOptions(), modes: modes() } });
  else if (message.method === "session/set_config_option") { model = message.params.value; send({ id: message.id, result: { configOptions: configOptions() } }); }
  else if (message.method === "session/set_model") send({ id: message.id, error: { code: -32601, message: "model changes require config options" } });
  else if (message.method === "session/set_mode") { mode = message.params.modeId; send({ id: message.id, result: {} }); }
  else if (message.method === "session/prompt") {
    const input = message.params.prompt.map((block) => block.text || "").join("\\n");
    const text = "KIMI(" + model + ") " + (/CLAUDE\\(|CODEX\\(/.test(input) ? "BRIDGED" : "DIRECT");
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
    send({ id: message.id, result: { stopReason: "end_turn" } });
  } else send({ id: message.id, result: {} });
});
`, { mode: 0o755 });

writeFileSync(join(home, ".paseo", "config.json"), JSON.stringify({
  agents: {
    providers: {
      kimi: { extends: "acp", label: "Kimi", command: [fakeAcpPath] },
      grok: { extends: "acp", label: "Grok", command: [fakeAcpPath, "--limited-modes"] },
      "agent-link": { extends: "acp", label: "AgentLink", command: [join(repo, "agent-link-acp.mjs")] },
    },
  },
}));

writeFileSync(join(agentLinkHome, "router", "config.json"), JSON.stringify({
  targetGroups: [{
    name: "fast",
    purpose: "Explanations and summaries",
    skills: ["test-skill"],
    instructions: "WORK_TYPE_MAGIC",
    targets: [
      { provider: "grok", account: "provider", model: "kimi-k3", mode: "full-access" },
      { provider: "codex", account: "auto", model: "gpt-5.6-sol", mode: "full-access" },
    ],
  }],
}));

class RpcClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.child = spawn(process.execPath, [join(repo, "agent-link-acp.mjs")], {
      cwd: repo,
      env: {
        ...process.env,
        HOME: home,
        AGENT_LINK_HOME: agentLinkHome,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        FAKE_PROVIDER_LOG: invocationLog,
        FAKE_ACP_LOG: acpInvocationLog,
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else {
        this.notifications.push(message);
      }
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const result = new Promise((resolvePromise, reject) => this.pending.set(id, { resolve: resolvePromise, reject }));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return result;
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  updatesSince(index) {
    return this.notifications.slice(index).filter((entry) => entry.method === "session/update");
  }

  close() {
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }
}

const rpc = new RpcClient();
try {
  const initialized = await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(initialized.protocolVersion, 1);
  assert.equal(initialized.agentInfo.name, "AgentLink");
  assert.equal(initialized.agentCapabilities.loadSession, true);

  const created = await rpc.request("session/new", { cwd: workspace, mcpServers: [] });
  const sessionId = created.sessionId;
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(created.modes.availableModes.map((mode) => mode.id), ["plan", "auto", "full-access"]);
  const beforeFirstTurn = await rpc.request("session/list", { cwd: workspace });
  assert.equal(beforeFirstTurn.sessions.length, 0, "zero-turn diagnostic sessions must not appear in history");
  const byName = new Map(created.models.availableModels.map((model) => [model.name, model.modelId]));
  const fable = byName.get("Claude Fable 5 · claude@example.com");
  const opus = byName.get("Claude Opus 5 · claude@example.com");
  const sol = byName.get("GPT-5.6 Sol · codex@example.com");
  const kimi = byName.get("Kimi K3 · Kimi");
  const limited = byName.get("Kimi K3 · Grok");
  const router = byName.get("AgentRouter · Automatic route");
  assert.ok(
    fable && opus && sol && kimi && limited && router,
    `automatic, account-suffixed and connected ACP model profiles should be advertised: ${JSON.stringify([...byName.keys()])}`,
  );

  await rpc.request("session/set_model", { sessionId, modelId: fable });
  let notificationStart = rpc.notifications.length;
  const first = await rpc.request("session/prompt", {
    sessionId,
    messageId: "11111111-1111-4111-8111-111111111111",
    prompt: [{ type: "text", text: "First turn" }],
  });
  assert.equal(first.stopReason, "end_turn");
  assert.ok(rpc.updatesSince(notificationStart).some((entry) => entry.params.update.content?.text === "CLAUDE(claude-fable-5) DIRECT"));
  const afterFirstTurn = await rpc.request("session/list", { cwd: workspace });
  assert.deepEqual(afterFirstTurn.sessions.map((entry) => entry.sessionId), [sessionId]);

  await rpc.request("session/set_model", { sessionId, modelId: sol });
  notificationStart = rpc.notifications.length;
  const second = await rpc.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Second turn" }],
  });
  assert.equal(second.stopReason, "end_turn");
  assert.ok(rpc.updatesSince(notificationStart).some((entry) => entry.params.update.content?.text === "CODEX(gpt-5.6-sol) BRIDGED"));

  await rpc.request("session/set_model", { sessionId, modelId: kimi });
  notificationStart = rpc.notifications.length;
  const third = await rpc.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Third turn" }],
  });
  assert.equal(third.stopReason, "end_turn");
  assert.ok(rpc.updatesSince(notificationStart).some((entry) => entry.params.update.content?.text === "KIMI(kimi-k3) BRIDGED"));
  assert.ok(
    readFileSync(acpInvocationLog, "utf8").split("\n").some((line) => line.includes('"method":"session/set_config_option"')),
    "connected ACP models exposed as config options should switch in the same child session",
  );

  await rpc.request("session/set_model", { sessionId, modelId: opus });
  notificationStart = rpc.notifications.length;
  const fourth = await rpc.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Fourth turn" }],
  });
  assert.equal(fourth.stopReason, "end_turn");
  assert.ok(rpc.updatesSince(notificationStart).some((entry) => entry.params.update.content?.text === "CLAUDE(claude-opus-5) BRIDGED"));

  const invocations = readFileSync(invocationLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(invocations.length, 3);
  assert.deepEqual(invocations.map((entry) => entry.provider), ["claude", "codex", "claude"]);
  assert.ok(
    invocations.filter((entry) => entry.provider === "codex").every((entry) =>
      !(entry.args.includes("--approve-for-me") && entry.args.includes("-s")),
    ),
    "Codex automatic review and explicit sandbox flags are mutually exclusive",
  );
  assert.deepEqual(invocations[0].args.slice(invocations[0].args.indexOf("--permission-mode"), invocations[0].args.indexOf("--permission-mode") + 2), ["--permission-mode", "auto"]);
  assert.ok(invocations[0].input.includes("read ~/.agents/skills/paseo/SKILL.md completely"));
  assert.ok(invocations[0].input.includes("use Paseo create_agent"));
  assert.ok(invocations[0].input.includes("Omit workspaceId so the child stays attached to this parent in the current workspace"));
  assert.ok(invocations[0].input.includes("Never create a workspace merely to delegate, retry, continue, investigate, or switch model/provider/account"));
  assert.ok(invocations[1].args.includes("--approve-for-me"));
  assert.ok(invocations[2].args.includes("--resume"), "switching model on one account should resume its native session");
  assert.ok(invocations[2].input.includes("KIMI(kimi-k3) BRIDGED"), "missed connected-provider turns should be bridged back");

  const stored = JSON.parse(readFileSync(join(agentLinkHome, "state", "acp", "sessions", `${sessionId}.json`), "utf8"));
  assert.equal(stored.id, sessionId);
  assert.equal(stored.transcript.length, 8);
  assert.equal(Object.keys(stored.backends).length, 3);

  notificationStart = rpc.notifications.length;
  const loaded = await rpc.request("session/load", { sessionId, cwd: workspace, mcpServers: [] });
  assert.equal(loaded.models.currentModelId, opus);
  assert.equal(rpc.updatesSince(notificationStart).length, 8, "loading should replay one logical transcript");

  await rpc.request("session/set_mode", { sessionId, modeId: "full-access" });
  await rpc.request("session/set_model", { sessionId, modelId: fable });
  await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Claude full access" }] });
  let modeInvocation = readFileSync(invocationLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
  assert.deepEqual(modeInvocation.args.slice(modeInvocation.args.indexOf("--permission-mode"), modeInvocation.args.indexOf("--permission-mode") + 2), ["--permission-mode", "bypassPermissions"]);
  assert.ok(modeInvocation.args.includes("--resume"), "changing mode should retain the Claude backend session");

  await rpc.request("session/set_model", { sessionId, modelId: sol });
  await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Codex full access" }] });
  modeInvocation = readFileSync(invocationLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
  assert.ok(modeInvocation.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(modeInvocation.args.includes("resume"), "changing mode should retain the Codex backend session");

  await rpc.request("session/set_model", { sessionId, modelId: kimi });
  await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Kimi full access" }] });
  assert.ok(readFileSync(acpInvocationLog, "utf8").split("\n").some((line) => line.includes('"method":"session/set_mode"') && line.includes('"modeId":"yolo"')));
  await rpc.request("session/set_model", { sessionId, modelId: limited });
  notificationStart = rpc.notifications.length;
  const unsupportedFullAccess = await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Unsupported full access" }] });
  assert.equal(unsupportedFullAccess.stopReason, "refusal");
  assert.ok(rpc.updatesSince(notificationStart).some((entry) => entry.params.update.content?.text?.includes("does not expose a compatible Full access mode")));
  await rpc.request("session/set_mode", { sessionId, modeId: "plan" });
  await rpc.request("session/set_model", { sessionId, modelId: fable });
  await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Claude plan" }] });
  modeInvocation = readFileSync(invocationLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
  assert.deepEqual(modeInvocation.args.slice(modeInvocation.args.indexOf("--permission-mode"), modeInvocation.args.indexOf("--permission-mode") + 2), ["--permission-mode", "plan"]);
  await rpc.request("session/set_model", { sessionId, modelId: sol });
  await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Codex plan" }] });
  modeInvocation = readFileSync(invocationLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
  assert.ok(modeInvocation.args.includes("-s") && modeInvocation.args.includes("read-only"));
  assert.ok(!modeInvocation.args.includes("--approve-for-me"));
  await rpc.request("session/set_model", { sessionId, modelId: kimi });
  await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Kimi plan" }] });
  assert.ok(readFileSync(acpInvocationLog, "utf8").split("\n").some((line) => line.includes('"method":"session/set_mode"') && line.includes('"modeId":"plan"')));
  await rpc.request("session/set_mode", { sessionId, modeId: "auto" });

  const pools = join(agentLinkHome, "state", "pools");
  mkdirSync(pools, { recursive: true });
  writeFileSync(join(pools, "hold-claude-primary"), "test hold\n");
  await rpc.request("session/set_model", { sessionId, modelId: fable });
  const refused = await rpc.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "PRESERVE_REFUSED_REQUEST" }],
  });
  assert.equal(refused.stopReason, "refusal");
  unlinkSync(join(pools, "hold-claude-primary"));
  await rpc.request("session/set_model", { sessionId, modelId: sol });
  await rpc.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "After refusal" }],
  });
  const afterRefusal = readFileSync(invocationLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
  assert.ok(afterRefusal.input.includes("PRESERVE_REFUSED_REQUEST"), "a refused turn must remain in canonical history after switching models");

  await rpc.request("session/set_model", { sessionId, modelId: router });
  notificationStart = rpc.notifications.length;
  const routed = await rpc.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Give me a quick summary" }],
  });
  assert.equal(routed.stopReason, "end_turn");
  assert.ok(rpc.updatesSince(notificationStart).some((entry) => entry.params.update.content?.text?.includes("CODEX(gpt-5.6-sol)")));
  const routedInvocation = readFileSync(invocationLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
  assert.ok(routedInvocation.args.includes("--dangerously-bypass-approvals-and-sandbox"), "a route target can override the chat mode");
  assert.ok(routedInvocation.input.includes("WORK_TYPE_MAGIC"));
  assert.ok(routedInvocation.input.includes(join(home, ".agents", "skills", "test-skill", "SKILL.md")));
  const routedStored = JSON.parse(readFileSync(join(agentLinkHome, "state", "acp", "sessions", `${sessionId}.json`), "utf8"));
  assert.equal(routedStored.currentModelId, router);
  assert.match(routedStored.transcript.at(-1).profile, /^AgentRouter → GPT-5\.6 Sol/);

  await rpc.request("session/set_model", { sessionId, modelId: sol });
  const slowPrompt = rpc.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "SLOW_TURN" }],
  });
  await delay(150);
  rpc.notify("session/cancel", { sessionId });
  assert.equal((await slowPrompt).stopReason, "cancelled");

  const listed = await rpc.request("session/list", { cwd: workspace });
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].sessionId, sessionId);

  console.log("PASS agent-link ACP keeps one session while switching provider, account and model");
} finally {
  rpc.close();
}
