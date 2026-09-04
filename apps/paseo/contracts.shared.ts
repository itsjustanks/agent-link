import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

// Every RPC lives under `agent-link-9router.router.*`. Secrets never cross this
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

/**
 * Spend-limit state, which is separate from the plan quotas above and can block
 * an account on its own.
 *
 * This mattered on 2026-09-04: an account read 86% on both plan meters — real
 * headroom — while `spendLimitReached` was true and every request failed. A
 * panel showing only the quota bars says "you have room" and is wrong, so the
 * spend side is reported next to them rather than left in the dashboard.
 */
export const ExtraUsageSchema = z.object({
  enabled: z.boolean(),
  spendLimitReached: z.boolean(),
  usedCredits: z.number().nullable(),
  monthlyLimit: z.number().nullable(),
  utilization: z.number().nullable(),
  currency: z.string().nullable(),
  /** 9router's own words for why extra usage is off, when it says. */
  disabledReason: z.string().nullable(),
});

export const UsageSchema = z.object({
  plan: z.string().nullable(),
  limitReached: z.boolean(),
  quotas: z.array(QuotaSchema),
  extra: ExtraUsageSchema.nullable(),
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
  // 9router routes far more than Claude and Codex; the panel discovers the
  // list from the router rather than hardcoding two.
  cli: z.string(),
  installed: z.boolean(),
  routed: z.boolean(),
  label: z.string(),
  configPath: z.string().nullable(),
  baseUrl: z.string().nullable(),
  supported: z.boolean(),
  note: z.string(),
  defaultModels: z.array(z.object({ key: z.string(), value: z.string() })),
});

/**
 * 9router sends its own hardcoded `claude-cli/<version>` User-Agent rather than
 * the one you have installed. When Anthropic gates a model behind a newer
 * client, every account 400s until 9router ships a bump — and it parks them
 * for the trouble. Detecting the mismatch turns a cryptic error into a fact.
 */
export const ClientVersionSchema = z.object({
  installed: z.string().nullable(),
  advertised: z.string().nullable(),
  mismatch: z.boolean(),
});

/**
 * Uptime for the local 9router process, read from the process table rather
 * than 9router's API: /api/health returns only {ok:true} and everything
 * richer is behind the dashboard cookie, so this keeps working in exactly
 * the degraded states worth reporting on.
 */
export const UptimeSchema = z.object({
  running: z.boolean(),
  pid: z.number().nullable(),
  uptimeSeconds: z.number().nullable(),
  startedAt: z.string().nullable(),
  rssMb: z.number().nullable(),
  lastSeenAt: z.string().nullable(),
  previousRunSeconds: z.number().nullable(),
  restartsToday: z.number(),
  history: z.array(
    z.object({ startedAt: z.string(), endedAt: z.string().nullable(), pid: z.number() }),
  ),
});

export type Uptime = z.infer<typeof UptimeSchema>;

/** Known-problem checks for the Claude Code -> 9router path. */
export const WarningSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  severity: z.enum(["warning", "danger"]),
});

export type RouterWarning = z.infer<typeof WarningSchema>;

export const RouterStatusSchema = z.object({
  clientVersion: ClientVersionSchema,
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
  uptime: UptimeSchema,
  warnings: z.array(WarningSchema),
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
  name: "agent-link-9router.router.status",
  input: z.object({}),
  output: RouterStatusSchema,
});

/**
 * Lifecycle for the local server: start it, stop it, or bounce it. A restart
 * is what picks up a change made outside this panel, so it is worth a button
 * rather than a trip to a terminal.
 */
export const routerStart = defineRpc({
  name: "agent-link-9router.router.start",
  input: z.object({ action: z.enum(["start", "stop", "restart"]).optional() }),
  output: z.object({ ok: z.boolean(), running: z.boolean(), message: z.string() }),
});

