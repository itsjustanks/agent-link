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
  thinkingFor,
  sameModelSet,
  providerLabel,
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
  const models = ids.filter(wanted).map((id) => ({
    id,
    label: modelLabel(id),
    ...thinkingFor(id),
  }));
  const overrides = await providerOverrides(paseo);
  const removedProviders = DEAD_PROVIDER_IDS.filter((id) => overrides[id] !== undefined);

  // One-shot repair for installs upgraded from a version that wrote 9router
  // model ids into Paseo's built-in providers. We only clear a list this
  // plugin created (every entry is a 9router id); a list the user curated is
  // left alone. Routing the built-in CLIs is 9router's own CLI-tools feature,
  // not ours — it writes ~/.claude/settings.json and ~/.codex/config.toml and
  // can undo both, so the plugin must never duplicate that.
  const polluted = ["claude", "codex"].filter((id) => {
    const extra = (overrides[id] as ProviderEntry | undefined)?.additionalModels;
    // ProviderModel.id is `unknown` (the config is user-editable), so narrow
    // to string before comparing — an entry without a string id is not ours.
    return (
      Array.isArray(extra) &&
      extra.length > 0 &&
      extra.every((m) => typeof m.id === "string" && ids.includes(m.id))
    );
  });
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

  // Paseo's OWN providers are NEVER patched. `claude`, `codex` and every other
  // preloaded provider are left exactly as they ship — this plugin only ever
  // writes its own `9router` provider entry (plus removing entries it created
  // in earlier versions).
  //
  // Earlier versions pushed 9router model ids into `claude` and `codex` via
  // `additionalModels`, which made the built-ins behave unlike a stock install:
  // their menus filled with cc/… and cx/… ids that only resolve while 9router
  // is running and routed. Nothing removed them again, so disconnecting the
  // plugin left both providers permanently polluted with models that then fail
  // the turn. See `cleanupBuiltinProviders` for the one-shot repair.
  //
  // Everything 9router serves is offered by the 9Router provider above: pick
  // that to use the pool, or pick `claude`/`codex` for the vendor path.
  for (const id of removedProviders) patch[id] = null;
  for (const id of polluted) patch[id] = { additionalModels: [] };

  await paseo.config.patch({ agents: { providers: patch } } as never);
  await refreshProviders(paseo, [PROVIDER_ID, ...polluted]);

  const removedShims = listStaleShims(isLegacyShim);
  for (const name of removedShims) removeShim(name);

  const notes = [`9Router provider now offers ${models.length} model(s).`];
  if (polluted.length > 0) {
    notes.push(
      `Restored ${polluted.join(", ")} to stock — an older version had added 9router models to them.`,
    );
  }
  if (removedProviders.length > 0) notes.push(`Removed ${removedProviders.join(", ")}.`);
  if (removedShims.length > 0) notes.push(`Retired ${removedShims.length} old shim(s).`);
  // `claude`/`codex` in this result are the per-CLI model COUNTS the 9Router
  // provider serves — reported for the UI only. They are no longer written
  // into Paseo's built-in providers of the same name.
  return {
    ok: true,
    claude: models.filter((m) => cliForModel(m.id) === "claude").length,
    codex: models.filter((m) => cliForModel(m.id) === "codex").length,
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
let localForward: {
  child: ReturnType<typeof spawn>;
  port: number;
  target: string;
  expiresAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
} | null = null;

function forwardAlive(): boolean {
  return Boolean(localForward && localForward.child.exitCode === null && !localForward.child.killed);
}

/** Drop the forward and its timer together, so neither outlives the other. */
function clearForward(): void {
  if (localForward?.timer) clearTimeout(localForward.timer);
  localForward = null;
}

export async function handleRouterLocalForwardStop() {
  if (!forwardAlive()) {
    clearForward();
    return { ok: true, message: "No forward was running." };
  }
  localForward?.child.kill();
  clearForward();
  return { ok: true, message: "Forward closed." };
}

/**
 * What the panel polls. A forward can die on its own — the timer fires, ssh
 * drops, the network goes — so the panel asks rather than assuming the state it
 * last saw is still true.
 */
export async function handleRouterLocalForwardStatus() {
  if (!forwardAlive()) {
    clearForward();
    return { open: false, url: null, localPort: null, target: null, expiresAt: null };
  }
  const state = localForward!;
  return {
    open: true,
    url: `http://127.0.0.1:${state.port}/dashboard`,
    localPort: state.port,
    target: state.target,
    expiresAt: state.expiresAt ? new Date(state.expiresAt).toISOString() : null,
  };
}

export async function handleRouterLocalForward(input: {
  sshTarget: string;
  sshPort: number | null;
  identityFile: string | null;
  remotePort: number;
  ttlMinutes: number | null;
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
      expiresAt: null,
      message: fallback.message,
    };
  }

  // Reuse a live forward to the same host rather than stacking listeners.
  if (forwardAlive() && localForward?.target === target) {
    return {
      ok: true,
      url: `http://127.0.0.1:${localForward.port}/dashboard`,
      localPort: localForward.port,
      expiresAt: localForward.expiresAt ? new Date(localForward.expiresAt).toISOString() : null,
      message: "Forward already open.",
    };
  }
  if (forwardAlive()) localForward?.child.kill();
  clearForward();

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
      return { ok: false, url: null, localPort: null, expiresAt: null, message: detail };
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
      return { ok: false, url: null, localPort: null, expiresAt: null, message: detail };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // A forward is a hole to an accounts dashboard. Default it to a short life so
  // a closed tab does not leave one open for the rest of the session; the timer
  // is cleared with the forward so a manual stop cannot leave it armed against
  // a later, unrelated forward.
  const ttl = input.ttlMinutes && input.ttlMinutes > 0 ? Math.min(input.ttlMinutes, 240) : null;
  const expiresAt = ttl ? Date.now() + ttl * 60_000 : null;
  const timer = ttl
    ? setTimeout(() => {
        if (localForward?.child === child) {
          child.kill();
          clearForward();
        }
      }, ttl * 60_000)
    : null;
  // Node keeps the event loop alive for a pending timer; this one must not hold
  // the plugin subprocess open on its own.
  timer?.unref?.();

  // ssh can die without us asking — the network drops, the far host reboots.
  // Reflect that rather than reporting a forward that is no longer there.
  child.once("exit", () => {
    if (localForward?.child === child) clearForward();
  });

  localForward = { child, port: localPort, target, expiresAt, timer };
  const window = ttl ? ` Closes in ${ttl} min.` : "";
  return {
    ok: true,
    url: `http://127.0.0.1:${localPort}/dashboard`,
    localPort,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    message: `Forwarding ${target}:${input.remotePort} to 127.0.0.1:${localPort}.${window}`,
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

/**
 * Refresh 9router's upstream model catalogue.
 *
 * Paseo's model list is a snapshot taken by `sync-models`, so a model the
 * router learns later is invisible until the next sync. Refreshing the
 * catalogue first makes that sync see everything currently on offer.
 */
export async function handleRouterCatalogSync() {
  const client = new RouterClient();
  if (!(await client.health())) {
    return { ok: false, message: "9router is not running.", models: 0 };
  }
  const result = await client.api<{ success?: boolean; result?: unknown; error?: string }>(
    "models/catalog-sync",
  );
  if (!result) {
    return { ok: false, message: client.authError ?? "Catalogue refresh failed.", models: 0 };
  }
  // Count from /v1/models rather than the sync payload: that is the list Paseo
  // will actually publish, so it is the number worth reporting.
  const models = (await client.models()).length;
  return { ok: true, message: `Catalogue refreshed — ${models} model(s) on offer.`, models };
}

/**
 * Per-connection health.
 *
 * The fields that decide whether a model answers live on the connection, not
 * the model: an expired token, an active backoff, or a model lock pinning the
 * account to one model regardless of what was asked for. None of that is
 * visible in Paseo's model picker.
 */
export async function handleRouterConnectionHealth() {
  const client = new RouterClient();
  const raw = await client.api<{
    connections?: Array<Record<string, unknown>>;
    providers?: Array<Record<string, unknown>>;
  }>("providers");
  const rows = raw?.connections ?? raw?.providers ?? [];
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

  return {
    connections: rows.map((row) => {
      const data = (row.data ?? {}) as Record<string, unknown>;
      // A lock is stored as a `modelLock_<id>` key on the connection's blob,
      // which is why it never shows up as a model property anywhere.
      const modelLocks = Object.keys(data)
        .filter((key) => key.startsWith("modelLock_"))
        .map((key) => key.slice("modelLock_".length));
      const expiresAt = Date.parse(text(data.expiresAt));
      return {
        id: text(row.id),
        provider: text(row.provider),
        name: text(row.name),
        email: text(row.email),
        isActive: row.isActive !== false && row.isActive !== 0,
        expiresInMinutes: Number.isFinite(expiresAt)
          ? Math.round((expiresAt - Date.now()) / 60_000)
          : null,
        backoffLevel: num(data.backoffLevel),
        lastError: text(data.lastError),
        lastErrorAt: text(data.lastErrorAt) || null,
        modelLocks,
      };
    }),
  };
}

/** Recent requests, so a failure can be read rather than inferred from a 404. */
export async function handleRouterRequestLogs({
  limit,
  errorsOnly,
}: {
  limit?: number;
  errorsOnly?: boolean;
}) {
  const client = new RouterClient();
  const size = Math.min(Math.max(limit ?? 25, 1), 100);
  const raw = await client.api<unknown>(`usage/request-logs?limit=${size}`);
  // The endpoint has returned both a bare array and a wrapped object across
  // versions; accept either rather than break on an upgrade.
  const rows: Array<Record<string, unknown>> = Array.isArray(raw)
    ? (raw as Array<Record<string, unknown>>)
    : ((raw as { logs?: unknown[]; requests?: unknown[] } | null)?.logs as Array<Record<string, unknown>>) ??
      ((raw as { requests?: unknown[] } | null)?.requests as Array<Record<string, unknown>>) ??
      [];

  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const maybeNum = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

  const requests = rows.map((row) => ({
    id: text(row.id) || text(row.requestId),
    at: text(row.createdAt) || text(row.at) || text(row.timestamp),
    model: text(row.model),
    provider: text(row.provider) || text(row.providerAlias),
    status: maybeNum(row.statusCode ?? row.status),
    latencyMs: maybeNum(row.latencyMs ?? row.duration),
    inputTokens: maybeNum(row.promptTokens ?? row.inputTokens),
    outputTokens: maybeNum(row.completionTokens ?? row.outputTokens),
    error: text(row.error) || text(row.errorMessage),
  }));

  return {
    requests: errorsOnly
      ? requests.filter((entry) => entry.error !== "" || (entry.status !== null && entry.status >= 400))
      : requests,
  };
}

/** Connections in the order 9router will try them. */
export async function handleRouterConnectionOrder() {
  const client = new RouterClient();
  const raw = await client.api<{
    connections?: Array<Record<string, unknown>>;
    providers?: Array<Record<string, unknown>>;
  }>("providers");
  const rows = raw?.connections ?? raw?.providers ?? [];
  const text = (value: unknown) => (typeof value === "string" ? value : "");

  return {
    connections: rows
      .map((row) => ({
        id: text(row.id),
        provider: text(row.provider),
        // Prefer the account's email: with several accounts on one provider it
        // is the only label that says which is which.
        label: text(row.email) || text(row.name) || text(row.id).slice(0, 8),
        priority: typeof row.priority === "number" ? row.priority : 99,
        isActive: row.isActive !== false && row.isActive !== 0,
      }))
      .sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label)),
  };
}

