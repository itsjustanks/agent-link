import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliHijack, Connection, CustomModel, RouterStatus } from "./contracts.shared";
import {
  DEAD_PROVIDER_IDS,
  cliForModel,
  isLegacyShim,
  modelLabel,
  normalizeUsage,
  sameModelSet,
} from "./router.logic";
import { applyPowerUp, listPowerUps } from "./powerups.server";
import {
  DEFAULT_ROUTER_PASSWORD,
  ROOT,
  RouterClient,
  SETTINGS_PATH,
  findBinary,
  listStaleShims,
  readSettings,
  removeShim,
  startRouter,
  stopRouter,
  writeSettings,
} from "./router.server";
import { readUptime, readWarnings } from "./uptime.server";

const HOME = homedir();

/**
 * Paseo requires provider IDs to match /^[a-z][a-z0-9-]*$/, so "9router" is
 * rejected outright — a leading digit makes the whole config invalid and takes
 * the CLI down with it. The label carries the branding instead.
 */
const PROVIDER_ID = "ninerouter";
/** The split Codex entry an earlier build wrote; removed on the next sync. */
const LEGACY_CODEX_PROVIDER_ID = "ninerouter-codex";


type ProviderModel = { id?: unknown; label?: unknown };
type ProviderEntry = { models?: ProviderModel[]; additionalModels?: ProviderModel[] } & Record<string, unknown>;
type ProviderOverrides = Record<string, ProviderEntry | undefined>;

/**
 * The daemon returns config flattened — providers live at `config.providers`
 * even though a patch is written as `{agents:{providers}}`. Reading only the
 * nested path silently yields {}, which makes every provider look unconfigured.
 */
async function providerOverrides(paseo: PluginHandlerContext["paseo"]): Promise<ProviderOverrides> {
  const { config } = await paseo.config.get();
  const shape = config as { providers?: ProviderOverrides; agents?: { providers?: ProviderOverrides } };
  return shape.providers ?? shape.agents?.providers ?? {};
}

function listedModels(overrides: ProviderOverrides, provider: string): string[] {
  const entry = overrides[provider];
  const list = entry?.models ?? entry?.additionalModels;
  if (!Array.isArray(list)) return [];
  return list.map((model) => model?.id).filter((id): id is string => typeof id === "string");
}

async function refreshProviders(paseo: PluginHandlerContext["paseo"], providers: string[]): Promise<void> {
  if (providers.length === 0) return;
  try {
    await paseo.providers.refresh({ providers: [...new Set(providers)] } as never);
    await paseo.providers.waitForReady({ timeoutMs: 20_000 } as never);
  } catch {
    // The persisted config is still valid; a later Paseo reload picks it up.
    // Never restart the daemon here — that would kill live agents.
  }
}

// --------------------------------------------------------------- CLI hijack

type ClaudeSettingsResponse = {
  installed?: boolean;
  has9Router?: boolean;
  settingsPath?: string;
  settings?: { env?: Record<string, unknown> };
};

type CodexSettingsResponse = { installed?: boolean; has9Router?: boolean; configPath?: string; config?: string };

/**
 * Which CLIs 9router can route, discovered from the router rather than
 * hardcoded — it knows about far more than Claude and Codex, and the set grows
 * with its releases. Only the two whose config shape this panel understands are
 * switchable here; the rest are reported so the dashboard link means something.
 */
const CLI_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  cline: "Cline",
  kilo: "Kilo",
  droid: "Droid",
  cowork: "Cowork",
  hermes: "Hermes",
  jcode: "JCode",
  devin: "Devin",
  "grok-build": "Grok Build",
  "deepseek-tui": "DeepSeek TUI",
};

/** The two whose settings this panel writes itself; the rest are read-only here. */
const SWITCHABLE = new Set(["claude", "codex"]);

async function readHijack(client: RouterClient): Promise<CliHijack[]> {
  const all = await client.api<Record<string, Record<string, unknown>>>("cli-tools/all-statuses");
  const claude = await client.api<ClaudeSettingsResponse>("cli-tools/claude-settings");
  const env = claude?.settings?.env ?? {};
  const defaults = Object.entries(env)
    .filter(([key, value]) => key.startsWith("ANTHROPIC_DEFAULT_") && typeof value === "string")
    .map(([key, value]) => ({ key, value: String(value) }));

  const rows: CliHijack[] = [];
  for (const [cli, raw] of Object.entries(all ?? {})) {
    if (!raw || typeof raw !== "object") continue;
    const installed = raw.installed === true;
    const switchable = SWITCHABLE.has(cli);
    rows.push({
      cli,
      label: CLI_LABELS[cli] ?? cli,
      installed,
      routed: raw.has9Router === true,
      configPath:
        typeof raw.settingsPath === "string"
          ? raw.settingsPath
          : typeof raw.configPath === "string"
            ? raw.configPath
            : null,
      baseUrl: cli === "claude" && typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : null,
      supported: switchable,
      note: !installed
        ? typeof raw.message === "string"
          ? raw.message
          : "not installed"
        : switchable
          ? ""
          : "switch this one in the 9router dashboard",
      defaultModels: cli === "claude" ? defaults : [],
    });
  }
  // Installed first, then the ones this panel can switch, then by name.
  rows.sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    if (a.supported !== b.supported) return a.supported ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return rows;
}

/**
 * Compare the Claude Code you have against the one 9router claims to be. The
 * advertised version is only observable through an error it causes, so it is
 * read from whatever 9router last recorded rather than probed for.
 */
