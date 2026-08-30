import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { RouteEvent, Slot } from "./contracts.shared";
import { onStart } from "./lifecycle.shared";

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

function collectSlots(): Array<Omit<Slot, "wiredProviderId" | "cooldownUntil" | "launches" | "lastUsed" | "preference" | "nearing" | "creditNote" | "blocked" | "parkReason" | "outputStyle" | "settingsDrift" | "modelHolds">> {
  const slots: Array<Omit<Slot, "wiredProviderId" | "cooldownUntil" | "launches" | "lastUsed" | "preference" | "nearing" | "creditNote" | "blocked" | "parkReason" | "outputStyle" | "settingsDrift" | "modelHolds">> = [];
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
    description?: string;
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

async function refreshProviders(paseo: PluginHandlerContext["paseo"], providers: string[]): Promise<boolean> {
  if (providers.length === 0) return true;
  try {
    await paseo.providers.refresh({ providers: [...new Set(providers)] } as never);
    await paseo.providers.waitForReady({ timeoutMs: 20_000 } as never);
    return true;
  } catch {
    // The persisted config is still valid. A later catalog refresh or Paseo
    // reload will pick it up; never restart the daemon and kill live agents.
    return false;
  }
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
        const [rawAt, provider, email, decision, group, agentId = "", cwd = "", model = ""] = line.split("\t");
        const at = Number.parseInt(rawAt ?? "", 10);
        if (!Number.isFinite(at) || (provider !== "claude" && provider !== "codex") || !email) return [];
        if (group !== "preferred" && group !== "standard" && group !== "reserve" && group !== "fallback") return [];
        return [{ at, provider, email, decision: decision || "routed", group, agentId, cwd, model }];
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
    return { ok: false, message: "Codex already reports its usage limits. A separate account test is not available.", log: "" };
  }
  const binary = searchPath()
    .flatMap((directory) => [join(directory, "agent-link"), join(directory, "agent-auth")])
    .find(existsSync);
  if (!binary) return { ok: false, message: "Install the AgentLink command-line tool before testing account limits.", log: "" };

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
          ? "Test complete. Refusing sign-ins remain blocked; passing sign-ins are available again."
          : "Test complete. Every sign-in served the model.",
        log,
      });
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ ok: false, message: "Account-limit test timed out after 3 minutes.", log: output.trim() });
    }, 180_000);
  });
}

// Which preferences differ from the primary — an account out of step behaves
// differently for no visible reason. The caller reads the primary settings once
// and passes them in, so a scan does not re-read the same file per slot.
const SYNC_SETTINGS_KEYS = ["outputStyle", "includeCoAuthoredBy", "env", "permissions", "model"];

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

function modelHolds(provider: string, email: string): string[] {
  const prefix = `holdmodel-${provider}-${email}-`;
  try {
    return readdirSync(poolsDir())
      .filter((name) => name.startsWith(prefix))
      .map((name) => name.slice(prefix.length))
      .filter(Boolean)
      .sort();
  } catch {
    return [];
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
      modelHolds: modelHolds(slot.provider, slot.email),
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
        modelHolds: modelHolds(provider, "primary"),
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
  };
}

export async function handleWireAuto({ provider }: { provider: "claude" | "codex" }, { paseo }: PluginHandlerContext) {
  const launcher = autoLauncherPath(provider);
  if (!existsSync(launcher)) {
    return {
      ok: false,
      providerId: null,
      message: `Automatic account selection is not ready. Run 'agent-link auto' in a terminal.`,
    };
  }
  const overrides = await providerOverrides(paseo);
  const providerId = autoWiredId(overrides, provider) ?? `${provider}-auto`;
  await paseo.config.patch({
    agents: {
      providers: {
        [providerId]: {
          extends: provider,
          label: `${provider === "claude" ? "Claude" : "Codex"} (Legacy AgentLink)`,
          description: "Kept for native legacy sessions. Start new multi-account chats with AgentLink.",
          command: [launcher],
        },
      },
    },
  } as never);
  const refreshed = await refreshProviders(paseo, [providerId]);
  return {
    ok: true,
    providerId,
    message: refreshed
      ? `Installed legacy provider '${providerId}'. Use AgentLink for new chats.`
      : `Installed '${providerId}'. Use Paseo reload if it does not appear yet.`,
  };
}

