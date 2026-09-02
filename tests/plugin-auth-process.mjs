#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const plugin = join(repo, "apps", "paseo");
const fixture = mkdtempSync(join(tmpdir(), "agent-link-plugin-auth-"));
const home = join(fixture, "home");
const agentLinkHome = join(fixture, "agent-link");
const bin = join(fixture, "bin");
const compiled = join(fixture, "compiled");
mkdirSync(join(home, ".claude", "output-styles"), { recursive: true });
mkdirSync(join(home, ".codex"), { recursive: true });
mkdirSync(join(agentLinkHome, "state", "pools"), { recursive: true });
mkdirSync(bin, { recursive: true });
writeFileSync(join(home, ".claude", "CLAUDE.md"), "fixture instructions\n");
writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
writeFileSync(join(home, ".claude", "output-styles", "brief.md"), "brief\n");
writeFileSync(join(home, ".codex", "config.toml"), 'cli_auth_credentials_store = "keyring"\n');

writeFileSync(join(bin, "test-shell"), "#!/bin/sh\nprintf %s \"$PATH\"\n", { mode: 0o755 });
writeFileSync(
  join(bin, "claude"),
  `#!/bin/sh
if [ "$1 $2 $3" = "auth status --json" ]; then
  printf '%s\\n' '{"loggedIn":true}'
  exit 0
fi
printf '%s\\n' 'Opening browser to sign in…'
printf '%s\\n' 'If the browser did not open, visit: https://claude.com/cai/oauth/authorize?code=true&state=fixture-state'
printf '%s' 'Paste code here if prompted > '
IFS= read -r response
[ "$response" = 'fresh-code#fixture-state' ] || exit 1
mkdir -p "$CLAUDE_CONFIG_DIR"
printf '%s\\n' '{"oauthAccount":{"emailAddress":"claude@example.com"}}' > "$CLAUDE_CONFIG_DIR/.claude.json"
`,
  { mode: 0o755 },
);

const payload = Buffer.from(JSON.stringify({ email: "codex@example.com" })).toString("base64url");
const wrongPayload = Buffer.from(JSON.stringify({ email: "someone-else@example.com" })).toString("base64url");
writeFileSync(
  join(bin, "codex"),
  `#!/bin/sh
if [ "$1 $2" = "login status" ]; then
  [ -f "$CODEX_HOME/auth.json" ]
  exit $?
fi
printf '\\033[94m%s\\033[0m\\n' 'https://auth.openai.com/codex/device'
printf '%s\\n' 'Enter this one-time code (expires in 15 minutes)'
printf '\\033[94m%s\\033[0m\\n' 'M7DM-4XN6Y'
sleep 1
mkdir -p "$CODEX_HOME"
case "$CODEX_HOME" in
  */wrong@example.com) printf '%s\\n' '{"tokens":{"id_token":"x.${wrongPayload}.x"}}' > "$CODEX_HOME/auth.json" ;;
  */missing@example.com) printf '%s\\n' '{"tokens":{}}' > "$CODEX_HOME/auth.json" ;;
  *) printf '%s\\n' '{"tokens":{"id_token":"x.${payload}.x"}}' > "$CODEX_HOME/auth.json" ;;
esac
`,
  { mode: 0o755 },
);

execFileSync(join(plugin, "node_modules", ".bin", "tsc"), [
  "auth.server.ts",
  "paseo-plugin.d.ts",
  "--outDir", compiled,
  "--module", "commonjs",
  "--moduleResolution", "node",
  "--target", "es2020",
  "--esModuleInterop",
  "--skipLibCheck",
  "--noEmit", "false",
  "--strict", "true",
], { cwd: plugin, stdio: "pipe" });

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "@getpaseo/plugin/server") return { defineRpc: (definition) => definition };
  if (request === "zod") return require(join(plugin, "node_modules", "zod"));
  return originalLoad.call(this, request, parent, isMain);
};