async function readClientVersion(client: RouterClient | null): Promise<{
  installed: string | null;
  advertised: string | null;
  mismatch: boolean;
}> {
  let installed: string | null = null;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const { stdout } = await run("claude", ["--version"], { timeout: 5_000 });
    installed = stdout.trim().split(/\s+/)[0] ?? null;
  } catch {
    // Claude Code missing or slow: nothing to compare against.
  }
  let advertised: string | null = null;
  if (client) {
    const availability = await client.api<{ models?: Array<{ lastError?: unknown }> }>("models/availability");
    for (const entry of availability?.models ?? []) {
      const error = typeof entry.lastError === "string" ? entry.lastError : "";
      const found = error.match(/Claude Code (\d+\.\d+\.\d+) does not support/);
      if (found) {
        advertised = found[1] ?? null;
        break;
      }
    }
  }
  return {
    installed,
    advertised,
    mismatch: Boolean(installed && advertised && installed !== advertised),
  };
}

// ------------------------------------------------------------------- status

/**
 * 9router ships with a known first-run password that most installs keep. When
 * none is saved and that one works, adopt it: otherwise a fresh install shows
 * a panel that can see nothing until the user types a password we already know.
 */
async function adoptDefaultPassword(): Promise<void> {
  const current = readSettings();
  if (current.password) return;
  const probe = new RouterClient({ ...current, password: DEFAULT_ROUTER_PASSWORD });
  if (!(await probe.health())) return;
  if ((await probe.api<unknown>("providers")) === null) return;
  writeSettings({ password: DEFAULT_ROUTER_PASSWORD });
  const key = await new RouterClient(readSettings()).ensureApiKey();
  if (key) writeSettings({ apiKey: key });
}

export async function handleRouterStatus(_input: unknown, { paseo }: PluginHandlerContext): Promise<RouterStatus> {
  await adoptDefaultPassword();
  const settings = readSettings();
  const client = new RouterClient(settings);
  const binaryPath = findBinary("9router");
  const running = await client.health();

  const overrides = await providerOverrides(paseo);
  const listed = listedModels(overrides, PROVIDER_ID);
  const paseoClaude = listed.filter((id) => cliForModel(id) === "claude");
  const paseoCodex = listed.filter((id) => cliForModel(id) === "codex");
  const staleProviders = DEAD_PROVIDER_IDS.filter((id) => overrides[id] !== undefined);
  const staleShims = listStaleShims(isLegacyShim);

  const clientVersion = await readClientVersion(running ? client : null);
  // Folds this observation into the history file; safe to call every refresh.
  const uptime = readUptime();
  const warnings = readWarnings();

  const empty: RouterStatus = {
    clientVersion,
    binary: { path: binaryPath, version: null },
    running,
    url: settings.url,
    dashboardUrl: `${settings.url}/dashboard`,
    settingsPath: SETTINGS_PATH,
    version: null,
    auth: { configured: client.hasPassword, ok: false, error: running ? client.authError : "9router is not running." },
    apiKey: { present: settings.apiKey !== null, last4: client.keyLast4 },
    connections: [],
    models: { count: 0, ids: [], custom: [] },
    aliases: [],
    combos: [],
    hijack: [],
    uptime,
    warnings,
    paseo: {
      listedModels: { claude: paseoClaude, codex: paseoCodex },
      modelsInSync: false,
      staleProviders,
      staleShims,
    },
  };
  if (!running) return empty;

  const ids = await client.models();
  const providers = await client.api<{ connections?: Array<Record<string, unknown>> }>("providers");
  const connections: Connection[] = [];
  for (const raw of providers?.connections ?? []) {
    const id = typeof raw.id === "string" ? raw.id : null;
    if (!id) continue;
    // Usage is one call per connection; they are independent so run them together.
    connections.push({
      id,
      provider: typeof raw.provider === "string" ? raw.provider : "unknown",
      authType: typeof raw.authType === "string" ? raw.authType : null,
      name: typeof raw.name === "string" ? raw.name : id,
      email: typeof raw.email === "string" ? raw.email : null,
      priority: typeof raw.priority === "number" ? raw.priority : 0,
      isActive: raw.isActive !== false,
      testStatus: typeof raw.testStatus === "string" ? raw.testStatus : null,
      expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null,
      usage: null,
    });
  }
  const usages = await Promise.all(connections.map((entry) => client.api<unknown>(`usage/${entry.id}`)));
  usages.forEach((usage, index) => {
    const target = connections[index];
    if (target) target.usage = normalizeUsage(usage);
  });

  const version = await client.api<{ currentVersion?: string; latestVersion?: string; hasUpdate?: boolean }>("version");
  const customRaw = await client.api<{ models?: Array<Record<string, unknown>> }>("models/custom");
  const custom: CustomModel[] = (customRaw?.models ?? []).map((entry) => ({
    providerAlias: String(entry.providerAlias ?? ""),
    id: String(entry.id ?? ""),
    type: String(entry.type ?? "llm"),
    name: typeof entry.name === "string" ? entry.name : null,
  }));
  const aliasRaw = await client.api<{ aliases?: Record<string, unknown> }>("models/alias");
  const aliases = Object.entries(aliasRaw?.aliases ?? {})
    .filter(([, model]) => typeof model === "string")
    .map(([alias, model]) => ({ alias, model: String(model) }));
  const comboRaw = await client.api<{ combos?: Array<Record<string, unknown>> }>("combos");
  const combos = (comboRaw?.combos ?? []).map((entry) => ({
    name: String(entry.name ?? ""),
    models: Array.isArray(entry.models) ? entry.models.map((model) => String(model)) : [],
  }));

  // What the provider should carry: the explicit selection, or everything.
  const selection = new Set(settings.syncSelection);
  const wantedIds = selection.size === 0 ? ids : ids.filter((id) => selection.has(id));

  return {
    ...empty,
    binary: { path: binaryPath, version: version?.currentVersion ?? null },
    version: version?.currentVersion
      ? {
          current: version.currentVersion,
          latest: version.latestVersion ?? version.currentVersion,
          hasUpdate: version.hasUpdate === true,
        }
      : null,
    auth: { configured: client.hasPassword, ok: providers !== null, error: providers === null ? client.authError : null },
    connections,
    models: { count: ids.length, ids, custom },
    aliases,
    combos,
    hijack: await readHijack(client),
    paseo: {
      listedModels: { claude: paseoClaude, codex: paseoCodex },
      modelsInSync: ids.length > 0 && sameModelSet(listed, wantedIds),
      staleProviders,
      staleShims,
    },
  };
}

