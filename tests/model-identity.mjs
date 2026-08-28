import assert from "node:assert/strict";
import { friendlyModelName, resolveRuntimeModel, UNKNOWN_MODEL } from "../apps/paseo/model.shared.ts";

assert.deepEqual(resolveRuntimeModel("codex-auto/gpt-5.6-sol", null), {
  provider: "codex-auto",
  model: "gpt-5.6-sol",
});
assert.deepEqual(resolveRuntimeModel("kimi", "kimi-code/k3"), {
  provider: "kimi",
  model: "kimi-code/k3",
});
assert.deepEqual(resolveRuntimeModel("custom", null), {
  provider: "custom",
  model: UNKNOWN_MODEL,
});
assert.equal(friendlyModelName("gpt-5.6-sol"), "GPT-5.6 Sol");
assert.equal(friendlyModelName("vendor/private-model"), "vendor/private-model");

console.log("model identity fixture passed");