const ROUTER_PROVIDER_ID = "agent-router";
const ROUTER_VIRTUAL_MODEL = "agent-router-auto";
type RouterController = "claude-auto" | "claude";
type RouterTarget = {
  provider: string;
  model: string;
  account: string;
  resolvedProvider: string;
};
type RouterTargetInput = Omit<RouterTarget, "resolvedProvider"> & {
  resolvedProvider?: string;
  available?: boolean | null;
};
type RouterTargetGroup = {
  name: string;
  purpose: string;
  selector: "in_order";
  targets: RouterTarget[];
};
type RouterTargetGroupInput = Omit<RouterTargetGroup, "targets"> & { targets: RouterTargetInput[] };
type RouterConfig = {
  controllerProvider: RouterController;
  controllerAccount: string;
  controllerConfigDir: string;
  controllerModel: string;
  targetGroups: RouterTargetGroup[];
};
const autoTarget = (provider: "claude" | "codex", model: string): RouterTarget => ({
  provider,
  model,
  account: "auto",
  resolvedProvider: `${provider}-auto`,
});
const providerTarget = (provider: string, model: string): RouterTarget => ({
  provider,
  model,
  account: "provider",
  resolvedProvider: provider,
});
const ROUTER_TARGET_GROUPS: RouterTargetGroup[] = [
  {
    name: "fast",
    purpose: "Explanations, summaries, formatting and tiny edits",
    selector: "in_order" as const,
    targets: [
      autoTarget("claude", "claude-haiku-4-5"),
      autoTarget("codex", "gpt-5.6-luna"),
      providerTarget("kimi", "kimi-code/kimi-for-coding-highspeed"),
      providerTarget("grok", "grok-4.5"),
    ],
  },
  {
    name: "planning",
    purpose: "Product and implementation plans",
    selector: "in_order" as const,
    targets: [
      autoTarget("claude", "claude-fable-5"),
      autoTarget("codex", "gpt-5.6-terra"),
      providerTarget("grok", "grok-4.6"),
    ],
  },
  {
    name: "judgment",
    purpose: "Architecture, UI/UX, audit and final review",
    selector: "in_order" as const,
    targets: [
      autoTarget("claude", "claude-opus-5"),
      providerTarget("grok", "grok-4.6"),
      autoTarget("codex", "gpt-5.6-sol"),
    ],
  },
  {
    name: "build",
    purpose: "Multi-file implementation, debugging, migrations and refactors",
    selector: "in_order" as const,
    targets: [
      autoTarget("codex", "gpt-5.6-sol"),
      providerTarget("kimi", "kimi-code/k3"),
      autoTarget("claude", "claude-opus-5"),
    ],
  },
  {
    name: "browser",
    purpose: "Browser-driving verification",
    selector: "in_order" as const,
    targets: [autoTarget("codex", "gpt-5.6-sol")],
  },
];
const ROUTER_DEFAULT_CONFIG: RouterConfig = {
  controllerProvider: "claude-auto",
  controllerAccount: "auto",
  controllerConfigDir: "",
  controllerModel: "claude-fable-5",
  targetGroups: ROUTER_TARGET_GROUPS,
};

function routerConfigPath(): string {
  return join(AGENT_LINK_HOME_DIR, "router", "config.json");
}

function routerRulesPath(): string {
  return join(AGENT_LINK_HOME_DIR, "router", "rules.md");
}