// ----------------------------------------------------------------- lifecycle

export async function handleRouterStart({ action }: { action?: "start" | "stop" | "restart" } = {}) {
  const settings = readSettings();
  if (action === "stop") {
    const stopped = await stopRouter(settings.url);
    return { ok: stopped.ok, running: !stopped.ok, message: stopped.message };
  }
  if (action === "restart") {
    // Stop failures are not fatal: the start below still has to prove health,
    // and a server that refused to stop will simply already be listening.
    await stopRouter(settings.url);
    const started = await startRouter(settings.url);
    return { ok: started.ok, running: started.ok, message: started.ok ? "9router restarted." : started.message };
  }
  const result = await startRouter(settings.url);
  return { ok: result.ok, running: result.ok, message: result.message };
}

export async function handleRouterSettingsSave({ url, password }: { url?: string; password?: string }) {
  const next = writeSettings({
    ...(url ? { url: url.replace(/\/+$/, "") } : {}),
    ...(password ? { password } : {}),
  });
  const client = new RouterClient(next);
  if (!(await client.health())) {
    return {
      ok: false,
      message: `Saved, but 9router did not answer at ${next.url}.`,
      apiKey: { present: next.apiKey !== null, last4: client.keyLast4 },
    };
  }
  const key = await client.ensureApiKey();
  if (!key) {
    return {
      ok: false,
      message: client.authError ?? "Could not read an API key — check the dashboard password.",
      apiKey: { present: next.apiKey !== null, last4: client.keyLast4 },
    };
  }
  const saved = writeSettings({ apiKey: key });
  return {
    ok: true,
    message: `Connected to 9router at ${saved.url}.`,
    apiKey: { present: true, last4: key.slice(-4) },
  };
}

// -------------------------------------------------------------- CLI routing

export async function handleRouterRouteCli({ cli, routed }: { cli: string; routed: boolean }) {
  const settings = readSettings();
  const client = new RouterClient(settings);
  if (!(await client.health())) return { ok: false, message: "9router is not running." };

  const path = `cli-tools/${cli}-settings`;
  if (!routed) {
    const result = await client.api<{ success?: boolean }>(path, { method: "DELETE" });
    if (result === null) return { ok: false, message: client.authError ?? `Could not restore ${cli}.` };
    // 9router's reset list misses ANTHROPIC_DEFAULT_FABLE_MODEL, so a restored
    // Claude would still point one model slot at a `cc/` id that no longer
    // resolves. Clear the leftover ourselves.
    if (cli === "claude") await clearOrphanClaudeDefaults();
    return { ok: true, message: `${cli === "claude" ? "Claude Code" : "Codex"} restored to its direct connection.` };
  }

  const key = await client.ensureApiKey();
  if (!key) return { ok: false, message: client.authError ?? "No API key available." };

  if (cli === "claude") {
    const ids = await client.models();
    const pick = (needle: string) => ids.find((id) => id.startsWith("cc/") && id.includes(needle)) ?? null;
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: settings.url,
      ANTHROPIC_AUTH_TOKEN: key,
    };
    for (const [slot, needle] of [
      ["ANTHROPIC_DEFAULT_OPUS_MODEL", "opus"],
      ["ANTHROPIC_DEFAULT_SONNET_MODEL", "sonnet"],
      ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "haiku"],
    ] as const) {
      const model = pick(needle);
      if (model) env[slot] = model;
    }
    const result = await client.apiJson<{ success?: boolean }>(path, "POST", { env });
    if (result === null) return { ok: false, message: client.authError ?? "Could not update Claude Code settings." };
    return { ok: true, message: "Claude Code now runs through 9router." };
  }

  // 9router's codex-settings route destructures {baseUrl, apiKey, model,
  // subagentModel} and rejects the request with 400 "baseUrl, apiKey and model
  // are required" unless the first three are all present. Sending only the URL
  // and key — which this did — fails every time, so routing Codex from the panel
  // never worked. The model is chosen from what the router actually exposes
  // rather than hardcoded, since the available `cx/` ids differ per install.
  const codexIds = await client.models();
  const codexModel =
    codexIds.find((id) => id.startsWith("cx/") && /gpt-5\.6-sol$/.test(id)) ??
    codexIds.find((id) => id.startsWith("cx/") && !id.endsWith("-review")) ??
    codexIds.find((id) => id.startsWith("cx/")) ??
    null;
  if (!codexModel) {
    return {
      ok: false,
      message: "9router exposes no Codex models, so there is nothing to route Codex to. Connect a Codex account first.",
    };
  }

  const result = await client.apiJson<{ success?: boolean }>(path, "POST", {
    baseUrl: `${settings.url}/v1`,
    apiKey: key,
    model: codexModel,
  });
  if (result === null) return { ok: false, message: client.authError ?? "Could not update Codex settings." };
  return { ok: true, message: `Codex now runs through 9router on ${codexModel}.` };
}

/**
 * Remove `ANTHROPIC_DEFAULT_*_MODEL` entries still pointing at 9router ids
 * after a restore. Reads and rewrites only that env block; an unreadable
 * settings.json is left untouched rather than replaced.
 */
