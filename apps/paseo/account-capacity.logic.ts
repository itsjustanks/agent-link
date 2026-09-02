export type AccountProvider = "claude" | "codex";

export type ExtraUsage = {
  at: number;
  accountEnabled: boolean | null;
  enabled: boolean | null;
  used: number | null;
  limit: number | null;
  balance: number | null;
  currency: string;
  reason: string;
  spendLimitReached: boolean;
  userDisabled: boolean | null;
  everEnabled: boolean | null;
  canToggle: boolean | null;
};

export type PoolQuota = {
  at: number;
  model: string;
  plan: string;
  source: string;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string } | null;
  extraUsage: ExtraUsage | null;
  windows: Array<{
    label: string;
    kind: "session" | "weekly" | "other";
    durationMinutes: number | null;
    pct: number;
    resetsAt: number | null;
  }>;
};

export type AccountQuotaBinding = {
  provider: AccountProvider;
  email: string;
  poolKey: string;
  isPrimary: boolean;
  quota: PoolQuota | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function normalizeAccountEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function accountIdentity(provider: AccountProvider, email: string): string {
  return `${provider}:${normalizeAccountEmail(email)}`;
}

export function groupAccountQuotaBindings<T extends AccountQuotaBinding>(bindings: T[]): Array<{
  accountId: string;
  bindings: T[];
  representative: T;
  quota: PoolQuota | null;
}> {
  const byAccount = new Map<string, T[]>();
  for (const binding of bindings) {
    const id = accountIdentity(binding.provider, binding.email);
    const group = byAccount.get(id) ?? [];
    group.push(binding);
    byAccount.set(id, group);
  }
  return [...byAccount.entries()].map(([accountId, group]) => ({
    accountId,
    bindings: group,
    representative: group.find((binding) => binding.isPrimary) ??
      [...group].sort((left, right) => left.poolKey.localeCompare(right.poolKey))[0]!,
    quota: group.reduce<PoolQuota | null>(
      (merged, binding) => mergePoolQuotas(merged, binding.quota),
      null,
    ),
  }));
}

export function epochSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.floor(value / 1_000) : value;
  }
  if (typeof value !== "string" || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : null;
}

function money(value: unknown): { amount: number; currency: string } | null {
  if (typeof value === "number" && Number.isFinite(value)) return { amount: value, currency: "" };
  const entry = record(value);
  if (!entry) return null;
  const minor = finiteNumber(entry.amount_minor ?? entry.amountMinor);
  if (minor === null) return null;
  const exponent = finiteNumber(entry.exponent) ?? 2;
  return {
    amount: minor / (10 ** exponent),
    currency: typeof entry.currency === "string" ? entry.currency.toUpperCase() : "",
  };
}

function parseExtraUsage(container: Record<string, unknown>, at: number): ExtraUsage | null {
  const extra = record(container.extra_usage ?? container.extraUsage);
  const spend = record(container.spend);
  if (!extra && !spend) return null;

  const usedMoney = money(spend?.used);
  const limitMoney = money(spend?.limit);
  const balanceMoney = money(spend?.balance);
  const extraUsed = finiteNumber(extra?.used_credits ?? extra?.usedCredits);
  const extraLimit = finiteNumber(extra?.monthly_limit ?? extra?.monthlyLimit);
  const currency = usedMoney?.currency || limitMoney?.currency || balanceMoney?.currency ||
    (typeof extra?.currency === "string" ? extra.currency.toUpperCase() : "");
  const reason = [spend?.disabled_reason, extra?.disabled_reason]
    .find((value) => typeof value === "string" && value !== "");

  return {
    at,
    accountEnabled: null,
    enabled: booleanOrNull(spend?.enabled) ?? booleanOrNull(extra?.is_enabled ?? extra?.enabled),
    used: usedMoney?.amount ?? extraUsed,
    limit: limitMoney?.amount ?? extraLimit,
    balance: balanceMoney?.amount ?? finiteNumber(extra?.balance),
    currency,
    reason: typeof reason === "string" ? reason : "",
    spendLimitReached: Boolean(extra?.spend_limit_reached ?? extra?.spendLimitReached),
    userDisabled: booleanOrNull(extra?.user_disabled ?? extra?.userDisabled),
    everEnabled: booleanOrNull(extra?.credits_ever_enabled ?? extra?.everEnabled),
    canToggle: booleanOrNull(spend?.can_toggle ?? spend?.canToggle),
  };
}