/**
 * Change one connection's priority or active flag.
 *
 * 9router's PUT replaces the record, so the current one is read first and the
 * single field merged in — sending a bare `{priority}` would blank the
 * account's credentials.
 */
async function updateConnection(
  id: string,
  patch: Record<string, unknown>,
  describe: (label: string) => string,
) {
  const client = new RouterClient();
  const current = await client.api<Record<string, unknown>>(`providers/${encodeURIComponent(id)}`);
  if (!current) {
    return { ok: false, message: client.authError ?? `No connection ${id}.` };
  }
  const body = { ...(current.provider ? current : (current.connection as object) ?? current), ...patch };
  const saved = await client.apiJson<{ error?: string }>(
    `providers/${encodeURIComponent(id)}`,
    "PUT",
    body,
  );
  if (!saved) {
    return { ok: false, message: client.authError ?? "Update refused." };
  }
  const label =
    (typeof current.email === "string" && current.email) ||
    (typeof current.name === "string" && current.name) ||
    id.slice(0, 8);
  return { ok: true, message: describe(label) };
}

export async function handleRouterConnectionPrioritySet({
  id,
  priority,
}: {
  id: string;
  priority: number;
}) {
  return updateConnection(id, { priority }, (label) => `${label} is now priority ${priority}.`);
}