process.env.HOME = home;
process.env.AGENT_LINK_HOME = agentLinkHome;
process.env.PATH = `${bin}${delimiter}/usr/bin${delimiter}/bin`;
process.env.SHELL = join(bin, "test-shell");

const auth = require(join(compiled, "auth.server.js"));

async function waitFor(provider, status, email = null) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const session = auth.handleAccountLoginSessions().sessions.find(
      (entry) => entry.provider === provider && (!email || entry.email === email) && entry.status === status,
    );
    if (session?.status === status) return session;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out waiting for ${provider} ${status}`);
}

try {
  const pools = join(agentLinkHome, "state", "pools");
  const claudeHold = join(pools, "hold-claude-claude@example.com");
  const claudeReason = join(pools, "reason-claude-claude@example.com");
  writeFileSync(claudeHold, "monthly spend limit — probe to release\n");
  writeFileSync(claudeReason, "auto: monthly spend limit\n");
  const claude = await auth.handleAccountLoginStart({ provider: "claude", source: "agent-link", email: "claude@example.com" });
  assert.equal(claude.status, "awaiting_code");
  assert.match(claude.url, /^https:\/\/claude\.com\//);
  assert.equal(claude.userCode, null);
  const submitted = auth.handleAccountLoginSubmit({ sessionId: claude.id, code: "fresh-code#fixture-state" });
  assert.equal(submitted.status, "waiting");
  const claudeDone = await waitFor("claude", "succeeded");
  assert.equal(claudeDone.url, null);
  assert.equal(readFileSync(join(agentLinkHome, "accounts", "claude", "claude@example.com", "CLAUDE.md"), "utf8"), "fixture instructions\n");
  assert.equal(readFileSync(claudeHold, "utf8"), "monthly spend limit — probe to release\n");
  assert.equal(readFileSync(claudeReason, "utf8"), "auto: monthly spend limit\n");

  const codexHold = join(pools, "hold-codex-codex@example.com");
  const codexReason = join(pools, "reason-codex-codex@example.com");
  writeFileSync(codexHold, "authentication failed — login required\n");
  writeFileSync(codexReason, "auto: authentication failed — login required\n");
  const codex = await auth.handleAccountLoginStart({ provider: "codex", source: "agent-link", email: "codex@example.com" });
  assert.equal(codex.status, "waiting");
  assert.equal(codex.url, "https://auth.openai.com/codex/device");
  assert.equal(codex.userCode, "M7DM-4XN6Y");
  const codexDone = await waitFor("codex", "succeeded");
  assert.equal(codexDone.userCode, null);
  assert.match(
    readFileSync(join(agentLinkHome, "accounts", "codex", "codex@example.com", "config.toml"), "utf8"),
    /^cli_auth_credentials_store = "file"/,
  );
  assert.equal(existsSync(codexHold), false);
  assert.equal(existsSync(codexReason), false);

  const wrong = await auth.handleAccountLoginStart({ provider: "codex", source: "agent-link", email: "wrong@example.com" });
  assert.equal(wrong.status, "waiting");
  const wrongDone = await waitFor("codex", "failed", "wrong@example.com");
  assert.match(wrongDone.message, /Signed in as someone-else@example\.com/);

  const missing = await auth.handleAccountLoginStart({ provider: "codex", source: "agent-link", email: "missing@example.com" });
  assert.equal(missing.status, "waiting");
  const missingDone = await waitFor("codex", "failed", "missing@example.com");
  assert.match(missingDone.message, /identity could not be verified/);

  const allAccountText = [join(agentLinkHome, "accounts"), home]
    .flatMap((root) => readdirSync(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");
  assert.doesNotMatch(allAccountText, /fresh-code#fixture-state/);
  console.log("PASS live plugin auth processes, isolation, identity checks and ephemeral code forwarding");
} finally {
  Module._load = originalLoad;
  rmSync(fixture, { recursive: true, force: true });
}
