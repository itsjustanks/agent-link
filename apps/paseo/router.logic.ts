/**
 * Pure helpers shared by the server handlers, the surface and the tests.
 * Nothing here touches the filesystem, the network or React.
 */

export type Quota = {
  label: string;
  used: number;
  total: number;
  remaining: number;
  remainingPercentage: number;
  resetAt: string | null;
  unlimited: boolean;
};

export type Usage = {
  plan: string | null;
  limitReached: boolean;
  quotas: Quota[];
};

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * 9router reports usage per provider in slightly different shapes: Claude has
 * `remaining` + `remainingPercentage`, Codex only `remaining`, Kimi only
 * `remainingPercentage`. Quota keys are provider-specific ("session (5h)",
 * "spark_weekly", "Weekly"), so the key is the label — no renaming.
 */
export function normalizeQuotas(raw: unknown): Quota[] {
  if (!raw || typeof raw !== "object") return [];
  const out: Quota[] = [];
  for (const [label, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const q = value as Record<string, unknown>;
    const total = num(q.total) ?? 100;
    const used = num(q.used) ?? 0;
    const percentage = num(q.remainingPercentage);
    let remaining = num(q.remaining);
    if (remaining === null) remaining = percentage !== null ? (total * percentage) / 100 : Math.max(0, total - used);
    const remainingPercentage = percentage ?? (total > 0 ? (remaining / total) * 100 : 0);
    out.push({
      label,
      used,
      total,
      remaining: Math.max(0, remaining),
      remainingPercentage: Math.max(0, Math.min(100, remainingPercentage)),
      resetAt: typeof q.resetAt === "string" ? q.resetAt : null,
      unlimited: q.unlimited === true,
    });
  }
  return out;
}

export function normalizeUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const quotas = normalizeQuotas(r.quotas);
  const plan = typeof r.plan === "string" && r.plan ? r.plan : null;
  if (quotas.length === 0 && plan === null) return null;
  return { plan, limitReached: r.limitReached === true, quotas };
}

/** Which CLI drives a 9router model id: Codex for `cx/`, Claude Code for everything else. */
export function cliForModel(modelId: string): "codex" | "claude" {
  return modelId.startsWith("cx/") ? "codex" : "claude";
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude Code",
  cc: "Claude Code",
  codex: "Codex",
  cx: "Codex",
  kimi: "Kimi",
  "kimi-coding": "Kimi",
  gemini: "Gemini",
  gemini_cli: "Gemini CLI",
  copilot: "GitHub Copilot",
  github: "GitHub Copilot",
  kiro: "Kiro",
  glm: "GLM",
  xai: "Grok",
  "grok-cli": "Grok CLI",
  cursor: "Cursor",
  qwen: "Qwen",
  antigravity: "Antigravity",
  iflow: "iFlow",
  combo: "Combos",
};

export function providerLabel(provider: string): string {
  const known = PROVIDER_LABELS[provider];
  if (known) return known;
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "Other";
}

export type ModelGroup = { prefix: string; label: string; ids: string[] };

const PREFIX_ORDER = ["cc", "cx"];

/**
 * Group model ids by their alias prefix (`cc/claude-opus-5` → `cc`), Claude
 * Code first, Codex second, everything else alphabetically. Ids without a
 * prefix land in a trailing "other" group. Order inside a group is preserved.
 */
export function groupModelIds(ids: readonly string[]): ModelGroup[] {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const slash = id.indexOf("/");
    const prefix = slash > 0 ? id.slice(0, slash) : "other";
    const list = groups.get(prefix) ?? [];
    list.push(id);
    groups.set(prefix, list);
  }
  const rank = (prefix: string) => {
    const index = PREFIX_ORDER.indexOf(prefix);
    if (index >= 0) return index;
    return prefix === "other" ? Number.MAX_SAFE_INTEGER : PREFIX_ORDER.length;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([prefix, list]) => ({ prefix, label: providerLabel(prefix), ids: list }));
}

/** Only the tail of a secret ever leaves the server. */
export function last4(secret: string | null | undefined): string | null {
  if (!secret || secret.length < 4) return null;
  return secret.slice(-4);
}

/** Turn Set-Cookie headers into a Cookie request header (name=value pairs only). */
export function cookieHeader(setCookies: readonly string[]): string {
  const jar = new Map<string, string>();
  for (const line of setCookies) {
    const pair = line.split(";", 1)[0]?.trim() ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

/**
 * The Claude sign-in page shows a code (`code#state`) for the user to copy;
 * some users paste the whole callback URL instead. Mirror the 9router
 * dashboard: a URL yields its `code` (+`state`), anything else is the code
 * itself and 9router splits a trailing `#state` on its side.
 */
export function parseOauthPaste(input: string): { code: string; state: string | null } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const code = url.searchParams.get("code");
      if (!code) return null;
      return { code, state: url.searchParams.get("state") };
    } catch {
      return null;
    }
  }
  return { code: trimmed, state: null };
}

/**
 * Provider entries agent-link used to write and now removes. `agent-link` is
 * on the list too: the ACP runtime it pointed at is gone, because 9router
 * rewrites the CLIs themselves and Paseo's native providers inherit that.
 */
export const DEAD_PROVIDER_IDS = ["agent-link", "claude-auto", "codex-auto", "agent-router"] as const;

/** Shims agent-link used to install into ROOT/bin and now removes. */
export function isLegacyShim(name: string): boolean {
  if (
    [
      "agent-link-acp",
      "claude-auto",
      "codex-auto",
      "agent-router",
      "codex-app-server-proxy",
      "claude",
      "codex",
      "claude-quota-statusline",
    ].includes(name)
  ) {
    return true;
  }
  return /^(claude|codex)-\d+$/.test(name);
}

/**
 * A readable label for a 9router model id. `cc/claude-opus-5` reads as
 * "Claude Opus 5 · 9router" so the native picker shows where the model comes
 * from without the raw alias prefix.
 */
export function modelLabel(id: string): string {
  const slash = id.indexOf("/");
  const bare = slash > 0 ? id.slice(slash + 1) : id;
  const pretty = bare
    .replace(/[-_]/g, " ")
    .replace(/\bgpt\b/gi, "GPT")
    .replace(/\bclaude\b/gi, "Claude")
    .replace(/\b([a-z])/g, (match) => match.toUpperCase())
    .replace(/\s+(\d)/g, " $1");
  return `${pretty} · 9router`;
}

/** Order-insensitive comparison, used to tell whether Paseo already lists what 9router serves. */
export function sameModelSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  for (const id of b) if (!left.has(id)) return false;
  return true;
}

export function formatReset(resetAt: string | null, now: number = Date.now()): string {
  if (!resetAt) return "";
  const at = Date.parse(resetAt);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return "resets now";
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `resets in ${days}d ${hours % 24}h`;
}

export function quotaTone(quota: Quota): "success" | "warning" | "danger" | "neutral" {
  if (quota.unlimited) return "neutral";
  if (quota.remainingPercentage <= 5) return "danger";
  if (quota.remainingPercentage <= 25) return "warning";
  return "success";
}