export async function handleRouterConnectionActiveSet({
  id,
  isActive,
}: {
  id: string;
  isActive: boolean;
}) {
  return updateConnection(id, { isActive }, (label) => `${label} is now ${isActive ? "active" : "parked"}.`);
}

/**
 * Per-model availability, derived from the accounts that can serve each model.
 *
 * A model is only as available as the connections behind it, and those
 * connections carry the state that matters: `backoffLevel` (9router resting an
 * account), `errorCode` 429 (upstream rate limit), `isActive` (parked), and
 * `modelLock_*` keys that restrict an account to specific models.
 */
export async function handleRouterModelAvailability() {
  const client = new RouterClient();
  if (!(await client.health())) {
    return { models: [] };
  }

  const ids = await client.models();
  const raw = await client.api<{
    connections?: Array<Record<string, unknown>>;
    providers?: Array<Record<string, unknown>>;
  }>("providers");
  const rows = raw?.connections ?? raw?.providers ?? [];

  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

  type Account = {
    pool: string;
    locks: string[];
    active: boolean;
    backoff: number;
    limited: boolean;
    resetAt: string | null;
  };

  const accounts: Account[] = rows.map((row) => {
    const data = (row.data ?? {}) as Record<string, unknown>;
    const locks = Object.keys(data)
      .filter((key) => key.startsWith("modelLock_"))
      .map((key) => key.slice("modelLock_".length));
    // 9router's provider name is the pool prefix used in model ids: a `claude`
    // connection serves `cc/…`, a `codex` connection serves `cx/…`.
    const provider = text(row.provider);
    return {
      pool: provider === "claude" ? "cc" : provider === "codex" ? "cx" : provider,
      locks,
      active: row.isActive !== false && row.isActive !== 0,
      backoff: num(data.backoffLevel),
      limited: num(data.errorCode) === 429,
      resetAt: text(data.resetAt) || text(data.lastErrorAt) || null,
    };
  });

  const models = ids.map((id) => {
    const [pool = "", bare = id] = id.includes("/") ? id.split("/", 2) : ["", id];
    // An account serves a model when the pool matches and either it holds no
    // locks (serves anything in its pool) or one of its locks names this model.
    const serving = accounts.filter(
      (account) =>
        account.pool === pool &&
        (account.locks.length === 0 || account.locks.includes(bare)),
    );
    const usable = serving.filter(
      (account) => account.active && !account.limited && account.backoff === 0,
    );
    const resting = serving.filter((account) => account.active && account.backoff > 0);

    let state: "ready" | "limited" | "resting" | "none";
    let detail: string;
    if (serving.length === 0) {
      state = "none";
      detail = "No connected account serves this model.";
    } else if (usable.length > 0) {
      state = "ready";
      detail = `${usable.length} of ${serving.length} account(s) ready.`;
    } else if (serving.some((account) => account.limited)) {
      state = "limited";
      detail = `All ${serving.length} account(s) rate-limited upstream.`;
    } else if (resting.length > 0) {
      state = "resting";
      detail = `9router is resting ${resting.length} account(s) after errors.`;
    } else {
      state = "none";
      detail = `All ${serving.length} account(s) parked.`;
    }

    const resets = serving.map((account) => account.resetAt).filter((at): at is string => !!at);
    return {
      id,
      label: modelLabel(id),
      state,
      accounts: serving.length,
      usable: usable.length,
      readyAt: resets.length > 0 ? resets.sort()[0] : null,
      detail,
    };
  });

  return { models };
}

