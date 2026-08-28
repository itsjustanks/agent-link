import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

/**
 * Raw JSON editing, import/export, and OAuth for MCP servers.
 *
 * Everything here speaks ONE shape — the JSON people actually paste out of a
 * README, which is Claude's:
 *
 *   { "type": "http", "url": "…", "headers": { "Authorization": "Bearer …" } }
 *   { "command": "npx", "args": ["-y", "pkg"], "env": { "KEY": "…" } }
 *
 * TOML destinations (Codex, Grok) are translated on the way in and out, so the
 * user never types TOML and never has to know that Codex spells headers
 * `http_headers`. Where a key has no equivalent it is reported as dropped
 * rather than silently discarded.
 */

export const DialectSchema = z.enum(["claude-json", "kimi-json", "codex-toml", "grok-toml"]);
export type Dialect = z.infer<typeof DialectSchema>;

/** A problem with a JSON buffer, precise enough to point at. */
export const JsonIssueSchema = z.object({
  line: z.number(),
  column: z.number(),
  code: z.enum([
    "json-syntax",
    "shape",
    "mask-unresolved",
    "placeholder",
    "name-invalid",
    "roundtrip-failed",
    "too-large",
    "not-found",
  ]),
  message: z.string(),
});
export type JsonIssue = z.infer<typeof JsonIssueSchema>;

export const RawDefRowSchema = z.object({
  destId: z.string(),
  destLabel: z.string(),
  dialect: DialectSchema,
  found: z.boolean(),
  /** The definition as canonical JSON, pretty-printed. Secrets masked unless revealed. */
  json: z.string(),
  /** True when the JSON above contains a ••• placeholder standing in for a secret. */
  masked: z.boolean(),
  /** How this destination stores it, for the user's orientation. */
  nativePreview: z.string(),
});
export type RawDefRow = z.infer<typeof RawDefRowSchema>;

export const mcpRawGet = defineRpc({
  name: "agent-link.mcp-raw-get",
  input: z.object({ name: z.string(), reveal: z.boolean() }),
  output: z.object({ rows: z.array(RawDefRowSchema), containsSecrets: z.boolean() }),
});

export const mcpRawPut = defineRpc({
  name: "agent-link.mcp-raw-put",
  input: z.object({
    name: z.string(),
    destId: z.string(),
    json: z.string(),
    /** Validate and show what would be written, touching nothing. */
    dryRun: z.boolean(),
  }),
  output: z.object({
    ok: z.boolean(),
    issues: z.array(JsonIssueSchema),
    warnings: z.array(z.string()),
    /** Exactly what the destination will hold, in its own format. */
    preview: z.string(),
    dropped: z.array(z.string()),
    message: z.string(),
  }),
});

export const ParsedServerSchema = z.object({
  name: z.string(),
  json: z.string(),
  kind: z.enum(["stdio", "http"]),
  summary: z.string(),
  hasPlaceholders: z.array(z.string()),
});

export const mcpImportParse = defineRpc({
  name: "agent-link.mcp-import-parse",
  input: z.object({ blob: z.string() }),
  output: z.object({
    servers: z.array(ParsedServerSchema),
    /** What had to be cleaned up to read it — fences, comments, a wrapper key. */
    normalisations: z.array(z.string()),
    issues: z.array(JsonIssueSchema),
  }),
});

export const mcpImportApply = defineRpc({
  name: "agent-link.mcp-import-apply",
  input: z.object({
    servers: z.array(z.object({ name: z.string(), json: z.string() })),
    targets: z.array(z.string()).min(1),
    overwrite: z.boolean(),
    allowPlaceholders: z.boolean(),
  }),
  output: z.object({
    ok: z.boolean(),
    written: z.array(z.string()),
    skipped: z.array(z.string()),
    issues: z.array(JsonIssueSchema),
    message: z.string(),
  }),
});

export const mcpExport = defineRpc({
  name: "agent-link.mcp-export",
  input: z.object({
    scope: z.enum(["one", "all"]),
    name: z.string().optional(),
    destId: z.string().optional(),
    reveal: z.boolean(),
  }),
  output: z.object({ text: z.string(), filename: z.string(), containsSecrets: z.boolean() }),
});

/** Write an export next to the user's other files — a panel cannot download. */
export const mcpExportFile = defineRpc({
  name: "agent-link.mcp-export-file",
  input: z.object({ text: z.string(), filename: z.string() }),
  output: z.object({ ok: z.boolean(), path: z.string(), message: z.string() }),
});

// ------------------------------------------------------------------ OAuth

/**
 * `claude mcp login <name>` and `codex mcp login <name>` run the OAuth dance
 * and store the grant in that account's own config directory. The panel spawns
 * one, surfaces the URL it prints, and watches for it to finish.
 *
 * The callback lands on the DAEMON machine's localhost, so this works when
 * Paseo's daemon is the machine you are sitting at. For a remote daemon the
 * panel says so and hands over the command instead.
 */
export const LoginSessionSchema = z.object({
  key: z.string(), // provider|accountDir|server
  server: z.string(),
  account: z.string(),
  provider: z.enum(["claude", "codex"]),
  state: z.enum(["starting", "waiting", "done", "failed"]),
  url: z.string(), // the page to open, when the CLI printed one
  callbackUrl: z.string(), // redirect target advertised by the OAuth request
  browserOpened: z.boolean(), // system-browser handoff was attempted on the daemon
  expectsRedirect: z.boolean(), // CLI needs the returned redirect URL on stdin
  message: z.string(),
  startedAt: z.number(),
});
export type LoginSession = z.infer<typeof LoginSessionSchema>;

export const mcpLogin = defineRpc({
  name: "agent-link.mcp-login",
  input: z.object({
    provider: z.enum(["claude", "codex"]),
    accountDir: z.string(),
    account: z.string(),
    server: z.string(),
  }),
  output: z.object({ ok: z.boolean(), session: LoginSessionSchema.nullable(), message: z.string() }),
});

export const mcpLoginStatus = defineRpc({
  name: "agent-link.mcp-login-status",
  input: z.object({}),
  output: z.object({ sessions: z.array(LoginSessionSchema), daemonIsLocal: z.boolean() }),
});

export const mcpLoginCancel = defineRpc({
  name: "agent-link.mcp-login-cancel",
  input: z.object({ key: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const mcpLoginComplete = defineRpc({
  name: "agent-link.mcp-login-complete",
  input: z.object({ key: z.string(), redirectUrl: z.string().url().max(8192) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const mcpLogout = defineRpc({
  name: "agent-link.mcp-logout",
  input: z.object({
    provider: z.enum(["claude", "codex"]),
    accountDir: z.string(),
    server: z.string(),
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});