function currentRouterConfig(): RouterConfig {
  const raw = readJson(routerConfigPath());
  if (!raw) return ROUTER_DEFAULT_CONFIG;
  const controllerProvider = raw.controllerProvider === "claude" ? "claude" : "claude-auto";
  const controllerAccount = typeof raw.controllerAccount === "string" && raw.controllerAccount
    ? raw.controllerAccount
    : controllerProvider === "claude-auto" ? "auto" : "primary";
  const controllerConfigDir = typeof raw.controllerConfigDir === "string" ? raw.controllerConfigDir : "";
  const controllerModel = typeof raw.controllerModel === "string" && raw.controllerModel ? raw.controllerModel : ROUTER_DEFAULT_CONFIG.controllerModel;
  const groups = Array.isArray(raw.targetGroups) ? raw.targetGroups : [];
  const targetGroups = groups.flatMap((entry): RouterTargetGroup[] => {
    if (!entry || typeof entry !== "object") return [];
    const group = entry as Record<string, unknown>;
    if (typeof group.name !== "string" || typeof group.purpose !== "string" || !Array.isArray(group.targets)) return [];
    const targets = group.targets.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const target = item as Record<string, unknown>;
      if (typeof target.provider !== "string" || typeof target.model !== "string") return [];
      const legacyProvider = target.provider;
      const migratedProvider = legacyProvider === "claude-auto"
        ? "claude"
        : legacyProvider === "codex-auto"
          ? "codex"
          : legacyProvider;
      const account = typeof target.account === "string" && target.account
        ? target.account
        : legacyProvider.endsWith("-auto")
          ? "auto"
          : legacyProvider === "claude" || legacyProvider === "codex"
            ? "primary"
            : "provider";
      const resolvedProvider = typeof target.resolvedProvider === "string" && target.resolvedProvider
        ? target.resolvedProvider
        : legacyProvider;
      return [{ provider: migratedProvider, model: target.model, account, resolvedProvider }];
    });
    return targets.length > 0 ? [{ name: group.name, purpose: group.purpose, selector: "in_order", targets }] : [];
  });
  return {
    controllerProvider,
    controllerAccount,
    controllerConfigDir,
    controllerModel,
    targetGroups: targetGroups.length > 0 ? targetGroups : ROUTER_TARGET_GROUPS,
  };
}

function currentRouterRules(): string {
  try {
    return readFileSync(routerRulesPath(), "utf8");
  } catch {
    return "";
  }
}

type RouterAccountOption = {
  provider: "claude" | "codex";
  id: string;
  label: string;
  description: string;
  available: boolean;
  resolvedProvider: string;
};

function routerAccountOptions(overrides: ProviderOverrides, availability: Map<string, boolean>): RouterAccountOption[] {
  const slots = collectSlots();
  const options: RouterAccountOption[] = [];
  for (const provider of ["claude", "codex"] as const) {
    const providerReady = availability.get(provider) !== false;
    const primaryDir = provider === "claude" ? HOME : join(HOME, ".codex");
    const primaryEmail = provider === "claude" ? claudeAccountEmail(HOME) : codexAccountEmail(primaryDir);
    const familySlots = slots.filter((slot) => slot.provider === provider);
    const primaryAvailable = providerReady && Boolean(primaryEmail) && !activelyParked(provider, "primary") && cooldownUntil(provider, "primary") === 0;
    const slotAvailable = (slot: (typeof familySlots)[number]) =>
      providerReady && slot.loggedIn && !slot.wrongAccount && !activelyParked(provider, slot.email) && cooldownUntil(provider, slot.email) === 0;
    const anyAvailable = primaryAvailable || familySlots.some(slotAvailable);
    options.push({
      provider,
      id: "auto",
      label: "Automatic healthy account",
      description: anyAvailable
        ? "Chooses by health, priority and least recent use"
        : "No healthy account is currently available",
      available: anyAvailable,
      resolvedProvider: provider,
    });
    options.push({
      provider,
      id: "primary",
      label: primaryEmail ? `${primaryEmail} · primary` : "Primary sign-in",
      description: primaryAvailable ? "Available now" : primaryEmail ? "Cooling down or blocked" : "Not signed in",
      available: primaryAvailable,
      resolvedProvider: provider,
    });
    for (const slot of familySlots) {
      const available = slotAvailable(slot);
      options.push({
        provider,
        id: slot.email,
        label: slot.actualEmail || slot.email,
        description: slot.wrongAccount
          ? `Folder is signed in as ${slot.actualEmail}`
          : !slot.loggedIn
            ? "Sign-in needed"
            : available
              ? "Available now · fixed to this account"
              : parkReason(provider, slot.email) || "Cooling down or blocked",
        available,
        resolvedProvider: providerIdForDir(overrides, provider, slot.dir) ?? slugForEmail(provider, slot.email),
      });
    }
  }
  return options;
}

