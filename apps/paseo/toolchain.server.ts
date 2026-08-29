import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { ToolchainProvider } from "./toolchain.shared";

const HOME = homedir();
function hasAccounts(root: string): boolean {
  return ["claude", "codex"].some((provider) => {
    try {
      return readdirSync(join(root, "accounts", provider)).length > 0;
    } catch {
      return false;
    }
  });
}
const ROOT = process.env.AGENT_LINK_HOME ?? process.env.AGENT_AUTH_HOME ?? (
  hasAccounts(join(HOME, ".agent-link")) ? join(HOME, ".agent-link")
    : hasAccounts(join(HOME, ".agent-auth")) ? join(HOME, ".agent-auth")
      : existsSync(join(HOME, ".agent-link")) ? join(HOME, ".agent-link") : join(HOME, ".agent-auth")
);
const CONFIG_PATH = join(ROOT, "toolchain-providers.json");
const STATE_PATH = join(ROOT, "state", "toolchain-updates.json");
const BUILT_INS: Record<string, { label: string; binary: string; updateArgs: string[]; processPattern: string }> = {
  claude: { label: "Claude Code", binary: "claude", updateArgs: ["update"], processPattern: "(^|/)(claude|claude-auto)( |$)" },
  codex: { label: "Codex", binary: "codex", updateArgs: ["update"], processPattern: "(^|/)(codex|codex-auto)( |$)" },
  kimi: { label: "Kimi Code CLI", binary: "kimi", updateArgs: ["managed installer"], processPattern: "(^|/)(kimi)( |$)" },
  grok: { label: "Grok", binary: "grok", updateArgs: ["update", "--stable"], processPattern: "(^|/)(grok)( |$)" },
};

type CustomUpdater = {
  id: string;
  label: string;
  binary: string;
  versionArgs: string[];
  updateArgs: string[];
  processPattern: string;
};

function readObject(path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function customUpdaters(): CustomUpdater[] {
  const providers = readObject(CONFIG_PATH).providers;
  if (!Array.isArray(providers)) return [];
  return providers.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.binary !== "string") return [];
    return [{
      id: row.id,
      label: typeof row.label === "string" ? row.label : row.id,
      binary: row.binary,
      versionArgs: Array.isArray(row.versionArgs) ? row.versionArgs.map(String) : ["--version"],
      updateArgs: Array.isArray(row.updateArgs) ? row.updateArgs.map(String) : [],
      processPattern: typeof row.processPattern === "string" ? row.processPattern : `(^|/)(${row.id})( |$)`,
    }];
  });
}