async function clearOrphanClaudeDefaults(): Promise<void> {
  const path = join(HOME, ".claude", "settings.json");
  if (!existsSync(path)) return;
  const { readFileSync, writeFileSync, renameSync, statSync } = await import("node:fs");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  const env = parsed.env;
  if (!env || typeof env !== "object") return;
  const record = env as Record<string, unknown>;
  let changed = false;
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith("ANTHROPIC_DEFAULT_")) continue;
    if (typeof value === "string" && /^(cc|cx)\//.test(value)) {
      delete record[key];
      changed = true;
    }
  }
  if (!changed) return;
  const mode = statSync(path).mode & 0o777;
  const tmp = `${path}.tmp-agent-link`;
  writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode });
  renameSync(tmp, path);
}

// ------------------------------------------------------------ Paseo wiring

/**
 * Create a dedicated "9Router" provider rather than editing Paseo's stock
 * Claude and Codex entries.
 *
 * A derived provider (`extends: "claude"` plus an `env` block) is a first-class
 * Paseo provider: it appears in the provider menu under its own name and owns
 * its whole model list. That is the honest shape here — these models come from
 * 9router, not from the Claude sign-in Paseo manages — and it leaves the stock
 * providers untouched for anyone who wants a direct connection alongside.
 *
 * Codex speaks a different wire protocol, so it gets its own entry.
 */
export async function handleRouterSyncModels(_input: unknown, { paseo }: PluginHandlerContext) {
  const settings = readSettings();
  const client = new RouterClient(settings);
  if (!(await client.health())) {
    return { ok: false, claude: 0, codex: 0, removedProviders: [], removedShims: [], message: "9router is not running." };
  }
  const key = settings.apiKey ?? (await client.ensureApiKey());
  if (!key) {
    return {
      ok: false,
      claude: 0,
      codex: 0,
      removedProviders: [],
      removedShims: [],
      message: client.authError ?? "No API key available — save the dashboard password first.",
    };
  }
  const ids = await client.models();
  if (ids.length === 0) {
    return {
      ok: false,
      claude: 0,
      codex: 0,
      removedProviders: [],
      removedShims: [],
      message: "9router reported no models. Connect an account first.",
    };
  }

  // One provider, every pool. 9router translates each pool into the Claude
  // wire format on /v1/messages — verified against cx/ and kimi/ as well as
  // cc/ — so a single Claude-extended provider can serve the whole catalogue.
  // Splitting it by pool would only mirror 9router's internals into a menu.
  const chosen = new Set(settings.syncSelection);
  const wanted = (id: string) => chosen.size === 0 || chosen.has(id);
  const models = ids.filter(wanted).map((id) => ({ id, label: modelLabel(id) }));
  const forClaude = models.filter((model) => cliForModel(model.id) === "claude");
  const forCodex = models.filter((model) => cliForModel(model.id) === "codex");

  const overrides = await providerOverrides(paseo);
  const removedProviders = DEAD_PROVIDER_IDS.filter((id) => overrides[id] !== undefined);
  const patch: Record<string, unknown> = {
    [PROVIDER_ID]: {
      extends: "claude",
      label: "9Router",
      description: "Every model your local 9router serves",
      env: { ANTHROPIC_BASE_URL: settings.url, ANTHROPIC_AUTH_TOKEN: key },
      models,
    },
  };
  // The earlier split provider is gone; remove it rather than leaving a second
  // entry offering a subset of the same catalogue.
  if (overrides[LEGACY_CODEX_PROVIDER_ID] !== undefined) patch[LEGACY_CODEX_PROVIDER_ID] = null;
  // Paseo's own providers keep their 9router models too: emptying that list
  // breaks any existing chat pinned to one of them, because a running agent
  // holds a model id and a provider that no longer offers it fails the turn.
  patch.claude = { additionalModels: forClaude };
  patch.codex = { additionalModels: forCodex };
  for (const id of removedProviders) patch[id] = null;

  await paseo.config.patch({ agents: { providers: patch } } as never);
  await refreshProviders(paseo, [PROVIDER_ID, "claude", "codex"]);

  const removedShims = listStaleShims(isLegacyShim);
  for (const name of removedShims) removeShim(name);

  const notes = [`9Router provider now offers ${models.length} model(s).`];
  if (removedProviders.length > 0) notes.push(`Removed ${removedProviders.join(", ")}.`);
  if (removedShims.length > 0) notes.push(`Retired ${removedShims.length} old shim(s).`);
  return {
    ok: true,
    claude: forClaude.length,
    codex: forCodex.length,
    removedProviders,
    removedShims,
    message: notes.join(" "),
  };
}

// ------------------------------------------------------------------- OAuth

type AuthorizeResponse = {
  authUrl?: string;
  state?: string;
  codeVerifier?: string;
  redirectUri?: string;
  fixedPort?: number;
};

export async function handleRouterConnectStart({ provider }: { provider: "claude" | "codex" }) {
  const client = new RouterClient();
  const query = provider === "codex" ? "?redirect_uri=http://localhost:1455/auth/callback" : "";
  const auth = await client.api<AuthorizeResponse>(`oauth/${provider}/authorize${query}`);
  if (!auth?.authUrl || !auth.state) throw new Error(client.authError ?? `Could not start the ${provider} sign-in.`);

  if (provider === "codex") {
    const port = auth.fixedPort ?? 1455;
    const params = new URLSearchParams({
      app_port: String(port),
      state: auth.state,
      code_verifier: auth.codeVerifier ?? "",
      redirect_uri: auth.redirectUri ?? `http://localhost:${port}/auth/callback`,
    });
    // 9router runs the loopback listener itself, so the browser redirect is
    // captured without this plugin opening a port.
    await client.api(`oauth/codex/start-proxy?${params.toString()}`);
  }

  return {
    provider,
    mode: provider === "codex" ? ("poll" as const) : ("paste-code" as const),
    authUrl: auth.authUrl,
    state: auth.state,
    codeVerifier: auth.codeVerifier ?? null,
    redirectUri: auth.redirectUri ?? "",
  };
}