function logicalProviderOptions(
  availability: Map<string, boolean>,
  labels: Map<string, string>,
  accounts: RouterAccountOption[],
) {
  const hidden = new Set(accounts.flatMap((entry) => entry.resolvedProvider === entry.provider ? [] : [entry.resolvedProvider]));
  const options = [...availability.entries()]
    .filter(([id]) => id !== "agent-link" && id !== ROUTER_PROVIDER_ID && !hidden.has(id) && id !== "claude-auto" && id !== "codex-auto")
    .map(([id, available]) => ({ id, label: labels.get(id) ?? id, available }));
  for (const provider of ["claude", "codex"] as const) {
    const family = accounts.filter((entry) => entry.provider === provider);
    const available = family.some((entry) => entry.available);
    const existing = options.find((entry) => entry.id === provider);
    if (existing) {
      existing.available = available || existing.available;
      existing.label = provider === "claude" ? "Claude Code" : "Codex";
    } else {
      options.push({ id: provider, label: provider === "claude" ? "Claude Code" : "Codex", available });
    }
  }
  const rank = (id: string) => id === "claude" ? 0 : id === "codex" ? 1 : 2;
  return options.sort((a, b) => rank(a.id) - rank(b.id) || Number(b.available) - Number(a.available) || a.label.localeCompare(b.label));
}

async function routerProviderStatus(paseo: PluginHandlerContext["paseo"], message = "") {
  const launcherPath = join(AGENT_LINK_HOME_DIR, "bin", "agent-link-acp");
  const rulesPath = routerRulesPath();
  const config = currentRouterConfig();
  const overrides = await providerOverrides(paseo);
  let loaded = false;
  const availability = new Map<string, boolean>();
  const providerLabels = new Map<string, string>();
  let controllerModels: Array<{ id: string; label: string }> = [];
  try {
    const available = await paseo.providers.listAvailable();
    for (const entry of available.providers as Array<{ provider: string; label?: string; available: boolean }>) {
      availability.set(entry.provider, entry.available);
      providerLabels.set(entry.provider, entry.label ?? providerLabel(entry.provider, overrides));
    }
    loaded = availability.get("agent-link") === true;
    const modelResult = (await paseo.providers.listModels("claude" as never)) as unknown as {
      models?: Array<{ id?: string; label?: string; name?: string; model?: string }>;
    };
    controllerModels = (modelResult.models ?? []).flatMap((model) =>
      typeof model.id === "string" ? [{ id: model.id, label: model.label ?? model.name ?? model.model ?? model.id }] : [],
    );
  } catch {
    // Configured remains useful when an older daemon cannot report availability.
  }
  const accountOptions = routerAccountOptions(overrides, availability);
  const installed = existsSync(launcherPath);
  const configured = Boolean(overrides["agent-link"]);
  return {
    installed,
    configured,
    loaded,
    launcherPath,
    rulesPath,
    baseProvider: "AgentLink",
    baseModel: ROUTER_VIRTUAL_MODEL,
    controllerProvider: config.controllerProvider,
    controllerAccount: config.controllerAccount,
    controllerModel: config.controllerModel,
    controllerAccountOptions: accountOptions.filter((entry) => entry.provider === "claude"),
    controllerModels,
    providerOptions: logicalProviderOptions(availability, providerLabels, accountOptions),
    accountOptions,
    targetGroups: config.targetGroups.map((group) => ({
      ...group,
      targets: group.targets.map((target) => ({
        ...target,
        available: availability.has(target.provider) ? availability.get(target.provider) ?? false : null,
      })),
    })),
    userRules: currentRouterRules(),
    message:
      message ||
      (loaded
        ? "AgentRouter is ready as AgentLink's Automatic model."
        : configured
          ? "AgentLink is saved. Refresh providers if its Automatic model does not appear yet."
          : installed
            ? "The AgentLink runtime is ready. Add AgentLink to Paseo's provider list."
            : "AgentLink is not installed."),
  };
}

