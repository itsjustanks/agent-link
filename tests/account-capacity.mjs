#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  accountIdentity,
  claudeCachedQuotaFromConfig,
  groupAccountQuotaBindings,
  mergePoolQuotas,
  normalizeAccountEmail,
  poolQuotaFromRaw,
} from "../apps/paseo/account-capacity.logic.ts";

assert.equal(normalizeAccountEmail("  Person@iCloud.Com "), "person@icloud.com");
assert.equal(accountIdentity("claude", "Person@iCloud.Com"), "claude:person@icloud.com");

const creditsOnly = poolQuotaFromRaw("claude", {
  at: 100,
  credits: { has_credits: true, unlimited: false, balance: "12.50" },
});
assert.equal(creditsOnly?.credits?.balance, "12.50");
assert.deepEqual(creditsOnly?.windows, []);

const extraOnly = poolQuotaFromRaw("claude", {
  at: 200,
  extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 4, currency: "aud" },
});
assert.equal(extraOnly?.extraUsage?.enabled, true);
assert.equal(extraOnly?.extraUsage?.limit, 50);

const olderExtra = poolQuotaFromRaw("claude", {
  at: 300,
  extra_usage: { is_enabled: true, balance: 20, currency: "aud" },
});
const newerWindows = poolQuotaFromRaw("claude", {
  at: 400,
  five_hour: { pct: 35, resets_at: 500 },
});
const merged = mergePoolQuotas(olderExtra, newerWindows);
assert.equal(merged?.at, 400);
assert.equal(merged?.windows[0]?.pct, 35);
assert.equal(merged?.extraUsage?.balance, 20);

const conflict = claudeCachedQuotaFromConfig({
  oauthAccount: { hasExtraUsageEnabled: true },
  cachedUsageUtilization: {
    fetchedAtMs: 500_000,
    utilization: {
      five_hour: { utilization: 10, resets_at: "2026-09-01T01:00:00Z" },
      extra_usage: { is_enabled: false },
      spend: { enabled: false },
    },
  },
});
assert.equal(conflict?.extraUsage?.accountEnabled, true);
assert.equal(conflict?.extraUsage?.enabled, false);

const entitlementOnly = claudeCachedQuotaFromConfig({ oauthAccount: { hasExtraUsageEnabled: true } });
assert.equal(entitlementOnly?.extraUsage?.accountEnabled, true);
assert.deepEqual(entitlementOnly?.windows, []);

const observedSpend = poolQuotaFromRaw("claude", {
  at: 600,
  spend: {
    enabled: true,
    used: { amount_minor: 1250, exponent: 2, currency: "aud" },
    limit: { amount_minor: 5000, exponent: 2, currency: "aud" },
  },
});
const newerEntitlementOnly = claudeCachedQuotaFromConfig({
  oauthAccount: { hasExtraUsageEnabled: true },
  cachedUsageUtilization: { fetchedAtMs: 700_000 },
});
const retainedSpend = mergePoolQuotas(observedSpend, newerEntitlementOnly);
assert.equal(retainedSpend?.extraUsage?.accountEnabled, true);
assert.equal(retainedSpend?.extraUsage?.enabled, true);
assert.equal(retainedSpend?.extraUsage?.used, 12.5);
assert.equal(retainedSpend?.extraUsage?.limit, 50);
assert.equal(retainedSpend?.extraUsage?.currency, "AUD");

const grouped = groupAccountQuotaBindings([
  { provider: "claude", email: "Person@iCloud.com", poolKey: "secondary", isPrimary: false, quota: olderExtra },
  { provider: "claude", email: "person@icloud.com", poolKey: "primary", isPrimary: true, quota: newerWindows },
]);
assert.equal(grouped.length, 1);
assert.equal(grouped[0]?.accountId, "claude:person@icloud.com");
assert.equal(grouped[0]?.representative.poolKey, "primary");
assert.equal(grouped[0]?.quota?.windows[0]?.pct, 35);
assert.equal(grouped[0]?.quota?.extraUsage?.balance, 20);

console.log("PASS canonical accounts and independent plan/extra-usage telemetry");
