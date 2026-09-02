import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

// Every RPC lives under `agent-link.router.*`. Secrets never cross this
// boundary: the API key is reported as `present` + `last4`, the password never.

export const QuotaSchema = z.object({
  label: z.string(),
  used: z.number(),
  total: z.number(),
  remaining: z.number(),
  remainingPercentage: z.number(),
  resetAt: z.string().nullable(),
  unlimited: z.boolean(),
});

export const UsageSchema = z.object({
  plan: z.string().nullable(),
  limitReached: z.boolean(),
  quotas: z.array(QuotaSchema),
});

export const ConnectionSchema = z.object({
  id: z.string(),
  provider: z.string(),
  authType: z.string().nullable(),
  name: z.string(),
  email: z.string().nullable(),
  priority: z.number(),
  isActive: z.boolean(),
  testStatus: z.string().nullable(),
  expiresAt: z.string().nullable(),
  usage: UsageSchema.nullable(),
});

export const CustomModelSchema = z.object({
  providerAlias: z.string(),
  id: z.string(),
  type: z.string(),
  name: z.string().nullable(),
});

export const AliasSchema = z.object({ alias: z.string(), model: z.string() });

/**
 * 9router rewrites the CLIs' own config so every launch of that binary — by
 * Paseo or anyone else — goes through the router. This is the state of that
 * rewrite, read back from 9router rather than guessed.
 */
export const CliHijackSchema = z.object({
  cli: z.enum(["claude", "codex"]),
  installed: z.boolean(),
  routed: z.boolean(),
  configPath: z.string().nullable(),
  baseUrl: z.string().nullable(),
  defaultModels: z.array(z.object({ key: z.string(), value: z.string() })),
});

export const RouterStatusSchema = z.object({
  binary: z.object({ path: z.string().nullable(), version: z.string().nullable() }),
  running: z.boolean(),
  url: z.string(),
  dashboardUrl: z.string(),
  settingsPath: z.string(),
  version: z.object({ current: z.string(), latest: z.string(), hasUpdate: z.boolean() }).nullable(),
  auth: z.object({ configured: z.boolean(), ok: z.boolean(), error: z.string().nullable() }),
  apiKey: z.object({ present: z.boolean(), last4: z.string().nullable() }),
  connections: z.array(ConnectionSchema),
  models: z.object({ count: z.number(), ids: z.array(z.string()), custom: z.array(CustomModelSchema) }),
  aliases: z.array(AliasSchema),
  combos: z.array(z.object({ name: z.string(), models: z.array(z.string()) })),
  hijack: z.array(CliHijackSchema),
  paseo: z.object({
    // Model ids currently listed on Paseo's native providers.
    listedModels: z.object({ claude: z.array(z.string()), codex: z.array(z.string()) }),
    modelsInSync: z.boolean(),
    // Dead entries this plugin used to write and now removes.
    staleProviders: z.array(z.string()),
    staleShims: z.array(z.string()),
  }),
});

export type RouterStatus = z.infer<typeof RouterStatusSchema>;
export type Connection = z.infer<typeof ConnectionSchema>;
export type CustomModel = z.infer<typeof CustomModelSchema>;
export type CliHijack = z.infer<typeof CliHijackSchema>;

export const routerStatus = defineRpc({
  name: "agent-link.router.status",
  input: z.object({}),
  output: RouterStatusSchema,
});

/**
 * Lifecycle for the local server: start it, stop it, or bounce it. A restart
 * is what picks up a change made outside this panel, so it is worth a button
 * rather than a trip to a terminal.
 */
export const routerStart = defineRpc({
  name: "agent-link.router.start",
  input: z.object({ action: z.enum(["start", "stop", "restart"]).optional() }),
  output: z.object({ ok: z.boolean(), running: z.boolean(), message: z.string() }),
});