export const routerSettingsSave = defineRpc({
  name: "agent-link-9router.router.settings.save",
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
  name: "agent-link-9router.router.route-cli",
  input: z.object({ cli: z.string(), routed: z.boolean() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** List 9router's models on Paseo's native claude/codex providers. */
export const routerSyncModels = defineRpc({
  name: "agent-link-9router.router.sync-models",
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
  name: "agent-link-9router.router.connect.start",
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
  name: "agent-link-9router.router.connect.poll",
  input: z.object({ provider: OauthProviderSchema, state: z.string() }),
  output: z.object({
    status: z.enum(["pending", "done", "error", "unknown"]),
    error: z.string().nullable(),
  }),
});

export const routerConnectComplete = defineRpc({
  name: "agent-link-9router.router.connect.complete",
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
  name: "agent-link-9router.router.connection.remove",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const routerModelExpose = defineRpc({
  name: "agent-link-9router.router.model.expose",
  input: z.object({ providerAlias: z.string(), id: z.string(), name: z.string().optional() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const routerModelUnexpose = defineRpc({
  name: "agent-link-9router.router.model.unexpose",
  input: z.object({ providerAlias: z.string(), id: z.string(), type: z.string().optional() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/**
 * Map a bare model name onto a 9router model, so a request that names
 * `claude-opus-5` reaches the `cc/` account pool instead of 404ing.
 */
export const routerAliasSet = defineRpc({
  name: "agent-link-9router.router.alias.set",
  input: z.object({ alias: z.string(), model: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const routerAliasRemove = defineRpc({
  name: "agent-link-9router.router.alias.remove",
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
  name: "agent-link-9router.router.usage-stats",
  input: z.object({}),
  output: UsageStatsSchema,
});

export const routerHolds = defineRpc({
  name: "agent-link-9router.router.holds",
  input: z.object({}),
  output: z.object({ count: z.number(), holds: z.array(HoldSchema) }),
});

export const routerClearHold = defineRpc({
  name: "agent-link-9router.router.clear-hold",
  // `connectionId` is what actually clears a connection parked with
  // testStatus "unavailable"; clearCooldown alone only lifts model locks.
  input: z.object({ provider: z.string(), model: z.string(), connectionId: z.string().optional() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const routerComboCreate = defineRpc({
  name: "agent-link-9router.router.combo.create",
  input: z.object({ name: z.string(), models: z.array(z.string()) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** Reachability of a model id, so the panel can prove the path works. */
export const routerTestModel = defineRpc({
  name: "agent-link-9router.router.test-model",
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
  name: "agent-link-9router.router.tuning",
  input: z.object({}),
  output: TuningSchema,
});

export const routerTuningSet = defineRpc({
  name: "agent-link-9router.router.tuning.set",
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
  name: "agent-link-9router.router.logs",
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
  name: "agent-link-9router.router.keys",
  input: z.object({}),
  output: z.object({ keys: z.array(ApiKeySchema) }),
});

export const routerKeyCreate = defineRpc({
  name: "agent-link-9router.router.key.create",
  input: z.object({ name: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string(), last4: z.string().nullable() }),
});

export const routerKeyDelete = defineRpc({
  name: "agent-link-9router.router.key.delete",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** Copy a key's full value to the clipboard, on explicit request only. */
export const routerKeyReveal = defineRpc({
  name: "agent-link-9router.router.key.reveal",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean(), key: z.string().nullable(), message: z.string() }),
});

export const routerCombos = defineRpc({
  name: "agent-link-9router.router.combos",
  input: z.object({}),
  output: z.object({ combos: z.array(ComboSchema) }),
});

export const routerComboSave = defineRpc({
  name: "agent-link-9router.router.combo.save",
  input: z.object({ id: z.string().optional(), name: z.string(), models: z.array(z.string()) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const routerComboDelete = defineRpc({
  name: "agent-link-9router.router.combo.delete",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** Change the dashboard password from here, and keep the saved copy in step. */
export const routerPasswordChange = defineRpc({
  name: "agent-link-9router.router.password.change",
  input: z.object({ currentPassword: z.string(), newPassword: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

// ----------------------------------------------------------------- power-ups

/**
 * A local modification to an installed package. These patch someone else's
 * files: reversible, re-checked on every read, and wiped by that package's
 * next upgrade — the panel says so rather than pretending otherwise.
 */
export const PowerUpSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  applied: z.boolean(),
  available: z.boolean(),
  status: z.string(),
  caution: z.string(),
  action: z.enum(["toggle", "run"]),
});

export const routerPowerUps = defineRpc({
  name: "agent-link-9router.router.power-ups",
  input: z.object({}),
  output: z.object({ powerUps: z.array(PowerUpSchema) }),
});

export const routerPowerUpApply = defineRpc({
  name: "agent-link-9router.router.power-up.apply",
  input: z.object({ id: z.string(), apply: z.boolean() }),
  output: z.object({ ok: z.boolean(), message: z.string(), restartRequired: z.boolean() }),
});

/** Which models Sync writes to Paseo. Empty means every cc/ and cx/ model. */
export const routerSyncSelection = defineRpc({
  name: "agent-link-9router.router.sync-selection",
  input: z.object({}),
  output: z.object({ selected: z.array(z.string()) }),
});

export const routerSyncSelectionSet = defineRpc({
  name: "agent-link-9router.router.sync-selection.set",
  input: z.object({ selected: z.array(z.string()) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

// -------------------------------------------------------------------- tunnel

/**
 * 9router can publish itself past loopback. That exposes a proxy holding live
 * subscription credentials, so the panel reports the API-key requirement
 * alongside the switch: a tunnel without one is an open proxy.
 */
export const TunnelSchema = z.object({
  provider: z.enum(["cloudflare", "tailscale"]),
  enabled: z.boolean(),
  running: z.boolean(),
  url: z.string(),
  note: z.string(),
});

export const routerTunnel = defineRpc({
  name: "agent-link-9router.router.tunnel",
  input: z.object({}),
  output: z.object({
    tunnels: z.array(TunnelSchema),
    requireApiKey: z.boolean(),
    localUrl: z.string(),
  }),
});

/**
 * A remote daemon's dashboard is bound to ITS loopback, so the panel's "Open"
 * button — which opens the URL on whichever machine the app is running on —
 * reaches the wrong machine entirely, or nothing at all. This forwards the
 * remote port to a local one over SSH so the link resolves where the user is
 * actually sitting. Nothing is exposed publicly.
 */
export const routerLocalForward = defineRpc({
  name: "agent-link-9router.router.local-forward",
  input: z.object({
    /** ssh target for the daemon's host, e.g. "user@host". */
    sshTarget: z.string(),
    sshPort: z.number().nullable(),
    identityFile: z.string().nullable(),
    /** Port the router listens on over there. */
    remotePort: z.number(),
    /**
     * Close the forward automatically after this many minutes. A forward is a
     * hole to an accounts dashboard; leaving one open indefinitely because a
     * tab was closed is the failure worth designing against.
     */
    ttlMinutes: z.number().nullable(),
  }),
  output: z.object({
    ok: z.boolean(),
    url: z.string().nullable(),
    localPort: z.number().nullable(),
    /** When the forward closes itself, ISO 8601; null when it will not. */
    expiresAt: z.string().nullable(),
    message: z.string(),
  }),
});

/** Live state of the forward, so the panel can count down and reflect a close. */
export const routerLocalForwardStatus = defineRpc({
  name: "agent-link-9router.router.local-forward.status",
  input: z.object({}),
  output: z.object({
    open: z.boolean(),
    url: z.string().nullable(),
    localPort: z.number().nullable(),
    target: z.string().nullable(),
    expiresAt: z.string().nullable(),
  }),
});

export const routerLocalForwardStop = defineRpc({
  name: "agent-link-9router.router.local-forward.stop",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const routerTunnelSet = defineRpc({
  name: "agent-link-9router.router.tunnel.set",
  input: z.object({ provider: z.enum(["cloudflare", "tailscale"]), enabled: z.boolean() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** Require a bearer key on /v1 — the thing that makes a tunnel survivable. */
export const routerRequireApiKey = defineRpc({
  name: "agent-link-9router.router.require-api-key",
  input: z.object({ required: z.boolean() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/**
 * Ask 9router to re-read its upstream model catalogue.
 *
 * `router.sync-models` publishes a *snapshot* of `/v1/models` into Paseo's
 * config, so a model the router learned after the last sync stays invisible
 * until someone syncs again. That is exactly how `cc/claude-fable-5-1` sat
 * unavailable for hours on 2026-09-03: the catalogue gained it 47 minutes
 * after the snapshot was taken. Refreshing here, then syncing, closes that gap
 * without a trip to the dashboard.
 */
export const routerCatalogSync = defineRpc({
  name: "agent-link-9router.router.catalog-sync",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), message: z.string(), models: z.number() }),
});

/** One connection's health: token expiry, backoff, last error, model locks. */
export const ConnectionHealthSchema = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  email: z.string(),
  isActive: z.boolean(),
  /** Minutes until the access token expires; negative once it has. */
  expiresInMinutes: z.number().nullable(),
  /** 9router's exponential backoff level; > 0 means it is being rested. */
  backoffLevel: z.number(),
  lastError: z.string(),
  lastErrorAt: z.string().nullable(),
  /**
   * Model ids this connection is pinned to. A lock is invisible in the picker
   * but decides what actually answers, so a request for one model can come
   * back as another entirely.
   */
  modelLocks: z.array(z.string()),
});

export const routerConnectionHealth = defineRpc({
  name: "agent-link-9router.router.connection-health",
  input: z.object({}),
  output: z.object({ connections: z.array(ConnectionHealthSchema) }),
});

/** A single request 9router handled, for reading a failure back. */
export const RequestLogSchema = z.object({
  id: z.string(),
  at: z.string(),
  model: z.string(),
  provider: z.string(),
  status: z.number().nullable(),
  latencyMs: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  error: z.string(),
});

export const routerRequestLogs = defineRpc({
  name: "agent-link-9router.router.request-logs",
  input: z.object({
    limit: z.number().min(1).max(100).optional(),
    /** Keep only failures — the reason to open this at all. */
    errorsOnly: z.boolean().optional(),
  }),
  output: z.object({ requests: z.array(RequestLogSchema) }),
});

/**
 * Account ordering.
 *
 * 9router tries connections in `priority` order, so priority is what decides
 * which account answers a request — the single most consequential setting in
 * the dashboard, and the one thing the panel could not change. `isActive`
 * parks an account without deleting it, which is how you rest a rate-limited
 * account and keep its tokens.
 */
export const ConnectionOrderSchema = z.object({
  id: z.string(),
  provider: z.string(),
  label: z.string(),
  priority: z.number(),
  isActive: z.boolean(),
});

export const routerConnectionOrder = defineRpc({
  name: "agent-link-9router.router.connection-order",
  input: z.object({}),
  output: z.object({ connections: z.array(ConnectionOrderSchema) }),
});

export const routerConnectionPrioritySet = defineRpc({
  name: "agent-link-9router.router.connection-priority.set",
  input: z.object({ id: z.string(), priority: z.number().min(1).max(99) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const routerConnectionActiveSet = defineRpc({
  name: "agent-link-9router.router.connection-active.set",
  input: z.object({ id: z.string(), isActive: z.boolean() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/**
 * Whether a model can actually be used right now.
 *
 * Presence in the picker says nothing about availability: on 2026-09-03 every
 * Claude account sat at backoff 8 with a 429, so `cc/claude-fable-5-1` was
 * listed, correctly configured, and completely unusable for two hours. The
 * only way to find out was to send a request and read the failure.
 *
 * Availability is per model because accounts are locked to models: an account
 * carrying `modelLock_claude-fable-5-1` can serve fable and nothing else, so
 * fable can be exhausted while other models still answer through the same
 * connection list.
 */
export const ModelAvailabilitySchema = z.object({
  id: z.string(),
  label: z.string(),
  /** ready = an account can serve it now; limited = every account is rate-limited; resting = 9router is backing off; none = no account offers it. */
  state: z.enum(["ready", "limited", "resting", "none"]),
  /** Accounts that could serve this model, and how many of those are usable. */
  accounts: z.number(),
  usable: z.number(),
  /** Soonest moment an account is expected back, when known. */
  readyAt: z.string().nullable(),
  detail: z.string(),
});

export const routerModelAvailability = defineRpc({
  name: "agent-link-9router.router.model-availability",
  input: z.object({}),
  output: z.object({ models: z.array(ModelAvailabilitySchema) }),
});

/**
 * Spend, as the dashboard's Quota page reports it.
 *
 * The router already aggregates this; recomputing it from `usageDaily` would
 * drift the moment 9router changes how it counts a cached token. Totals and
 * per-model rows come straight from `/api/usage/stats`.
 */
export const SpendRowSchema = z.object({
  label: z.string(),
  requests: z.number(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  cachedTokens: z.number(),
  cost: z.number(),
  lastUsed: z.string().nullable(),
});

export const routerSpend = defineRpc({
  name: "agent-link-9router.router.spend",
  input: z.object({ days: z.number().int().min(1).max(90).nullable() }),
  output: z.object({
    ok: z.boolean(),
    message: z.string().nullable(),
    totals: SpendRowSchema.nullable(),
    byProvider: z.array(SpendRowSchema),
    byModel: z.array(SpendRowSchema),
    byAccount: z.array(SpendRowSchema),
  }),
});

/**
 * Which CLIs are installed and where each one currently sends its traffic.
 *
 * A CLI can be installed, configured, and still bypassing the router — the
 * 401s to api.openai.com came from exactly that, Codex reading its own
 * config.toml while Claude's env vars pointed at 9router. This reports the
 * base URL each tool resolves, so a bypass is visible rather than inferred.
 */
export const CliToolSchema = z.object({
  id: z.string(),
  label: z.string(),
  installed: z.boolean(),
  routed: z.boolean(),
  baseUrl: z.string().nullable(),
  detail: z.string(),
});

export const routerCliTools = defineRpc({
  name: "agent-link-9router.router.cli-tools",
  input: z.object({}),
  output: z.object({ tools: z.array(CliToolSchema) }),
});

/** Outbound proxy pools, and the upstream nodes traffic can be forwarded to. */
export const ProxyPoolSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string().nullable(),
  active: z.boolean(),
  detail: z.string(),
});

export const routerProxyPools = defineRpc({
  name: "agent-link-9router.router.proxy-pools",
  input: z.object({}),
  output: z.object({
    pools: z.array(ProxyPoolSchema),
    nodes: z.array(ProxyPoolSchema),
  }),
});

/**
 * pxpipe — the router's prompt-compaction sidecar.
 *
 * Reported rather than controlled: it installs itself on demand, and a panel
 * that offers a Start button for something not installed invites a failure
 * the user cannot act on.
 */
export const routerPxpipe = defineRpc({
  name: "agent-link-9router.router.pxpipe",
  input: z.object({}),
  output: z.object({
    installed: z.boolean(),
    running: z.boolean(),
    enabled: z.boolean(),
    version: z.string().nullable(),
    mode: z.string().nullable(),
    minChars: z.number().nullable(),
    detail: z.string(),
  }),
});

/**
 * How 9router picks between the accounts behind one provider.
 *
 * This decides which account absorbs a request, so it decides which account
 * hits its ceiling first. With `fallback` the top-priority account carries
 * everything until it 429s; with `round-robin` the load spreads and no single
 * account is exhausted while others sit idle. Invisible in the panel until
 * now, which made an all-accounts-limited state look inexplicable.
 */
export const ProviderStrategySchema = z.object({
  provider: z.string(),
  label: z.string(),
  /** null means the provider follows 9router's default (fallback). */
  strategy: z.enum(["fallback", "round-robin", "priority", "random"]).nullable(),
  /** Requests one account serves before round-robin advances. Only meaningful for round-robin. */
  stickyLimit: z.number().nullable(),
  accounts: z.number(),
  detail: z.string(),
});

export const routerStrategies = defineRpc({
  name: "agent-link-9router.router.strategies",
  input: z.object({}),
  output: z.object({
    strategies: z.array(ProviderStrategySchema),
    defaultStickyLimit: z.number().nullable(),
  }),
});

export const routerStrategySet = defineRpc({
  name: "agent-link-9router.router.strategy-set",
  input: z.object({
    provider: z.string(),
    strategy: z.enum(["fallback", "round-robin", "priority", "random"]),
    stickyLimit: z.number().int().min(1).max(50).nullable(),
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/**
 * Tailscale as the private path to a remote router.
 *
 * 9router ships both a Cloudflare quick tunnel and Tailscale. The quick tunnel
 * is public, its URL changes on every restart, and it puts inference traffic
 * through Cloudflare's edge. Tailscale is private and its address is stable,
 * so it is the better answer for reaching a daemon's router — but the panel
 * previously offered only a Publish toggle, which does nothing when Tailscale
 * is installed and not signed in. This reports the state that toggle assumed.
 */
export const TailscaleStateSchema = z.object({
  installed: z.boolean(),
  loggedIn: z.boolean(),
  daemonRunning: z.boolean(),
  platform: z.string().nullable(),
  /** Whether the router can install it here without the user leaving the panel. */
  canInstall: z.boolean(),
  url: z.string().nullable(),
  detail: z.string(),
  /** The one thing to do next, in the user's terms. */
  nextStep: z.string().nullable(),
});

export const routerTailscale = defineRpc({
  name: "agent-link-9router.router.tailscale",
  input: z.object({}),
  output: TailscaleStateSchema,
});

export const routerTailscaleAction = defineRpc({
  name: "agent-link-9router.router.tailscale-action",
  input: z.object({ action: z.enum(["install", "enable", "disable"]) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** 9router's own version, and whether an upgrade is waiting. */
export const routerVersion = defineRpc({
  name: "agent-link-9router.router.version",
  input: z.object({}),
  output: z.object({
    current: z.string().nullable(),
    latest: z.string().nullable(),
    hasUpdate: z.boolean(),
    detail: z.string(),
  }),
});

export const routerUpdate = defineRpc({
  name: "agent-link-9router.router.update",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/**
 * Whether an account can actually serve each model, tested against the
 * provider rather than inferred from the catalogue.
 */
export const ModelTestSchema = z.object({
  model: z.string(),
  ok: z.boolean(),
  status: z.number().nullable(),
  detail: z.string(),
});

export const routerTestConnectionModels = defineRpc({
  name: "agent-link-9router.router.test-connection-models",
  input: z.object({ connectionId: z.string(), models: z.array(z.string()).nullable() }),
  output: z.object({ results: z.array(ModelTestSchema), message: z.string().nullable() }),
});

/**
 * Whether adaptive thinking survives the 9router hop.
 *
 * 9router maps thinking mode "auto" to the literal string "auto" and writes it
 * to `output_config.effort`; Anthropic only accepts low|medium|high|xhigh|max
 * and returns 400. 9router then counts that 400 as a provider failure and backs
 * the account off, so the NEXT request — a perfectly valid one — fails with
 * "Unavailable". On 2026-09-04 that read as a rate-limit outage for hours.
 *
 * The check sends one adaptive request and reports what came back, so the state
 * is visible instead of being inferred from a cascade of unrelated 429s.
 */
export const ThinkingCheckSchema = z.object({
  state: z.enum(["ok", "broken", "blocked", "unknown"]),
  model: z.string().nullable(),
  detail: z.string(),
  /** What to do about it, when there is something to do. */
  fix: z.string().nullable(),
});

export const routerThinkingCheck = defineRpc({
  name: "agent-link-9router.router.thinking-check",
  input: z.object({ model: z.string().nullable() }),
  output: ThinkingCheckSchema,
});