export async function handleRouterConnectPoll({ provider, state }: { provider: "claude" | "codex"; state: string }) {
  const client = new RouterClient();
  const result = await client.api<{ status?: string; error?: string }>(
    `oauth/${provider}/poll-status?state=${encodeURIComponent(state)}`,
  );
  const status = result?.status;
  if (status === "done") return { status: "done" as const, error: null };
  if (status === "error") return { status: "error" as const, error: result?.error ?? "Sign-in failed." };
  if (status === "pending") return { status: "pending" as const, error: null };
  return { status: "unknown" as const, error: result === null ? client.authError : null };
}

export async function handleRouterConnectComplete(input: {
  provider: "claude" | "codex";
  code: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}) {
  const client = new RouterClient();
  const result = await client.apiJson<{ success?: boolean; error?: string }>(
    `oauth/${input.provider}/exchange`,
    "POST",
    {
      code: input.code,
      state: input.state,
      codeVerifier: input.codeVerifier,
      redirectUri: input.redirectUri,
    },
  );
  if (result?.success) return { ok: true, error: null };
  return { ok: false, error: result?.error ?? client.authError ?? "Sign-in failed." };
}

export async function handleRouterConnectionRemove({ id }: { id: string }) {
  const client = new RouterClient();
  const result = await client.api<{ success?: boolean }>(`providers/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (result === null) return { ok: false, message: client.authError ?? "Could not remove that account." };
  return { ok: true, message: "Account removed from 9router." };
}

// ------------------------------------------------------------------ models

export async function handleRouterModelExpose({
  providerAlias,
  id,
  name,
}: {
  providerAlias: string;
  id: string;
  name?: string;
}) {
  const client = new RouterClient();
  const result = await client.apiJson<{ success?: boolean; error?: string }>("models/custom", "POST", {
    providerAlias,
    id,
    type: "llm",
    ...(name ? { name } : {}),
  });
  if (result?.success) return { ok: true, message: `Exposed ${providerAlias}/${id}.` };
  return { ok: false, message: result?.error ?? client.authError ?? "Could not expose that model." };
}

export async function handleRouterModelUnexpose({
  providerAlias,
  id,
  type,
}: {
  providerAlias: string;
  id: string;
  type?: string;
}) {
  const client = new RouterClient();
  const params = new URLSearchParams({ providerAlias, id, type: type ?? "llm" });
  const result = await client.api<{ success?: boolean }>(`models/custom?${params.toString()}`, { method: "DELETE" });
  if (result === null) return { ok: false, message: client.authError ?? "Could not remove that model." };
  return { ok: true, message: `Removed ${providerAlias}/${id}.` };
}

export async function handleRouterAliasSet({ alias, model }: { alias: string; model: string }) {
  const client = new RouterClient();
  const result = await client.apiJson<{ success?: boolean; error?: string }>("models/alias", "PUT", { alias, model });
  if (result?.success) return { ok: true, message: `${alias} now routes to ${model}.` };
  return { ok: false, message: result?.error ?? client.authError ?? "Could not save that alias." };
}

export async function handleRouterAliasRemove({ alias }: { alias: string }) {
  const client = new RouterClient();
  const result = await client.api<{ success?: boolean }>(`models/alias?alias=${encodeURIComponent(alias)}`, {
    method: "DELETE",
  });
  if (result === null) return { ok: false, message: client.authError ?? "Could not remove that alias." };
  return { ok: true, message: `Removed the ${alias} alias.` };
}

export { ROOT };

// ------------------------------------------------------------------ round 2

export async function handleRouterUsageStats() {
  const client = new RouterClient();
  const raw = await client.api<{
    totalRequests?: number;
    totalCost?: number;
    totalPromptTokens?: number;
    totalCompletionTokens?: number;
    totalCachedTokens?: number;
    byProvider?: Record<string, { requests?: number; cost?: number }>;
    byModel?: Record<string, { requests?: number; cost?: number; lastUsed?: string }>;
  }>("usage/stats");
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    totalRequests: num(raw?.totalRequests),
    totalCost: num(raw?.totalCost),
    totalPromptTokens: num(raw?.totalPromptTokens),
    totalCompletionTokens: num(raw?.totalCompletionTokens),
    totalCachedTokens: num(raw?.totalCachedTokens),
    byProvider: Object.entries(raw?.byProvider ?? {})
      .map(([provider, value]) => ({ provider, requests: num(value?.requests), cost: num(value?.cost) }))
      .sort((a, b) => b.cost - a.cost),
    byModel: Object.entries(raw?.byModel ?? {})
      .map(([model, value]) => ({
        model,
        requests: num(value?.requests),
        cost: num(value?.cost),
        lastUsed: typeof value?.lastUsed === "string" ? value.lastUsed : null,
      }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 12),
  };
}

/**
 * Accounts 9router has parked. Worth surfacing: a hold survives the condition
 * that caused it, so a fixed problem can still look broken until it is cleared.
 */
export async function handleRouterHolds() {
  const client = new RouterClient();
  const raw = await client.api<{ models?: Array<Record<string, unknown>>; unavailableCount?: number }>(
    "models/availability",
  );
  const holds = (raw?.models ?? []).map((entry) => ({
    connectionId: String(entry.connectionId ?? ""),
    provider: String(entry.provider ?? ""),
    model: String(entry.model ?? ""),
    connectionName: String(entry.connectionName ?? entry.connectionId ?? ""),
    status: String(entry.status ?? "unavailable"),
    until: typeof entry.until === "string" ? entry.until : null,
    lastError: String(entry.lastError ?? "").slice(0, 400),
  }));
  return { count: typeof raw?.unavailableCount === "number" ? raw.unavailableCount : holds.length, holds };
}

export async function handleRouterClearHold({
  provider,
  model,
  connectionId,
}: {
  provider: string;
  model: string;
  connectionId?: string;
}) {
  const client = new RouterClient();
  // Two different states look identical in the UI. A model lock is lifted by
  // clearCooldown; a connection parked with testStatus "unavailable" has no
  // lock to lift and is only revived by writing the connection itself.
  const cleared = await client.apiJson<{ ok?: boolean; error?: string }>("models/availability", "POST", {
    action: "clearCooldown",
    provider,
    model,
  });
  let revived = false;
  if (connectionId) {
    const result = await client.apiJson<{ success?: boolean }>(
      `providers/${encodeURIComponent(connectionId)}`,
      "PUT",
      { testStatus: "active", lastError: null, lastErrorAt: null, backoffLevel: 0 },
    );
    revived = result !== null;
  }
  if (cleared?.ok || revived) return { ok: true, message: `Cleared the hold on ${provider}.` };
  return { ok: false, message: cleared?.error ?? client.authError ?? "Could not clear that hold." };
}

export async function handleRouterComboCreate({ name, models }: { name: string; models: string[] }) {
  const client = new RouterClient();
  const result = await client.apiJson<{ success?: boolean; error?: string }>("combos", "POST", {
    name,
    models,
    kind: "fallback",
  });
  if (result?.success !== false && result !== null) {
    return { ok: true, message: `Combo "${name}" now falls back across ${models.length} models.` };
  }
  return { ok: false, message: result?.error ?? client.authError ?? "Could not create that combo." };
}

/**
 * One tiny completion through the router, so "is this model reachable" is
 * answered by the real path rather than by a catalogue entry.
 */
export async function handleRouterTestModel({ model }: { model: string }) {
  const settings = readSettings();
  if (!settings.apiKey) return { ok: false, message: "No API key saved yet.", latencyMs: 0 };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(`${settings.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply with: ok" }] }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const text = await response.text();
    if (!response.ok) {
      // 9router's own error text is the useful part — a version gate, an
      // exhausted account, a missing credential. Pass it through unchanged.
      const detail = text.slice(0, 300).replace(/\s+/g, " ").trim();
      return { ok: false, message: detail || `HTTP ${response.status}`, latencyMs };
    }
    return { ok: true, message: `${model} answered in ${(latencyMs / 1000).toFixed(1)}s.`, latencyMs };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function handleRouterTuning() {
  const client = new RouterClient();
  const raw = await client.api<Record<string, unknown>>("settings");
  const bool = (key: string, fallback = false) => (typeof raw?.[key] === "boolean" ? (raw[key] as boolean) : fallback);
  const str = (key: string, fallback = "") => (typeof raw?.[key] === "string" ? (raw[key] as string) : fallback);
  const num = (key: string, fallback = 0) => (typeof raw?.[key] === "number" ? (raw[key] as number) : fallback);
  return {
    rtkEnabled: bool("rtkEnabled"),
    cavemanEnabled: bool("cavemanEnabled"),
    cavemanLevel: str("cavemanLevel", "lite"),
    ponytailEnabled: bool("ponytailEnabled"),
    ponytailLevel: str("ponytailLevel", "full"),
    headroomEnabled: bool("headroomEnabled"),
    headroomUrl: str("headroomUrl"),
    headroomCompressUserMessages: bool("headroomCompressUserMessages"),
    comboStrategy: str("comboStrategy", "fallback"),
    stickyRoundRobinLimit: num("stickyRoundRobinLimit", 3),
    requireApiKey: bool("requireApiKey"),
  };
}

export async function handleRouterTuningSet(input: Record<string, unknown>) {
  const client = new RouterClient();
  // Only the keys the caller actually set; PATCH merges into 9router's settings.
  const patch = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  if (Object.keys(patch).length === 0) return { ok: true, message: "Nothing to change." };
  const result = await client.apiJson<{ success?: boolean; error?: string }>("settings", "PATCH", patch);
  if (result === null) return { ok: false, message: client.authError ?? "Could not update 9router settings." };
  return { ok: true, message: `Updated ${Object.keys(patch).join(", ")}.` };
}

export async function handleRouterLogs({ limit }: { limit?: number }) {
  const client = new RouterClient();
  const raw = await client.api<{ logs?: unknown[] }>(`translator/console-logs?limit=${limit ?? 200}`);
  const lines = (raw?.logs ?? []).filter((line): line is string => typeof line === "string");
  return { lines: lines.slice(-(limit ?? 200)) };
}

// ------------------------------------------------------------------ round 3

export async function handleRouterKeys() {
  const client = new RouterClient();
  const raw = await client.api<{ keys?: Array<Record<string, unknown>> }>("keys");
  return {
    keys: (raw?.keys ?? []).map((entry) => ({
      id: String(entry.id ?? ""),
      name: String(entry.name ?? "unnamed"),
      // The secret itself never leaves the handler; only its tail identifies it.
      last4: typeof entry.key === "string" ? entry.key.slice(-4) : "",
      isActive: entry.isActive !== false,
      createdAt: typeof entry.createdAt === "string" ? entry.createdAt : null,
    })),
  };
}

export async function handleRouterKeyCreate({ name }: { name: string }) {
  const client = new RouterClient();
  const result = await client.apiJson<{ key?: unknown; name?: string }>("keys", "POST", { name });
  const created = typeof result?.key === "string" ? result.key : null;
  if (!created) return { ok: false, message: client.authError ?? "Could not create that key.", last4: null };
  return { ok: true, message: `Created "${name}".`, last4: created.slice(-4) };
}

export async function handleRouterKeyDelete({ id }: { id: string }) {
  const client = new RouterClient();
  const result = await client.api<{ success?: boolean }>(`keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (result === null) return { ok: false, message: client.authError ?? "Could not delete that key." };
  return { ok: true, message: "Key deleted." };
}

/**
 * The one place a full key is returned, and only because the caller pressed a
 * button meaning "put this on my clipboard". It is never rendered.
 */
export async function handleRouterKeyReveal({ id }: { id: string }) {
  const client = new RouterClient();
  const raw = await client.api<{ keys?: Array<Record<string, unknown>> }>("keys");
  const match = (raw?.keys ?? []).find((entry) => String(entry.id ?? "") === id);
  const key = typeof match?.key === "string" ? match.key : null;
  if (!key) return { ok: false, key: null, message: client.authError ?? "That key is no longer available." };
  return { ok: true, key, message: "Key copied to the clipboard." };
}

export async function handleRouterCombos() {
  const client = new RouterClient();
  const raw = await client.api<{ combos?: Array<Record<string, unknown>> }>("combos");
  return {
    combos: (raw?.combos ?? []).map((entry) => ({
      id: String(entry.id ?? entry.name ?? ""),
      name: String(entry.name ?? ""),
      models: Array.isArray(entry.models) ? entry.models.map((model) => String(model)) : [],
      kind: typeof entry.kind === "string" ? entry.kind : null,
    })),
  };
}

export async function handleRouterComboSave({ id, name, models }: { id?: string; name: string; models: string[] }) {
  const client = new RouterClient();
  const body = { name, models, kind: "fallback" };
  const result = id
    ? await client.apiJson<{ success?: boolean; error?: string }>(`combos/${encodeURIComponent(id)}`, "PUT", body)
    : await client.apiJson<{ success?: boolean; error?: string }>("combos", "POST", body);
  if (result === null) return { ok: false, message: client.authError ?? "Could not save that combo." };
  return { ok: true, message: `Combo "${name}" falls back across ${models.length} model(s).` };
}

export async function handleRouterComboDelete({ id }: { id: string }) {
  const client = new RouterClient();
  const result = await client.api<{ success?: boolean }>(`combos/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (result === null) return { ok: false, message: client.authError ?? "Could not delete that combo." };
  return { ok: true, message: "Combo deleted." };
}

/**
 * Change 9router's dashboard password. The saved copy is only updated after
 * 9router accepts the change — otherwise a failed attempt would leave this
 * panel holding a password that no longer opens anything.
 */
export async function handleRouterPasswordChange({
  currentPassword,
  newPassword,
}: {
  currentPassword: string;
  newPassword: string;
}) {
  if (newPassword.length < 6) return { ok: false, message: "Pick a password of at least 6 characters." };
  const client = new RouterClient();
  const result = await client.apiJson<{ success?: boolean; error?: string }>("settings", "PATCH", {
    currentPassword,
    newPassword,
  });
  if (result === null || result.error) {
    return { ok: false, message: result?.error ?? client.authError ?? "9router refused that password change." };
  }
  writeSettings({ password: newPassword });
  return { ok: true, message: "Password changed and saved." };
}

// ---------------------------------------------------- power-ups & selection

export async function handleRouterPowerUps() {
  return { powerUps: await listPowerUps() };
}

export async function handleRouterPowerUpApply({ id, apply }: { id: string; apply: boolean }) {
  return applyPowerUp(id, apply);
}

/**
 * Which models Sync writes into Paseo. Stored beside the router settings so it
 * survives a reload; empty means "every cc/ and cx/ model", which is what
 * anyone gets before they touch this.
 */
export async function handleRouterSyncSelection() {
  return { selected: readSettings().syncSelection };
}

export async function handleRouterSyncSelectionSet({ selected }: { selected: string[] }) {
  writeSettings({ syncSelection: selected });
  return {
    ok: true,
    message:
      selected.length === 0
        ? "Sync will list every Claude and Codex model."
        : `Sync will list ${selected.length} model(s).`,
  };
}

// -------------------------------------------------------------------- tunnel

export async function handleRouterTunnel() {
  const client = new RouterClient();
  const settings = readSettings();
  const raw = await client.api<{ tunnel?: Record<string, unknown>; tailscale?: Record<string, unknown> }>(
    "tunnel/status",
  );
  const config = await client.api<Record<string, unknown>>("settings");
  const read = (source: Record<string, unknown> | undefined, provider: "cloudflare" | "tailscale") => ({
    provider,
    enabled: source?.settingsEnabled === true || source?.enabled === true,
    running: source?.running === true,
    url: String(source?.publicUrl ?? source?.tunnelUrl ?? ""),
    note:
      provider === "tailscale" && source?.loggedIn === false
        ? "Tailscale is not signed in on this machine."
        : "",
  });
  return {
    tunnels: [read(raw?.tunnel, "cloudflare"), read(raw?.tailscale, "tailscale")],
    requireApiKey: config?.requireApiKey === true,
    localUrl: settings.url,
  };
}

export async function handleRouterTunnelSet({
  provider,
  enabled,
}: {
  provider: "cloudflare" | "tailscale";
  enabled: boolean;
}) {
  const client = new RouterClient();
  if (enabled) {
    // A tunnel without a required bearer key publishes an open proxy onto your
    // subscriptions. Refuse rather than warn: the failure mode is somebody
    // else spending your quota, and it is silent.
    const config = await client.api<Record<string, unknown>>("settings");
    if (config?.requireApiKey !== true) {
      return {
        ok: false,
        message: "Turn on \"API key required on /v1\" first — a tunnel without it is an open proxy onto your accounts.",
      };
    }
  }
  const path =
    provider === "tailscale"
      ? `tunnel/tailscale-${enabled ? "enable" : "disable"}`
      : `tunnel/${enabled ? "enable" : "disable"}`;
  const result = await client.api<{ success?: boolean; error?: string }>(path, { method: "POST" });
  if (result === null) {
    return { ok: false, message: client.authError ?? `Could not ${enabled ? "start" : "stop"} the tunnel.` };
  }
  return {
    ok: true,
    message: enabled ? "Tunnel starting — its public URL appears once it connects." : "Tunnel stopped.",
  };
}

export async function handleRouterRequireApiKey({ required }: { required: boolean }) {
  const client = new RouterClient();
  const result = await client.apiJson<{ success?: boolean; error?: string }>("settings", "PATCH", {
    requireApiKey: required,
  });
  if (result === null) return { ok: false, message: client.authError ?? "Could not change that setting." };
  return {
    ok: true,
    message: required ? "/v1 now requires a bearer key." : "/v1 no longer requires a key — keep it on loopback.",
  };
}

// --------------------------------------------------------- local forward

/**
 * An SSH port-forward to a remote daemon's dashboard.
 *
 * The panel's "Open dashboard" button hands a URL to the client, which opens it
 * on the machine the APP runs on. When the selected host is a remote daemon,
 * its dashboard is bound to that machine's loopback, so the link either reaches
 * the local router by coincidence or fails outright. Forwarding the port makes
 * the same URL mean the right thing from here.
 *
 * One forward at a time, tracked at module scope so it survives across handler
 * calls (the plugin subprocess outlives them) and can be replaced or stopped.
 */
let localForward: { child: ReturnType<typeof spawn>; port: number; target: string } | null = null;

function forwardAlive(): boolean {
  return Boolean(localForward && localForward.child.exitCode === null && !localForward.child.killed);
}

export async function handleRouterLocalForwardStop() {
  if (!forwardAlive()) {
    localForward = null;
    return { ok: true, message: "No forward was running." };
  }
  localForward?.child.kill();
  localForward = null;
  return { ok: true, message: "Forward closed." };
}

export async function handleRouterLocalForward(input: {
  sshTarget: string;
  sshPort: number | null;
  identityFile: string | null;
  remotePort: number;
}) {
  const target = input.sshTarget.trim();
  if (!target) {
    // No SSH route to this daemon. 9router can expose its own dashboard through
    // Cloudflare, so offer that rather than leaving the user stuck — but say
    // plainly that it becomes a public URL, which an accounts dashboard being
    // reachable from the internet deserves.
    const fallback = await cloudflareFallback();
    return {
      ok: fallback.url !== null,
      url: fallback.url,
      localPort: null,
      message: fallback.message,
    };
  }

  // Reuse a live forward to the same host rather than stacking listeners.
  if (forwardAlive() && localForward?.target === target) {
    return {
      ok: true,
      url: `http://127.0.0.1:${localForward.port}/dashboard`,
      localPort: localForward.port,
      message: "Forward already open.",
    };
  }
  if (forwardAlive()) localForward?.child.kill();
  localForward = null;

  // Offset from the remote port so a local router on the standard port keeps
  // working while a remote one is being viewed.
  const localPort = input.remotePort + 1;

  const args = [
    "-N",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    // Without IdentitiesOnly ssh offers every key the agent holds; a host that
    // refuses too many closes the connection, and where fail2ban is watching it
    // bans this machine for the ban window. Measured the hard way.
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ExitOnForwardFailure=yes",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${input.remotePort}`,
  ];
  if (input.identityFile) args.push("-i", input.identityFile);
  if (input.sshPort) args.push("-p", String(input.sshPort));
  args.push(target);

  const child = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"], detached: false });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-2000);
  });

  // Wait for the listener rather than assuming it: ExitOnForwardFailure makes
  // ssh exit when the local port is taken, and reporting success then would
  // hand the user a link to nothing.
  const deadline = Date.now() + 8000;
  for (;;) {
    if (child.exitCode !== null) {
      const detail = stderr.trim().split("\n").pop() ?? `ssh exited (${child.exitCode})`;
      return { ok: false, url: null, localPort: null, message: detail };
    }
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port: localPort });
      const done = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(700);
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
    });
    if (reachable) break;
    if (Date.now() > deadline) {
      child.kill();
      const detail = stderr.trim().split("\n").pop() ?? "the forward did not come up in time";
      return { ok: false, url: null, localPort: null, message: detail };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  localForward = { child, port: localPort, target };
  return {
    ok: true,
    url: `http://127.0.0.1:${localPort}/dashboard`,
    localPort,
    message: `Forwarding ${target}:${input.remotePort} to 127.0.0.1:${localPort}.`,
  };
}

