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
  creditNote: z.string(), // "" when fine, else e.g. "out of credits"
  blocked: z.boolean(), // spend limit reached — routing skips it
  parkReason: z.string(), // why it is parked, "" when not parked
  outputStyle: z.string(), // active output style, "" when unset
  settingsDrift: z.array(z.string()), // preference keys that differ from the primary
});
export type Slot = z.infer<typeof SlotSchema>;

export const AutoRouterSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  launcherPath: z.string(),
  launcherExists: z.boolean(),
  wiredProviderId: z.string().nullable(),
});
export type AutoRouter = z.infer<typeof AutoRouterSchema>;

export const scan = defineRpc({
  name: "superpowers.scan",
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
        duplicated: z.boolean(), // an account slot already holds this account
      }),
    ),
    nextUp: z.array(z.object({ provider: z.enum(["claude", "codex"]), email: z.string() })),
    autoRouters: z.array(AutoRouterSchema),
    agentAuthInstalled: z.boolean(),
    needsRestart: z.boolean(),
  }),
});

export const wireAuto = defineRpc({
  name: "superpowers.wire-auto",
  input: z.object({ provider: z.enum(["claude", "codex"]) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const addAccount = defineRpc({
  name: "superpowers.add-account",
  input: z.object({ provider: z.enum(["claude", "codex"]), email: z.string().min(3) }),
  output: z.object({ ok: z.boolean(), message: z.string(), started: z.boolean() }),
});

export const setCooldown = defineRpc({
  name: "superpowers.set-cooldown",
  input: z.object({ provider: z.enum(["claude", "codex"]), email: z.string(), minutes: z.number() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const wireProvider = defineRpc({
  name: "superpowers.wire-provider",
  input: z.object({
    provider: z.enum(["claude", "codex"]),
    email: z.string(),
    dir: z.string(),
  }),
  output: z.object({ providerId: z.string(), needsRestart: z.boolean() }),
});

export const diagnoseProvider = defineRpc({
  name: "superpowers.diagnose-provider",
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
  lastActive: z.number(), // epoch seconds, 0 = none in window
  models: z.array(z.string()),
  cacheCreationTokens: z.number(),
  limitHits: z.number(), // times this account was refused for a limit
  limitLast: z.number(), // epoch seconds of the most recent refusal
  daily: z.array(z.number()), // output tokens per day, oldest first
  topProject: z.string(),
});
export type AccountUsage = z.infer<typeof AccountUsageSchema>;

export const accountUsage = defineRpc({
  name: "superpowers.account-usage",
  input: z.object({ days: z.number() }),
  output: z.object({ accounts: z.array(AccountUsageSchema) }),
});

export const providerHealth = defineRpc({
  name: "superpowers.provider-health",
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
  presentIn: z.array(z.string()), // destination ids
});
export type McpServerRow = z.infer<typeof McpServerRowSchema>;

export const mcpMatrix = defineRpc({
  name: "superpowers.mcp-matrix",
  input: z.object({}),
  output: z.object({
    destinations: z.array(DestinationSchema),
    servers: z.array(McpServerRowSchema),
  }),
});

export const mcpAdd = defineRpc({
  name: "superpowers.mcp-add",
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
  name: "superpowers.mcp-apply",
  input: z.object({
    name: z.string(),
    targets: z.array(z.string()).min(1),
    sourceDestId: z.string().optional(), // copy THIS destination's version; default = best available
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const mcpRemove = defineRpc({
  name: "superpowers.mcp-remove",
  input: z.object({ name: z.string(), targets: z.array(z.string()).min(1) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const McpAuthAccountSchema = z.object({
  email: z.string(),
  dir: z.string(),
  isPrimary: z.boolean(),
  definedServers: z.number(),
  needsAuth: z.array(z.string()),
});
export type McpAuthAccount = z.infer<typeof McpAuthAccountSchema>;

export const mcpAuth = defineRpc({
  name: "superpowers.mcp-auth",
  input: z.object({}),
  output: z.object({
    accounts: z.array(McpAuthAccountSchema),
    projectServers: z.array(z.object({ project: z.string(), name: z.string() })),
  }),
});

export const mcpSync = defineRpc({
  name: "superpowers.mcp-sync",
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
  name: "superpowers.mcp-def-all",
  input: z.object({ name: z.string(), reveal: z.boolean() }),
  output: z.object({ rows: z.array(McpDefRowSchema) }),
});

export const mcpEditOne = defineRpc({
  name: "superpowers.mcp-edit-one",
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
  name: "superpowers.mcp-rename",
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
  name: "superpowers.mcp-health",
  input: z.object({}),
  output: z.object({ results: z.array(McpHealthSchema) }),
});