export async function handleRouterStatus(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  return routerProviderStatus(paseo);
}

export async function handleRouterConfigure(
  input: {
    controllerAccount: string;
    controllerModel: string;
    targetGroups: RouterTargetGroupInput[];
    userRules: string;
  },
  context: PluginHandlerContext,
) {
  if (new Set(input.targetGroups.map((group) => group.name)).size !== input.targetGroups.length) {
    return routerProviderStatus(context.paseo, "Every work type needs a different name.");
  }
  const slots = collectSlots();
  const resolveTarget = (target: RouterTargetInput): RouterTarget => {
    if (target.provider !== "claude" && target.provider !== "codex") {
      return { ...target, account: "provider", resolvedProvider: target.provider };
    }
    const provider = target.provider;
    if (target.account === "auto") {
      return { ...target, resolvedProvider: provider };
    }
    if (target.account === "primary") {
      const email = provider === "claude" ? claudeAccountEmail(HOME) : codexAccountEmail(join(HOME, ".codex"));
      if (!email || activelyParked(provider, "primary") || cooldownUntil(provider, "primary") > 0) {
        throw new Error(`${provider} primary account is not available. Choose Automatic or another healthy account.`);
      }
      return { ...target, resolvedProvider: provider };
    }
    const slot = slots.find((entry) => entry.provider === provider && entry.email === target.account);
    if (!slot) throw new Error(`${provider} account '${target.account}' was not found.`);
    if (!slot.loggedIn || slot.wrongAccount || activelyParked(provider, slot.email) || cooldownUntil(provider, slot.email) > 0) {
      throw new Error(`${slot.actualEmail || slot.email} is not available. Choose Automatic or another healthy account.`);
    }
    return { ...target, resolvedProvider: provider };
  };
  let resolvedGroups: RouterTargetGroup[];
  try {
    resolvedGroups = input.targetGroups.map((group) => ({
      ...group,
      targets: group.targets.map(resolveTarget),
    }));
  } catch (error) {
    return routerProviderStatus(context.paseo, error instanceof Error ? error.message : String(error));
  }
  // Retain these fields for backward-compatible config parsing. AgentRouter now
  // classifies locally, so it never spends a separate request-reader turn.
  const controllerProvider: RouterController = input.controllerAccount === "auto" ? "claude-auto" : "claude";
  const controllerConfigDir = input.controllerAccount === "auto" || input.controllerAccount === "primary"
    ? ""
    : slots.find((entry) => entry.provider === "claude" && entry.email === input.controllerAccount)?.dir ?? "";
  mkdirSync(join(AGENT_LINK_HOME_DIR, "router"), { recursive: true });
  backupFile(routerConfigPath());
  backupFile(routerRulesPath());
  writeJsonAtomic(routerConfigPath(), {
    controllerProvider,
    controllerAccount: input.controllerAccount,
    controllerConfigDir,
    controllerModel: input.controllerModel,
    targetGroups: resolvedGroups.map((group) => ({ ...group, selector: undefined })),
  });
  writeTextAtomic(routerRulesPath(), input.userRules.endsWith("\n") ? input.userRules : `${input.userRules}\n`);
  const status = await routerProviderStatus(context.paseo);
  return { ...status, message: "AgentRouter choices saved for AgentLink's Automatic model." };
}