export function poolQuotaFromRaw(provider: string, raw: Record<string, unknown> | null): PoolQuota | null {
  if (!raw) return null;
  const windows: PoolQuota["windows"] = [];
  for (const [keyName, fallbackMinutes] of [
    ["five_hour", 300],
    ["seven_day", 10_080],
    ["primary", null],
    ["secondary", null],
  ] as const) {
    const value = record(raw[keyName]);
    const pct = finiteNumber(value?.pct);
    if (pct === null) continue;
    const legacyMinutes = keyName === "primary" ? finiteNumber(raw.window_minutes) : null;
    const durationMinutes = finiteNumber(value?.window_minutes) ?? legacyMinutes ?? fallbackMinutes;
    const kind = durationMinutes !== null && durationMinutes <= 360
      ? "session"
      : durationMinutes !== null && durationMinutes >= 10_080
        ? "weekly"
        : "other";
    windows.push({
      label: kind === "session" ? "Session limit" : kind === "weekly" ? "Weekly limit" : "Usage limit",
      kind,
      durationMinutes,
      pct,
      resetsAt: finiteNumber(value?.resets_at),
    });
  }
  const extraWindows = Array.isArray(raw.windows) ? raw.windows : [];
  for (const candidate of extraWindows) {
    const value = record(candidate);
    const pct = finiteNumber(value?.pct);
    if (!value || pct === null || typeof value.label !== "string") continue;
    const kind = value.kind === "session" || value.kind === "weekly" ? value.kind : "other";
    const resetsAt = finiteNumber(value.resets_at);
    if (windows.some((entry) => entry.label === value.label && entry.resetsAt === resetsAt)) continue;
    windows.push({
      label: value.label,
      kind,
      durationMinutes: finiteNumber(value.duration_minutes),
      pct,
      resetsAt,
    });
  }
  const at = finiteNumber(raw.at) ?? 0;
  const credit = record(raw.credits);
  const credits = typeof credit?.has_credits === "boolean"
    ? {
        hasCredits: credit.has_credits,
        unlimited: Boolean(credit.unlimited),
        balance: credit.balance === undefined || credit.balance === null ? "" : String(credit.balance),
      }
    : null;
  const extraUsage = parseExtraUsage(raw, at);
  if (windows.length === 0 && !credits && !extraUsage) return null;
  return {
    at,
    model: typeof raw.model === "string" ? raw.model : "",
    plan: typeof raw.plan === "string" ? raw.plan : "",
    source: typeof raw.source === "string" && raw.source !== ""
      ? raw.source
      : provider === "claude" ? "Claude statusline" : "Codex rollout",
    credits,
    extraUsage,
    windows,
  };
}

