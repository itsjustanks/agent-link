import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const SlotSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  email: z.string(),
  dir: z.string(),
  source: z.enum(["agent-link", "external"]),
  loggedIn: z.boolean(),
  actualEmail: z.string(),
  wrongAccount: z.boolean(),
  wiredProviderId: z.string().nullable(),
  cooldownUntil: z.number(), // epoch seconds; 0 = available
  launches: z.number(), // agents this account has been handed by the router
  lastUsed: z.number(), // epoch seconds; 0 = never
  preference: z.enum(["preferred", "standard", "reserve"]),
  nearing: z.boolean(), // healthy enough to serve, but new work drains elsewhere
  creditNote: z.string(), // "" when fine, else e.g. "out of credits"
  blocked: z.boolean(), // active hold/cooldown — routing skips it
  parkReason: z.string(), // why it is parked, "" when not parked
  outputStyle: z.string(), // active output style, "" when unset
  settingsDrift: z.array(z.string()), // preference keys that differ from the primary
  modelHolds: z.array(z.string()), // model slugs this account cannot currently serve
});
export type Slot = z.infer<typeof SlotSchema>;

export const AutoRouterSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  launcherPath: z.string(),
  launcherExists: z.boolean(),
  wiredProviderId: z.string().nullable(),
});
export type AutoRouter = z.infer<typeof AutoRouterSchema>;

export const RouteEventSchema = z.object({
  at: z.number(),
  provider: z.enum(["claude", "codex"]),
  email: z.string(),
  decision: z.string(),
  group: z.enum(["preferred", "standard", "reserve", "fallback"]),
  agentId: z.string(),
  cwd: z.string(),
  model: z.string(),
});
export type RouteEvent = z.infer<typeof RouteEventSchema>;

export const scan = defineRpc({
  name: "agent-link.scan",
  input: z.object({}),
  output: z.object({
    slots: z.array(SlotSchema),
    primaryAccounts: z.object({ claude: z.string(), codex: z.string() }),
    primaryCreditNote: z.string(),
    primaries: z.array(
      z.object({
        provider: z.enum(["claude", "codex"]),
        email: z.string(),
        launches: z.number(),
        cooldownUntil: z.number(),
        blocked: z.boolean(),
        parkReason: z.string(),
        preference: z.enum(["preferred", "standard", "reserve"]),
        nearing: z.boolean(),
        modelHolds: z.array(z.string()),
        duplicated: z.boolean(), // an account slot already holds this account
      }),
    ),
    nextUp: z.array(z.object({ provider: z.enum(["claude", "codex"]), email: z.string() })),
    recentRoutes: z.array(RouteEventSchema),
    autoRouters: z.array(AutoRouterSchema),
    agentAuthInstalled: z.boolean(),
    needsRestart: z.boolean(),
  }),
});

export const RouterTargetSchema = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9-]*$/),
  model: z.string().min(1).max(160),
  available: z.boolean().nullable().optional(),
});

export const RouterTargetGroupSchema = z.object({
  name: z.string().min(1).max(40).regex(/^[a-z][a-z0-9-]*$/),
  purpose: z.string().min(1).max(200),
  selector: z.literal("in_order").default("in_order"),
  targets: z.array(RouterTargetSchema).min(1).max(12),
});

export const RouterProviderStatusSchema = z.object({
  installed: z.boolean(),
  configured: z.boolean(),
  loaded: z.boolean(),
  launcherPath: z.string(),
  rulesPath: z.string(),
  baseProvider: z.string(),
  baseModel: z.string(),
  controllerProvider: z.enum(["claude-auto", "claude"]),
  controllerModel: z.string(),
  controllerOptions: z.array(
    z.object({
      provider: z.enum(["claude-auto", "claude"]),
      label: z.string(),
      available: z.boolean(),
      models: z.array(z.object({ id: z.string(), label: z.string() })),
    }),
  ),
  providerOptions: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      available: z.boolean(),
    }),
  ),
  targetGroups: z.array(RouterTargetGroupSchema),
  userRules: z.string(),
  message: z.string(),
});
export type RouterProviderStatus = z.infer<typeof RouterProviderStatusSchema>;