function writeUpdaters(providers: CustomUpdater[]): void {
  mkdirSync(ROOT, { recursive: true });
  const temp = `${CONFIG_PATH}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ providers }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, CONFIG_PATH);
}

function searchPath(): string[] {
  return [...new Set([
    ...(process.env.PATH ?? "").split(delimiter),
    join(HOME, ".local", "bin"),
    join(HOME, ".kimi-code", "bin"),
    join(HOME, ".grok", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter(Boolean))];
}

function resolveBinary(binary: string): string {
  if (isAbsolute(binary)) return existsSync(binary) ? binary : "";
  return searchPath().map((directory) => join(directory, binary)).find(existsSync) ?? "";
}

function agentLinkBinary(): string {
  return resolveBinary("agent-link");
}

function binaryVersion(path: string, args: string[]): string {
  if (!path) return "";
  try {
    return execFileSync(path, args.length > 0 ? args : ["--version"], { encoding: "utf8", timeout: 12_000 }).trim().split("\n")[0] ?? "";
  } catch {
    return "unknown";
  }
}

async function statusFor(paseo: PluginHandlerContext["paseo"]) {
  const configured = customUpdaters();
  const customById = new Map(configured.map((provider) => [provider.id, provider]));
  const lastProviders = (readObject(STATE_PATH).providers ?? {}) as Record<string, Record<string, unknown>>;
  const live = await paseo.providers.listAvailable();
  const catalog = new Map<string, { label: string; available: boolean }>();
  for (const entry of live.providers as Array<{ provider: string; label?: string; available: boolean }>) {
    if (entry.provider === "agent-router" || entry.provider.endsWith("-auto")) continue;
    catalog.set(entry.provider, { label: entry.label ?? entry.provider, available: entry.available });
  }
  for (const [id, builtIn] of Object.entries(BUILT_INS)) {
    const prior = catalog.get(id);
    catalog.set(id, { label: prior?.label ?? builtIn.label, available: prior?.available ?? false });
  }
  for (const custom of configured) {
    const prior = catalog.get(custom.id);
    catalog.set(custom.id, { label: prior?.label ?? custom.label, available: prior?.available ?? false });
  }
  const providers: ToolchainProvider[] = [...catalog.entries()].map(([id, catalogEntry]) => {
    const builtIn = BUILT_INS[id];
    const custom = customById.get(id);
    const definition = custom ?? builtIn;
    const binary = definition?.binary ?? id;
    const path = resolveBinary(binary);
    const last = lastProviders[id] ?? {};
    return {
      id,
      label: custom?.label ?? catalogEntry.label,
      availableInPaseo: catalogEntry.available,
      installed: Boolean(path),
      managed: Boolean(definition),
      builtIn: Boolean(builtIn),
      binary: path || binary,
      version: binaryVersion(path, custom?.versionArgs ?? ["--version"]),
      versionArgs: custom?.versionArgs ?? ["--version"],
      updateArgs: custom?.updateArgs ?? builtIn?.updateArgs ?? [],
      processPattern: custom?.processPattern ?? builtIn?.processPattern ?? `(^|/)(${id})( |$)`,
      lastResult: typeof last.result === "string" ? last.result : "",
      lastChecked: typeof last.checkedAt === "string" ? last.checkedAt : "",
      detail: typeof last.detail === "string" ? last.detail : "",
    };
  }).sort((a, b) => Number(b.availableInPaseo) - Number(a.availableInPaseo) || a.label.localeCompare(b.label));

  let schedule = "disabled";
  const cli = agentLinkBinary();
  if (cli) {
    try {
      const line = execFileSync(cli, ["toolchain", "status"], { encoding: "utf8", timeout: 12_000 }).split("\n")[0] ?? "";
      schedule = line.replace(/^Automatic provider CLI updates:\s*/, "") || "disabled";
    } catch {
      schedule = "status unavailable";
    }
  }
  return { enabled: schedule.startsWith("enabled"), schedule, providers };
}

export async function handleToolchainStatus(_input: Record<string, never>, { paseo }: PluginHandlerContext) {
  return statusFor(paseo);
}

export async function handleToolchainConfigure(input: CustomUpdater, { paseo }: PluginHandlerContext) {
  if (BUILT_INS[input.id]) return { ok: false, message: `${input.label} already has a verified built-in updater.`, status: await statusFor(paseo) };
  const providers = customUpdaters().filter((provider) => provider.id !== input.id);
  providers.push(input);
  writeUpdaters(providers);
  return { ok: true, message: `${input.label} updater saved. It will run only when the provider is provably idle.`, status: await statusFor(paseo) };
}

export async function handleToolchainRemove({ id }: { id: string }, { paseo }: PluginHandlerContext) {
  if (BUILT_INS[id]) return { ok: false, message: "Built-in updater definitions cannot be removed.", status: await statusFor(paseo) };
  writeUpdaters(customUpdaters().filter((provider) => provider.id !== id));
  return { ok: true, message: `${id} returned to manual updates.`, status: await statusFor(paseo) };
}

export async function handleToolchainRun(): Promise<{ ok: boolean; message: string }> {
  const cli = agentLinkBinary();
  if (!cli) return { ok: false, message: "Install the AgentLink CLI first." };
  const child = spawn(cli, ["toolchain", "update"], { detached: true, stdio: "ignore" });
  child.unref();
  return { ok: true, message: "Provider update check started. Live providers are skipped, not interrupted." };
}

export async function handleToolchainSetEnabled({ enabled }: { enabled: boolean }, { paseo }: PluginHandlerContext) {
  const cli = agentLinkBinary();
  if (!cli) return { ok: false, message: "Install the AgentLink CLI first.", status: await statusFor(paseo) };
  try {
    const message = execFileSync(cli, ["toolchain", enabled ? "enable" : "disable"], { encoding: "utf8", timeout: 15_000 }).trim();
    return { ok: true, message: message.split("\n")[0] || (enabled ? "Automatic updates enabled." : "Automatic updates disabled."), status: await statusFor(paseo) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message.split("\n")[0] : String(error), status: await statusFor(paseo) };
  }
}
