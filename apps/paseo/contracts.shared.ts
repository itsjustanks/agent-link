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

export const routerStart = defineRpc({
  name: "agent-link.router.start",
  input: z.object({}),
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