export const routerStatus = defineRpc({
  name: "agent-link.router-status",
  input: z.object({}),
  output: RouterProviderStatusSchema,
});

export const routerInstall = defineRpc({
  name: "agent-link.router-install",
  input: z.object({}),
  output: RouterProviderStatusSchema,
});

export const routerConfigure = defineRpc({
  name: "agent-link.router-configure",
  input: z.object({
    controllerProvider: z.enum(["claude-auto", "claude"]),
    controllerModel: z.string().min(1).max(160),
    targetGroups: z.array(RouterTargetGroupSchema).min(1).max(12),
    userRules: z.string().max(12_000),
  }),
  output: RouterProviderStatusSchema,
});

export const routerModels = defineRpc({
  name: "agent-link.router-models",
  input: z.object({ provider: z.string().regex(/^[a-z][a-z0-9-]*$/) }),
  output: z.object({
    provider: z.string(),
    models: z.array(z.object({ id: z.string(), label: z.string(), description: z.string() })),
    message: z.string(),
  }),
});

export const RouterTraceNodeSchema = z.object({
  source: z.enum(["control", "paseo", "provider-internal"]),
  id: z.string(),
  title: z.string(),
  provider: z.string(),
  model: z.string(),
  status: z.string(),
  note: z.string(),
  account: z.string(),
  routedAt: z.number(),
});
export type RouterTraceNode = z.infer<typeof RouterTraceNodeSchema>;

export const routerTrace = defineRpc({
  name: "agent-link.router-trace",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({
    isAgentRouter: z.boolean(),
    summary: z.string(),
    nodes: z.array(RouterTraceNodeSchema),
  }),
});