/** Read the router's own aggregate rather than recomputing it from usageDaily. */
export async function handleRouterSpend(input: { days: number | null }) {
  const client = new RouterClient();
  const path = input.days === null ? "usage/stats" : `usage/history?days=${input.days}`;
  const stats = await client.api<Record<string, unknown>>(path);
  if (!stats) {
    return {
      ok: false,
      message: client.authError ?? "9router did not return usage.",
      totals: null,
      byProvider: [],
      byModel: [],
      byAccount: [],
    };
  }

  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const row = (label: string, source: Record<string, unknown>) => ({
    label,
    requests: num(source.requests),
    promptTokens: num(source.promptTokens),
    completionTokens: num(source.completionTokens),
    cachedTokens: num(source.cachedTokens),
    cost: num(source.cost),
    lastUsed: typeof source.lastUsed === "string" ? source.lastUsed : null,
  });

  // Spend rows are only useful ranked — an unsorted list of 20 models buries
  // the one account that burned the quota.
  const group = (key: string) => {
    const raw = stats[key];
    if (!raw || typeof raw !== "object") return [];
    return Object.entries(raw as Record<string, Record<string, unknown>>)
      .map(([label, value]) => row(label, value ?? {}))
      .sort((a, b) => b.cost - a.cost || b.requests - a.requests);
  };

  // byAccount is keyed by connection id; resolve it to the email the user knows.
  const connections = await client.api<{ providers?: Array<Record<string, unknown>>; connections?: Array<Record<string, unknown>> }>("providers");
  const names = new Map<string, string>();
  for (const entry of connections?.providers ?? connections?.connections ?? []) {
    const id = typeof entry.id === "string" ? entry.id : null;
    const name = typeof entry.name === "string" ? entry.name : typeof entry.label === "string" ? entry.label : null;
    if (id && name) names.set(id, name);
  }

  return {
    ok: true,
    message: null,
    totals: {
      label: input.days === null ? "All time" : `Last ${input.days}d`,
      requests: num(stats.totalRequests),
      promptTokens: num(stats.totalPromptTokens),
      completionTokens: num(stats.totalCompletionTokens),
      cachedTokens: num(stats.totalCachedTokens),
      cost: num(stats.totalCost),
      lastUsed: null,
    },
    byProvider: group("byProvider"),
    byModel: group("byModel"),
    byAccount: group("byAccount").map((entry) => ({ ...entry, label: names.get(entry.label) ?? entry.label })),
  };
}

