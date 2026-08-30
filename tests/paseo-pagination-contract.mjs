import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../apps/paseo/handlers.server.ts", import.meta.url), "utf8");
const limits = [...source.matchAll(/page:\s*\{\s*limit:\s*(\d+)/g)].map((match) => Number(match[1]));

assert.ok(limits.length > 0, "expected at least one Paseo agent-list page limit");
assert.ok(limits.every((limit) => limit <= 200), `Paseo agent-list page limit exceeds 200: ${limits.join(", ")}`);

console.log("Paseo pagination contract fixture passed");
