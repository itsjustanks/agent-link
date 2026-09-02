#!/usr/bin/env node
// Unit tests for the plugin's pure logic. Node 26 runs TypeScript directly, so
// the module is imported as-is — but Node ESM wants the extension that Paseo's
// bundler forbids, so the source is copied to a temp file with the specifier
// rewritten. Same trick the other tests in this repo use.
//
// Run: node tests/router-logic.mjs

import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const staging = mkdtempSync(join(tmpdir(), "agent-link-tests-"));
copyFileSync(join(here, "..", "apps", "paseo", "router.logic.ts"), join(staging, "router.logic.ts"));

const {
  cliForModel,
  cookieHeader,
  formatReset,
  groupModelIds,
  isLegacyShim,
  last4,
  modelLabel,
  normalizeUsage,
  parseOauthPaste,
  providerLabel,
  quotaTone,
  sameModelSet,
  DEAD_PROVIDER_IDS,
} = await import(join(staging, "router.logic.ts"));

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
};

check("cliForModel keeps foreign pools out of the native pickers", () => {
  assert.equal(cliForModel("cc/claude-opus-5"), "claude");
  assert.equal(cliForModel("cx/gpt-5.6-sol"), "codex");
  // The bug this guards: "not cx/" once meant Claude, which put 214 Cursor
  // models and 10 Kimi models in Paseo's Claude picker.
  assert.equal(cliForModel("cu/claude-4.6-opus-max"), "other");
  assert.equal(cliForModel("kimi/kimi-k2.5"), "other");
  assert.equal(cliForModel("my-combo"), "other");
});

check("normalizeUsage flattens both providers' quota shapes", () => {
  const claude = normalizeUsage({
    plan: "Claude Code",
    quotas: {
      "session (5h)": { used: 0, total: 100, remaining: 100, remainingPercentage: 100, resetAt: null },
      "weekly (7d)": { used: 31, total: 100, remaining: 69, remainingPercentage: 69, resetAt: "2026-09-02T11:59:59Z" },
    },
  });
  assert.equal(claude.plan, "Claude Code");
  assert.equal(claude.quotas.length, 2);
  assert.equal(claude.quotas[1].label, "weekly (7d)");
  assert.equal(claude.quotas[1].remaining, 69);

  const codex = normalizeUsage({
    plan: "pro",
    limitReached: false,
    quotas: { session: { used: 5, total: 100, remaining: 95, resetAt: "2026-09-08T02:11:13Z" } },
  });
  assert.equal(codex.plan, "pro");
  assert.equal(codex.quotas[0].label, "session");
  // remainingPercentage is absent on Codex and must be derived, not defaulted.
  assert.equal(codex.quotas[0].remainingPercentage, 95);

  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({ nonsense: true })?.quotas.length ?? 0, 0);
});

check("quotaTone escalates as a window drains", () => {
  const at = (remainingPercentage) => quotaTone({ remainingPercentage, unlimited: false });
  assert.equal(at(90), "success");
  assert.equal(at(15), "warning");
  assert.equal(at(2), "danger");
  assert.equal(quotaTone({ remainingPercentage: 0, unlimited: true }), "neutral");
});

check("groupModelIds groups by pool and keeps every id", () => {
  const groups = groupModelIds(["cc/a", "cx/b", "cc/c", "kimi/d"]);
  const byPrefix = Object.fromEntries(groups.map((group) => [group.prefix, group.ids.length]));
  assert.equal(byPrefix.cc, 2);
  assert.equal(byPrefix.cx, 1);
  assert.equal(groups.reduce((total, group) => total + group.ids.length, 0), 4);
});

check("modelLabel reads as a name, not an id", () => {
  assert.equal(modelLabel("cc/claude-opus-5"), "9Router · Claude Opus 5");
  assert.match(modelLabel("cx/gpt-5.6-sol"), /^9Router · GPT 5\.6 Sol$/);
});

check("sameModelSet ignores order", () => {
  assert.ok(sameModelSet(["a", "b"], ["b", "a"]));
  assert.ok(!sameModelSet(["a"], ["a", "b"]));
  assert.ok(sameModelSet([], []));
});

check("isLegacyShim matches the retired launchers and nothing else", () => {
  for (const name of ["agent-link-acp", "claude-auto", "codex-auto", "agent-router", "claude", "codex", "claude-3", "codex-12"]) {
    assert.ok(isLegacyShim(name), `${name} should be retired`);
  }
  for (const name of ["9router", "agent-link", "claude-quota-helper"]) {
    assert.ok(!isLegacyShim(name), `${name} should be left alone`);
  }
  // The ACP provider entry is dead too, now that 9router rewrites the CLIs.
  assert.ok(DEAD_PROVIDER_IDS.includes("agent-link"));
});

check("last4 never reveals a key", () => {
  assert.equal(last4("sk-0000000000000000-example-000000ab"), "00ab");
  assert.equal(last4(null), null);
  assert.equal(last4(""), null);
});

check("cookieHeader folds Set-Cookie into one request header", () => {
  const header = cookieHeader([
    "auth=abc; Path=/; HttpOnly; SameSite=Lax",
    "other=def; Path=/",
  ]);
  assert.equal(header, "auth=abc; other=def");
  assert.equal(cookieHeader([]), "");
});

check("parseOauthPaste takes a bare code or a whole callback URL", () => {
  assert.deepEqual(parseOauthPaste("  abc123  "), { code: "abc123", state: null });
  assert.deepEqual(parseOauthPaste("http://localhost:8080/callback?code=xyz&state=st1"), {
    code: "xyz",
    state: "st1",
  });
  // Claude's own page shows `code#state`.
  assert.deepEqual(parseOauthPaste("xyz#st1"), { code: "xyz", state: "st1" });
  assert.equal(parseOauthPaste(""), null);
});

check("providerLabel names the pools a human recognises", () => {
  assert.equal(providerLabel("claude"), "Claude Code");
  assert.equal(providerLabel("codex"), "Codex");
  assert.equal(providerLabel("kimi"), "Kimi");
});

check("formatReset says when, or nothing", () => {
  const now = Date.parse("2026-09-02T10:00:00Z");
  assert.match(formatReset("2026-09-02T12:00:00Z", now), /2h/);
  assert.equal(formatReset(null, now), "");
  // A window whose reset has passed reads as due, not as a negative countdown.
  assert.equal(formatReset("2026-09-02T09:00:00Z", now), "resets now");
});

rmSync(staging, { recursive: true, force: true });

if (process.exitCode) {
  console.error(`\n${passed} passed, some failed.`);
} else {
  console.log(`✓ ${passed} checks passed`);
}