export const routerSettingsSave = defineRpc({
  name: "agent-link.router.settings.save",
  input: z.object({ url: z.string().optional(), password: z.string().optional() }),
  output: z.object({
    ok: z.boolean(),
    message: z.string(),
    apiKey: z.object({ present: z.boolean(), last4: z.string().nullable() }),
  }),
});

/**
 * Turn the CLI hijack on or off. This rewrites `~/.claude/settings.json` or
 * `~/.codex/config.toml`, so it changes every launch of that binary on the
 * machine — not only the ones Paseo starts.
 */
export const routerRouteCli = defineRpc({
  name: "agent-link.router.route-cli",
  input: z.object({ cli: z.enum(["claude", "codex"]), routed: z.boolean() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** List 9router's models on Paseo's native claude/codex providers. */
export const routerSyncModels = defineRpc({
  name: "agent-link.router.sync-models",
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
    claude: z.number(),
    codex: z.number(),
    removedProviders: z.array(z.string()),
    removedShims: z.array(z.string()),
    message: z.string(),
  }),
});

export const OauthProviderSchema = z.enum(["claude", "codex"]);

export const routerConnectStart = defineRpc({
  name: "agent-link.router.connect.start",
  input: z.object({ provider: OauthProviderSchema }),
  output: z.object({
    provider: OauthProviderSchema,
    mode: z.enum(["paste-code", "poll"]),
    authUrl: z.string(),
    state: z.string(),
    codeVerifier: z.string().nullable(),
    redirectUri: z.string(),
  }),
});

export const routerConnectPoll = defineRpc({
  name: "agent-link.router.connect.poll",
  input: z.object({ provider: OauthProviderSchema, state: z.string() }),
  output: z.object({
    status: z.enum(["pending", "done", "error", "unknown"]),
    error: z.string().nullable(),
  }),
});

export const routerConnectComplete = defineRpc({
  name: "agent-link.router.connect.complete",
  input: z.object({
    provider: OauthProviderSchema,
    code: z.string(),
    state: z.string(),
    codeVerifier: z.string(),
    redirectUri: z.string(),
  }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

export const routerConnectionRemove = defineRpc({
  name: "agent-link.router.connection.remove",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const routerModelExpose = defineRpc({
  name: "agent-link.router.model.expose",
  input: z.object({ providerAlias: z.string(), id: z.string(), name: z.string().optional() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const routerModelUnexpose = defineRpc({
  name: "agent-link.router.model.unexpose",
  input: z.object({ providerAlias: z.string(), id: z.string(), type: z.string().optional() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/**
 * Map a bare model name onto a 9router model, so a request that names
 * `claude-opus-5` reaches the `cc/` account pool instead of 404ing.
 */
export const routerAliasSet = defineRpc({
  name: "agent-link.router.alias.set",
  input: z.object({ alias: z.string(), model: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const routerAliasRemove = defineRpc({
  name: "agent-link.router.alias.remove",
  input: z.object({ alias: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

// ------------------------------------------------------------------ round 2

export const UsageStatsSchema = z.object({
  totalRequests: z.number(),
  totalCost: z.number(),
  totalPromptTokens: z.number(),
  totalCompletionTokens: z.number(),
  totalCachedTokens: z.number(),
  byProvider: z.array(z.object({ provider: z.string(), requests: z.number(), cost: z.number() })),
  byModel: z.array(z.object({ model: z.string(), requests: z.number(), cost: z.number(), lastUsed: z.string().nullable() })),
});

/** An account 9router has parked for a model, with the error that parked it. */
export const HoldSchema = z.object({
  connectionId: z.string(),
  provider: z.string(),
  model: z.string(),
  connectionName: z.string(),
  status: z.string(),
  until: z.string().nullable(),
  lastError: z.string(),
});

export const routerUsageStats = defineRpc({
  name: "agent-link.router.usage-stats",
  input: z.object({}),
  output: UsageStatsSchema,
});

export const routerHolds = defineRpc({
  name: "agent-link.router.holds",
  input: z.object({}),
  output: z.object({ count: z.number(), holds: z.array(HoldSchema) }),
});

export const routerClearHold = defineRpc({
  name: "agent-link.router.clear-hold",
  // `connectionId` is what actually clears a connection parked with
  // testStatus "unavailable"; clearCooldown alone only lifts model locks.
  input: z.object({ provider: z.string(), model: z.string(), connectionId: z.string().optional() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const routerComboCreate = defineRpc({
  name: "agent-link.router.combo.create",
  input: z.object({ name: z.string(), models: z.array(z.string()) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** Reachability of a model id, so the panel can prove the path works. */
export const routerTestModel = defineRpc({
  name: "agent-link.router.test-model",
  input: z.object({ model: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string(), latencyMs: z.number() }),
});

/** 9router's token-saver and routing knobs, the ones worth a switch in Paseo. */
export const TuningSchema = z.object({
  rtkEnabled: z.boolean(),
  cavemanEnabled: z.boolean(),
  cavemanLevel: z.string(),
  ponytailEnabled: z.boolean(),
  ponytailLevel: z.string(),
  headroomEnabled: z.boolean(),
  headroomUrl: z.string(),
  headroomCompressUserMessages: z.boolean(),
  comboStrategy: z.string(),
  stickyRoundRobinLimit: z.number(),
  requireApiKey: z.boolean(),
});

export const routerTuning = defineRpc({
  name: "agent-link.router.tuning",
  input: z.object({}),
  output: TuningSchema,
});

export const routerTuningSet = defineRpc({
  name: "agent-link.router.tuning.set",
  input: z.object({
    rtkEnabled: z.boolean().optional(),
    cavemanEnabled: z.boolean().optional(),
    cavemanLevel: z.string().optional(),
    ponytailEnabled: z.boolean().optional(),
    ponytailLevel: z.string().optional(),
    headroomEnabled: z.boolean().optional(),
    comboStrategy: z.string().optional(),
    stickyRoundRobinLimit: z.number().optional(),
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** 9router's live console, so a failing turn can be read without leaving Paseo. */
export const routerLogs = defineRpc({
  name: "agent-link.router.logs",
  input: z.object({ limit: z.number().optional() }),
  output: z.object({ lines: z.array(z.string()) }),
});

// ------------------------------------------------------------------ round 3

/** An API key as the panel is allowed to see it: identity, never the secret. */
export const ApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  last4: z.string(),
  isActive: z.boolean(),
  createdAt: z.string().nullable(),
});

export const ComboSchema = z.object({
  id: z.string(),
  name: z.string(),
  models: z.array(z.string()),
  kind: z.string().nullable(),
});

export const routerKeys = defineRpc({
  name: "agent-link.router.keys",
  input: z.object({}),
  output: z.object({ keys: z.array(ApiKeySchema) }),
});

export const routerKeyCreate = defineRpc({
  name: "agent-link.router.key.create",
  input: z.object({ name: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string(), last4: z.string().nullable() }),
});

export const routerKeyDelete = defineRpc({
  name: "agent-link.router.key.delete",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** Copy a key's full value to the clipboard, on explicit request only. */
export const routerKeyReveal = defineRpc({
  name: "agent-link.router.key.reveal",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean(), key: z.string().nullable(), message: z.string() }),
});

export const routerCombos = defineRpc({
  name: "agent-link.router.combos",
  input: z.object({}),
  output: z.object({ combos: z.array(ComboSchema) }),
});

export const routerComboSave = defineRpc({
  name: "agent-link.router.combo.save",
  input: z.object({ id: z.string().optional(), name: z.string(), models: z.array(z.string()) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const routerComboDelete = defineRpc({
  name: "agent-link.router.combo.delete",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** Change the dashboard password from here, and keep the saved copy in step. */
export const routerPasswordChange = defineRpc({
  name: "agent-link.router.password.change",
  input: z.object({ currentPassword: z.string(), newPassword: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});