/**
 * Where each installed CLI actually sends traffic.
 *
 * `installed` and `routed` are separate on purpose: Codex was installed and
 * configured while still reaching api.openai.com directly, because its base
 * URL lives in config.toml and never saw Claude's environment variables.
 */
export async function handleRouterCliTools() {
  const client = new RouterClient();
  const statuses = await client.api<Record<string, Record<string, unknown>>>("cli-tools/all-statuses");
  if (!statuses) return { tools: [] };

  const routerHost = (() => {
    try {
      return new URL(client.url).host;
    } catch {
      return null;
    }
  })();

  // The base URL hides in a different place per tool; search rather than
  // hardcode, so a tool that moves its key still reports honestly.
  const findBaseUrl = (value: unknown, depth = 0): string | null => {
    if (depth > 6) return null;
    if (typeof value === "string") return /^https?:\/\//.test(value) ? value : null;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = findBaseUrl(entry, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (!/url|endpoint|base/i.test(key)) continue;
        const found = findBaseUrl(entry, depth + 1);
        if (found) return found;
      }
      for (const entry of Object.values(value as Record<string, unknown>)) {
        const found = findBaseUrl(entry, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };

  // Some tools report their config as a raw TOML/INI string rather than a
  // nested object (Codex does), so an object walk alone reports "no base URL"
  // for a tool that is correctly routed. Read the string form too.
  const baseUrlFromText = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const match = value.match(/^\s*base_url\s*=\s*["']([^"']+)["']/m);
    return match ? match[1] : null;
  };

  const tools = Object.entries(statuses)
    .map(([id, raw]) => {
      const source = raw ?? {};
      const installed = source.installed === true;
      // currentUrl is what the tools that answer in their own shape report.
      const baseUrl =
        baseUrlFromText(source.config) ??
        (typeof source.currentUrl === "string" ? source.currentUrl : null) ??
        findBaseUrl(source.settings ?? source);
      let routed = source.has9Router === true;
      if (!routed && baseUrl && routerHost) {
        try {
          routed = new URL(baseUrl).host === routerHost;
        } catch {
          routed = false;
        }
      }
      const detail = !installed
        ? "Not installed."
        : routed
          ? "Routed through 9router."
          : baseUrl
            ? `Bypassing 9router — reaches ${(() => {
                try {
                  return new URL(baseUrl).host;
                } catch {
                  return baseUrl;
                }
              })()} directly.`
            : "Installed, but no base URL configured.";
      return {
        id,
        label: id.replace(/(^|-)([a-z])/g, (_m, sep: string, ch: string) => `${sep ? " " : ""}${ch.toUpperCase()}`),
        installed,
        routed,
        baseUrl,
        detail,
      };
    })
    // Installed tools first, then bypassing ones — the actionable rows on top.
    .sort((a, b) => Number(b.installed) - Number(a.installed) || Number(a.routed) - Number(b.routed) || a.id.localeCompare(b.id));

  return { tools };
}

export async function handleRouterProxyPools() {
  const client = new RouterClient();
  const [pools, nodes] = await Promise.all([
    client.api<{ proxyPools?: Array<Record<string, unknown>> }>("proxy-pools"),
    client.api<{ nodes?: Array<Record<string, unknown>> }>("provider-nodes"),
  ]);

  const shape = (entry: Record<string, unknown>, fallbackKind: string) => {
    const id = typeof entry.id === "string" ? entry.id : String(entry.id ?? "");
    const label =
      typeof entry.name === "string" ? entry.name : typeof entry.label === "string" ? entry.label : id || "(unnamed)";
    const kind = typeof entry.type === "string" ? entry.type : typeof entry.provider === "string" ? entry.provider : fallbackKind;
    const active = entry.isActive !== false && entry.enabled !== false;
    const url = typeof entry.baseUrl === "string" ? entry.baseUrl : typeof entry.url === "string" ? entry.url : null;
    return { id, label, kind, active, detail: url ?? (active ? "Active." : "Inactive.") };
  };

  return {
    pools: (pools?.proxyPools ?? []).map((entry) => shape(entry, "pool")),
    nodes: (nodes?.nodes ?? []).map((entry) => shape(entry, "node")),
  };
}