export async function handleRouterModels({ provider }: { provider: string }, { paseo }: PluginHandlerContext) {
  try {
    const result = (await paseo.providers.listModels(provider as never)) as unknown as {
      models?: Array<{ id?: string; label?: string; name?: string; model?: string; description?: string }>;
    };
    const models = (result.models ?? []).flatMap((model) => typeof model.id === "string" ? [{
      id: model.id,
      label: model.label ?? model.name ?? model.model ?? model.id,
      description: model.description ?? "",
    }] : []);
    return {
      provider,
      models,
      message: models.length > 0 ? `${models.length} models reported by Paseo.` : "This provider did not report a model catalog; a custom model ID is still allowed.",
    };
  } catch (error) {
    return {
      provider,
      models: [],
      message: `Model catalog unavailable: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    };
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
      ? `Sign-in created. Finish in a terminal: agent-link login ${provider} ${email}`
      : `Sign-in created. Finish in a terminal: ${envVarFor(provider)}="${dir}" ${provider} ${
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
    return { ok: false, message: `No ${provider} sign-in named '${email}' was found.` };
  }
  const state = join(AGENT_LINK_HOME_DIR, "state");
  try {
    mkdirSync(state, { recursive: true });
    updateLineSet(join(state, `prefer-${provider}-first`), email, preference === "preferred");
    updateLineSet(join(state, `prefer-${provider}-last`), email, preference === "reserve");
    const label = preference === "preferred" ? "priority" : preference === "reserve" ? "reserve" : "default";
    return { ok: true, message: `${provider} · ${email} now has ${label} priority for AgentRouter turns.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function handleRemoveAccount(
  { provider, email }: { provider: "claude" | "codex"; email: string },
  { paseo }: PluginHandlerContext,
) {
  if (!/^[^/\\]+$/.test(email) || email === "." || email === "..") {
    return { ok: false, message: "That sign-in name is invalid." };
  }
  const dir = join(AGENT_LINK_ROOT, provider, email);
  const slot = collectSlots().find(
    (candidate) => candidate.source === "agent-link" && candidate.provider === provider && candidate.email === email && candidate.dir === dir,
  );
  if (!slot) return { ok: false, message: `No managed ${provider} sign-in named '${email}' was found.` };

  const pinned = providerIdForDir(await providerOverrides(paseo), provider, dir);
  if (pinned) {
    return { ok: false, message: `Remove the fixed-account Paseo provider '${pinned}' before removing this sign-in.` };
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
    return { ok: true, message: `${email} removed from AgentLink and archived at ${archived}.${shims}` };
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
      return { ok: true, message: `${email} is available in AgentLink again.` };
    }
    mkdirSync(poolsDir(), { recursive: true });
    writeFileSync(file, String(Math.floor(Date.now() / 1000) + minutes * 60));
    return { ok: true, message: `${email} will be skipped for ${minutes} minutes.` };
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
  await refreshProviders(paseo, [providerId]);
  return { providerId };
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
          ? "Claude only reports these limits during an interactive chat. Open `claude`, send one message, then refresh."
          : `Claude only reports these limits during an interactive chat. Run \`agent-link run claude ${poolKey} claude\`, send one message, then refresh.`
        : "No current usage limits are available. Run one Codex chat with this sign-in, then refresh.";
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
    const autoProviderId = pooled ? autoWiredId(overrides, id) : null;
    const routeLoaded = Boolean(autoProviderId && availableIds.has(autoProviderId));
    return {
      id,
      label: providerLabel(id, overrides),
      available: familyAvailable,
      kind: pooled ? ("pooled" as const) : ("single" as const),
      quotaTelemetry: pooled,
      autoProviderId,
      aliases,
      summary: !familyAvailable
        ? "Paseo cannot find this provider. Check its command location, then reload Paseo"
        : pooled
          ? routeLoaded
            ? "Provider and automatic account selection are ready"
            : "Provider is ready, but automatic account selection is not installed"
          : "Provider is ready. Use Check setup to confirm its login and models",
    };
  });
  const rank = (id: string) => (id === "claude" ? 0 : id === "codex" ? 1 : 2);
  providers.sort((a, b) => rank(a.id) - rank(b.id) || a.label.localeCompare(b.label));
  return { checkedAt: Math.floor(Date.now() / 1000), providers };
}
