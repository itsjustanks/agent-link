#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  accountCoveredByManagedBinding,
  dedupeRouteCandidates,
} from "../apps/paseo/account-routing.logic.ts";

const base = {
  email: "Person@iCloud.com",
  last: 50,
  preference: "standard",
  nearing: false,
};

assert.equal(
  dedupeRouteCandidates("claude", [
    { ...base, poolKey: "z-secondary", preference: "reserve", last: 100 },
    { ...base, email: "person@icloud.com", poolKey: "a-secondary", preference: "preferred", last: 200 },
  ])[0]?.poolKey,
  "a-secondary",
);

assert.equal(
  dedupeRouteCandidates("claude", [
    { ...base, poolKey: "secondary", nearing: true },
    { ...base, poolKey: "primary" },
  ])[0]?.poolKey,
  "primary",
);

assert.equal(
  accountCoveredByManagedBinding("claude", "Person@iCloud.com", [
    { provider: "claude", email: "person@icloud.com" },
    { provider: "codex", email: "person@icloud.com" },
  ]),
  true,
);
assert.equal(
  accountCoveredByManagedBinding("claude", "other@example.com", [
    { provider: "claude", email: "person@icloud.com" },
  ]),
  false,
);

console.log("PASS duplicate account bindings route deterministically");