/**
 * When there is no SSH route to a daemon, fall back to 9router's own Cloudflare
 * tunnel rather than spawning cloudflared here — the router already owns that
 * lifecycle, so borrowing it avoids a second orphan-prone process.
 *
 * The quick-tunnel hostname is printed several seconds BEFORE DNS carries it,
 * and a lookup made in that window is cached as NXDOMAIN by whichever resolver
 * asked. So the URL is handed back with that warning rather than probed here;
 * probing it early is what makes it unreachable for the rest of its life.
 */
async function cloudflareFallback(): Promise<{ url: string | null; message: string }> {
  const client = new RouterClient();
  if (!(await client.health())) {
    return { url: null, message: "No SSH target for this host, and 9router is not reachable to expose it." };
  }

  const status = await client.api<{ tunnel?: Record<string, unknown> }>("tunnel/status");
  const existing = status?.tunnel;
  const liveUrl = String(existing?.publicUrl ?? existing?.tunnelUrl ?? "");
  if (existing?.running === true && liveUrl) {
    return { url: `${liveUrl.replace(/\/$/, "")}/dashboard`, message: "Using the Cloudflare tunnel 9router already has open." };
  }

  const started = await client.apiJson<{ success?: boolean }>("tunnel/cloudflare", "POST", { enabled: true });
  if (started === null) {
    return {
      url: null,
      message: client.authError ?? "No SSH target, and the Cloudflare tunnel could not be started. Install cloudflared on that machine or add SSH access.",
    };
  }
  return {
    url: null,
    message:
      "No SSH route, so a Cloudflare tunnel is starting. Its address is public and takes a few seconds to resolve — reopen this in about ten seconds to get the link.",
  };
}