export async function handleRouterPxpipe() {
  const client = new RouterClient();
  const status = await client.api<Record<string, unknown>>("pxpipe/status");
  if (!status) {
    return {
      installed: false,
      running: false,
      enabled: false,
      version: null,
      mode: null,
      minChars: null,
      detail: client.authError ?? "9router did not report pxpipe.",
    };
  }
  const installed = status.installed === true;
  const running = status.running === true;
  const enabled = status.enabled === true;
  const minChars = typeof status.minChars === "number" ? status.minChars : null;
  const detail = !installed
    ? status.installing === true
      ? "Installing…"
      : "Not installed — 9router installs it on first use."
    : !enabled
      ? "Installed but disabled."
      : running
        ? `Compacting prompts over ${minChars ?? "?"} characters.`
        : "Enabled but not running.";
  return {
    installed,
    running,
    enabled,
    version: typeof status.version === "string" ? status.version : null,
    mode: typeof status.mode === "string" ? status.mode : null,
    minChars,
    detail,
  };
}

const STRATEGY_DETAIL: Record<string, string> = {
  fallback: "One account carries everything until it fails, then the next takes over.",
  "round-robin": "Requests spread across accounts, so no single account is exhausted first.",
  priority: "Strict priority order; lower-priority accounts only serve when higher ones cannot.",
  random: "Each request picks an account at random.",
};

export async function handleRouterStrategies() {
  const client = new RouterClient();
  const [settings, connections] = await Promise.all([
    client.api<Record<string, unknown>>("settings"),
    client.api<{ providers?: Array<Record<string, unknown>>; connections?: Array<Record<string, unknown>> }>("providers"),
  ]);
  if (!settings) return { strategies: [], defaultStickyLimit: null };

  const perProvider = (settings.providerStrategies ?? {}) as Record<string, Record<string, unknown>>;
  const defaultSticky = typeof settings.stickyRoundRobinLimit === "number" ? settings.stickyRoundRobinLimit : null;

  // Only list providers that actually have accounts — a strategy for a provider
  // with nothing behind it is a control that changes nothing.
  const counts = new Map<string, number>();
  for (const entry of connections?.providers ?? connections?.connections ?? []) {
    const provider = typeof entry.provider === "string" ? entry.provider : null;
    if (provider) counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }

  const strategies = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([provider, accounts]) => {
      const config = perProvider[provider] ?? {};
      const raw = typeof config.fallbackStrategy === "string" ? config.fallbackStrategy : null;
      const known = ["fallback", "round-robin", "priority", "random"] as const;
      const strategy: (typeof known)[number] | null =
        known.find((candidate) => candidate === raw) ?? null;
      const stickyLimit = typeof config.stickyRoundRobinLimit === "number" ? config.stickyRoundRobinLimit : null;
      const effective = strategy ?? "fallback";
      let detail = STRATEGY_DETAIL[effective] ?? "";
      if (strategy === null) detail = `Default — ${detail.charAt(0).toLowerCase()}${detail.slice(1)}`;
      if (effective === "round-robin") {
        detail += ` Advances every ${stickyLimit ?? defaultSticky ?? 1} request(s).`;
      }
      return {
        provider,
        label: providerLabel(provider),
        strategy,
        stickyLimit,
        accounts,
        detail,
      };
    });

  return { strategies, defaultStickyLimit: defaultSticky };
}

/**
 * Settings is a single document, so this reads the current strategy map and
 * PATCHes it back with one provider changed. Sending only the new provider
 * would drop every other provider's strategy.
 */
export async function handleRouterStrategySet(input: {
  provider: string;
  strategy: "fallback" | "round-robin" | "priority" | "random";
  stickyLimit: number | null;
}) {
  const client = new RouterClient();
  const settings = await client.api<Record<string, unknown>>("settings");
  if (!settings) return { ok: false, message: client.authError ?? "Could not read 9router settings." };

  const current = { ...((settings.providerStrategies ?? {}) as Record<string, unknown>) };
  const entry: Record<string, unknown> = { fallbackStrategy: input.strategy };
  if (input.strategy === "round-robin" && input.stickyLimit !== null) {
    entry.stickyRoundRobinLimit = input.stickyLimit;
  }
  current[input.provider] = entry;

  const saved = await client.apiJson<unknown>("settings", "PATCH", { providerStrategies: current });
  if (saved === null) return { ok: false, message: client.authError ?? "9router rejected the strategy change." };
  return {
    ok: true,
    message: `${providerLabel(input.provider)} now uses ${input.strategy}.`,
  };
}

