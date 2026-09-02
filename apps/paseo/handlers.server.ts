import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { existsSync } from "node:fs";
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
import {
  ROOT,
  RouterClient,
  SETTINGS_PATH,
  findBinary,
  listStaleShims,
  readSettings,
  removeShim,
  startRouter,
  writeSettings,
} from "./router.server";

const HOME = homedir();

type ProviderEntry = { additionalModels?: Array<{ id?: unknown; label?: unknown }> } & Record<string, unknown>;
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
  if (!entry || !Array.isArray(entry.additionalModels)) return [];
  return entry.additionalModels.map((model) => model?.id).filter((id): id is string => typeof id === "string");
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

async function readHijack(client: RouterClient): Promise<CliHijack[]> {
  const claude = await client.api<ClaudeSettingsResponse>("cli-tools/claude-settings");
  const codex = await client.api<CodexSettingsResponse>("cli-tools/codex-settings");
  const env = claude?.settings?.env ?? {};
  const defaults = Object.entries(env)
    .filter(([key, value]) => key.startsWith("ANTHROPIC_DEFAULT_") && typeof value === "string")
    .map(([key, value]) => ({ key, value: String(value) }));
  const baseUrl = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : null;
  const codexBase = (codex?.config ?? "").match(/base_url\s*=\s*"([^"]+)"/)?.[1] ?? null;
  return [
    {
      cli: "claude",
      installed: claude?.installed === true,
      routed: claude?.has9Router === true,
      configPath: claude?.settingsPath ?? join(HOME, ".claude", "settings.json"),
      baseUrl,
      defaultModels: defaults,
    },
    {
      cli: "codex",
      installed: codex?.installed === true,
      routed: codex?.has9Router === true,
      configPath: codex?.configPath ?? join(HOME, ".codex", "config.toml"),
      baseUrl: codexBase,
      defaultModels: [],
    },
  ];
}

// ------------------------------------------------------------------- status

export async function handleRouterStatus(_input: unknown, { paseo }: PluginHandlerContext): Promise<RouterStatus> {
  const settings = readSettings();
  const client = new RouterClient(settings);
  const binaryPath = findBinary("9router");
  const running = await client.health();

  const overrides = await providerOverrides(paseo);
  const paseoClaude = listedModels(overrides, "claude");
  const paseoCodex = listedModels(overrides, "codex");
  const staleProviders = DEAD_PROVIDER_IDS.filter((id) => overrides[id] !== undefined);
  const staleShims = listStaleShims(isLegacyShim);

  const empty: RouterStatus = {
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

  const wantClaude = ids.filter((id) => cliForModel(id) === "claude");
  const wantCodex = ids.filter((id) => cliForModel(id) === "codex");

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
      modelsInSync:
        ids.length > 0 && sameModelSet(paseoClaude, wantClaude) && sameModelSet(paseoCodex, wantCodex),
      staleProviders,
      staleShims,
    },
  };
}

// ----------------------------------------------------------------- lifecycle

export async function handleRouterStart() {
  const settings = readSettings();
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

export async function handleRouterRouteCli({ cli, routed }: { cli: "claude" | "codex"; routed: boolean }) {
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

  const result = await client.apiJson<{ success?: boolean }>(path, "POST", {
    baseUrl: `${settings.url}/v1`,
    apiKey: key,
  });
  if (result === null) return { ok: false, message: client.authError ?? "Could not update Codex settings." };
  return { ok: true, message: "Codex now runs through 9router." };
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

export async function handleRouterSyncModels(_input: unknown, { paseo }: PluginHandlerContext) {
  const client = new RouterClient();
  if (!(await client.health())) {
    return { ok: false, claude: 0, codex: 0, removedProviders: [], removedShims: [], message: "9router is not running." };
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

  const forClaude = ids.filter((id) => cliForModel(id) === "claude").map((id) => ({ id, label: modelLabel(id) }));
  const forCodex = ids.filter((id) => cliForModel(id) === "codex").map((id) => ({ id, label: modelLabel(id) }));

  const overrides = await providerOverrides(paseo);
  const removedProviders = DEAD_PROVIDER_IDS.filter((id) => overrides[id] !== undefined);
  const patch: Record<string, unknown> = {
    claude: { additionalModels: forClaude },
    codex: { additionalModels: forCodex },
  };
  // Paseo removes a provider when its entry is patched to null.
  for (const id of removedProviders) patch[id] = null;
  await paseo.config.patch({ agents: { providers: patch } } as never);
  await refreshProviders(paseo, ["claude", "codex"]);

  const removedShims = listStaleShims(isLegacyShim);
  for (const name of removedShims) removeShim(name);

  const notes = [`Listed ${forClaude.length} Claude and ${forCodex.length} Codex models in Paseo.`];
  if (removedProviders.length > 0) notes.push(`Removed ${removedProviders.join(", ")}.`);
  if (removedShims.length > 0) notes.push(`Retired ${removedShims.length} old shim(s).`);
  return { ok: true, claude: forClaude.length, codex: forCodex.length, removedProviders, removedShims, message: notes.join(" ") };
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
