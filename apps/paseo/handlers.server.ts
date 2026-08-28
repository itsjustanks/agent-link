import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Destination, RouteEvent, Slot } from "./contracts.shared";
import { onStart } from "./lifecycle.shared";
import { ensureLimitSentry } from "./limits.server";
import type { Dialect } from "./mcpjson.shared";

const HOME = homedir();
// Home dir: prefer whichever location actually holds accounts. Picking a
// merely-existing empty dir made the panel look at the wrong place and report
// working accounts as missing and the auto-router as unwired.
function hasAccounts(root: string): boolean {
  for (const provider of ["claude", "codex"]) {
    try {
      if (readdirSync(join(root, "accounts", provider)).length > 0) return true;
    } catch {
      // missing dir is simply "no accounts here"
    }
  }
  return false;
}

const AGENT_LINK_HOME_DIR = (() => {
  const explicit = process.env.AGENT_LINK_HOME ?? process.env.AGENT_AUTH_HOME;
  if (explicit) return explicit;
  const link = join(HOME, ".agent-link");
  const auth = join(HOME, ".agent-auth");
  if (hasAccounts(link)) return link;
  if (hasAccounts(auth)) return auth;
  return existsSync(link) ? link : auth;
})();

const AGENT_LINK_ROOT = join(AGENT_LINK_HOME_DIR, "accounts");
// Hand-rolled slot layouts some setups use outside agent-link (read-only here).
const EXTERNAL_ROOTS: Array<{ provider: "claude" | "codex"; root: string }> = [
  { provider: "claude", root: join(HOME, ".claude-accounts") },
  { provider: "codex", root: join(HOME, ".codex-accounts") },
];

// Set after a provider is wired; Paseo builds its provider registry at startup,
// so new providers appear only after a daemon restart.
let needsRestart = false;

// ---------------------------------------------------------------- fs helpers

function listDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

export function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const BACKUP_KEEP = 20;

export function backupFile(path: string): void {
  if (!existsSync(path)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(path, `${path}.bak-agent-link-${stamp}`);
  // Keep the most recent few so config dirs do not fill with backups. The count
  // is per file and generous on purpose: applying one server to seven
  // destinations is a single user action that writes seven files, and a tighter
  // cap would push the pre-change copy out within two such presses.
  try {
    const dir = dirname(path);
    const prefix = `${basename(path)}.bak-agent-link-`;
    const old = readdirSync(dir)
      .filter((entry) => entry.startsWith(prefix))
      .sort() // ISO timestamps sort chronologically
      .slice(0, -BACKUP_KEEP);
    for (const entry of old) rmSync(join(dir, entry), { force: true });
  } catch {
    // Pruning is best-effort; never block a write on it.
  }
}

/**
 * Replace a file's contents in one step, keeping the permissions it already
 * had. These files hold bearer tokens, so a fresh one is created private, and
 * an existing 0600 config is never widened by being edited here.
 */
export function writeTextAtomic(path: string, text: string): void {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const tmp = `${path}.tmp-agent-link`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------- accounts / slots

// Only the account email is ever read from credential-adjacent files — no token
// material leaves the handler.
function claudeAccountEmail(configDir: string): string {
  const config = readJson(configDir === HOME ? join(HOME, ".claude.json") : join(configDir, ".claude.json"));
  const account = config?.oauthAccount as { emailAddress?: string } | undefined;
  return account?.emailAddress ?? "";
}

function codexAccountEmail(codexHome: string): string {
  const auth = readJson(join(codexHome, "auth.json"));
  const idToken = (auth?.tokens as { id_token?: string } | undefined)?.id_token;
  if (!idToken) return "";
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString());
    return typeof payload.email === "string" ? payload.email : "";
  } catch {
    return "";
  }
}

// Claude Code does NOT drop a credentials file inside CLAUDE_CONFIG_DIR on
// macOS — the tokens go to the OS keychain, keyed per config dir. Verified:
// three config dirs report three different `claude auth status` accounts at the
// same time. So identity in .claude.json, not a credentials file, is what says
// "this slot is logged in". Codex does keep auth.json inside CODEX_HOME.
function slotLoggedIn(provider: "claude" | "codex", dir: string, accountEmail: string): boolean {
  if (provider === "claude") return accountEmail !== "";
  return existsSync(join(dir, "auth.json"));
}

// Claude records why extra usage is unavailable in its own config — a
// token-free signal that an account has hit a spend limit.
function creditNote(provider: "claude" | "codex", dir: string): string {
  if (provider !== "claude") return "";
  const config = readJson(dir === HOME ? join(HOME, ".claude.json") : join(dir, ".claude.json"));
  if (!config) return "";
  const reason = config.cachedExtraUsageDisabledReason;
  if (typeof reason !== "string" || reason === "") return "";
  if (reason === "out_of_credits") return "extra usage exhausted (may still serve some models)";
  if (reason.startsWith("org_level_disabled")) return "extra usage disabled for this org (may refuse premium models)";
  return `extra usage unavailable (${reason})`;
}

export function envVarFor(provider: "claude" | "codex"): string {
  return provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
}

function collectSlots(): Array<Omit<Slot, "wiredProviderId" | "cooldownUntil" | "launches" | "lastUsed" | "preference" | "nearing" | "creditNote" | "blocked" | "parkReason" | "outputStyle" | "settingsDrift">> {
  const slots: Array<Omit<Slot, "wiredProviderId" | "cooldownUntil" | "launches" | "lastUsed" | "preference" | "nearing" | "creditNote" | "blocked" | "parkReason" | "outputStyle" | "settingsDrift">> = [];
  const seen = new Set<string>();
  const add = (provider: "claude" | "codex", dir: string, source: "agent-link" | "external") => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const email = basename(dir);
    const actualEmail = provider === "claude" ? claudeAccountEmail(dir) : codexAccountEmail(dir);
    const loggedIn = slotLoggedIn(provider, dir, actualEmail);
    slots.push({
      provider,
      email,
      dir,
      source,
      loggedIn,
      actualEmail,
      wrongAccount: loggedIn && actualEmail !== "" && actualEmail !== email,
    });
  };
  for (const provider of ["claude", "codex"] as const) {
    for (const dir of listDirs(join(AGENT_LINK_ROOT, provider))) add(provider, dir, "agent-link");
  }
  for (const { provider, root } of EXTERNAL_ROOTS) {
    for (const dir of listDirs(root)) add(provider, dir, "external");
  }
  return slots;
}

type ProviderOverrides = Record<
  string,
  {
    extends?: string;
    env?: Record<string, string>;
    enabled?: boolean;
    label?: string;
    command?: string[];
    models?: Array<{ id: string; label?: string; description?: string; isDefault?: boolean }>;
  } | undefined
>;

// The daemon returns config FLATTENED — providers live at config.providers,
// even though a patch is written as { agents: { providers } }. Reading the
// nested path silently yielded {} , so every provider looked unconfigured:
// wired accounts showed as unwired and the auto-router always offered "Wire".
async function providerOverrides(paseo: PluginHandlerContext["paseo"]): Promise<ProviderOverrides> {
  const { config } = await paseo.config.get();
  const shape = config as { providers?: ProviderOverrides; agents?: { providers?: ProviderOverrides } };
  return (shape.providers ?? shape.agents?.providers ?? {}) as ProviderOverrides;
}

function providerIdForDir(overrides: ProviderOverrides, provider: "claude" | "codex", dir: string): string | null {
  const envVar = envVarFor(provider);
  for (const [id, override] of Object.entries(overrides)) {
    if (override?.env?.[envVar] === dir) return id;
  }
  return null;
}

function slugForEmail(provider: string, email: string): string {
  return `${provider}-${email.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

// A GUI-launched daemon inherits a minimal PATH, not the user's login PATH, so
// tools installed in /opt/homebrew/bin, ~/.local/bin etc. look "missing".
// Resolve the login shell's PATH once per process.
let cachedSearchPath: string[] | null = null;

export function searchPath(): string[] {
  if (cachedSearchPath === null) {
    let raw = process.env.PATH ?? "";
    try {
      const shell = process.env.SHELL || "/bin/sh";
      const out = execFileSync(shell, ["-lc", 'printf %s "$PATH"'], { encoding: "utf8", timeout: 5000 });
      if (out.trim()) raw = out.trim();
    } catch {
      // Fall back to the inherited PATH.
    }
    const extras = [join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
    cachedSearchPath = [...new Set(raw.split(delimiter).concat(extras).filter(Boolean))];
  }
  return cachedSearchPath;
}

// A slow shell rc can take seconds, so fill the cache once the plugin is up
// rather than leaving the first RPC that needs a PATH lookup to stall on it.
onStart(searchPath);

function agentLinkInstalled(): boolean {
  return searchPath().some((dir) => existsSync(join(dir, "agent-link")) || existsSync(join(dir, "agent-auth")));
}

// ---------------------------------------------------------------- MCP formats

export type McpDef = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
  // Verbatim TOML lines this mini-parser does not model (enabled,
  // startup_timeout_sec, …). Carried through so a rename or a copy never
  // silently drops settings it did not understand.
  extra?: string[];
  // Which subtable this destination keeps HTTP headers in. Codex uses
  // `http_headers`; Grok uses `headers`. Reading the wrong one reports a server
  // as credential-free, and writing the wrong one deletes its token.
  headerTable?: "headers" | "http_headers";
};

/**
 * What each config language actually accepts, in one table so nothing has to
 * guess twice. Measured on this machine: ~/.claude.json holds 19 servers, 18
 * carrying `type`; ~/.codex/config.toml holds 27, 7 of them with an
 * `http_headers` subtable and 26 with `enabled`.
 *
 * Reading is forgiving — either header spelling is understood, so a file
 * already written with the wrong one is recovered rather than reported as
 * credential-free. Writing is strict: only the dialect's own spelling is
 * emitted, and a key the target has no word for is reported as dropped.
 */
export const DIALECTS: Record<
  Dialect,
  {
    format: "json-mcp" | "toml-mcp";
    label: string;
    headerKey: "headers" | "http_headers";
    writesType: boolean;
  }
> = {
  "claude-json": { format: "json-mcp", label: "Claude", headerKey: "headers", writesType: true },
  "kimi-json": { format: "json-mcp", label: "Kimi", headerKey: "headers", writesType: false },
  "codex-toml": { format: "toml-mcp", label: "Codex", headerKey: "http_headers", writesType: false },
  "grok-toml": { format: "toml-mcp", label: "Grok", headerKey: "headers", writesType: false },
};

export function dialectOf(dest: Destination): Dialect {
  if (dest.provider === "claude") return "claude-json";
  if (dest.provider === "kimi") return "kimi-json";
  if (dest.provider === "codex") return "codex-toml";
  if (dest.provider === "grok") return "grok-toml";
  // A destination contributed by some other provider id still has to land in a
  // real language. Path, not provider name, is the reliable tell for Codex.
  if (dest.format === "json-mcp") return dest.configPath.endsWith(".claude.json") ? "claude-json" : "kimi-json";
  return /codex/i.test(dest.configPath) ? "codex-toml" : "grok-toml";
}

/** TOML-only bookkeeping that must never be written into a JSON config. */
export function jsonSafeDef(def: McpDef, dialect: "claude-json" | "other"): McpDef {
  const { extra: _extra, headerTable: _headerTable, ...rest } = def;
  const clean: McpDef = { ...rest };
  // Claude Code needs `type` to treat an entry as HTTP; 18 of the 19 servers in
  // a real config carry it, and an entry that loses it stops loading.
  if (dialect === "claude-json" && !clean.type) clean.type = clean.url ? "http" : "stdio";
  return clean;
}

// json-mcp: a JSON file with a top-level `mcpServers` object. Claude Code's
// ~/.claude.json and Kimi Code's mcp.json both use this shape.
export function jsonMcpRead(path: string): Record<string, McpDef> {
  const config = readJson(path);
  return (config?.mcpServers as Record<string, McpDef> | undefined) ?? {};
}

function jsonMcpWrite(path: string, name: string, def: McpDef | null): void {
  // A file that EXISTS but will not parse must never be overwritten: rewriting
  // it from `{}` would drop everything else it holds (account identity, project
  // history, settings). Missing is fine — that is a genuine first write.
  const config = existsSync(path) ? readJson(path) : {};
  if (config === null) {
    throw new Error(`${path} exists but is not valid JSON — refusing to overwrite it`);
  }
  const servers = (config.mcpServers as Record<string, McpDef> | undefined) ?? {};
  if (def === null) delete servers[name];
  else servers[name] = jsonSafeDef(def, path.endsWith(".claude.json") ? "claude-json" : "other");
  config.mcpServers = servers;
  backupFile(path);
  writeJsonAtomic(path, config);
}

// toml-mcp: [mcp_servers.<name>] tables. Codex and Grok both use this shape.
function tomlString(value: string): string {
  return JSON.stringify(value);
}

// Table headers may be indented — valid TOML, and missing it once caused a
// duplicate table to be appended (which makes the whole file unparseable).
export function tomlMcpNamesFromText(text: string): string[] {
  return [...new Set([...text.matchAll(/^[ \t]*\[mcp_servers\.([^\].]+)/gm)].map((match) => match[1] ?? ""))];
}

export function tomlMcpNames(path: string): string[] {
  try {
    return tomlMcpNamesFromText(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

// TOML basic ("…", escapes) and literal ('…', no escapes) strings.
function tomlUnquote(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return null;
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return null;
}

export function tomlServerBlock(text: string, name: string): { start: number; end: number } | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^[ \\t]*\\[mcp_servers\\.${escaped}(?:\\.[^\\]]+)?\\]`, "m");
  const startMatch = header.exec(text);
  if (!startMatch) return null;
  const start = startMatch.index;
  const rest = text.slice(start);
  const lines = rest.split("\n");
  const next = lines.findIndex((line, index) => {
    if (index === 0) return false;
    return /^\s*\[/.test(line) && !new RegExp(`^\\s*\\[mcp_servers\\.${escaped}[.\\]]`).test(line);
  });
  if (next === -1) return { start, end: text.length };
  const offset = lines.slice(0, next).join("\n").length + 1;
  return { start, end: start + offset };
}