export async function handleRouterTailscale() {
  const client = new RouterClient();
  const [check, status] = await Promise.all([
    client.api<Record<string, unknown>>("tunnel/tailscale-check"),
    client.api<{ tailscale?: Record<string, unknown> }>("tunnel/status"),
  ]);
  if (!check) {
    return {
      installed: false,
      loggedIn: false,
      daemonRunning: false,
      platform: null,
      canInstall: false,
      url: null,
      detail: client.authError ?? "9router did not report Tailscale.",
      nextStep: null,
    };
  }
  const ts = status?.tailscale ?? {};
  const installed = check.installed === true;
  const loggedIn = check.loggedIn === true;
  const daemonRunning =
    check.daemonRunning === true || check.systemDaemonRunning === true || check.customDaemonRunning === true;
  const running = ts.running === true;
  const url = typeof ts.tunnelUrl === "string" && ts.tunnelUrl ? ts.tunnelUrl : null;

  // The next step is stated rather than implied: a Publish button that silently
  // does nothing because Tailscale is not signed in is the state this replaces.
  let detail: string;
  let nextStep: string | null = null;
  if (!installed) {
    detail = "Not installed on the router's machine.";
    nextStep = check.brewAvailable === true ? "Install it from here." : "Install Tailscale, then come back.";
  } else if (!loggedIn) {
    detail = "Installed but not signed in, so it cannot serve a private address yet.";
    nextStep = "Run `tailscale up` on the router's machine to sign in.";
  } else if (!daemonRunning) {
    detail = "Signed in, but the Tailscale daemon is not running.";
    nextStep = "Start the Tailscale daemon on the router's machine.";
  } else if (!running) {
    detail = "Ready — Tailscale is signed in and running, and the router is not published on it yet.";
    nextStep = "Publish to get a private, stable address.";
  } else {
    detail = "Published on your tailnet. Private, and the address does not change on restart.";
  }

  return {
    installed,
    loggedIn,
    daemonRunning,
    platform: typeof check.platform === "string" ? check.platform : null,
    canInstall: !installed && check.brewAvailable === true,
    url,
    detail,
    nextStep,
  };
}

export async function handleRouterTailscaleAction(input: { action: "install" | "enable" | "disable" }) {
  const client = new RouterClient();
  const path =
    input.action === "install"
      ? "tunnel/tailscale-install"
      : input.action === "enable"
        ? "tunnel/tailscale-enable"
        : "tunnel/tailscale-disable";
  // Install pulls a package; give it far longer than a normal call.
  const result = await client.apiJson<{ success?: boolean; error?: string; url?: string }>(path, "POST", {});
  if (result === null) {
    return { ok: false, message: client.authError ?? `9router refused the ${input.action}.` };
  }
  if (result.error) return { ok: false, message: result.error };
  const done =
    input.action === "install"
      ? "Tailscale installed. Sign in with `tailscale up`, then publish."
      : input.action === "enable"
        ? `Published on your tailnet${result.url ? ` at ${result.url}` : ""}.`
        : "Unpublished from your tailnet.";
  return { ok: true, message: done };
}

export async function handleRouterVersion() {
  const client = new RouterClient();
  const raw = await client.api<Record<string, unknown>>("version");
  const current = typeof raw?.currentVersion === "string" ? raw.currentVersion : null;
  const latest = typeof raw?.latestVersion === "string" ? raw.latestVersion : null;
  const hasUpdate = raw?.hasUpdate === true;
  // Said plainly because a missed upgrade is expensive: 0.5.65 carried the fix
  // for Fable 5.1 rejecting 9router's spoofed CLI version, and there was no way
  // to notice that from this panel.
  const detail = !current
    ? (client.authError ?? "9router did not report a version.")
    : hasUpdate
      ? `Update available: ${current} → ${latest}. Upgrades have carried model-compatibility fixes.`
      : `Up to date on ${current}.`;
  return { current, latest, hasUpdate, detail };
}

export async function handleRouterUpdate() {
  const client = new RouterClient();
  const result = await client.apiJson<{ success?: boolean; error?: string }>("version/update", "POST", {});
  if (result === null) return { ok: false, message: client.authError ?? "9router refused the update." };
  if (result.error) return { ok: false, message: result.error };
  return { ok: true, message: "Update started. 9router restarts itself when it finishes." };
}

/**
 * Test what an account can really serve.
 *
 * Presence in the catalogue is not capability: a model can be listed, aliased
 * and correctly configured while every request fails. This asks the provider
 * instead of inferring, which is the difference between a picker that lies and
 * one that does not.
 */