export function claudeCachedQuotaFromConfig(config: Record<string, unknown> | null): PoolQuota | null {
  const cached = record(config?.cachedUsageUtilization);
  const utilization = record(cached?.utilization);
  const entitlement = booleanOrNull(record(config?.oauthAccount)?.hasExtraUsageEnabled);
  if (!utilization && entitlement === null) return null;
  const at = epochSeconds(cached?.fetchedAtMs) ?? 0;
  const windows: PoolQuota["windows"] = [];
  for (const [key, label, kind, durationMinutes] of [
    ["five_hour", "Session limit", "session", 300],
    ["seven_day", "Weekly limit", "weekly", 10_080],
  ] as const) {
    const value = record(utilization?.[key]);
    const pct = finiteNumber(value?.utilization);
    if (pct === null) continue;
    windows.push({ label, kind, durationMinutes, pct, resetsAt: epochSeconds(value?.resets_at) });
  }
  const limits = Array.isArray(utilization?.limits) ? utilization.limits : [];
  for (const candidate of limits) {
    const value = record(candidate);
    const scope = record(value?.scope);
    const model = record(scope?.model)?.display_name;
    const pct = finiteNumber(value?.percent);
    if (typeof model !== "string" || pct === null) continue;
    windows.push({
      label: `${model} weekly limit`,
      kind: "weekly",
      durationMinutes: 10_080,
      pct,
      resetsAt: epochSeconds(value?.resets_at),
    });
  }
  const parsedExtraUsage = parseExtraUsage(utilization ?? {}, at);
  const extraUsage = parsedExtraUsage || entitlement !== null
    ? {
        ...(parsedExtraUsage ?? {
          at,
          enabled: null,
          used: null,
          limit: null,
          balance: null,
          currency: "",
          reason: "",
          spendLimitReached: false,
          userDisabled: null,
          everEnabled: null,
          canToggle: null,
        }),
        accountEnabled: entitlement,
      }
    : null;
  if (windows.length === 0 && !extraUsage) return null;
  return {
    at,
    model: "",
    plan: "",
    source: "Claude /usage cache",
    credits: null,
    extraUsage,
    windows,
  };
}

export function mergePoolQuotas(left: PoolQuota | null, right: PoolQuota | null): PoolQuota | null {
  if (!left) return right;
  if (!right) return left;
  const newer = right.at > left.at ? right : left;
  const older = newer === left ? right : left;
  const windowSource = newer.windows.length > 0 ? newer : older.windows.length > 0 ? older : newer;
  const extraUsageCandidates = [left.extraUsage, right.extraUsage]
    .filter((entry): entry is ExtraUsage => entry !== null)
    .sort((a, b) => b.at - a.at);
  const newestExtraUsage = extraUsageCandidates[0] ?? null;
  const newestValue = <T,>(read: (entry: ExtraUsage) => T | null): T | null => {
    for (const entry of extraUsageCandidates) {
      const value = read(entry);
      if (value !== null) return value;
    }
    return null;
  };
  const newestText = (read: (entry: ExtraUsage) => string): string =>
    extraUsageCandidates.map(read).find((value) => value !== "") ?? "";
  const hasSpendObservation = (entry: ExtraUsage): boolean =>
    entry.enabled !== null ||
    entry.used !== null ||
    entry.limit !== null ||
    entry.balance !== null ||
    entry.currency !== "" ||
    entry.reason !== "" ||
    entry.spendLimitReached ||
    entry.userDisabled !== null ||
    entry.everEnabled !== null ||
    entry.canToggle !== null;
  const spendObservation = extraUsageCandidates.find(hasSpendObservation) ?? null;
  const extraUsage = newestExtraUsage
    ? {
        at: spendObservation?.at ?? newestExtraUsage.at,
        accountEnabled: newestValue((entry) => entry.accountEnabled),
        enabled: newestValue((entry) => entry.enabled),
        used: newestValue((entry) => entry.used),
        limit: newestValue((entry) => entry.limit),
        balance: newestValue((entry) => entry.balance),
        currency: newestText((entry) => entry.currency),
        reason: newestText((entry) => entry.reason),
        spendLimitReached: spendObservation?.spendLimitReached ?? false,
        userDisabled: newestValue((entry) => entry.userDisabled),
        everEnabled: newestValue((entry) => entry.everEnabled),
        canToggle: newestValue((entry) => entry.canToggle),
      }
    : null;
  return {
    at: windowSource.windows.length > 0 ? windowSource.at : Math.max(left.at, right.at),
    model: newer.model || older.model,
    plan: newer.plan || older.plan,
    source: windowSource.source,
    credits: newer.credits ?? older.credits,
    extraUsage,
    windows: windowSource.windows,
  };
}