// Minimal parse of one server block — enough to re-create the definition elsewhere.
export function tomlMcpReadOne(path: string, name: string): McpDef | null {
  try {
    return tomlMcpReadOneFromText(readFileSync(path, "utf8"), name);
  } catch {
    return null;
  }
}

// Same parse against a buffer rather than a file, so a computed document can be
// re-read and compared before anything is written to disk.
export function tomlMcpReadOneFromText(text: string, name: string): McpDef | null {
  const block = tomlServerBlock(text, name);
  if (!block) return null;
  const body = text.slice(block.start, block.end);
  const def: McpDef = {};
  const bodyLines = body.split("\n");
  // Top-level lines of the block: everything before the first subtable header.
  const subStart = bodyLines.findIndex((line, index) => index > 0 && /^[ \t]*\[/.test(line));
  const topLines = (subStart === -1 ? bodyLines : bodyLines.slice(0, subStart)).slice(1);
  const extra: string[] = [];
  for (const line of topLines) {
    const pair = /^[ \t]*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!pair) continue;
    const [, key, rawValue] = pair;
    if (key === "url" || key === "command") {
      const value = tomlUnquote(rawValue);
      if (value !== null) def[key] = value;
      continue;
    }
    if (key === "args") {
      const inner = /^\[(.*)\]$/.exec(rawValue.trim());
      if (inner) {
        def.args = [...inner[1].matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'/g)]
          .map((match) => tomlUnquote(match[0]))
          .filter((value): value is string => value !== null);
      }
      continue;
    }
    // Anything else (enabled, startup_timeout_sec, …) survives verbatim.
    extra.push(line.trim());
  }
  if (extra.length > 0) def.extra = extra;
  for (const sub of ["env", "headers", "http_headers"] as const) {
    const subHeader = new RegExp(`^[ \\t]*\\[mcp_servers\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.${sub}\\]`, "m").exec(body);
    if (!subHeader) continue;
    const subBody = body.slice(subHeader.index).split("\n").slice(1);
    const record: Record<string, string> = {};
    for (const line of subBody) {
      if (/^[ \t]*\[/.test(line)) break;
      const pair = /^[ \t]*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (!pair) continue;
      const value = tomlUnquote(pair[2]);
      if (value !== null) record[pair[1]] = value;
    }
    if (Object.keys(record).length === 0) continue;
    if (sub === "env") def.env = record;
    else {
      def.headers = { ...def.headers, ...record };
      def.headerTable = sub;
    }
  }
  // A block we could not read meaningfully must not be treated as a definition:
  // re-serializing an empty def would silently destroy the real one.
  if (!def.command && !def.url) return null;
  return def;
}

// A bare TOML table key. Anything else (dots, quotes, spaces, brackets) would
// either nest the table under a different server or make the file unparseable.
export const TOML_SAFE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Which subtable a brand-new block should use. Codex reads `http_headers`;
 * Grok reads `headers`. Only consulted when neither the file nor the source
 * definition already answers the question.
 */
export function headerTableFor(configPath: string): "headers" | "http_headers" {
  return /codex/i.test(configPath) ? "http_headers" : "headers";
}

// Pure text transform so callers can apply several servers in memory and write once.
// `forceHeaderTable` is how a dialect-aware caller corrects a file that was
// written with the other CLI's spelling; without it the file's own choice wins.
export function tomlApply(
  text: string,
  name: string,
  def: McpDef | null,
  fileHint = "",
  forceHeaderTable?: "headers" | "http_headers",
): string {
  if (!TOML_SAFE_NAME.test(name)) {
    throw new Error(`'${name}' is not a valid TOML table name (letters, numbers, - and _ only)`);
  }
  let next = text;
  // Whichever subtable this file already used for headers wins: rewriting a
  // Codex block's `http_headers` as `headers` deletes the token Codex reads.
  const existingHeaderTable = new RegExp(
    `^[ \\t]*\\[mcp_servers\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(http_headers|headers)\\]`,
    "m",
  ).exec(text)?.[1] as "headers" | "http_headers" | undefined;
  let block = tomlServerBlock(next, name);
  while (block) {
    next = next.slice(0, block.start) + next.slice(block.end);
    block = tomlServerBlock(next, name);
  }
  if (def) {
    const lines = [`\n[mcp_servers.${name}]`];
    if (def.command) lines.push(`command = ${tomlString(def.command)}`);
    if (def.args?.length) lines.push(`args = [${def.args.map(tomlString).join(", ")}]`);
    if (def.url) lines.push(`url = ${tomlString(def.url)}`);
    for (const line of def.extra ?? []) lines.push(line);
    const headerTable = forceHeaderTable ?? existingHeaderTable ?? def.headerTable ?? headerTableFor(fileHint);
    for (const [sub, record] of [
      ["env", def.env],
      [headerTable, def.headers],
    ] as const) {
      if (record && Object.keys(record).length > 0) {
        lines.push(`[mcp_servers.${name}.${sub}]`);
        for (const [key, value] of Object.entries(record)) lines.push(`${key} = ${tomlString(value)}`);
      }
    }
    next = `${next.replace(/\n*$/, "\n")}${lines.join("\n")}\n`;
  }
  return next;
}

// Only a MISSING file may be created from scratch. An unreadable existing file
// is an error, never a reason to replace it.
export function tomlReadForWrite(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${path} exists but could not be read (${error instanceof Error ? error.message : String(error)}) — refusing to overwrite it`);
  }
}

function tomlMcpWrite(path: string, name: string, def: McpDef | null): void {
  const text = tomlReadForWrite(path);
  const next = tomlApply(text, name, def, path); // throws before any write on a bad name
  backupFile(path);
  writeTextAtomic(path, next);
}

// The one-line summary shown in the always-visible list must never carry a
// secret: tokens hide in command args (--header "Authorization: Bearer …",
// --api-key …) and in URL query strings.
const SECRETISH = /(token|secret|key|password|auth|bearer|credential)/i;

export function hasInlineCredentials(def: McpDef | null): boolean {
  if (!def) return false;
  if ((def.env && Object.keys(def.env).length > 0) || (def.headers && Object.keys(def.headers).length > 0)) return true;
  if ((def.args ?? []).some((arg) => SECRETISH.test(arg))) return true;
  if (!def.url) return false;
  try {
    return [...new URL(def.url).searchParams.keys()].some((key) => SECRETISH.test(key));
  } catch {
    // A malformed URL is already surfaced by health/editing. Do not infer auth.
    return false;
  }
}

export function redactDetail(def: McpDef | null): string {
  if (!def) return "";
  if (def.url) return def.url.replace(/\?.*/, "?…");
  if (!def.command) return "";
  const parts: string[] = [def.command];
  const args = def.args ?? [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (SECRETISH.test(arg)) {
      // Redact the flag's value too, whether inline (--key=v) or the next arg.
      parts.push(arg.includes("=") ? `${arg.split("=")[0]}=•••` : `${arg.split(/\s/)[0]} •••`);
      if (!arg.includes("=") && !/\s/.test(arg)) index += 1;
      continue;
    }
    parts.push(arg.replace(/\?.*/, "?…"));
  }
  return parts.join(" ");
}

export function destRead(dest: Destination): Record<string, McpDef> {
  if (dest.format === "json-mcp") return jsonMcpRead(dest.configPath);
  // One read of the file, then every block is parsed from that text.
  let text = "";
  try {
    text = readFileSync(dest.configPath, "utf8");
  } catch {
    return {};
  }
  const defs: Record<string, McpDef> = {};
  for (const name of tomlMcpNamesFromText(text)) {
    const def = tomlMcpReadOneFromText(text, name);
    if (def) defs[name] = def;
  }
  return defs;
}

function destNames(dest: Destination): string[] {
  return dest.format === "json-mcp" ? Object.keys(jsonMcpRead(dest.configPath)) : tomlMcpNames(dest.configPath);
}

export function destWrite(dest: Destination, name: string, def: McpDef | null): void {
  if (dest.format === "json-mcp") jsonMcpWrite(dest.configPath, name, def);
  else tomlMcpWrite(dest.configPath, name, def);
}

// ---------------------------------------------------------------- destinations

export async function buildDestinations(paseo: PluginHandlerContext["paseo"]): Promise<Destination[]> {
  const overrides = await providerOverrides(paseo);
  const destinations: Destination[] = [];
  const seen = new Set<string>();
  const push = (dest: Destination) => {
    if (seen.has(dest.configPath) || !existsSync(dirname(dest.configPath))) return;
    seen.add(dest.configPath);
    destinations.push(dest);
  };

  const enabled = (id: string) => overrides[id]?.enabled !== false;

  // Claude's config sits directly in $HOME, so the generic parent-dir check in
  // push() cannot tell "Claude Code is installed" from "this is a home dir".
  if (enabled("claude") && (existsSync(join(HOME, ".claude.json")) || existsSync(join(HOME, ".claude")))) {
    const account = claudeAccountEmail(HOME);
    push({
      id: join(HOME, ".claude.json"),
      label: `Claude · ${account || "primary"} (primary)`,
      provider: "claude",
      account,
      configPath: join(HOME, ".claude.json"),
      format: "json-mcp",
    });
  }
  if (enabled("codex")) {
    const account = codexAccountEmail(join(HOME, ".codex"));
    push({
      id: join(HOME, ".codex", "config.toml"),
      label: `Codex · ${account || "primary"} (primary)`,
      provider: "codex",
      account,
      configPath: join(HOME, ".codex", "config.toml"),
      format: "toml-mcp",
    });
  }
  if (enabled("kimi") && existsSync(join(HOME, ".kimi-code"))) {
    push({
      id: join(HOME, ".kimi-code", "mcp.json"),
      label: "Kimi Code",
      provider: "kimi",
      account: "",
      configPath: join(HOME, ".kimi-code", "mcp.json"),
      format: "json-mcp",
    });
  }
  if (enabled("grok") && existsSync(join(HOME, ".grok"))) {
    push({
      id: join(HOME, ".grok", "config.toml"),
      label: "Grok",
      provider: "grok",
      account: "",
      configPath: join(HOME, ".grok", "config.toml"),
      format: "toml-mcp",
    });
  }
  // Derived per-account providers (extends claude/codex with a config-dir env).
  for (const [id, override] of Object.entries(overrides)) {
    const base = override?.extends;
    if (base !== "claude" && base !== "codex") continue;
    if (override?.enabled === false) continue;
    const dir = override?.env?.[envVarFor(base)];
    if (!dir) continue;
    const configPath = base === "claude" ? join(dir, ".claude.json") : join(dir, "config.toml");
    const account = base === "claude" ? claudeAccountEmail(dir) : codexAccountEmail(dir);
    push({
      id: configPath,
      label: `${base === "claude" ? "Claude" : "Codex"} · ${account || basename(dir)} (${id})`,
      provider: base,
      account: account || basename(dir),
      configPath,
      format: base === "claude" ? "json-mcp" : "toml-mcp",
    });
  }
  // Slots that exist but are not wired as providers yet.
  for (const slot of collectSlots()) {
    const configPath = slot.provider === "claude" ? join(slot.dir, ".claude.json") : join(slot.dir, "config.toml");
    push({
      id: configPath,
      label: `${slot.provider === "claude" ? "Claude" : "Codex"} · ${slot.email} (slot)`,
      provider: slot.provider,
      account: slot.email,
      configPath,
      format: slot.provider === "claude" ? "json-mcp" : "toml-mcp",
    });
  }
  return destinations;
}

// ---------------------------------------------------------------- handlers

function poolsDir(): string {
  return join(AGENT_LINK_HOME_DIR, "state", "pools");
}

function poolNumber(kind: "count" | "last", provider: string, email: string): number {
  try {
    const raw = readFileSync(join(poolsDir(), `${kind}-${provider}-${email}`), "utf8").trim();
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

type RoutePreference = "preferred" | "standard" | "reserve";

function routePreference(provider: string, key: string): RoutePreference {
  for (const [file, value] of [
    [`prefer-${provider}-first`, "preferred"],
    [`prefer-${provider}-last`, "reserve"],
  ] as const) {
    try {
      if (readFileSync(join(AGENT_LINK_HOME_DIR, "state", file), "utf8").split(/\r?\n/).includes(key)) return value;
    } catch {
      // Missing preference file means the standard group.
    }
  }
  return "standard";
}

function nearingLimit(provider: string, key: string): boolean {
  try {
    const markedAt = Number.parseInt(readFileSync(join(poolsDir(), `nearing-${provider}-${key}`), "utf8").trim(), 10);
    return Number.isFinite(markedAt) && Date.now() / 1000 - markedAt <= 90 * 60;
  } catch {
    return false;
  }
}

function heldReason(provider: string, key: string): string {
  try {
    return readFileSync(join(poolsDir(), `hold-${provider}-${key}`), "utf8").trim();
  } catch {
    return "";
  }
}

function activelyParked(provider: string, key: string): boolean {
  return heldReason(provider, key) !== "" || cooldownUntil(provider, key) > 0;
}

function recentRouteEvents(): RouteEvent[] {
  try {
    return readFileSync(join(poolsDir(), "routes.log"), "utf8")
      .trim()
      .split(/\r?\n/)
      .slice(-20)
      .reverse()
      .flatMap((line) => {
        const [rawAt, provider, email, decision, group, agentId = "", cwd = ""] = line.split("\t");
        const at = Number.parseInt(rawAt ?? "", 10);
        if (!Number.isFinite(at) || (provider !== "claude" && provider !== "codex") || !email) return [];
        if (group !== "preferred" && group !== "standard" && group !== "reserve" && group !== "fallback") return [];
        return [{ at, provider, email, decision: decision || "routed", group, agentId, cwd }];
      });
  } catch {
    return [];
  }
}

export async function handleProbeAccounts({
  provider,
  model,
  parkFailures,
}: {
  provider: "claude" | "codex";
  model: string;
  parkFailures: boolean;
}) {
  if (provider !== "claude") {
    return { ok: false, message: "Codex exposes its quota windows directly; its CLI has no account probe yet.", log: "" };
  }
  const binary = searchPath()
    .flatMap((directory) => [join(directory, "agent-link"), join(directory, "agent-auth")])
    .find(existsSync);
  if (!binary) return { ok: false, message: "Install the AgentLink CLI from this panel before probing accounts.", log: "" };

  const args = ["probe", provider];
  const trimmedModel = model.trim();
  if (trimmedModel || parkFailures) args.push(trimmedModel);
  if (parkFailures) args.push("--park");

  return await new Promise<{ ok: boolean; message: string; log: string }>((done) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENT_LINK_HOME: AGENT_LINK_HOME_DIR },
    });
    let output = "";
    let settled = false;
    const finish = (result: { ok: boolean; message: string; log: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(result);
    };
    const onChunk = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-64 * 1024);
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.once("error", (error) => finish({ ok: false, message: error.message, log: output.trim() }));
    child.once("exit", (code) => {
      const log = output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trim();
      const refused = /CANNOT SERVE/i.test(log);
      finish({
        ok: code === 0,
        message: refused
          ? "Probe complete. Refusing accounts are held out; passing accounts were released."
          : "Probe complete. Every checked account served the model.",
        log,
      });
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, message: "Account probe timed out after 3 minutes.", log: output.trim() });
    }, 180_000);
  });
}

// Which preferences differ from the primary — an account out of step behaves
// differently for no visible reason. The caller reads the primary settings once
// and passes them in, so a scan does not re-read the same file per slot.
function settingsDrift(provider: "claude" | "codex", dir: string, base: Record<string, unknown>): { style: string; drift: string[] } {
  if (provider !== "claude") return { style: "", drift: [] };
  const own = readJson(join(dir, "settings.json")) ?? {};
  const drift = SYNC_SETTINGS_KEYS.filter(
    (key) => key in base && JSON.stringify(own[key]) !== JSON.stringify(base[key]),
  );
  return { style: typeof own.outputStyle === "string" ? own.outputStyle : "", drift };
}

function parkReason(provider: string, email: string): string {
  try {
    return readFileSync(join(poolsDir(), `reason-${provider}-${email}`), "utf8").trim();
  } catch {
    return "";
  }
}

function cooldownUntil(provider: string, email: string): number {
  try {
    const raw = readFileSync(join(poolsDir(), `cooldown-${provider}-${email}`), "utf8").trim();
    const until = Number.parseInt(raw, 10);
    return Number.isFinite(until) && until * 1000 > Date.now() ? until : 0;
  } catch {
    return 0;
  }
}

function autoLauncherPath(provider: "claude" | "codex"): string {
  return join(AGENT_LINK_HOME_DIR, "bin", `${provider}-auto`);
}

// A provider is the auto-router for `provider` when its command points at that
// provider's launcher.
function autoWiredId(overrides: ProviderOverrides, provider: "claude" | "codex"): string | null {
  // Match by launcher filename, not full path: an install whose home differs
  // (~/.agent-auth vs ~/.agent-link) is still the same wired router, and the
  // exact-path compare made a wired provider look unwired.
  const suffix = `/${provider}-auto`;
  for (const [id, override] of Object.entries(overrides)) {
    const command = (override as { command?: string[] } | undefined)?.command;
    if (command?.some((part) => part.endsWith(suffix))) return id;
  }
  return null;
}

export async function handleScan(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  // First panel contact after a daemon start arms the resident limit sentry.
  ensureLimitSentry(paseo);
  const overrides = await providerOverrides(paseo);
  // Everything the sections below share is read once here, not once per section.
  const baseSettings = readJson(join(HOME, ".claude", "settings.json")) ?? {};
  const primaryEmails = { claude: claudeAccountEmail(HOME), codex: codexAccountEmail(join(HOME, ".codex")) };
  const primaryCooldowns = { claude: cooldownUntil("claude", "primary"), codex: cooldownUntil("codex", "primary") };
  // "Out of credits" is not reliable — a flagged account can still serve some
  // models — so parking (set by `agent-link probe --park`, or by hand) is what
  // actually blocks routing.
  const primaryParked = { claude: activelyParked("claude", "primary"), codex: activelyParked("codex", "primary") };
  const slots = collectSlots().map((slot) => {
    const drift = settingsDrift(slot.provider, slot.dir, baseSettings);
    const parked = parkReason(slot.provider, slot.email);
    const until = cooldownUntil(slot.provider, slot.email);
    return {
      ...slot,
      wiredProviderId: providerIdForDir(overrides, slot.provider, slot.dir),
      cooldownUntil: until,
      launches: poolNumber("count", slot.provider, slot.email),
      preference: routePreference(slot.provider, slot.email),
      nearing: nearingLimit(slot.provider, slot.email),
      creditNote: creditNote(slot.provider, slot.dir),
      blocked: heldReason(slot.provider, slot.email) !== "" || until > 0,
      parkReason: parked,
      outputStyle: drift.style,
      settingsDrift: drift.drift,
      lastUsed: poolNumber("last", slot.provider, slot.email),
    };
  });
  const routingSlots = slots.filter((slot) => slot.source === "agent-link");
  const autoRouters = (["claude", "codex"] as const).map((provider) => ({
    provider,
    launcherPath: autoLauncherPath(provider),
    launcherExists: existsSync(autoLauncherPath(provider)),
    wiredProviderId: autoWiredId(overrides, provider),
  }));
  return {
    slots,
    primaryAccounts: primaryEmails,
    primaryCreditNote: creditNote("claude", HOME),
    primaries: (["claude", "codex"] as const).map((provider) => {
      const email = primaryEmails[provider];
      return {
        provider,
        email,
        launches: poolNumber("count", provider, "primary"),
        cooldownUntil: primaryCooldowns[provider],
        blocked: primaryParked[provider],
        parkReason: parkReason(provider, "primary"),
        preference: routePreference(provider, "primary"),
        nearing: nearingLimit(provider, "primary"),
        duplicated: routingSlots.some((slot) => slot.provider === provider && (slot.actualEmail || slot.email) === email),
      };
    }),
    nextUp: (["claude", "codex"] as const).map((provider) => {
      const primaryEmail = primaryEmails[provider];
      const candidates: Array<{ email: string; last: number; preference: RoutePreference; nearing: boolean }> = [];
      const duplicated = routingSlots.some((slot) => slot.provider === provider && (slot.actualEmail || slot.email) === primaryEmail);
      if (primaryEmail && !duplicated && !primaryParked[provider] && primaryCooldowns[provider] === 0) {
        candidates.push({
          email: primaryEmail,
          last: poolNumber("last", provider, "primary"),
          preference: routePreference(provider, "primary"),
          nearing: nearingLimit(provider, "primary"),
        });
      }
      for (const slot of routingSlots) {
        if (slot.provider !== provider || !slot.loggedIn || slot.wrongAccount || slot.blocked || slot.cooldownUntil > 0) continue;
        candidates.push({ email: slot.email, last: slot.lastUsed, preference: slot.preference, nearing: slot.nearing });
      }
      const preferenceRank = { preferred: 0, standard: 1, reserve: 2 } as const;
      const healthy = candidates.filter((candidate) => !candidate.nearing);
      const eligible = healthy.length > 0 ? healthy : candidates;
      eligible.sort((a, b) => preferenceRank[a.preference] - preferenceRank[b.preference] || a.last - b.last);
      return { provider, email: eligible[0]?.email ?? "" };
    }),
    recentRoutes: recentRouteEvents(),
    autoRouters,
    agentAuthInstalled: agentLinkInstalled(),
    needsRestart,
  };
}

export async function handleWireAuto({ provider }: { provider: "claude" | "codex" }, { paseo }: PluginHandlerContext) {
  const launcher = autoLauncherPath(provider);
  if (!existsSync(launcher)) {
    return {
      ok: false,
      message: `no launcher at ${launcher} — run 'agent-link auto' in a terminal to create it`,
    };
  }
  const providerId = `${provider}-auto`;
  await paseo.config.patch({
    agents: {
      providers: {
        [providerId]: {
          extends: provider,
          label: `${provider === "claude" ? "Claude" : "Codex"} (Dynamic Agent Link)`,
          description: `Routes each new agent through health, priority groups and least-recently-used ${provider} targets`,
          command: [launcher],
        },
      },
    },
  } as never);
  needsRestart = true;
  return { ok: true, message: `'${providerId}' wired — restart the Paseo daemon to load it` };
}

const ROUTER_PROVIDER_ID = "agent-router";
const ROUTER_BASE_MODEL = "claude-haiku-4-5";

function agentLinkBinary(): string | null {
  return searchPath()
    .flatMap((directory) => [join(directory, "agent-link"), join(directory, "agent-auth")])
    .find(existsSync) ?? null;
}

async function routerProviderStatus(paseo: PluginHandlerContext["paseo"], message = "") {
  const launcherPath = join(AGENT_LINK_HOME_DIR, "bin", ROUTER_PROVIDER_ID);
  const rulesPath = join(AGENT_LINK_HOME_DIR, "router", "rules.md");
  const overrides = await providerOverrides(paseo);
  let loaded = false;
  try {
    const available = await paseo.providers.listAvailable();
    loaded = available.providers.some((entry: { provider: string }) => entry.provider === ROUTER_PROVIDER_ID);
  } catch {
    // Configured remains useful when an older daemon cannot report availability.
  }
  const installed = existsSync(launcherPath) && existsSync(rulesPath);
  const configured = Boolean(overrides[ROUTER_PROVIDER_ID]);
  return {
    installed,
    configured,
    loaded,
    launcherPath,
    rulesPath,
    baseProvider: "Claude (Dynamic Agent Link)",
    baseModel: "Haiku 4.5",
    message:
      message ||
      (loaded
        ? "AgentRouter is available in Paseo's provider picker."
        : configured
          ? "AgentRouter is configured; reload Paseo to publish it."
          : installed
            ? "The router launcher is ready; add its Paseo provider profile."
            : "AgentRouter is not installed."),
  };
}

export async function handleRouterStatus(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  return routerProviderStatus(paseo);
}

export async function handleRouterInstall(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  const binary = agentLinkBinary();
  if (!binary) return routerProviderStatus(paseo, "Install the AgentLink CLI first.");
  try {
    execFileSync(binary, ["router", "install"], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, AGENT_LINK_HOME: AGENT_LINK_HOME_DIR },
    });
    const launcherPath = join(AGENT_LINK_HOME_DIR, "bin", ROUTER_PROVIDER_ID);
    if (!existsSync(launcherPath)) return routerProviderStatus(paseo, "AgentRouter launcher was not created.");
    await paseo.config.patch({
      agents: {
        providers: {
          [ROUTER_PROVIDER_ID]: {
            extends: "claude",
            label: "AgentRouter (Dynamic Agent Link)",
            description: "Cheap task triage that delegates complex work through Paseo while account choice stays health-routed",
            command: [launcherPath],
            models: [
              {
                id: ROUTER_BASE_MODEL,
                label: "Haiku 4.5 (router)",
                description: "Fast base model for triage and delegation",
                isDefault: true,
              },
            ],
          },
        },
      },
    } as never);
    needsRestart = true;
    return routerProviderStatus(paseo, "AgentRouter installed. Reload Paseo, then choose it like any other provider.");
  } catch (caught) {
    return routerProviderStatus(
      paseo,
      `AgentRouter install failed: ${caught instanceof Error ? caught.message.split("\n")[0] : String(caught)}`,
    );
  }
}

// Create the slot and kick off that CLI's own browser login. The flow opens a
// browser and completes there, so it can be started detached — the panel then
// shows the account as logged in once its config records the identity.
export async function handleAddAccount({ provider, email }: { provider: "claude" | "codex"; email: string }) {
  if (!/^[^\s/\\]+@[^\s/\\]+$/.test(email)) {
    return { ok: false, started: false, message: "that does not look like an account email" };
  }
  const dir = join(AGENT_LINK_ROOT, provider, email);
  try {
    mkdirSync(dir, { recursive: true });
    if (provider === "codex") {
      // Codex slots must keep credentials inside CODEX_HOME.
      const target = join(dir, "config.toml");
      let text = existsSync(target)
        ? readFileSync(target, "utf8")
        : existsSync(join(HOME, ".codex", "config.toml"))
          ? readFileSync(join(HOME, ".codex", "config.toml"), "utf8")
          : "";
      const pin = 'cli_auth_credentials_store = "file"';
      text = /^\s*cli_auth_credentials_store\s*=/m.test(text)
        ? text.replace(/^\s*cli_auth_credentials_store\s*=.*$/m, pin)
        : `${pin}\n${text}`;
      writeTextAtomic(target, text);
    }
  } catch (error) {
    return { ok: false, started: false, message: error instanceof Error ? error.message : String(error) };
  }

  // Deliberately do NOT spawn the login here. Both CLIs finish sign-in by having
  // you paste a code back into the terminal, which a detached process cannot
  // receive — it would sit there looking busy and never complete. Create the
  // slot, hand over the exact command.
  const cli = searchPath().some((entry) => existsSync(join(entry, "agent-link"))) ? "agent-link" : null;
  return {
    ok: true,
    started: false,
    message: cli
      ? `Slot created. Finish in a terminal: agent-link login ${provider} ${email}`
      : `Slot created. Finish in a terminal: ${envVarFor(provider)}="${dir}" ${provider} ${
          provider === "claude" ? `auth login --email ${email}` : "login"
        }`,
  };
}

function updateLineSet(path: string, key: string, present: boolean): void {
  let values: string[] = [];
  try {
    values = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    // A missing file is an empty set.
  }
  const next = values.filter((value) => value !== key);
  if (present) next.push(key);
  if (next.length === 0) rmSync(path, { force: true });
  else writeTextAtomic(path, `${next.join("\n")}\n`);
}

export async function handleSetPreference({
  provider,
  email,
  preference,
}: {
  provider: "claude" | "codex";
  email: string;
  preference: "preferred" | "standard" | "reserve";
}) {
  if (
    email !== "primary" &&
    !collectSlots().some((slot) => slot.source === "agent-link" && slot.provider === provider && slot.email === email)
  ) {
    return { ok: false, message: `no ${provider} target '${email}'` };
  }
  const state = join(AGENT_LINK_HOME_DIR, "state");
  try {
    mkdirSync(state, { recursive: true });
    updateLineSet(join(state, `prefer-${provider}-first`), email, preference === "preferred");
    updateLineSet(join(state, `prefer-${provider}-last`), email, preference === "reserve");
    const label = preference === "preferred" ? "priority" : preference === "reserve" ? "reserve" : "default";
    return { ok: true, message: `${provider} · ${email} moved to the ${label} routing group` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function handleRemoveAccount(
  { provider, email }: { provider: "claude" | "codex"; email: string },
  { paseo }: PluginHandlerContext,
) {
  if (!/^[^/\\]+$/.test(email) || email === "." || email === "..") {
    return { ok: false, message: "invalid account slot" };
  }
  const dir = join(AGENT_LINK_ROOT, provider, email);
  const slot = collectSlots().find(
    (candidate) => candidate.source === "agent-link" && candidate.provider === provider && candidate.email === email && candidate.dir === dir,
  );
  if (!slot) return { ok: false, message: `no managed ${provider} slot '${email}'` };

  const pinned = providerIdForDir(await providerOverrides(paseo), provider, dir);
  if (pinned) {
    return { ok: false, message: `remove the pinned Paseo provider '${pinned}' before removing this slot` };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveRoot = join(AGENT_LINK_HOME_DIR, "removed");
  const archived = join(archiveRoot, `${provider}-${email}-${stamp}`);
  try {
    mkdirSync(archiveRoot, { recursive: true });
    renameSync(dir, archived);

    const state = join(AGENT_LINK_HOME_DIR, "state");
    updateLineSet(join(state, `order-${provider}`), email, false);
    updateLineSet(join(state, `prefer-${provider}-first`), email, false);
    updateLineSet(join(state, `prefer-${provider}-last`), email, false);
    try {
      if (readFileSync(join(state, `route-${provider}`), "utf8").trim() === email) {
        writeTextAtomic(join(state, `route-${provider}`), "primary\n");
      }
    } catch {
      // No fixed route pointed at this slot.
    }
    for (const name of [
      `count-${provider}-${email}`,
      `last-${provider}-${email}`,
      `cooldown-${provider}-${email}`,
      `reason-${provider}-${email}`,
      `hold-${provider}-${email}`,
      `holdcheck-${provider}-${email}`,
      `nearing-${provider}-${email}`,
      `quota-${provider}-${email}.json`,
      `.quota-check-${provider}-${email}`,
    ]) {
      rmSync(join(poolsDir(), name), { force: true });
    }

    let shims = "";
    const cli = searchPath().map((entry) => join(entry, "agent-link")).find((candidate) => existsSync(candidate));
    if (cli) {
      try {
        execFileSync(cli, ["shims"], {
          stdio: "ignore",
          timeout: 10_000,
          env: { ...process.env, AGENT_LINK_HOME: AGENT_LINK_HOME_DIR },
        });
      } catch {
        shims = " Numbered launchers need a refresh: agent-link shims.";
      }
    }
    return { ok: true, message: `${email} removed from routing and archived at ${archived}.${shims}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function handleSetCooldown({
  provider,
  email,
  minutes,
}: {
  provider: "claude" | "codex";
  email: string;
  minutes: number;
}) {
  const file = join(poolsDir(), `cooldown-${provider}-${email}`);
  try {
    if (minutes <= 0) {
      rmSync(file, { force: true });
      rmSync(join(poolsDir(), `hold-${provider}-${email}`), { force: true });
      rmSync(join(poolsDir(), `reason-${provider}-${email}`), { force: true });
      return { ok: true, message: `${email} is back in rotation` };
    }
    mkdirSync(poolsDir(), { recursive: true });
    writeFileSync(file, String(Math.floor(Date.now() / 1000) + minutes * 60));
    return { ok: true, message: `${email} parked for ${minutes}m — auto-routing will skip it` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function handleWireProvider(
  { provider, email, dir }: { provider: "claude" | "codex"; email: string; dir: string },
  { paseo }: PluginHandlerContext,
) {
  const providerId = slugForEmail(provider, email);
  await paseo.config.patch({
    agents: {
      providers: {
        [providerId]: {
          extends: provider,
          label: `${provider === "claude" ? "Claude" : "Codex"} · ${email}`,
          description: `${provider} pinned to ${email} (wired by agent-agent-link)`,
          env: { [envVarFor(provider)]: dir },
        },
      },
    },
  } as never);
  needsRestart = true;
  return { providerId, needsRestart };
}

// Diagnostic payloads are provider-shaped and may echo env values back. Mask
// anything token-like before it reaches the UI.
function redactSecrets(text: string): string {
  return text
    .replace(/("(?:[^"]*(?:token|secret|key|password|auth|credential)[^"]*)"\s*:\s*")([^"]{4,})(")/gi, "$1•••$3")
    .replace(/\b(sk-|pk-|ghp_|gho_|xox[abprs]-)[A-Za-z0-9_-]{8,}/g, "$1•••")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer •••");
}

export async function handleDiagnoseProvider({ providerId }: { providerId: string }, { paseo }: PluginHandlerContext) {
  try {
    const result = await paseo.providers.diagnostic(providerId as never);
    return { summary: redactSecrets(JSON.stringify(result, null, 2)).slice(0, 2000) };
  } catch (error) {
    return { summary: `diagnostic failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// Real per-account activity, read from each account's own transcripts. Quota
// windows are handled separately below; this answers what each account did.
async function usageForClaudeDir(dir: string, sinceMs: number, days: number) {
  const totals = {
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    contextWindow: 0,
    lastActive: 0,
    limitHits: 0,
    limitLast: 0,
    models: new Set<string>(),
    daily: new Array<number>(days).fill(0),
    topProject: "",
  };
  const perProject = new Map<string, number>();
  const projects = join(dir, "projects");
  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(projects).map((entry) => join(projects, entry));
  } catch {
    return totals;
  }
  const dayOf = (ms: number) => {
    const index = days - 1 - Math.floor((Date.now() - ms) / 86_400_000);
    return index >= 0 && index < days ? index : -1;
  };
  for (const projectDir of projectDirs) {
    let files: string[] = [];
    try {
      files = readdirSync(projectDir).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of files) {
      const file = join(projectDir, name);
      let mtime = 0;
      let size = 0;
      try {
        const info = statSync(file);
        mtime = info.mtimeMs;
        size = info.size;
      } catch {
        continue;
      }
      if (mtime < sinceMs || size > 25_000_000) continue;
      totals.sessions += 1;
      totals.lastActive = Math.max(totals.lastActive, Math.floor(mtime / 1000));
      const label = basename(projectDir).split("--").pop() ?? basename(projectDir);
      perProject.set(label, (perProject.get(label) ?? 0) + 1);
      // Stream rather than slurp: a transcript can run to tens of MB, and one
      // readFileSync of that both spikes memory and blocks the event loop.
      try {
        const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
        for await (const line of lines) {
          if (!line) continue;
          // Cheap string test before paying for a JSON parse. A limit only
          // counts on the record Claude stamps for an API error — a chat that
          // merely mentions limits is not a refusal.
          const hasUsage = line.indexOf('"usage"') !== -1;
          const hasLimit =
            line.indexOf('"isApiErrorMessage":true') !== -1 &&
            /spend limit|usage limit|limit reached/i.test(line);
          if (!hasUsage && !hasLimit) continue;
          let entry: { message?: { usage?: Record<string, number>; model?: string }; timestamp?: string };
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          const stamp = entry.timestamp ? Date.parse(entry.timestamp) : mtime;
          if (hasLimit) {
            totals.limitHits += 1;
            totals.limitLast = Math.max(totals.limitLast, Math.floor((Number.isFinite(stamp) ? stamp : mtime) / 1000));
          }
          const usage = entry.message?.usage;
          if (!usage) continue;
          const out = Number(usage.output_tokens ?? 0);
          totals.inputTokens += Number(usage.input_tokens ?? 0);
          totals.outputTokens += out;
          totals.cacheReadTokens += Number(usage.cache_read_input_tokens ?? 0);
          totals.cacheCreationTokens += Number(usage.cache_creation_input_tokens ?? 0);
          totals.reasoningTokens += Number(usage.reasoning_output_tokens ?? 0);
          const bucket = dayOf(Number.isFinite(stamp) ? stamp : mtime);
          if (bucket >= 0) totals.daily[bucket] += out;
          const model = entry.message?.model;
          if (model && model !== "<synthetic>") totals.models.add(model);
        }
      } catch {
        continue;
      }
    }
  }
  totals.topProject = [...perProject.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  return totals;
}

/**
 * Codex stores one rollout JSONL per session. Its token-count events are
 * cumulative, so only the last total in each file is counted; summing every
 * event would multiply usage by the number of turns in the conversation.
 */
async function usageForCodexDir(dir: string, sinceMs: number, days: number) {
  const totals = {
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    contextWindow: 0,
    lastActive: 0,
    limitHits: 0,
    limitLast: 0,
    models: new Set<string>(),
    daily: new Array<number>(days).fill(0),
    topProject: "",
  };
  const perProject = new Map<string, number>();
  const files = listDirs(join(dir, "sessions"))
    .flatMap((year) => listDirs(year))
    .flatMap((month) => listDirs(month))
    .flatMap((day) => {
      try {
        return readdirSync(day)
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => join(day, name));
      } catch {
        return [];
      }
    });
  const dayOf = (ms: number) => {
    const index = days - 1 - Math.floor((Date.now() - ms) / 86_400_000);
    return index >= 0 && index < days ? index : -1;
  };
  for (const file of files) {
    let mtime = 0;
    let size = 0;
    try {
      const info = statSync(file);
      mtime = info.mtimeMs;
      size = info.size;
    } catch {
      continue;
    }
    if (mtime < sinceMs) continue;
    let floor = 0;
    try {
      floor = Number(readFileSync(`${file}.al-moved`, "utf8").trim()) || 0;
    } catch {
      // A native session starts at byte zero.
    }
    if (size <= floor) continue;
    totals.sessions += 1;
    totals.lastActive = Math.max(totals.lastActive, Math.floor(mtime / 1000));
    let cwd = "";
    let model = "";
    let reached = false;
    let latest = {
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
    };
    try {
      // Session metadata is at the head; read only that small prefix for the
      // project name when the cumulative-usage tail will not include it.
      if (floor === 0 && size > 512_000) {
        const head = createInterface({
          input: createReadStream(file, { encoding: "utf8", start: 0, end: Math.min(size - 1, 64_000) }),
          crlfDelay: Infinity,
        });
        for await (const line of head) {
          if (!line.includes('"session_meta"')) continue;
          try {
            const entry = JSON.parse(line) as { type?: string; payload?: { cwd?: string } };
            if (entry.type === "session_meta" && entry.payload?.cwd) cwd = entry.payload.cwd;
          } catch {
            // Keep looking until the metadata line parses.
          }
          if (cwd) break;
        }
      }
      // Codex token counts are cumulative. The final 512 KB gives the latest
      // total without rereading gigabytes of conversations for a dashboard.
      const start = Math.max(floor, size - 512_000);
      const lines = createInterface({ input: createReadStream(file, { encoding: "utf8", start }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line || (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"token_count"'))) {
          continue;
        }
        let entry: {
          type?: string;
          payload?: {
            type?: string;
            cwd?: string;
            model?: string;
            info?: {
              total_token_usage?: Partial<typeof latest>;
              model_context_window?: number;
            };
            rate_limits?: { rate_limit_reached_type?: unknown };
          };
        };
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.type === "session_meta" && entry.payload?.cwd) cwd = entry.payload.cwd;
        if (entry.type === "turn_context" && entry.payload?.model) model = entry.payload.model;
        if (entry.type !== "event_msg" || entry.payload?.type !== "token_count") continue;
        const usage = entry.payload.info?.total_token_usage;
        if (usage) latest = { ...latest, ...usage };
        totals.contextWindow = Math.max(totals.contextWindow, Number(entry.payload.info?.model_context_window ?? 0));
        if (entry.payload.rate_limits?.rate_limit_reached_type) reached = true;
      }
    } catch {
      continue;
    }
    totals.inputTokens += Number(latest.input_tokens ?? 0);
    totals.outputTokens += Number(latest.output_tokens ?? 0);
    totals.cacheReadTokens += Number(latest.cached_input_tokens ?? 0);
    totals.cacheCreationTokens += Number(latest.cache_write_input_tokens ?? 0);
    totals.reasoningTokens += Number(latest.reasoning_output_tokens ?? 0);
    const bucket = dayOf(mtime);
    if (bucket >= 0) totals.daily[bucket] += Number(latest.output_tokens ?? 0);
    if (model) totals.models.add(model);
    if (reached) {
      totals.limitHits += 1;
      totals.limitLast = Math.max(totals.limitLast, Math.floor(mtime / 1000));
    }
    const project = cwd ? basename(cwd) : "";
    if (project) perProject.set(project, (perProject.get(project) ?? 0) + 1);
  }
  totals.topProject = [...perProject.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  return totals;
}

type PoolQuota = {
  at: number;
  model: string;
  plan: string;
  source: string;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string } | null;
  windows: Array<{
    label: string;
    kind: "session" | "weekly" | "other";
    durationMinutes: number | null;
    pct: number;
    resetsAt: number | null;
  }>;
};

function poolQuotaFromRaw(provider: string, raw: Record<string, unknown> | null): PoolQuota | null {
  if (!raw) return null;
  const windows: PoolQuota["windows"] = [];
  for (const [keyName, fallbackMinutes] of [
    ["five_hour", 300],
    ["seven_day", 10_080],
    ["primary", null],
    ["secondary", null],
  ] as const) {
    const value = raw[keyName] as { pct?: number; resets_at?: number; window_minutes?: number } | undefined;
    if (value && typeof value.pct === "number") {
      const legacyMinutes = keyName === "primary" && typeof raw.window_minutes === "number" ? raw.window_minutes : null;
      const durationMinutes = typeof value.window_minutes === "number" ? value.window_minutes : legacyMinutes ?? fallbackMinutes;
      const kind =
        durationMinutes !== null && durationMinutes <= 360
          ? "session"
          : durationMinutes !== null && durationMinutes >= 10_080
            ? "weekly"
            : "other";
      const label = kind === "session" ? "Session limit" : kind === "weekly" ? "Weekly limit" : "Usage limit";
      windows.push({
        label,
        kind,
        durationMinutes,
        pct: value.pct,
        resetsAt: typeof value.resets_at === "number" ? value.resets_at : null,
      });
    }
  }
  const extraWindows = Array.isArray(raw.windows) ? raw.windows : [];
  for (const candidate of extraWindows) {
    if (!candidate || typeof candidate !== "object") continue;
    const value = candidate as Record<string, unknown>;
    if (typeof value.pct !== "number" || typeof value.label !== "string") continue;
    const kind = value.kind === "session" || value.kind === "weekly" ? value.kind : "other";
    const resetsAt = typeof value.resets_at === "number" ? value.resets_at : null;
    if (windows.some((entry) => entry.label === value.label && entry.resetsAt === resetsAt)) continue;
    windows.push({
      label: value.label,
      kind,
      durationMinutes: typeof value.duration_minutes === "number" ? value.duration_minutes : null,
      pct: value.pct,
      resetsAt,
    });
  }
  if (windows.length === 0) return null;
  const credit = raw.credits as { has_credits?: boolean; unlimited?: boolean; balance?: string | number } | undefined;
  return {
    at: typeof raw.at === "number" ? raw.at : 0,
    model: typeof raw.model === "string" ? raw.model : "",
    plan: typeof raw.plan === "string" ? raw.plan : "",
    source:
      typeof raw.source === "string" && raw.source !== ""
        ? raw.source
        : provider === "claude"
          ? "Claude statusline"
          : "Codex rollout",
    credits:
      credit && typeof credit.has_credits === "boolean"
        ? {
            hasCredits: credit.has_credits,
            unlimited: Boolean(credit.unlimited),
            balance: credit.balance === undefined || credit.balance === null ? "" : String(credit.balance),
          }
        : null,
    windows,
  };
}

function epochSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? Math.floor(value / 1000) : value;
  if (typeof value !== "string" || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

/**
 * Claude's interactive /usage view caches the same account limits in
 * .claude.json. Paseo runs Claude in non-interactive mode, so its statusline
 * never executes; this token-free cache is the only exact fallback available
 * without reaching into OAuth credentials or scraping a private API.
 */
function readClaudeCachedQuota(configDir: string): PoolQuota | null {
  const primaryDir = join(HOME, ".claude");
  const path = configDir === HOME || configDir === primaryDir ? join(HOME, ".claude.json") : join(configDir, ".claude.json");
  const config = readJson(path);
  const cached = config?.cachedUsageUtilization as { fetchedAtMs?: unknown; utilization?: Record<string, unknown> } | undefined;
  const utilization = cached?.utilization;
  if (!utilization) return null;
  const windows: PoolQuota["windows"] = [];
  for (const [key, label, kind, durationMinutes] of [
    ["five_hour", "Session limit", "session", 300],
    ["seven_day", "Weekly limit", "weekly", 10_080],
  ] as const) {
    const value = utilization[key] as { utilization?: unknown; resets_at?: unknown } | undefined;
    if (typeof value?.utilization !== "number") continue;
    windows.push({
      label,
      kind,
      durationMinutes,
      pct: value.utilization,
      resetsAt: epochSeconds(value.resets_at),
    });
  }
  const limits = Array.isArray(utilization.limits) ? utilization.limits : [];
  for (const candidate of limits) {
    if (!candidate || typeof candidate !== "object") continue;
    const value = candidate as {
      kind?: unknown;
      percent?: unknown;
      resets_at?: unknown;
      scope?: { model?: { display_name?: unknown } } | null;
    };
    const model = value.scope?.model?.display_name;
    if (typeof model !== "string" || typeof value.percent !== "number") continue;
    windows.push({
      label: `${model} weekly limit`,
      kind: "weekly",
      durationMinutes: 10_080,
      pct: value.percent,
      resetsAt: epochSeconds(value.resets_at),
    });
  }
  if (windows.length === 0) return null;
  return {
    at: epochSeconds(cached?.fetchedAtMs) ?? 0,
    model: "",
    plan: "",
    source: "Claude /usage cache",
    credits: null,
    windows,
  };
}

function readPoolQuota(provider: string, key: string, configDir?: string): PoolQuota | null {
  const stored = poolQuotaFromRaw(provider, readJson(join(poolsDir(), `quota-${provider}-${key}.json`)));
  if (provider !== "claude" || !configDir) return stored;
  const cached = readClaudeCachedQuota(configDir);
  if (!stored) return cached;
  if (!cached) return stored;
  return cached.at > stored.at ? cached : stored;
}

function readHeld(provider: string, key: string): string | null {
  try {
    return readFileSync(join(poolsDir(), `hold-${provider}-${key}`), "utf8").trim() || "held";
  } catch {
    return null;
  }
}

export async function handleAccountCapacity() {
  const shape = (provider: "claude" | "codex", email: string, poolKey: string, isPrimary: boolean, dir: string) => {
    const quota = readPoolQuota(provider, poolKey, dir);
    const held = readHeld(provider, poolKey);
    const cooling = cooldownUntil(provider, poolKey);
    const maxUsed = Math.max(0, ...(quota?.windows.map((entry) => entry.pct) ?? []));
    const stale = quota ? quota.at <= 0 || Date.now() / 1000 - quota.at > 45 * 60 : false;
    const state = held
      ? "held"
      : cooling > 0
        ? "parked"
        : !quota || stale
          ? "unknown"
          : maxUsed >= 85
            ? "nearing"
            : "ready";
    const noTelemetry =
      provider === "claude"
        ? isPrimary
          ? "Paseo runs Claude non-interactively, so it cannot emit statusline quota. Open `claude`, send one message, then refresh."
          : `Paseo runs Claude non-interactively, so it cannot emit statusline quota. Run \`agent-link run claude ${poolKey} claude\`, send one message, then refresh.`
        : "No current usage report. Run one Codex session on this account to refresh it.";
    return {
      provider,
      email,
      isPrimary,
      poolKey,
      state: state as "ready" | "nearing" | "parked" | "held" | "unknown",
      detail: held ?? (cooling > 0 ? parkReason(provider, poolKey) : stale ? "Last report is over 45 minutes old." : quota ? "" : noTelemetry),
      at: quota?.at ?? 0,
      plan: quota?.plan ?? "",
      model: quota?.model ?? "",
      source: quota?.source ?? "",
      credits: quota?.credits ?? null,
      windows: (quota?.windows ?? []).map((entry) => ({
        label: entry.label,
        kind: entry.kind,
        durationMinutes: entry.durationMinutes,
        usedPct: entry.pct,
        resetsAt: entry.resetsAt,
      })),
    };
  };
  const accounts = [];
  const primary = {
    claude: claudeAccountEmail(HOME),
    codex: codexAccountEmail(join(HOME, ".codex")),
  };
  if (primary.claude) accounts.push(shape("claude", primary.claude, "primary", true, HOME));
  if (primary.codex) accounts.push(shape("codex", primary.codex, "primary", true, join(HOME, ".codex")));
  for (const slot of collectSlots()) {
    if (!slot.loggedIn) continue;
    accounts.push(shape(slot.provider, slot.actualEmail || slot.email, slot.email, false, slot.dir));
  }
  return { accounts };
}

export async function handleAccountUsage({ days }: { days: number }) {
  const window = Math.max(1, Math.min(30, days));
  const sinceMs = Date.now() - window * 86_400_000;
  const shape = async (provider: "claude" | "codex", email: string, dir: string, poolKey: string) => {
    const t = provider === "claude" ? await usageForClaudeDir(dir, sinceMs, window) : await usageForCodexDir(dir, sinceMs, window);
    return {
      provider,
      email,
      sessions: t.sessions,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheCreationTokens: t.cacheCreationTokens,
      reasoningTokens: t.reasoningTokens,
      contextWindow: t.contextWindow,
      lastActive: t.lastActive,
      limitHits: t.limitHits,
      limitLast: t.limitLast,
      daily: t.daily,
      topProject: t.topProject,
      models: [...t.models].sort(),
      quota: readPoolQuota(provider, poolKey, dir),
      held: readHeld(provider, poolKey),
    };
  };
  const pending: Array<{ provider: "claude" | "codex"; email: string; dir: string; poolKey: string }> = [];
  const primaryClaude = claudeAccountEmail(HOME);
  const primaryCodexDir = join(HOME, ".codex");
  const primaryCodex = codexAccountEmail(primaryCodexDir);
  if (primaryClaude) pending.push({ provider: "claude", email: primaryClaude, dir: join(HOME, ".claude"), poolKey: "primary" });
  if (primaryCodex) pending.push({ provider: "codex", email: primaryCodex, dir: primaryCodexDir, poolKey: "primary" });
  for (const slot of collectSlots()) {
    if (!slot.loggedIn) continue;
    pending.push({ provider: slot.provider, email: slot.actualEmail || slot.email, dir: slot.dir, poolKey: slot.email });
  }
  // Transcript scans are deliberately sequential: Activity is on-demand and
  // can take a little longer, while parallel multi-account reads recreate the
  // memory and disk-pressure problem this plugin is meant to prevent.
  const accounts = [];
  for (const account of pending) accounts.push(await shape(account.provider, account.email, account.dir, account.poolKey));
  return { accounts };
}

export async function handleProviderHealth(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  const overrides = await providerOverrides(paseo);
  const ids = new Set<string>(["claude", "codex", "kimi", "grok"]);
  for (const [id, override] of Object.entries(overrides)) {
    if (override?.enabled === false) ids.delete(id);
    else ids.add(id);
  }
  for (const skip of ["cursor", "devin", "copilot", "opencode", "pi"]) {
    if (overrides[skip]?.enabled === false) ids.delete(skip);
  }
  // Only providers the daemon actually has. Probing one that was never set up
  // reports its absence ("ACP not enabled") on a red badge — noise, not health,
  // for a CLI the user simply does not use.
  try {
    const known = new Set((await paseo.providers.listAvailable()).providers.map((entry: { provider: string }) => entry.provider));
    for (const id of [...ids]) if (!known.has(id)) ids.delete(id);
  } catch {
    // A daemon without this RPC keeps the unfiltered list.
  }
  const providers = await Promise.all(
    [...ids].map(async (id) => {
      try {
        const result = await paseo.providers.diagnostic(id as never);
        const text = JSON.stringify(result);
        const ok = !/"error"|not logged|login required|unauthorized|failed/i.test(text);
        const models = /"models"\s*:\s*\[/.test(text) ? (text.match(/"id"\s*:/g)?.length ?? 0) : 0;
        const summary = ok ? `ok${models ? ` · ~${models} models` : ""}` : redactSecrets(text).slice(0, 160);
        return { id, label: overrides[id]?.label ?? id, ok, summary };
      } catch (error) {
        return {
          id,
          label: overrides[id]?.label ?? id,
          ok: false,
          summary: `diagnostic failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 160),
        };
      }
    }),
  );
  providers.sort((a, b) => a.id.localeCompare(b.id));
  return { providers };
}

function providerFamily(id: string, overrides: ProviderOverrides): string {
  let current = id;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const parent = overrides[current]?.extends;
    if (!parent || parent === "acp") return current;
    if (parent === "claude" || parent === "codex") return parent;
    if (!overrides[parent]) return current;
    current = parent;
  }
  return id;
}

function providerLabel(id: string, overrides: ProviderOverrides): string {
  if (id === "claude") return "Claude";
  if (id === "codex") return "Codex";
  const configured = overrides[id]?.label;
  if (configured) return configured;
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

export async function handleProviderHeartbeat(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  // listAvailable is a registry lookup, not a diagnostic. That distinction is
  // why this can poll without opening ACP sessions or consuming model quota.
  const available = await paseo.providers.listAvailable();
  const overrides = await providerOverrides(paseo);
  const availableIds = new Set<string>();
  const grouped = new Map<string, Set<string>>();
  const add = (id: string) => {
    const family = providerFamily(id, overrides);
    const ids = grouped.get(family) ?? new Set<string>();
    ids.add(id);
    grouped.set(family, ids);
  };
  for (const entry of available.providers as Array<{ provider: string }>) {
    const id = entry.provider;
    if (overrides[id]?.enabled === false) continue;
    availableIds.add(id);
    add(id);
  }
  // Keep configured additions visible even when their CLI is currently
  // missing. Vanishing a broken provider is precisely the wrong status UI.
  for (const [id, override] of Object.entries(overrides)) {
    if (override?.enabled === false) continue;
    add(id);
  }
  const providers = [...grouped.entries()].map(([id, ids]) => {
    const pooled = id === "claude" || id === "codex";
    const aliases = [...ids].filter((candidate) => candidate !== id).sort();
    const familyAvailable = [...ids].some((candidate) => availableIds.has(candidate));
    const routeLoaded = availableIds.has(`${id}-auto`);
    return {
      id,
      label: providerLabel(id, overrides),
      available: familyAvailable,
      kind: pooled ? ("pooled" as const) : ("single" as const),
      quotaTelemetry: pooled,
      aliases,
      summary: !familyAvailable
        ? "Configured, but unavailable to the daemon; check the provider CLI and PATH, then reload"
        : pooled
          ? routeLoaded
            ? "Provider and dynamic account route are registered"
            : "Provider is registered; dynamic account route is not loaded"
          : "Provider is registered; auth and model response require a manual deep check",
    };
  });
  const rank = (id: string) => (id === "claude" ? 0 : id === "codex" ? 1 : 2);
  providers.sort((a, b) => rank(a.id) - rank(b.id) || a.label.localeCompare(b.label));
  return { checkedAt: Math.floor(Date.now() / 1000), providers };
}

export async function handleMcpMatrix(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  const destinations = await buildDestinations(paseo);
  const nameSets = new Map<string, Set<string>>();
  for (const dest of destinations) nameSets.set(dest.id, new Set(destNames(dest)));
  const allNames = [...new Set([...nameSets.values()].flatMap((set) => [...set]))].sort();
  // Every definition, read once per destination — not once per server × destination.
  const defsByDest = new Map(destinations.map((dest) => [dest.id, destRead(dest)] as const));

  const servers = allNames.map((name) => {
    const presentIn = destinations.filter((dest) => nameSets.get(dest.id)?.has(name)).map((dest) => dest.id);
    // Best definition for display: prefer a json-mcp source.
    let def: McpDef | null = null;
    for (const dest of destinations) {
      const candidate = defsByDest.get(dest.id)?.[name];
      if (candidate) {
        def = candidate;
        if (dest.format === "json-mcp") break;
      }
    }
    const transport: "stdio" | "http" | "unknown" = def?.command ? "stdio" : def?.url ? "http" : "unknown";
    // Key names only — env/header VALUES never leave the handler.
    const inlineCredentialsIn = destinations
      .filter((dest) => hasInlineCredentials(defsByDest.get(dest.id)?.[name] ?? null))
      .map((dest) => dest.id);
    const detail = redactDetail(def).slice(0, 80);
    return {
      name,
      transport,
      detail,
      authStyle: inlineCredentialsIn.length > 0 ? ("inline-credentials" as const) : ("oauth-or-none" as const),
      inlineCredentialsIn,
      presentIn,
    };
  });
  return { destinations, servers };
}

function parseKvLines(text: string | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  for (const line of (text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    record[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return record;
}

function applyDefToTargets(
  destinations: Destination[],
  targets: string[],
  name: string,
  def: McpDef,
): { written: string[]; skipped: string[] } {
  const written: string[] = [];
  const skipped: string[] = [];
  for (const target of targets) {
    const dest = destinations.find((candidate) => candidate.id === target);
    if (!dest) {
      skipped.push(`${target}: unknown destination`);
      continue;
    }
    try {
      destWrite(dest, name, def);
      written.push(dest.label);
    } catch (error) {
      skipped.push(`${dest.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { written, skipped };
}

export async function handleMcpAdd(
  input: { name: string; kind: "stdio" | "http"; command?: string; url?: string; kvLines?: string; targets: string[] },
  { paseo }: PluginHandlerContext,
) {
  if (!/^[A-Za-z0-9_-]+$/.test(input.name)) {
    return { ok: false, message: "name must be letters, numbers, hyphens, underscores" };
  }
  const def: McpDef = {};
  if (input.kind === "stdio") {
    const parts = (input.command ?? "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { ok: false, message: "stdio server needs a command" };
    def.command = parts[0];
    if (parts.length > 1) def.args = parts.slice(1);
    const env = parseKvLines(input.kvLines);
    if (Object.keys(env).length > 0) def.env = env;
  } else {
    if (!input.url?.trim()) return { ok: false, message: "http server needs a URL" };
    def.url = input.url.trim();
    const headers = parseKvLines(input.kvLines);
    if (Object.keys(headers).length > 0) def.headers = headers;
  }
  const destinations = await buildDestinations(paseo);
  const { written, skipped } = applyDefToTargets(destinations, input.targets, input.name, def);
  return {
    ok: written.length > 0,
    message: [
      written.length ? `added '${input.name}' to: ${written.join(", ")} (backups saved)` : "nothing written",
      ...skipped,
    ].join("\n"),
  };
}

export async function handleMcpApply(
  { name, targets, sourceDestId }: { name: string; targets: string[]; sourceDestId?: string },
  { paseo }: PluginHandlerContext,
) {
  const destinations = await buildDestinations(paseo);
  let def: McpDef | null = null;
  if (sourceDestId) {
    const source = destinations.find((candidate) => candidate.id === sourceDestId);
    def = source ? destReadOne(source, name) : null;
    if (!def) return { ok: false, message: `'${name}' not found in the selected source destination` };
  } else {
    def = findDef(destinations, name);
  }
  if (!def) return { ok: false, message: `no existing definition of '${name}' found anywhere` };
  const { written, skipped } = applyDefToTargets(destinations, targets, name, def);
  return {
    ok: written.length > 0,
    message: [
      written.length ? `applied '${name}' to: ${written.join(", ")} (backups saved)` : "nothing written",
      ...skipped,
    ].join("\n"),
  };
}

export async function handleMcpRemove({ name, targets }: { name: string; targets: string[] }, { paseo }: PluginHandlerContext) {
  const destinations = await buildDestinations(paseo);
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const target of targets) {
    const dest = destinations.find((candidate) => candidate.id === target);
    if (!dest) {
      skipped.push(`${target}: unknown destination`);
      continue;
    }
    try {
      destWrite(dest, name, null);
      removed.push(dest.label);
    } catch (error) {
      skipped.push(`${dest.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    ok: removed.length > 0,
    message: [
      removed.length
        ? `removed '${name}' from: ${removed.join(", ")} (backups saved). Note: a running CLI session may rewrite its own config from memory.`
        : "nothing removed",
      ...skipped,
    ].join("\n"),
  };
}

// `preRead` lets a caller that looks up many names read each destination once
// up front instead of once per name.
function findDef(destinations: Destination[], name: string, preRead?: Map<string, Record<string, McpDef>>): McpDef | null {
  let def: McpDef | null = null;
  for (const dest of destinations) {
    const candidate = preRead ? (preRead.get(dest.id)?.[name] ?? null) : destReadOne(dest, name);
    if (candidate) {
      def = candidate;
      if (dest.format === "json-mcp") break;
    }
  }
  return def;
}

export function maskValue(value: string): string {
  return value.length > 4 ? `•••${value.slice(-4)}` : "•••";
}

export function destReadOne(dest: Destination, name: string): McpDef | null {
  return dest.format === "json-mcp" ? (jsonMcpRead(dest.configPath)[name] ?? null) : tomlMcpReadOne(dest.configPath, name);
}

export async function handleMcpDefAll({ name, reveal }: { name: string; reveal: boolean }, { paseo }: PluginHandlerContext) {
  const destinations = await buildDestinations(paseo);
  const rows = destinations.map((dest) => {
    const def = destReadOne(dest, name);
    if (!def) return { destId: dest.id, found: false, kind: "http" as const, command: "", url: "", kvLines: "" };
    const kind = def.command ? ("stdio" as const) : ("http" as const);
    const record = (kind === "stdio" ? def.env : def.headers) ?? {};
    const kvLines = Object.entries(record)
      .map(([key, value]) => `${key}=${reveal ? value : maskValue(value)}`)
      .join("\n");
    return {
      destId: dest.id,
      found: true,
      kind,
      command: def.command ? [def.command, ...(def.args ?? [])].join(" ") : "",
      url: def.url ?? "",
      kvLines,
    };
  });
  return { rows };
}

export async function handleMcpEditOne(
  input: { name: string; destId: string; kind: "stdio" | "http"; command?: string; url?: string; kvLines?: string },
  { paseo }: PluginHandlerContext,
) {
  const destinations = await buildDestinations(paseo);
  const dest = destinations.find((candidate) => candidate.id === input.destId);
  if (!dest) return { ok: false, message: `unknown destination ${input.destId}` };
  // Masked values restore from THIS destination's stored secret — per-account
  // auth settings are the point.
  const stored = destReadOne(dest, input.name);
  const storedRecord = (input.kind === "stdio" ? stored?.env : stored?.headers) ?? {};
  const parsed = parseKvLines(input.kvLines);
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value.startsWith("•••")) {
      // Renaming the key of a masked line would otherwise resolve to "" and
      // silently drop the secret while reporting success.
      if (!(key in storedRecord)) {
        return {
          ok: false,
          message: `'${key}' has no stored value here — press Reveal secrets and paste the real value, or keep the original key name`,
        };
      }
      record[key] = storedRecord[key];
      continue;
    }
    if (value !== "") record[key] = value;
  }
  // Start from what is stored and change only the four things this form owns.
  // Rebuilding the entry from the form dropped every key the form cannot show —
  // `type` (18 of 19 real Claude entries carry it, and an HTTP entry without it
  // stops loading) and Codex's `enabled` (a disabled server came back to life on
  // an unrelated header edit).
  const def: McpDef = { ...(stored ?? {}) };
  if (input.kind === "stdio") {
    const parts = (input.command ?? "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { ok: false, message: "stdio server needs a command" };
    def.command = parts[0];
    if (parts.length > 1) def.args = parts.slice(1);
    else delete def.args;
    delete def.url;
    delete def.headers;
    if (Object.keys(record).length > 0) def.env = record;
    else delete def.env;
  } else {
    if (!input.url?.trim()) return { ok: false, message: "http server needs a URL" };
    def.url = input.url.trim();
    delete def.command;
    delete def.args;
    delete def.env;
    if (Object.keys(record).length > 0) def.headers = record;
    else delete def.headers;
  }
  // Only correct `type` when the transport itself changed: an entry that says
  // "sse" must keep saying "sse" through a header edit.
  if (def.type && (def.type === "stdio") !== (input.kind === "stdio")) def.type = input.kind === "stdio" ? "stdio" : "http";
  try {
    destWrite(dest, input.name, def);
    return { ok: true, message: `updated '${input.name}' in ${dest.label} (backup saved)` };
  } catch (error) {
    return { ok: false, message: `${dest.label}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function handleMcpRename({ name, newName }: { name: string; newName: string }, { paseo }: PluginHandlerContext) {
  if (!/^[A-Za-z0-9_-]+$/.test(newName)) {
    return { ok: false, message: "new name must be letters, numbers, hyphens, underscores" };
  }
  if (newName === name) return { ok: false, message: "new name is the same" };
  const destinations = await buildDestinations(paseo);
  const renamed: string[] = [];
  const skipped: string[] = [];
  for (const dest of destinations) {
    const def = destReadOne(dest, name);
    if (!def) continue;
    if (destReadOne(dest, newName)) {
      skipped.push(`${dest.label}: '${newName}' already exists there`);
      continue;
    }
    try {
      destWrite(dest, newName, def); // write the copy first, then remove the old —
      destWrite(dest, name, null); //   a failure in between leaves both, never neither
      renamed.push(dest.label);
    } catch (error) {
      skipped.push(`${dest.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (renamed.length === 0) return { ok: false, message: ["nothing renamed", ...skipped].join("\n") };
  return {
    ok: true,
    message: [
      `renamed '${name}' → '${newName}' in: ${renamed.join(", ")} (backups saved). OAuth grants keyed to the old name may need re-authorizing in each CLI.`,
      ...skipped,
    ].join("\n"),
  };
}

function binaryOnPath(command: string): boolean {
  if (command.includes("/")) return existsSync(command);
  return searchPath().some((dir) => existsSync(join(dir, command)));
}

async function probeHttp(url: string, headers: Record<string, string> | undefined) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
    const code = response.status;
    if (code === 401 || code === 403) return { status: "auth-required" as const, note: `HTTP ${code} — authentication needed` };
    if (code >= 200 && code < 400) return { status: "ok" as const, note: `HTTP ${code}` };
    if (code === 404 || code === 405 || code === 406) return { status: "ok" as const, note: `reachable (HTTP ${code})` };
    return { status: "warn" as const, note: `HTTP ${code}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "down" as const, note: reason.includes("abort") ? "timeout after 5s" : reason.slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}

export async function handleMcpHealth(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  const destinations = await buildDestinations(paseo);
  const names = [...new Set(destinations.flatMap((dest) => destNames(dest)))].sort();
  const defsByDest = new Map(destinations.map((dest) => [dest.id, destRead(dest)] as const));
  const results = await Promise.all(
    names.map(async (name) => {
      const def = findDef(destinations, name, defsByDest);
      if (!def) return { name, status: "unknown" as const, note: "no readable definition" };
      if (def.command) {
        return binaryOnPath(def.command)
          ? { name, status: "ok" as const, note: `binary '${def.command}' found` }
          : { name, status: "binary-missing" as const, note: `'${def.command}' not on PATH` };
      }
      if (def.url) {
        const probe = await probeHttp(def.url, def.headers);
        return { name, ...probe };
      }
      return { name, status: "unknown" as const, note: "no command or url" };
    }),
  );
  return { results };
}

// Native sync — no agent-auth CLI required (the CLI is an optional companion).
// Copies user-level MCP definitions + project trust from each provider's
// primary config into its account slots. Never credentials.
const SYNC_GLOBAL_FLAGS = ["hasCompletedOnboarding", "bypassPermissionsModeAccepted", "theme", "autoUpdates", "effortLevel"];
// Preferences that should be identical on every account, so an agent behaves
// the same wherever rotation sends it.
const SYNC_SETTINGS_KEYS = ["outputStyle", "includeCoAuthoredBy", "env", "permissions", "model"];

// Seeded into ~/.claude/output-styles once (never overwritten), then synced to
// every account like any other style. Select it with settings.json
// "outputStyle": "concise" — sync carries that setting to all accounts too.
// Earlier versions of the seeded style, byte-exact. A seed that still
// matches one was never touched by the user, so it is safe to upgrade;
// anything else is the user's file and stays theirs.
const CONCISE_STYLE_PREVIOUS: string[] = [`---
name: concise
description: Plain English, short answers, no fluff
---

# Output rules

Write like a good engineer answering a busy colleague:

- Lead with the answer or outcome. Explanation after, only if it changes what the reader does next.
- Plain English, short sentences, short paragraphs. Define a technical term the first time you use it.
- No filler: never restate the question, never announce what you are about to do, never pad with "Certainly", "Great question", or a summary of your own message.
- Match length to the question. One-line question, one-line answer. Only go long when asked, or when skipping detail would mislead.
- No headers, bullets, or tables unless they genuinely organise the content or the user asked for them.
- Keep the precise parts precise: exact file paths with line numbers, exact commands, exact error text. Never paraphrase these.
- When you finish a task: one short line on what changed, and state plainly what was verified and what was not.
- If you hit a usage-limit error, say so in one line and stop; the account router gives the next launch a fresh account.
`];

const CONCISE_STYLE = `---
name: concise
description: Plain English, short answers, no fluff
---

# Output rules

Write like a good engineer answering a busy colleague:

- Lead with the answer or outcome. Explanation after, only if it changes what the reader does next.
- Plain English, short sentences, short paragraphs. Define a technical term the first time you use it.
- No filler: never restate the question, never announce what you are about to do, never pad with "Certainly", "Great question", or a summary of your own message.
- Match length to the question. One-line question, one-line answer. Only go long when asked, or when skipping detail would mislead.
- No headers, bullets, or tables unless they genuinely organise the content or the user asked for them.
- Keep the precise parts precise: exact file paths with line numbers, exact commands, exact error text. Never paraphrase these.
- When you finish a task: one short line on what changed, and state plainly what was verified and what was not.
- If you hit a usage-limit error, say so in one line and stop; the account router gives the next launch a fresh account, and a resumed conversation continues on a healthy one.
- If you were resumed after a usage-limit interruption, continue exactly where you left off; never redo completed work.
- If you orchestrate Paseo subagents and one stops with a usage-limit error, tell it to continue with send_agent_prompt — its relaunch gets a fresh account automatically.
`;

const SYNC_PROJECT_FIELDS = [
  "hasTrustDialogAccepted",
  "hasCompletedProjectOnboarding",
  "allowedTools",
  "mcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "dontCrawlDirectory",
];

// Which MCP servers each ACCOUNT still has to authorize. Claude records this
// per config dir, so it is readable without touching a token — and it is the
// answer to "server X says not connected".
function codexMcpAuth(accountDir: string): Record<string, "connected" | "not-connected" | "unsupported" | "unknown"> {
  const binary = searchPath().map((entry) => join(entry, "codex")).find(existsSync);
  if (!binary) return {};
  try {
    const env = { ...process.env, CODEX_HOME: accountDir };
    const output = execFileSync(binary, ["mcp", "list", "--json"], { encoding: "utf8", timeout: 8_000, maxBuffer: 4 * 1024 * 1024, env });
    const rows = JSON.parse(output) as Array<{ name?: string; auth_status?: string }>;
    return Object.fromEntries(
      rows.flatMap((row) => {
        if (!row.name) return [];
        const raw = row.auth_status ?? "unknown";
        const state =
          raw === "not_logged_in"
            ? "not-connected"
            : raw === "unsupported"
              ? "unsupported"
              : /logged_in|authenticated|connected/i.test(raw)
                ? "connected"
                : "unknown";
        return [[row.name, state]];
      }),
    );
  } catch {
    return {};
  }
}

export async function handleMcpAuth() {
  const readNeeds = (dir: string): string[] => {
    const data = readJson(join(dir, "mcp-needs-auth-cache.json"));
    return data ? Object.keys(data) : [];
  };
  const countServers = (configPath: string): number => Object.keys(jsonMcpRead(configPath)).length;
  const accounts = [] as Array<{
    provider: "claude" | "codex";
    email: string;
    dir: string;
    isPrimary: boolean;
    definedServers: number;
    needsAuth: string[];
    authStatus: Record<string, "connected" | "not-connected" | "unsupported" | "unknown">;
  }>;
  const primaryEmail = claudeAccountEmail(HOME);
  if (primaryEmail) {
    const needsAuth = readNeeds(join(HOME, ".claude"));
    accounts.push({
      provider: "claude",
      email: primaryEmail,
      dir: join(HOME, ".claude"),
      isPrimary: true,
      definedServers: countServers(join(HOME, ".claude.json")),
      needsAuth,
      authStatus: Object.fromEntries(needsAuth.map((name) => [name, "not-connected" as const])),
    });
  }
  for (const slot of collectSlots()) {
    if (slot.provider !== "claude") continue;
    const needsAuth = readNeeds(slot.dir);
    accounts.push({
      provider: "claude",
      email: slot.email,
      dir: slot.dir,
      isPrimary: false,
      definedServers: countServers(join(slot.dir, ".claude.json")),
      needsAuth,
      authStatus: Object.fromEntries(needsAuth.map((name) => [name, "not-connected" as const])),
    });
  }
  const primaryCodexDir = join(HOME, ".codex");
  const primaryCodexEmail = codexAccountEmail(primaryCodexDir);
  if (primaryCodexEmail) {
    accounts.push({
      provider: "codex",
      email: primaryCodexEmail,
      dir: primaryCodexDir,
      isPrimary: true,
      definedServers: tomlMcpNames(join(primaryCodexDir, "config.toml")).length,
      needsAuth: [],
      authStatus: codexMcpAuth(primaryCodexDir),
    });
  }
  for (const slot of collectSlots()) {
    if (slot.provider !== "codex" || !slot.loggedIn) continue;
    accounts.push({
      provider: "codex",
      // The destination is keyed by the slot name. The Agents tab separately
      // flags a slot whose authenticated email does not match that name.
      email: slot.email,
      dir: slot.dir,
      isPrimary: false,
      definedServers: tomlMcpNames(join(slot.dir, "config.toml")).length,
      needsAuth: [],
      authStatus: codexMcpAuth(slot.dir),
    });
  }
  // Project-scoped servers live in a repo's .mcp.json — not managed here, but
  // they still need authorizing per account, so they must be visible.
  const projectServers: Array<{ project: string; name: string }> = [];
  const roots = [join(HOME, ".superset", "projects"), join(HOME, "projects"), join(HOME, "code")];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = join(root, entry, ".mcp.json");
      if (!existsSync(file)) continue;
      for (const name of Object.keys(jsonMcpRead(file))) projectServers.push({ project: entry, name });
    }
  }
  return { accounts, projectServers };
}

/** Resolve project MCP state from Paseo's live workspace registry, never a client path. */
export async function handleMcpWorkspace(
  { workspaceId }: { workspaceId: string },
  { paseo }: PluginHandlerContext,
) {
  const result = await paseo.workspaces.list();
  const entries = (result as {
    entries: Array<{
      id: string;
      name: string;
      workspaceDirectory?: string;
      projectRootPath: string;
    }>;
  }).entries;
  const workspace = entries.find((entry) => entry.id === workspaceId);
  if (!workspace) throw new Error("This Paseo workspace no longer exists.");

  const directory = workspace.workspaceDirectory || workspace.projectRootPath;
  const candidates = [...new Set([directory, workspace.projectRootPath].filter(Boolean))];
  const configPath = candidates.map((candidate) => join(candidate, ".mcp.json")).find(existsSync) ?? "";
  const definitions = configPath ? jsonMcpRead(configPath) : {};
  const servers = Object.entries(definitions)
    .map(([name, def]) => {
      const hasInline = hasInlineCredentials(def);
      return {
        name,
        transport: def.command ? ("stdio" as const) : def.url ? ("http" as const) : ("unknown" as const),
        detail: redactDetail(def).slice(0, 80),
        authStyle: hasInline ? ("inline-credentials" as const) : ("oauth-or-none" as const),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const { accounts } = await handleMcpAuth();
  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      directory,
      projectRootPath: workspace.projectRootPath,
    },
    configPath,
    servers,
    accounts,
  };
}

export async function handleMcpSync(): Promise<{ ok: boolean; log: string }> {
  const logs: string[] = [];
  const slots = collectSlots();
  const primary = readJson(join(HOME, ".claude.json"));
  if (primary) {
    const mcp = (primary.mcpServers as Record<string, unknown> | undefined) ?? {};
    const projects = (primary.projects as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const slot of slots.filter((entry) => entry.provider === "claude")) {
      const path = join(slot.dir, ".claude.json");
      const config = existsSync(path) ? readJson(path) : {};
      if (config === null) {
        logs.push(`claude · ${slot.email}: SKIPPED — ${path} exists but is not valid JSON`);
        continue;
      }
      // Union, not replace: a server that exists only in this account (or an
      // auth header edited per account) must survive a sync.
      const slotServers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
      config.mcpServers = { ...mcp, ...slotServers };
      for (const flag of SYNC_GLOBAL_FLAGS) {
        if (flag in primary) config[flag] = primary[flag];
      }
      const slotProjects = (config.projects as Record<string, Record<string, unknown>> | undefined) ?? {};
      config.projects = slotProjects;
      let trusted = 0;
      for (const [projectPath, entry] of Object.entries(projects)) {
        if (!entry?.hasTrustDialogAccepted) continue;
        trusted += 1;
        const target = slotProjects[projectPath] ?? {};
        slotProjects[projectPath] = target;
        for (const field of SYNC_PROJECT_FIELDS) {
          if (field in entry) target[field] = entry[field];
        }
      }
      backupFile(path);
      writeJsonAtomic(path, config);
      logs.push(`claude · ${slot.email}: ${Object.keys(mcp).length} MCP servers, ${trusted} trusted projects`);
    }
  }
  // settings.json + custom output styles (Claude accounts)
  const primarySettingsPath = join(HOME, ".claude", "settings.json");
  const primarySettings = existsSync(primarySettingsPath) ? readJson(primarySettingsPath) : null;
  if (primarySettings) {
    for (const slot of slots.filter((entry) => entry.provider === "claude")) {
      const target = join(slot.dir, "settings.json");
      const current = existsSync(target) ? (readJson(target) ?? {}) : {};
      let changed = 0;
      for (const key of SYNC_SETTINGS_KEYS) {
        if (key in primarySettings && JSON.stringify(current[key]) !== JSON.stringify(primarySettings[key])) {
          current[key] = primarySettings[key];
          changed += 1;
        }
      }
      if (changed > 0) {
        backupFile(target);
        writeJsonAtomic(target, current);
      }
      logs.push(`claude · ${slot.email}: settings ${changed > 0 ? `updated (${changed})` : "already match"}`);
    }
  }
  // The user-level system prompt. Each config dir has its own CLAUDE.md, so a
  // rotated account without this copy runs with no brief at all.
  const primaryBrief = join(HOME, ".claude", "CLAUDE.md");
  if (existsSync(primaryBrief)) {
    let briefed = 0;
    for (const slot of slots.filter((entry) => entry.provider === "claude")) {
      copyFileSync(primaryBrief, join(slot.dir, "CLAUDE.md"));
      briefed += 1;
    }
    if (briefed > 0) logs.push(`CLAUDE.md (system prompt) synced to ${briefed} account(s)`);
  }
  const primaryStyles = join(HOME, ".claude", "output-styles");
  // Seed the concise style once, so "keep output short" is a setting away on
  // every synced account. Never overwritten: the user's edit wins.
  try {
    mkdirSync(primaryStyles, { recursive: true });
    const seed = join(primaryStyles, "concise.md");
    if (!existsSync(seed)) {
      writeFileSync(seed, CONCISE_STYLE);
    } else if (CONCISE_STYLE_PREVIOUS.includes(readFileSync(seed, "utf8"))) {
      writeFileSync(seed, CONCISE_STYLE);
    }
  } catch {
    // A read-only home is unusual but not a reason to fail the sync.
  }
  if (existsSync(primaryStyles)) {
    let styles: string[] = [];
    try {
      styles = readdirSync(primaryStyles).filter((name) => name.endsWith(".md"));
    } catch {
      styles = [];
    }
    for (const slot of slots.filter((entry) => entry.provider === "claude")) {
      const dest = join(slot.dir, "output-styles");
      mkdirSync(dest, { recursive: true });
      for (const name of styles) copyFileSync(join(primaryStyles, name), join(dest, name));
    }
    if (styles.length > 0) logs.push(`output styles synced (${styles.length})`);
  }

  const codexPrimary = join(HOME, ".codex", "config.toml");
  if (existsSync(codexPrimary)) {
    // Copy only the MCP blocks the slot is missing, never the whole file — the
    // slot's own model/approval settings and per-account servers stay put.
    const pin = 'cli_auth_credentials_store = "file"';
    // One read of the primary file; per-name re-reads made this ~28 reads of it.
    let primaryText = "";
    try {
      primaryText = readFileSync(codexPrimary, "utf8");
    } catch {
      primaryText = "";
    }
    const primaryDefs: Array<[string, McpDef]> = [];
    for (const name of tomlMcpNamesFromText(primaryText)) {
      const def = tomlMcpReadOneFromText(primaryText, name);
      if (def) primaryDefs.push([name, def]);
    }
    for (const slot of slots.filter((entry) => entry.provider === "codex")) {
      const path = join(slot.dir, "config.toml");
      try {
        let text = tomlReadForWrite(path);
        const existing = new Set(tomlMcpNamesFromText(text));
        let added = 0;
        for (const [name, def] of primaryDefs) {
          if (existing.has(name)) continue; // never clobber a per-account definition
          text = tomlApply(text, name, def);
          added += 1;
        }
        text = /^\s*cli_auth_credentials_store\s*=/m.test(text)
          ? text.replace(/^\s*cli_auth_credentials_store\s*=.*$/m, pin)
          : `${text.replace(/\n*$/, "\n")}${pin}\n`;
        backupFile(path);
        writeTextAtomic(path, text);
        const agentsMd = join(HOME, ".codex", "AGENTS.md");
        if (existsSync(agentsMd)) copyFileSync(agentsMd, join(slot.dir, "AGENTS.md"));
        logs.push(`codex · ${slot.email}: ${added} MCP server(s) added, ${existing.size} kept as-is, instructions + pin synced`);
      } catch (error) {
        logs.push(`codex · ${slot.email}: SKIPPED — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (logs.length === 0) return { ok: true, log: "no account slots to sync yet" };
  logs.push("==> user-level definitions & trust only — OAuth tokens never copied");
  return { ok: true, log: logs.join("\n") };
}