export async function handleRouterTestConnectionModels(input: {
  connectionId: string;
  models: string[] | null;
}) {
  const client = new RouterClient();
  const body: Record<string, unknown> = {};
  if (input.models && input.models.length > 0) body.models = input.models;
  const raw = await client.apiJson<{ results?: Array<Record<string, unknown>>; error?: string }>(
    `providers/${encodeURIComponent(input.connectionId)}/test-models`,
    "POST",
    body,
  );
  if (raw === null) {
    return { results: [], message: client.authError ?? "9router did not run the test." };
  }
  if (raw.error) return { results: [], message: raw.error };

  const results = (raw.results ?? []).map((entry) => {
    const model = String(entry.model ?? entry.id ?? "");
    const status = typeof entry.status === "number" ? entry.status : null;
    const ok = entry.ok === true || entry.success === true || status === 200;
    const error = typeof entry.error === "string" ? entry.error : typeof entry.message === "string" ? entry.message : "";
    // A 400 naming output_config.effort is the adaptive-thinking bug, not a
    // dead model — worth saying so, because the two look identical otherwise
    // and the wrong reading sends you hunting a quota problem that is not there.
    const detail = ok
      ? "Serves this model."
      : /output_config\.effort/i.test(error)
        ? "Rejected the thinking/effort field — 9router bug, not a dead model or a quota limit."
        : error || (status ? `HTTP ${status}` : "Failed.");
    return { model, ok, status, detail };
  });
  return { results, message: null };
}

export async function handleRouterThinkingCheck(input: { model: string | null }) {
  const settings = readSettings();
  const client = new RouterClient(settings);
  const key = settings.apiKey ?? (await client.ensureApiKey());
  if (!key) {
    return {
      state: "unknown" as const,
      model: null,
      detail: client.authError ?? "No API key available to test with.",
      fix: null,
    };
  }
  // Prefer a Claude model, since this is where the bug lives.
  const model =
    input.model ?? (await client.models()).find((id) => id.startsWith("cc/")) ?? "cc/claude-sonnet-5";

  let status = 0;
  let body = "";
  try {
    const response = await fetch(`${settings.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "adaptive" },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    status = response.status;
    body = await response.text();
  } catch (error) {
    return {
      state: "unknown" as const,
      model,
      detail: error instanceof Error ? error.message : String(error),
      fix: null,
    };
  }

  if (status === 200) {
    return {
      state: "ok" as const,
      model,
      detail: "Adaptive thinking round-trips cleanly.",
      fix: null,
    };
  }
  if (/output_config\.effort/i.test(body)) {
    return {
      state: "broken" as const,
      model,
      detail:
        "9router sends effort:\"auto\", which Anthropic rejects with 400 — and it then backs the account off, so the next valid request fails too.",
      fix: "Upgrade 9router, or patch the claude-adaptive branch so mode \"auto\" maps to a real level.",
    };
  }
  if (/rate_limit|429|Unavailable/i.test(body)) {
    return {
      state: "blocked" as const,
      model,
      detail: "Rate-limited or backing off right now, so adaptive thinking could not be tested.",
      fix: "Try again once the account is out of backoff.",
    };
  }
  return {
    state: "unknown" as const,
    model,
    detail: `HTTP ${status}: ${body.slice(0, 160)}`,
    fix: null,
  };
}

export async function handleRouterUsageChart(input: { days: number }) {
  const client = new RouterClient();
  const raw = await client.api<Array<Record<string, unknown>>>(`usage/chart?days=${input.days}`);
  if (!Array.isArray(raw)) {
    return {
      points: [],
      peakTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      trend: null,
      message: client.authError ?? "9router did not return a usage series.",
    };
  }
  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const points = raw.map((entry) => ({
    label: String(entry.label ?? ""),
    tokens: num(entry.tokens),
    cost: num(entry.cost),
  }));

  const peakTokens = points.reduce((max, point) => Math.max(max, point.tokens), 0);
  const totalTokens = points.reduce((sum, point) => sum + point.tokens, 0);
  const totalCost = points.reduce((sum, point) => sum + point.cost, 0);

  // Compare today against the days that actually had traffic: averaging in a
  // run of zeros reports a huge multiple on a quiet week and means nothing.
  let trend: string | null = null;
  if (points.length >= 3) {
    const today = points[points.length - 1];
    const prior = points.slice(0, -1).filter((point) => point.tokens > 0);
    if (prior.length >= 2 && today.tokens > 0) {
      const mean = prior.reduce((sum, point) => sum + point.tokens, 0) / prior.length;
      if (mean > 0) {
        const ratio = today.tokens / mean;
        trend =
          ratio >= 1.5
            ? `Today is ${ratio.toFixed(1)}× the recent daily average.`
            : ratio <= 0.5
              ? `Today is well below the recent daily average.`
              : "Today is in line with recent days.";
      }
    }
  }

  return { points, peakTokens, totalTokens, totalCost, trend, message: null };
}