export const wireAuto = defineRpc({
  name: "agent-link.wire-auto",
  input: z.object({ provider: z.enum(["claude", "codex"]) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const addAccount = defineRpc({
  name: "agent-link.add-account",
  input: z.object({ provider: z.enum(["claude", "codex"]), email: z.string().min(3) }),
  output: z.object({ ok: z.boolean(), message: z.string(), started: z.boolean() }),
});

export const removeAccount = defineRpc({
  name: "agent-link.remove-account",
  input: z.object({ provider: z.enum(["claude", "codex"]), email: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const setPreference = defineRpc({
  name: "agent-link.set-preference",
  input: z.object({
    provider: z.enum(["claude", "codex"]),
    email: z.string().min(1),
    preference: z.enum(["preferred", "standard", "reserve"]),
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const setCooldown = defineRpc({
  name: "agent-link.set-cooldown",
  input: z.object({ provider: z.enum(["claude", "codex"]), email: z.string(), minutes: z.number() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const wireProvider = defineRpc({
  name: "agent-link.wire-provider",
  input: z.object({
    provider: z.enum(["claude", "codex"]),
    email: z.string(),
    dir: z.string(),
  }),
  output: z.object({ providerId: z.string(), needsRestart: z.boolean() }),
});

export const diagnoseProvider = defineRpc({
  name: "agent-link.diagnose-provider",
  input: z.object({ providerId: z.string() }),
  output: z.object({ summary: z.string() }),
});

export const AccountUsageSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  email: z.string(),
  sessions: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  reasoningTokens: z.number(),
  contextWindow: z.number(),
  lastActive: z.number(), // epoch seconds, 0 = none in window
  models: z.array(z.string()),
  cacheCreationTokens: z.number(),
  limitHits: z.number(), // times this account was refused for a limit
  limitLast: z.number(), // epoch seconds of the most recent refusal
  daily: z.array(z.number()), // output tokens per day, oldest first
  topProject: z.string(),
  /** Live window usage captured from the account's own telemetry (statusline / rollouts). */
  quota: z
    .object({
      at: z.number(), // epoch seconds the snapshot was taken
      model: z.string(),
      windows: z.array(z.object({ label: z.string(), pct: z.number(), resetsAt: z.number().nullable() })),
    })
    .nullable(),
  /** Non-expiring park reason (spend limit / held by hand), null when not held. */
  held: z.string().nullable(),
});
export type AccountUsage = z.infer<typeof AccountUsageSchema>;

export const accountUsage = defineRpc({
  name: "agent-link.account-usage",
  input: z.object({ days: z.number() }),
  output: z.object({ accounts: z.array(AccountUsageSchema) }),
});

export const CapacityWindowSchema = z.object({
  label: z.string(),
  kind: z.enum(["session", "weekly", "other"]),
  durationMinutes: z.number().nullable(),
  usedPct: z.number(),
  resetsAt: z.number().nullable(),
});

export const CapacityAccountSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  email: z.string(),
  isPrimary: z.boolean(),
  poolKey: z.string(),
  state: z.enum(["ready", "nearing", "parked", "held", "unknown"]),
  detail: z.string(),
  at: z.number(),
  plan: z.string(),
  model: z.string(),
  source: z.string(),
  credits: z
    .object({
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
      balance: z.string(),
    })
    .nullable(),
  windows: z.array(CapacityWindowSchema),
});
export type CapacityAccount = z.infer<typeof CapacityAccountSchema>;

export const accountCapacity = defineRpc({
  name: "agent-link.account-capacity",
  input: z.object({}),
  output: z.object({ accounts: z.array(CapacityAccountSchema) }),
});

/**
 * An explicit, paid provider turn. This is deliberately separate from the
 * cheap heartbeat so opening the panel can never consume quota.
 */
export const probeAccounts = defineRpc({
  name: "agent-link.probe-accounts",
  input: z.object({
    provider: z.enum(["claude", "codex"]),
    model: z.string().max(160),
    parkFailures: z.boolean(),
  }),
  output: z.object({ ok: z.boolean(), message: z.string(), log: z.string() }),
});

export const providerHealth = defineRpc({
  name: "agent-link.provider-health",
  input: z.object({}),
  output: z.object({
    providers: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        ok: z.boolean(),
        summary: z.string(),
      }),
    ),
  }),
});

export const ProviderHeartbeatSchema = z.object({
  /** The provider family shown as one tab; account-pinned aliases roll up here. */
  id: z.string(),
  label: z.string(),
  available: z.boolean(),
  kind: z.enum(["pooled", "single"]),
  quotaTelemetry: z.boolean(),
  aliases: z.array(z.string()),
  summary: z.string(),
});
export type ProviderHeartbeat = z.infer<typeof ProviderHeartbeatSchema>;

/**
 * Cheap liveness signal: daemon RPC + provider registry only. It deliberately
 * never starts a provider process or model turn; providerHealth remains the
 * explicit deep check.
 */
export const providerHeartbeat = defineRpc({
  name: "agent-link.provider-heartbeat",
  input: z.object({}),
  output: z.object({
    checkedAt: z.number(),
    providers: z.array(ProviderHeartbeatSchema),
  }),
});

// ---- universal MCP management -------------------------------------------------

export const DestinationSchema = z.object({
  id: z.string(), // stable: the config file path
  label: z.string(), // "Claude · you@work.com (primary)"
  provider: z.string(), // claude | codex | kimi | grok | <custom paseo id>
  account: z.string(), // email, or "" when the CLI has no per-account identity here
  configPath: z.string(),
  format: z.enum(["json-mcp", "toml-mcp"]),
});
export type Destination = z.infer<typeof DestinationSchema>;

export const McpServerRowSchema = z.object({
  name: z.string(),
  transport: z.enum(["stdio", "http", "unknown"]),
  detail: z.string(),
  authStyle: z.enum(["inline-credentials", "oauth-or-none"]),
  inlineCredentialsIn: z.array(z.string()),
  presentIn: z.array(z.string()), // destination ids
});
export type McpServerRow = z.infer<typeof McpServerRowSchema>;

export const mcpMatrix = defineRpc({
  name: "agent-link.mcp-matrix",
  input: z.object({}),
  output: z.object({
    destinations: z.array(DestinationSchema),
    servers: z.array(McpServerRowSchema),
  }),
});

export const mcpAdd = defineRpc({
  name: "agent-link.mcp-add",
  input: z.object({
    name: z.string().min(1),
    kind: z.enum(["stdio", "http"]),
    command: z.string().optional(), // stdio: full command line (first token = binary)
    url: z.string().optional(), // http
    kvLines: z.string().optional(), // env (stdio) or headers (http), one KEY=VALUE per line
    targets: z.array(z.string()).min(1), // destination ids
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const mcpApply = defineRpc({
  name: "agent-link.mcp-apply",
  input: z.object({
    name: z.string(),
    targets: z.array(z.string()).min(1),
    sourceDestId: z.string().optional(), // copy THIS destination's version; default = best available
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const mcpRemove = defineRpc({
  name: "agent-link.mcp-remove",
  input: z.object({ name: z.string(), targets: z.array(z.string()).min(1) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const McpAuthAccountSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  email: z.string(),
  dir: z.string(),
  isPrimary: z.boolean(),
  definedServers: z.number(),
  needsAuth: z.array(z.string()),
  authStatus: z.record(z.string(), z.enum(["connected", "not-connected", "unsupported", "unknown"])),
});
export type McpAuthAccount = z.infer<typeof McpAuthAccountSchema>;

export const mcpAuth = defineRpc({
  name: "agent-link.mcp-auth",
  input: z.object({}),
  output: z.object({
    accounts: z.array(McpAuthAccountSchema),
    projectServers: z.array(z.object({ project: z.string(), name: z.string() })),
  }),
});

export const ProjectMcpServerSchema = z.object({
  name: z.string(),
  transport: z.enum(["stdio", "http", "unknown"]),
  detail: z.string(),
  authStyle: z.enum(["inline-credentials", "oauth-or-none"]),
});
export type ProjectMcpServer = z.infer<typeof ProjectMcpServerSchema>;

/** Read-only project MCP inventory resolved from a live Paseo workspace id. */
export const mcpWorkspace = defineRpc({
  name: "agent-link.mcp-workspace",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({
    workspace: z.object({
      id: z.string(),
      name: z.string(),
      directory: z.string(),
      projectRootPath: z.string(),
    }),
    configPath: z.string(),
    servers: z.array(ProjectMcpServerSchema),
    accounts: z.array(McpAuthAccountSchema),
  }),
});

export const mcpSync = defineRpc({
  name: "agent-link.mcp-sync",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), log: z.string() }),
});

// Per-destination editable view of one server. Secrets are MASKED (•••last4)
// unless reveal=true — it is the user's own machine and their own secrets.
// An edit that keeps a masked value keeps that destination's stored secret.
export const McpDefRowSchema = z.object({
  destId: z.string(),
  found: z.boolean(),
  kind: z.enum(["stdio", "http"]),
  command: z.string(),
  url: z.string(),
  kvLines: z.string(), // KEY=value per line (env for stdio, headers for http)
});
export type McpDefRow = z.infer<typeof McpDefRowSchema>;

export const mcpDefAll = defineRpc({
  name: "agent-link.mcp-def-all",
  input: z.object({ name: z.string(), reveal: z.boolean() }),
  output: z.object({ rows: z.array(McpDefRowSchema) }),
});

export const mcpEditOne = defineRpc({
  name: "agent-link.mcp-edit-one",
  input: z.object({
    name: z.string(),
    destId: z.string(),
    kind: z.enum(["stdio", "http"]),
    command: z.string().optional(),
    url: z.string().optional(),
    kvLines: z.string().optional(), // masked values (•••…) keep that destination's stored secret
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const mcpRename = defineRpc({
  name: "agent-link.mcp-rename",
  input: z.object({ name: z.string(), newName: z.string().min(1) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const McpHealthSchema = z.object({
  name: z.string(),
  status: z.enum(["ok", "auth-required", "warn", "down", "binary-missing", "unknown"]),
  note: z.string(),
});
export type McpHealth = z.infer<typeof McpHealthSchema>;

export const mcpHealth = defineRpc({
  name: "agent-link.mcp-health",
  input: z.object({}),
  output: z.object({ results: z.array(McpHealthSchema) }),
});
