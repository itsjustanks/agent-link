import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { cliInstall, cliStatus, cliUpdateApply, cliUpdateCheck } from "./cli.shared";
import { limitsResume, limitsSetAuto, limitsStatus, type LimitEvent } from "./limits.shared";
import { resourceSetEnabled, resourceStatus } from "./resources.shared";
import {
  accountUsage,
  accountCapacity,
  addAccount,
  removeAccount,
  diagnoseProvider,
  providerHeartbeat,
  scan,
  setCooldown,
  setPreference,
  routerLaunch,
  wireAuto,
  wireProvider,
  type AccountUsage,
  type CapacityAccount,
  type ProviderHeartbeat,
  type AutoRouter,
  type Slot,
} from "./contracts.shared";
import {
  Button,
  Card,
  CodeBlock,
  ConfirmButton,
  Disclosure,
  ErrorText,
  Facts,
  Field,
  Loading,
  Meter,
  Notice,
  Row,
  Screen,
  Section,
  Segmented,
  Spark,
  StatusPill,
  Tag,
  Toolbar,
  statusColor,
  useTokens,
  useUi,
  type Status,
} from "./ui.client";

/**
 * Agent Link's account surface.
 *
 * The product is the router: one Paseo provider that hands each new agent to a
 * live account. So the router is the hero and holds the view's only primary
 * button; accounts are the evidence underneath it, and everything that repairs
 * a single account (its login command, its own pinned provider, its usage
 * detail) lives in that account's row rather than in a shared block of copy.
 */

type ProviderId = "claude" | "codex";

const CARD_TITLE: Record<ProviderId, string> = { claude: "Claude Code", codex: "Codex" };
const SHORT: Record<ProviderId, string> = { claude: "Claude", codex: "Codex" };

function agoLabel(epoch: number): string {
  const mins = Math.max(0, Math.round((Date.now() - epoch * 1000) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function remainingLabel(until: number): string {
  const mins = Math.max(1, Math.round((until * 1000 - Date.now()) / 60000));
  return mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return value >= 1000 ? `${Math.round(value / 1000)}k` : `${value}`;
}

// Cache reads are input the account did not pay full price for.
function cachePercent(row: AccountUsage): number {
  // Codex reports cached input as a subset of input_tokens; Claude reports it
  // beside input_tokens. Use each provider's own accounting shape.
  const total = row.provider === "codex" ? row.inputTokens : row.inputTokens + row.cacheReadTokens + row.cacheCreationTokens;
  return total > 0 ? Math.round((row.cacheReadTokens / total) * 100) : 0;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

type CapacityWindow = CapacityAccount["windows"][number];

function countdownLabel(epoch: number): string {
  const minutes = Math.floor((epoch * 1000 - Date.now()) / 60_000);
  if (minutes <= 0) return "reset due";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}

function deviceResetLabel(epoch: number): string {
  return `${new Date(epoch * 1000).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  })} on this device`;
}

function durationLabel(window: CapacityWindow): string {
  const minutes = window.durationMinutes;
  if (!minutes) return window.kind === "weekly" ? "7-day window" : window.kind === "session" ? "rolling session window" : "provider window";
  if (minutes === 10_080) return "7-day rolling window";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}-week rolling window`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day rolling window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour rolling window`;
  return `${minutes}-minute rolling window`;
}

function capacityTone(entry: CapacityAccount): Status {
  if (entry.state === "held") return "error";
  if (entry.state === "parked" || entry.state === "nearing") return "attention";
  if (entry.state === "ready") return "ok";
  return "neutral";
}

function capacityStateLabel(entry: CapacityAccount): string {
  if (entry.state === "held") return "held";
  if (entry.state === "parked") return "cooling down";
  if (entry.state === "nearing") return "routing away";
  if (entry.state === "ready") return "available";
  return entry.windows.length > 0 ? "report is stale" : "no report yet";
}

function creditLabel(entry: CapacityAccount): string | null {
  if (!entry.credits) return null;
  if (entry.credits.unlimited) return "unlimited extra credits";
  if (!entry.credits.hasCredits) return "no extra credits";
  const balance = Number(entry.credits.balance);
  return Number.isFinite(balance) ? `extra credit balance ${balance.toFixed(2)}` : "extra credits available";
}

function LimitWindow({ window }: { window: CapacityWindow }) {
  const t = useTokens();
  const used = Math.max(0, Math.min(100, Math.round(window.usedPct)));
  const available = 100 - used;
  const tone: Status = used >= 99 ? "error" : used >= 85 ? "attention" : "ok";
  const reset = window.resetsAt
    ? `${countdownLabel(window.resetsAt)} · ${deviceResetLabel(window.resetsAt)}`
    : "reset time not reported";
  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: t.compact ? "100%" : 250,
        minWidth: 0,
        gap: t.space.sm,
        padding: t.space.md,
        borderRadius: t.radius.sm,
        backgroundColor: t.color.surface2,
      }}
    >
      <View style={{ gap: 1 }}>
        <Text style={t.text.bodyStrong}>{window.label}</Text>
        <Text style={t.text.caption}>{durationLabel(window)}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 5 }}>
        <Text style={[t.text.display, { color: statusColor(t, tone) }]}>{available}%</Text>
        <Text style={t.text.caption}>available</Text>
      </View>
      <Meter fraction={used / 100} tone={tone} label={`${used}% used · ${available}% remaining`} />
      <Text style={t.text.caption}>{reset}</Text>
    </View>
  );
}

function CapacityAccountPanel({ entry, first }: { entry: CapacityAccount; first: boolean }) {
  const t = useTokens();
  const tone = capacityTone(entry);
  const credit = creditLabel(entry);
  const freshest = entry.at > 0 ? `updated ${agoLabel(entry.at)}` : "not reported yet";
  return (
    <View
      style={{
        padding: t.compact ? t.space.md : t.space.lg,
        gap: t.space.md,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: t.color.borderSubtle,
      }}
    >
      <View
        style={{
          flexDirection: t.compact ? "column" : "row",
          alignItems: t.compact ? "stretch" : "flex-start",
          justifyContent: "space-between",
          gap: t.space.sm,
        }}
      >
        <View style={{ flex: 1, minWidth: 0, gap: t.space.xs }}>
          <Text style={t.text.heading} numberOfLines={1}>
            {entry.email}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.xs }}>
            <Tag label={entry.provider === "claude" ? "Claude" : "Codex"} />
            <Tag label={entry.isPrimary ? "Primary account" : "Routed account"} />
            {entry.plan ? <Tag label={`${entry.plan} plan`} tone="busy" /> : null}
            {entry.model ? <Tag label={entry.model} /> : null}
          </View>
        </View>
        <StatusPill status={tone} label={capacityStateLabel(entry)} />
      </View>

      {entry.windows.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
          {entry.windows.map((window, index) => (
            <LimitWindow key={`${window.label}-${window.durationMinutes ?? index}`} window={window} />
          ))}
        </View>
      ) : (
        <View style={{ padding: t.space.md, borderRadius: t.radius.sm, backgroundColor: t.color.surface2, gap: t.space.xs }}>
          <Text style={t.text.bodyStrong}>No quota telemetry yet</Text>
          <Text style={t.text.caption}>{entry.detail}</Text>
        </View>
      )}

      <Facts
        items={[
          entry.detail ? { value: entry.detail, tone: entry.state === "ready" ? undefined : tone } : null,
          { value: entry.source ? `${freshest} from ${entry.source}` : freshest, tone: entry.state === "unknown" ? "attention" : undefined },
          credit ? { value: credit, tone: entry.credits?.hasCredits ? "ok" : "neutral" } : null,
        ]}
      />
    </View>
  );
}

function ActivityAccountPanel({ row, first }: { row: AccountUsage; first: boolean }) {
  const t = useTokens();
  const active = row.lastActive > 0;
  return (
    <View
      style={{
        padding: t.compact ? t.space.md : t.space.lg,
        gap: t.space.sm,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: t.color.borderSubtle,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: t.space.sm }}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={t.text.heading} numberOfLines={1}>
            {row.email}
          </Text>
          <Text style={t.text.caption}>{row.provider === "claude" ? "Claude" : "Codex"} · last 7 days</Text>
        </View>
        <StatusPill status={row.limitHits > 0 ? "attention" : active ? "ok" : "neutral"} label={active ? `active ${agoLabel(row.lastActive)}` : "no activity"} />
      </View>
      {row.sessions > 0 ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.md }}>
            <Spark values={row.daily} tone={row.limitHits > 0 ? "attention" : "busy"} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Facts
                items={[
                  { value: plural(row.sessions, "session", "sessions") },
                  { value: `${formatTokens(row.inputTokens)} input` },
                  { value: `${formatTokens(row.outputTokens)} output` },
                  { value: `${cachePercent(row)}% cached` },
                ]}
              />
            </View>
          </View>
          {row.models.length > 0 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.xs }}>
              {row.models.map((model) => (
                <Tag key={model} label={model.replace("claude-", "")} />
              ))}
            </View>
          ) : null}
          <Facts
            items={[
              row.reasoningTokens > 0 ? { value: `${formatTokens(row.reasoningTokens)} reasoning tokens` } : null,
              row.contextWindow > 0 ? { value: `${formatTokens(row.contextWindow)} context window` } : null,
              row.topProject ? { value: `mostly ${row.topProject}` } : null,
              row.limitHits > 0 ? { value: plural(row.limitHits, "limit refusal", "limit refusals"), tone: "error" } : null,
            ]}
          />
        </>
      ) : (
        <Text style={t.text.caption}>No sessions recorded for this account in the last 7 days.</Text>
      )}
    </View>
  );
}

export function AgentSyncSurface({ theme, layout }: PluginSurfaceProps) {
  const t = useUi(theme, layout.compact);
  const queryClient = useQueryClient();
  const callScan = useRpc(scan);
  const callCliStatus = useRpc(cliStatus);
  const callCliInstall = useRpc(cliInstall);
  const callUpdateCheck = useRpc(cliUpdateCheck);
  const callUpdateApply = useRpc(cliUpdateApply);
  const callWire = useRpc(wireProvider);
  const callDiagnose = useRpc(diagnoseProvider);
  const callHeartbeat = useRpc(providerHeartbeat);
  const callWireAuto = useRpc(wireAuto);
  const callRouterLaunch = useRpc(routerLaunch);
  const callCooldown = useRpc(setCooldown);
  const callAddAccount = useRpc(addAccount);
  const callRemoveAccount = useRpc(removeAccount);
  const callSetPreference = useRpc(setPreference);
  const callUsage = useRpc(accountUsage);
  const callCapacity = useRpc(accountCapacity);
  const callLimitsStatus = useRpc(limitsStatus);
  const callLimitsSetAuto = useRpc(limitsSetAuto);
  const callLimitsResume = useRpc(limitsResume);
  const callResourceStatus = useRpc(resourceStatus);
  const callResourceSetEnabled = useRpc(resourceSetEnabled);

  const [diagnosis, setDiagnosis] = useState<Record<string, string>>({});
  const [diagnosing, setDiagnosing] = useState<string | null>(null);
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [addingFor, setAddingFor] = useState<ProviderId | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [routerTask, setRouterTask] = useState("");
  const [usageView, setUsageView] = useState<"limits" | "activity">("limits");
  const [providerTab, setProviderTab] = useState("claude");

  const scanQuery = useQuery({
    queryKey: ["agent-link", "scan"],
    queryFn: () => callScan({}),
    refetchInterval: 30000,
  });
  // Usage re-reads every transcript on disk, so it runs on request only.
  const usageQuery = useQuery({
    queryKey: ["agent-link", "account-usage"],
    queryFn: () => callUsage({ days: 7 }),
    enabled: false,
  });
  // Capacity is only a few tiny state files, so it can be the always-visible
  // answer. Transcript activity remains opt-in because it is much heavier.
  const capacityQuery = useQuery({
    queryKey: ["agent-link", "account-capacity"],
    queryFn: () => callCapacity({}),
    refetchInterval: 30000,
  });
  // This is intentionally a registry heartbeat, not a provider diagnostic:
  // it proves the daemon and provider registration are live without starting
  // an ACP session or spending a model request.
  const heartbeatQuery = useQuery({
    queryKey: ["agent-link", "provider-heartbeat"],
    queryFn: () => callHeartbeat({}),
    refetchInterval: 30000,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["agent-link"] });

  // Cheap (a JSON file read) and it arms the sentry, so it runs on mount and
  // refreshes on a slow poll — a dead agent shows up without a manual refresh.
  const limitsQuery = useQuery({
    queryKey: ["agent-link", "limits"],
    queryFn: () => callLimitsStatus({}),
    refetchInterval: 30000,
  });
  const limitsAutoMutation = useMutation({
    mutationFn: (auto: boolean) => callLimitsSetAuto({ auto }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agent-link", "limits"] }),
  });
  const resourceQuery = useQuery({
    queryKey: ["agent-link", "resources"],
    queryFn: () => callResourceStatus({}),
    refetchInterval: 10000,
  });
  const resourceMutation = useMutation({
    mutationFn: (enabled: boolean) => callResourceSetEnabled({ enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agent-link", "resources"] }),
  });
  const routerLaunchMutation = useMutation({
    mutationFn: (prompt: string) => callRouterLaunch({ prompt }),
    onSuccess: (result) => {
      setNotice(result.message);
      if (result.ok) setRouterTask("");
    },
  });
  const limitsResumeMutation = useMutation({
    mutationFn: (agentId: string) => callLimitsResume({ agentId }),
    onSuccess: (result) => {
      setNotice(result.ok ? "Agent nudged — it continues on a healthy account" : `Resume failed: ${result.error ?? "unknown"}`);
      void queryClient.invalidateQueries({ queryKey: ["agent-link", "limits"] });
    },
  });

  const routerMutation = useMutation({
    mutationFn: async (providers: ProviderId[]) => {
      const lines: string[] = [];
      for (const provider of providers) lines.push((await callWireAuto({ provider })).message);
      return lines.join("\n");
    },
    onSuccess: (message) => {
      setNotice(message);
      refresh();
    },
  });
  const pinMutation = useMutation({
    mutationFn: (slot: Slot) => callWire({ provider: slot.provider, email: slot.email, dir: slot.dir }),
    onSuccess: (result) => {
      setNotice(`'${result.providerId}' wired — it always uses that one account`);
      refresh();
    },
  });
  const addMutation = useMutation({
    mutationFn: (input: { provider: ProviderId; email: string }) => callAddAccount(input),
    onSuccess: (result) => {
      setNotice(result.message);
      if (result.ok) {
        setAddingFor(null);
        setNewEmail("");
      }
      refresh();
    },
  });
  const cooldownMutation = useMutation({
    mutationFn: (input: { provider: ProviderId; email: string; minutes: number }) => callCooldown(input),
    onSuccess: (result) => {
      setNotice(result.message);
      refresh();
    },
  });
  const preferenceMutation = useMutation({
    mutationFn: (input: { provider: ProviderId; email: string; preference: "preferred" | "standard" | "reserve" }) =>
      callSetPreference(input),
    onSuccess: (result) => {
      setNotice(result.message);
      refresh();
    },
  });
  const removeMutation = useMutation({
    mutationFn: (input: { provider: ProviderId; email: string }) => callRemoveAccount(input),
    onSuccess: (result) => {
      setNotice(result.message);
      refresh();
    },
  });

  const slots = scanQuery.data?.slots ?? [];
  const routingSlots = slots.filter((slot) => slot.source === "agent-link");
  const primaryAccounts = scanQuery.data?.primaryAccounts;
  const routers = scanQuery.data?.autoRouters ?? [];
  const heartbeatProviders = heartbeatQuery.data?.providers ?? [];
  const heartbeatById = new Map(heartbeatProviders.map((provider) => [provider.id, provider]));
  const primaryInfo = (provider: ProviderId) => (scanQuery.data?.primaries ?? []).find((entry) => entry.provider === provider);
  const primaryEmail = (provider: ProviderId) => (provider === "claude" ? primaryAccounts?.claude : primaryAccounts?.codex) ?? "";

  // A rate limit belongs to an ACCOUNT, so two entries signed into the same
  // account are one pool wearing two hats — the failure mode where you think
  // you have a spare pool and don't.
  const accountUses = new Map<string, number>();
  const countAccount = (provider: string, email: string) => {
    if (!email) return;
    const key = `${provider}:${email}`;
    accountUses.set(key, (accountUses.get(key) ?? 0) + 1);
  };
  countAccount("claude", primaryAccounts?.claude ?? "");
  countAccount("codex", primaryAccounts?.codex ?? "");
  for (const slot of routingSlots) countAccount(slot.provider, slot.actualEmail || slot.email);
  const isShared = (provider: string, email: string) => (accountUses.get(`${provider}:${email}`) ?? 0) > 1;
  const distinctPools = accountUses.size;

  useEffect(() => {
    if (heartbeatProviders.length > 0 && !heartbeatProviders.some((provider) => provider.id === providerTab)) {
      setProviderTab(heartbeatProviders[0]!.id);
    }
  }, [heartbeatProviders, providerTab]);
  const totalEntries = [...accountUses.values()].reduce((sum, count) => sum + count, 0);

  const maxLaunches = Math.max(
    1,
    ...slots.map((slot) => slot.launches),
    ...(scanQuery.data?.primaries ?? []).map((entry) => entry.launches),
  );

  // The server already picked who takes the next agent; resolve it to a row so
  // the tag lands on that row and not on a duplicate of the same address.
  const nextUpKey = (provider: ProviderId): string => {
    const email = (scanQuery.data?.nextUp ?? []).find((entry) => entry.provider === provider)?.email ?? "";
    if (!email) return "";
    const info = primaryInfo(provider);
    if (email === primaryEmail(provider) && info && !info.duplicated) return `primary-${provider}`;
    const slot = routingSlots.find(
      (entry) =>
        entry.provider === provider &&
        entry.email === email &&
        entry.loggedIn &&
        !entry.wrongAccount &&
        !entry.blocked &&
        entry.cooldownUntil === 0,
    );
    return slot ? slot.dir : "";
  };
  const nextUpKeys: Record<ProviderId, string> = { claude: nextUpKey("claude"), codex: nextUpKey("codex") };

  const usageFor = (email: string): AccountUsage | null =>
    (usageQuery.data?.accounts ?? []).find((entry) => entry.email === email) ?? null;

  const pad = t.compact ? t.space.md : t.space.lg;
  const toggleRow = (key: string) => setOpenRows((previous) => ({ ...previous, [key]: !previous[key] }));
  const runDiagnose = (providerId: string, key: string) => {
    setDiagnosing(key);
    void callDiagnose({ providerId })
      .then((result) => setDiagnosis((previous) => ({ ...previous, [key]: previous[key] ? "" : result.summary })))
      .finally(() => setDiagnosing(null));
  };

  // ------------------------------------------------------------------ routing

  const capacityAccounts = capacityQuery.data?.accounts ?? [];
  const readyCapacity = capacityAccounts.filter((entry) => entry.state === "ready").length;
  const constrainedCapacity = capacityAccounts.filter((entry) => entry.state === "nearing" || entry.state === "parked" || entry.state === "held").length;
  const unknownCapacity = capacityAccounts.filter((entry) => entry.state === "unknown").length;
  const capacityCard = (
    <Card padded={false} tone={constrainedCapacity > 0 ? "attention" : undefined}>
      <View>
        <View style={{ padding: pad, gap: t.space.md }}>
          <View
            style={{
              flexDirection: t.compact ? "column" : "row",
              alignItems: t.compact ? "stretch" : "flex-start",
              justifyContent: "space-between",
              gap: t.space.md,
            }}
          >
            <View style={{ flex: 1, minWidth: 0, gap: t.space.xs }}>
              <Text style={t.text.heading}>Provider usage</Text>
              <Text style={[t.text.body, { color: t.color.muted }]}>Live limit windows and observed activity for every routed account.</Text>
              {usageView === "limits" && capacityAccounts.length > 0 ? (
                <Facts
                  items={[
                    { value: plural(readyCapacity, "account available", "accounts available"), tone: readyCapacity > 0 ? "ok" : "attention" },
                    constrainedCapacity > 0
                      ? { value: plural(constrainedCapacity, "account constrained", "accounts constrained"), tone: "attention" }
                      : null,
                    unknownCapacity > 0
                      ? { value: plural(unknownCapacity, "account awaiting telemetry", "accounts awaiting telemetry"), tone: "attention" }
                      : null,
                    { value: "refreshes every 30 seconds" },
                  ]}
                />
              ) : null}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: t.space.sm }}>
              <Segmented
                value={usageView}
                options={[
                  { value: "limits", label: "Limits" },
                  { value: "activity", label: "Activity · 7 days" },
                ]}
                onChange={(value) => {
                  setUsageView(value);
                  if (value === "activity" && !usageQuery.data && !usageQuery.isFetching) void usageQuery.refetch();
                }}
              />
              <Button
                label="Refresh"
                variant="ghost"
                loading={usageView === "limits" ? capacityQuery.isFetching : usageQuery.isFetching}
                onPress={() => void (usageView === "limits" ? capacityQuery.refetch() : usageQuery.refetch())}
              />
            </View>
          </View>
          {usageView === "limits" ? (
            <Text style={t.text.caption}>
              Providers report rolling account limits, not a separate remaining balance for every model. Model names show which session supplied the report.
            </Text>
          ) : (
            <Text style={t.text.caption}>Models below are observed from local session history; activity is not the same as quota consumed.</Text>
          )}
        </View>

        {usageView === "limits" ? (
          capacityQuery.isLoading ? (
            <Loading label="Reading provider limits…" />
          ) : capacityQuery.error ? (
            <View style={{ padding: pad }}>
              <ErrorText>{String(capacityQuery.error)}</ErrorText>
            </View>
          ) : capacityAccounts.length === 0 ? (
            <View style={{ padding: pad }}>
              <Text style={t.text.caption}>No signed-in Claude or Codex accounts were found.</Text>
            </View>
          ) : (
            capacityAccounts.map((entry, index) => (
              <CapacityAccountPanel key={`${entry.provider}-${entry.poolKey}`} entry={entry} first={index === 0} />
            ))
          )
        ) : usageQuery.isFetching && !usageQuery.data ? (
          <Loading label="Reading 7 days of local activity…" />
        ) : usageQuery.error ? (
          <View style={{ padding: pad }}>
            <ErrorText>{String(usageQuery.error)}</ErrorText>
          </View>
        ) : (usageQuery.data?.accounts.length ?? 0) === 0 ? (
          <View style={{ padding: pad }}>
            <Text style={t.text.caption}>No account activity was found in the last 7 days.</Text>
          </View>
        ) : (
          usageQuery.data?.accounts.map((row, index) => (
            <ActivityAccountPanel key={`${row.provider}-${row.email}`} row={row} first={index === 0} />
          ))
        )}
      </View>
    </Card>
  );

  const pending = routers.filter((entry) => !entry.wiredProviderId && entry.launcherExists).map((entry) => entry.provider);
  const noLauncher = routers.filter((entry) => !entry.wiredProviderId && !entry.launcherExists);
  const wired = routers.filter((entry) => entry.wiredProviderId).length;
  const routingStatus: Status = routers.length > 0 && wired === routers.length ? "ok" : "attention";
  const routingLabel = wired === 0 ? "not installed" : wired === routers.length ? "installed" : "half installed";

  const inRotation = (provider: ProviderId) => {
    const info = primaryInfo(provider);
    const own = primaryEmail(provider) && info && !info.duplicated && !info.blocked && info.cooldownUntil === 0 ? 1 : 0;
    return own + routingSlots.filter((slot) => slot.provider === provider && slot.loggedIn && !slot.wrongAccount && !slot.blocked && slot.cooldownUntil === 0).length;
  };

  const routerRow = (entry: AutoRouter) => {
    const next = (scanQuery.data?.nextUp ?? []).find((item) => item.provider === entry.provider)?.email ?? "";
    const count = inRotation(entry.provider);
    const primary = primaryInfo(entry.provider);
    const targets = [
      ...(primary && primary.email
        ? [
            {
              key: `primary-${entry.provider}`,
              email: primary.email,
              preference: primary.preference,
              launches: primary.launches,
              lastUsed: 0,
              ready: !primary.duplicated && !primary.blocked && primary.cooldownUntil === 0,
              nearing: primary.nearing,
              state: primary.duplicated
                ? "duplicate skipped"
                : primary.blocked || primary.cooldownUntil > 0
                  ? "cooling down"
                  : primary.nearing
                    ? "draining"
                    : "available",
              detail: primary.parkReason,
              slot: null as Slot | null,
            },
          ]
        : []),
      ...routingSlots
        .filter((slot) => slot.provider === entry.provider)
        .map((slot) => ({
          key: slot.dir,
          email: slot.email,
          preference: slot.preference,
          launches: slot.launches,
          lastUsed: slot.lastUsed,
          ready: slot.loggedIn && !slot.wrongAccount && !slot.blocked && slot.cooldownUntil === 0,
          nearing: slot.nearing,
          state: !slot.loggedIn
            ? "not signed in"
            : slot.wrongAccount
              ? "wrong account"
              : slot.blocked || slot.cooldownUntil > 0
                ? "cooling down"
                : slot.nearing
                  ? "draining"
                  : "available",
          detail: slot.parkReason,
          slot,
        })),
    ];
    const routeHistory = (scanQuery.data?.recentRoutes ?? []).filter((route) => route.provider === entry.provider).slice(0, 5);
    const recent = routeHistory[0];
    const groupLabel = (preference: "preferred" | "standard" | "reserve") =>
      preference === "preferred" ? "priority" : preference === "reserve" ? "reserve" : "default";
    const targetState = (target: (typeof targets)[number]): Status =>
      target.state === "wrong account"
        ? "error"
        : !target.ready || target.nearing
          ? "attention"
          : "ok";
    return (
      <Row
        key={`router-${entry.provider}`}
        tone={entry.wiredProviderId ? "ok" : "attention"}
        title={`${entry.provider}-auto → ${CARD_TITLE[entry.provider]}`}
        subtitle={
          entry.wiredProviderId
            ? "health gate → priority group → least-recently-used target"
            : entry.launcherExists
              ? "not wired yet — new agents still go to one fixed account"
              : "no launcher on disk"
        }
        meta={
          <Facts
            items={[
              { value: `${plural(count, "target", "targets")} in rotation` },
              next ? { value: `next: ${next}` } : { value: "no account available", tone: "attention" },
              { value: "decision at launch" },
            ]}
          />
        }
        trailing={<StatusPill status={entry.wiredProviderId ? "ok" : "attention"} label={entry.wiredProviderId ? "routing" : "off"} />}
        expanded={
          targets.length > 0 ? (
            <View style={{ gap: t.space.sm }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.xs }}>
                <Tag label="quota health" tone="ok" />
                <Tag label="priority groups" />
                <Tag label="LRU selector" />
                <Tag label="cooldown filtering" tone="attention" />
              </View>
              <View style={{ borderRadius: t.radius.sm, backgroundColor: t.color.surface2, overflow: "hidden" }}>
                {targets.map((target, index) => {
                  const capacity = capacityAccounts.find(
                    (account) => account.provider === entry.provider && account.email === target.email,
                  );
                  const used = capacity?.windows.length
                    ? Math.max(...capacity.windows.map((window) => window.usedPct))
                    : null;
                  return (
                    <Row
                      key={target.key}
                      first={index === 0}
                      title={target.email}
                      subtitle={target.detail || `${groupLabel(target.preference)} target`}
                      meta={
                        <Facts
                          items={[
                            { value: groupLabel(target.preference) },
                            used === null ? { value: "quota unknown" } : { value: `${Math.max(0, 100 - Math.round(used))}% headroom` },
                            { value: plural(target.launches, "launch", "launches") },
                            target.lastUsed > 0 ? { value: `last ${agoLabel(target.lastUsed)}` } : null,
                          ]}
                        />
                      }
                      trailing={
                        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm, flexWrap: "wrap" }}>
                          <StatusPill status={targetState(target)} label={target.state} />
                          {target.slot?.source === "agent-link" ? (
                            <ConfirmButton
                              label="Remove"
                              confirmLabel="Archive & remove"
                              onConfirm={() =>
                                removeMutation.mutate({ provider: target.slot!.provider, email: target.slot!.email })
                              }
                            />
                          ) : null}
                        </View>
                      }
                    />
                  );
                })}
              </View>
              {recent ? (
                <View style={{ gap: t.space.xs }}>
                  <Text style={t.text.bodyStrong}>Recent route decisions</Text>
                  {routeHistory.map((route, index) => (
                    <Text key={`${route.at}-${route.email}-${index}`} style={t.text.caption}>
                      {`${agoLabel(route.at)} · ${route.email === "primary" ? primaryEmail(entry.provider) : route.email} · ${route.group} · ${route.decision}`}
                    </Text>
                  ))}
                </View>
              ) : (
                <Text style={t.text.caption}>Decision history appears after the next routed launch.</Text>
              )}
            </View>
          ) : undefined
        }
      />
    );
  };

  // Everything else on this surface works without the CLI, but a Paseo provider
  // runs a command, so routing needs the launcher the CLI writes. Rather than
  // sending someone to a terminal, offer to put it there.
  const cli = useQuery({ queryKey: ["agent-link", "cli"], queryFn: () => callCliStatus({}) });
  const installCli = useMutation({
    mutationFn: () => callCliInstall({ withRouters: true }),
    onSuccess: (result) => {
      setNotice(result.message);
      void queryClient.invalidateQueries({ queryKey: ["agent-link"] });
    },
    onError: (error: Error) => setNotice(error.message),
  });

  const cliCard =
    cli.data && !cli.data.installed ? (
      <Card tone="attention">
        <Text style={t.text.heading}>Install the agent-link CLI</Text>
        <Text style={[t.text.body, { color: t.color.muted }]}>
          Accounts and MCP both work without it. Routing does not: a Paseo provider runs a command, and that
          command is a small launcher the CLI writes. Installing it downloads one file to {cli.data.binDir} and writes
          the launchers, after which routing can be installed from here.
        </Text>
        <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "center", flexWrap: "wrap" }}>
          <Button
            label="Install it"
            variant="primary"
            loading={installCli.isPending}
            onPress={() => installCli.mutate()}
          />
          <Text style={t.text.caption}>or run it yourself:</Text>
        </View>
        <CodeBlock>{cli.data.command}</CodeBlock>
      </Card>
    ) : null;

  // One cheap GitHub check per panel session compares the installed ancestry
  // with the latest release; the Update button runs the CLI installer.
  const update = useQuery({
    queryKey: ["agent-link", "update-check"],
    queryFn: () => callUpdateCheck({}),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
  const applyUpdate = useMutation({
    mutationFn: () => callUpdateApply({}),
    onSuccess: (result) => {
      setNotice(result.message);
      void queryClient.invalidateQueries({ queryKey: ["agent-link"] });
    },
    onError: (error: Error) => setNotice(error.message),
  });

  const updateCard =
    update.data?.updateReady ? (
      <Card tone="attention">
        <Text style={t.text.heading}>Plugin update ready</Text>
        <Text style={[t.text.body, { color: t.color.muted }]}>
          {update.data.note ||
            `agent-link on GitHub has moved on (${update.data.installedSha.slice(0, 7) || "unstamped"} → ${update.data.latestSha.slice(0, 7)}). Updating fetches the latest, typechecks it, and reinstalls this panel — Paseo itself is untouched.`}
        </Text>
        <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "center", flexWrap: "wrap" }}>
          <Button label="Update now" variant="primary" loading={applyUpdate.isPending} onPress={() => applyUpdate.mutate()} />
          <Text style={t.text.caption}>or in a terminal: agent-link update</Text>
        </View>
      </Card>
    ) : null;

  const routingCard = (
    <Card padded={false} tone={routingStatus}>
      <View>
        <View style={{ padding: pad, gap: t.space.md }}>
          <View
            style={{
              flexDirection: t.compact ? "column" : "row",
              alignItems: t.compact ? "stretch" : "flex-start",
              justifyContent: "space-between",
              gap: t.space.md,
            }}
          >
            <View style={{ flex: 1, minWidth: 0, gap: t.space.xs }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
                <Text style={t.text.heading}>Routing</Text>
                <StatusPill status={routingStatus} label={routingLabel} />
              </View>
              <Text style={[t.text.body, { color: t.color.muted }]}>
                One launch route per provider: unhealthy targets are removed, priority groups are applied, then the
                least-recently-used eligible account wins.
              </Text>
              <Facts
                items={[
                  { value: plural(totalEntries, "signed-in entry", "signed-in entries") },
                  {
                    value: plural(distinctPools, "quota pool", "quota pools"),
                    tone: totalEntries > distinctPools ? "attention" : undefined,
                  },
                ]}
              />
            </View>
            {pending.length > 0 ? (
              <View style={{ flexShrink: 0 }}>
                <Button
                  label={pending.length > 1 ? "Install for both" : `Install for ${SHORT[pending[0]!]}`}
                  variant="primary"
                  loading={routerMutation.isPending}
                  onPress={() => routerMutation.mutate(pending)}
                />
              </View>
            ) : null}
          </View>
          {totalEntries > distinctPools ? (
            <Notice tone="attention">
              An account below is signed in twice, so those entries draw on one rate limit — parking one does not free
              the other.
            </Notice>
          ) : null}
          {noLauncher.length > 0 ? (
            <View style={{ gap: t.space.xs }}>
              <Text style={t.text.caption}>
                {`No launcher for ${noLauncher.map((entry) => SHORT[entry.provider]).join(" and ")} yet. Create it in a terminal:`}
              </Text>
              <CodeBlock tone="attention">agent-link auto</CodeBlock>
            </View>
          ) : null}
          {routerMutation.error ? <ErrorText>{String(routerMutation.error)}</ErrorText> : null}
        </View>
        {routers.map(routerRow)}
      </View>
    </Card>
  );

  // ----------------------------------------------------------------- accounts

  const usageSummary = (row: AccountUsage) => {
    if (row.sessions === 0) return <Facts items={[{ value: "no sessions in 7 days" }]} />;
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
        <Spark values={row.daily} tone="busy" />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Facts
            items={[
              { value: plural(row.sessions, "session", "sessions") },
              { value: `${formatTokens(row.outputTokens)} out` },
              { value: `${cachePercent(row)}% cached` },
            ]}
          />
        </View>
      </View>
    );
  };

  const usageDetail = (provider: ProviderId, row: AccountUsage) => (
    <Section title="last 7 days">
      {row.held ? <ErrorText>{`HELD — ${row.held}`}</ErrorText> : null}
      {row.quota ? (
        <View style={{ gap: t.space.xs }}>
          {row.quota.windows.map((w) => (
            <Meter
              key={w.label}
              fraction={w.pct / 100}
              tone={w.pct >= 99 ? "error" : w.pct >= 85 ? "attention" : "neutral"}
              label={`${w.label} ${Math.round(w.pct)}%${w.resetsAt ? ` · resets ${deviceResetLabel(w.resetsAt)}` : ""}`}
            />
          ))}
          <Text style={t.text.caption}>
            {`${row.quota.model ? `${row.quota.model} · ` : ""}live usage as of ${agoLabel(row.quota.at)} — captured from the account's own sessions`}
          </Text>
        </View>
      ) : (
        <Text style={t.text.caption}>No live usage yet — it appears after this account runs one hooked session.</Text>
      )}
      {row.models.length > 0 ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.xs }}>
          {row.models.slice(0, 3).map((model) => (
            <Tag key={model} label={model.replace("claude-", "")} />
          ))}
        </View>
      ) : null}
      <Facts
        items={[
          { value: `${formatTokens(row.inputTokens)} in` },
          row.topProject ? { value: `mostly ${row.topProject}` } : null,
          row.lastActive > 0 ? { value: `last active ${agoLabel(row.lastActive)}` } : null,
        ]}
      />
      {row.limitHits > 0 ? (
        <View style={{ gap: t.space.xs }}>
          <ErrorText>
            {`${plural(row.limitHits, "limit refusal", "limit refusals")} in 7 days${
              row.limitLast > 0 ? ` · last ${agoLabel(row.limitLast)}` : ""
            } — an account can be healthy and still refuse one model`}
          </ErrorText>
          <CodeBlock tone="error">{`agent-link probe ${provider} <model> --park`}</CodeBlock>
        </View>
      ) : null}
    </Section>
  );

  const loginCommand = (slot: Slot): string => {
    if (scanQuery.data?.agentAuthInstalled) return `agent-link login ${slot.provider} ${slot.email}`;
    return slot.provider === "claude"
      ? `CLAUDE_CONFIG_DIR="${slot.dir}" claude auth login --email ${slot.email}`
      : `CODEX_HOME="${slot.dir}" codex login`;
  };

  const parkButton = (provider: ProviderId, email: string, parked: boolean) => (
    <Button
      label={parked ? "Resume" : "Park 3h"}
      loading={
        cooldownMutation.isPending &&
        cooldownMutation.variables?.provider === provider &&
        cooldownMutation.variables?.email === email
      }
      disabled={cooldownMutation.isPending}
      onPress={() => cooldownMutation.mutate({ provider, email, minutes: parked ? 0 : 180 })}
    />
  );

  const preferenceControl = (
    provider: ProviderId,
    email: string,
    preference: "preferred" | "standard" | "reserve",
  ) => (
    <View style={{ gap: t.space.xs }}>
      <Text style={t.text.caption}>Routing priority</Text>
      <Segmented
        value={preference}
        options={[
          { value: "preferred", label: "Priority", disabled: preferenceMutation.isPending },
          { value: "standard", label: "Default", disabled: preferenceMutation.isPending },
          { value: "reserve", label: "Reserve", disabled: preferenceMutation.isPending },
        ]}
        onChange={(value) => preferenceMutation.mutate({ provider, email, preference: value })}
      />
    </View>
  );

  const slotDetail = (slot: Slot) => {
    const usage = usageFor(slot.actualEmail || slot.email);
    const pinning = pinMutation.variables?.dir === slot.dir;
    return (
      <View style={{ gap: t.space.sm }}>
        {!slot.loggedIn || slot.wrongAccount ? (
          <View style={{ gap: t.space.xs }}>
            <Text style={t.text.caption}>
              {slot.wrongAccount ? "Sign this folder back into its own account:" : "Finish the sign-in in a terminal:"}
            </Text>
            <CodeBlock tone="attention">{loginCommand(slot)}</CodeBlock>
            <Text style={t.text.caption}>
              Each run prints a fresh single-use link — use that run's URL and paste the whole code, including
              everything after “#”. A 400 means the code was stale or partial: run the command again.
            </Text>
          </View>
        ) : null}
        <Facts
          items={[
            { value: slot.source === "external" ? "external folder" : "agent-link slot" },
            slot.outputStyle ? { value: `style: ${slot.outputStyle}` } : null,
            slot.settingsDrift.length > 0
              ? { value: `settings differ from primary: ${slot.settingsDrift.join(", ")}`, tone: "attention" }
              : null,
          ]}
        />
        {slot.source === "agent-link" ? preferenceControl(slot.provider, slot.email, slot.preference) : null}
        <CodeBlock>{slot.dir}</CodeBlock>
        {usage ? usageDetail(slot.provider, usage) : null}
        {slot.wiredProviderId ? (
          <View style={{ gap: t.space.xs }}>
            <Facts items={[{ value: `own provider: ${slot.wiredProviderId}` }]} />
            <View style={{ flexDirection: "row", gap: t.space.sm }}>
              <Button
                label="Diagnose provider"
                variant="ghost"
                loading={diagnosing === slot.dir}
                disabled={diagnosing !== null}
                onPress={() => runDiagnose(slot.wiredProviderId!, slot.dir)}
              />
            </View>
          </View>
        ) : slot.loggedIn ? (
          <View style={{ gap: t.space.xs }}>
            <Text style={t.text.caption}>A provider pinned to this account alone, for work that must stay on it.</Text>
            <View style={{ flexDirection: "row", gap: t.space.sm }}>
              <Button
                label="Pin as its own provider"
                loading={pinning && pinMutation.isPending}
                onPress={() => pinMutation.mutate(slot)}
              />
            </View>
          </View>
        ) : null}
        {diagnosis[slot.dir] ? <CodeBlock>{diagnosis[slot.dir]}</CodeBlock> : null}
        {pinMutation.error && pinning ? <ErrorText>{String(pinMutation.error)}</ErrorText> : null}
        {slot.source === "agent-link" ? (
          <View style={{ gap: t.space.xs }}>
            <Text style={t.text.caption}>
              Only remove this slot when none of its agents are running. Its login and chat history are archived for recovery.
            </Text>
            <ConfirmButton
              label="Remove slot"
              confirmLabel="Archive & remove"
              onConfirm={() => removeMutation.mutate({ provider: slot.provider, email: slot.email })}
            />
          </View>
        ) : null}
        {removeMutation.error ? <ErrorText>{String(removeMutation.error)}</ErrorText> : null}
      </View>
    );
  };

  const slotRow = (slot: Slot) => {
    const parked = slot.cooldownUntil > 0;
    const shared = slot.loggedIn && isShared(slot.provider, slot.actualEmail || slot.email);
    const usage = usageFor(slot.actualEmail || slot.email);
    const status: Status = !slot.loggedIn
      ? "attention"
      : slot.wrongAccount || slot.blocked
        ? "error"
        : parked
          ? "neutral"
          : slot.creditNote
            ? "attention"
            : "ok";
    const label = !slot.loggedIn
      ? "sign-in needed"
      : slot.wrongAccount
        ? "wrong account"
        : slot.blocked
          ? "spend limit"
          : parked
            ? `parked ${remainingLabel(slot.cooldownUntil)}`
            : slot.creditNote
              ? "credit limited"
              : "in rotation";
    const facts: Array<{ value: string; tone?: Status } | null> = [
      slot.lastUsed > 0 ? { value: `last agent ${agoLabel(slot.lastUsed)}` } : null,
      slot.creditNote ? { value: slot.creditNote, tone: "attention" } : null,
      usage && usage.limitHits > 0 ? { value: plural(usage.limitHits, "limit refusal", "limit refusals"), tone: "error" } : null,
    ];
    const open = Boolean(openRows[slot.dir]);
    return (
      <Row
        key={slot.dir}
        tone={status}
        title={slot.email}
        subtitle={
          slot.wrongAccount
            ? `signed in as ${slot.actualEmail}`
            : parked && slot.parkReason
              ? slot.parkReason
              : undefined
        }
        onPress={() => toggleRow(slot.dir)}
        meta={
          <View style={{ gap: t.space.xs }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
              <StatusPill status={status} label={label} />
              {nextUpKeys[slot.provider] === slot.dir ? <Tag label="next up" tone="busy" /> : null}
              {shared ? <Tag label="shared quota" tone="attention" /> : null}
            </View>
            <Facts items={facts.slice(0, 3)} />
            {slot.loggedIn ? (
              <Meter
                fraction={slot.launches / maxLaunches}
                tone={parked ? "attention" : "busy"}
                label={
                  slot.launches === 0
                    ? "no agents yet"
                    : `${plural(slot.launches, "launch", "launches")} · ${
                        slot.launches === maxLaunches ? "most in rotation" : `busiest has ${maxLaunches}`
                      }`
                }
              />
            ) : null}
            {usage ? usageSummary(usage) : null}
          </View>
        }
        trailing={
          <>
            {slot.loggedIn ? parkButton(slot.provider, slot.email, parked) : null}
            <Button label={open ? "Hide" : "Details"} variant="ghost" onPress={() => toggleRow(slot.dir)} />
          </>
        }
        expanded={open ? slotDetail(slot) : undefined}
      />
    );
  };

  const primaryRow = (provider: ProviderId) => {
    const key = `primary-${provider}`;
    const info = primaryInfo(provider);
    const account = primaryEmail(provider);
    const parked = (info?.cooldownUntil ?? 0) > 0;
    const shared = account !== "" && isShared(provider, account);
    const credit = provider === "claude" ? scanQuery.data?.primaryCreditNote ?? "" : "";
    const usage = account ? usageFor(account) : null;
    const launches = info?.launches ?? 0;
    const status: Status = !account ? "attention" : parked ? "neutral" : credit || info?.duplicated ? "attention" : "ok";
    const label = !account
      ? "sign-in needed"
      : parked
        ? `parked ${remainingLabel(info?.cooldownUntil ?? 0)}`
        : info?.duplicated
          ? "duplicated"
          : credit
            ? "credit limited"
            : "in rotation";
    const open = Boolean(openRows[key]);
    return (
      <Row
        key={key}
        tone={status}
        title={account || "not signed in"}
        subtitle={`primary — the account plain \`${provider}\` uses`}
        onPress={() => toggleRow(key)}
        meta={
          <View style={{ gap: t.space.xs }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
              <StatusPill status={status} label={label} />
              {nextUpKeys[provider] === key ? <Tag label="next up" tone="busy" /> : null}
              {shared ? <Tag label="shared quota" tone="attention" /> : null}
            </View>
            <Facts
              items={[
                credit ? { value: credit, tone: "attention" } : null,
                info?.duplicated ? { value: "an account below holds it too — routing uses that row", tone: "attention" } : null,
                usage && usage.limitHits > 0
                  ? { value: plural(usage.limitHits, "limit refusal", "limit refusals"), tone: "error" }
                  : null,
              ]}
            />
            {account ? (
              <Meter
                fraction={launches / maxLaunches}
                tone={parked ? "attention" : "busy"}
                label={
                  launches === 0
                    ? "no agents yet"
                    : `${plural(launches, "launch", "launches")} · ${
                        launches === maxLaunches ? "most in rotation" : `busiest has ${maxLaunches}`
                      }`
                }
              />
            ) : null}
            {usage ? usageSummary(usage) : null}
          </View>
        }
        trailing={
          <>
            {account ? parkButton(provider, "primary", parked) : null}
            <Button label={open ? "Hide" : "Details"} variant="ghost" onPress={() => toggleRow(key)} />
          </>
        }
        expanded={
          open ? (
            <View style={{ gap: t.space.sm }}>
              {account ? null : (
                <View style={{ gap: t.space.xs }}>
                  <Text style={t.text.caption}>Sign in to the default account in a terminal:</Text>
                  <CodeBlock tone="attention">{provider === "claude" ? "claude auth login" : "codex login"}</CodeBlock>
                </View>
              )}
              <Facts items={[{ value: "managed by the CLI itself, not by a slot folder" }]} />
              {info ? preferenceControl(provider, "primary", info.preference) : null}
              {usage ? usageDetail(provider, usage) : null}
            </View>
          ) : undefined
        }
      />
    );
  };

  const addRow = (provider: ProviderId) => {
    const open = addingFor === provider;
    return (
      <Row
        key={`add-${provider}`}
        title={<Text style={[t.text.body, { color: t.color.muted }]}>Add another {SHORT[provider]} account</Text>}
        trailing={
          open ? undefined : (
            <Button
              label="+ Add account"
              onPress={() => {
                setAddingFor(provider);
                setNewEmail("");
              }}
            />
          )
        }
        expanded={
          open ? (
            <View style={{ gap: t.space.sm }}>
              <Field
                label="Account email"
                value={newEmail}
                onChangeText={setNewEmail}
                placeholder={`new ${provider} account email`}
                autoFocus
                hint="Creates the slot and hands you the one command that finishes the browser sign-in — that step needs a terminal, because the CLI asks you to paste a code back."
              />
              <View style={{ flexDirection: "row", gap: t.space.sm }}>
                {/* The router install is the view's primary action; when it is
                    already done, finishing this account is what's left. */}
                <Button
                  label="Create & sign in"
                  variant={pending.length > 0 ? "secondary" : "primary"}
                  loading={addMutation.isPending}
                  disabled={newEmail.trim() === ""}
                  onPress={() => addMutation.mutate({ provider, email: newEmail.trim() })}
                />
                <Button label="Cancel" variant="ghost" onPress={() => setAddingFor(null)} />
              </View>
              {addMutation.error ? <ErrorText>{String(addMutation.error)}</ErrorText> : null}
            </View>
          ) : undefined
        }
      />
    );
  };

  const heartbeatStatus = (entry: ProviderHeartbeat | undefined): { status: Status; label: string } => {
    if (heartbeatQuery.isLoading) return { status: "busy", label: "connecting" };
    if (heartbeatQuery.error || !entry) return { status: "error", label: "unavailable" };
    return { status: entry.available ? "ok" : "error", label: entry.available ? "registered" : "unavailable" };
  };

  const providerCard = (provider: ProviderId, heartbeat: ProviderHeartbeat | undefined) => {
    const state = heartbeatStatus(heartbeat);
    return (
      <Card key={provider} padded={false}>
        <View>
          <View style={{ padding: pad, gap: t.space.sm }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm }}>
              <View style={{ flex: 1, minWidth: 0, gap: t.space.xs }}>
                <Text numberOfLines={1} style={t.text.heading}>
                  {CARD_TITLE[provider]}
                </Text>
                <StatusPill status={state.status} label={state.label} />
              </View>
              <Button
                label="Deep check"
                variant="ghost"
                loading={diagnosing === provider}
                disabled={diagnosing !== null}
                onPress={() => runDiagnose(provider, provider)}
              />
            </View>
            <Text style={t.text.caption}>
              {heartbeat?.summary ?? "Waiting for the Paseo provider registry."} Heartbeat is registry-only; Deep check starts the provider.
            </Text>
            {diagnosis[provider] ? <CodeBlock>{diagnosis[provider]}</CodeBlock> : null}
          </View>
          {primaryRow(provider)}
          {slots.filter((slot) => slot.provider === provider).map(slotRow)}
          {addRow(provider)}
        </View>
      </Card>
    );
  };

  const singleProviderCard = (entry: ProviderHeartbeat) => {
    const state = heartbeatStatus(entry);
    return (
      <Card key={entry.id} padded={false}>
        <View>
          <View style={{ padding: pad, gap: t.space.md }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm }}>
              <View style={{ flex: 1, minWidth: 0, gap: t.space.xs }}>
                <Text numberOfLines={1} style={t.text.heading}>{entry.label}</Text>
                <StatusPill status={state.status} label={state.label} />
              </View>
              <Button
                label="Deep check"
                variant="ghost"
                loading={diagnosing === entry.id}
                disabled={diagnosing !== null}
                onPress={() => runDiagnose(entry.id, entry.id)}
              />
            </View>
            <Text style={t.text.caption}>{entry.summary} Heartbeat never starts a model turn.</Text>
            <Facts
              items={[
                { value: "single provider login" },
                { value: "no Agent Link account cycling", tone: "attention" },
                { value: entry.quotaTelemetry ? "quota telemetry available" : "quota telemetry not exposed", tone: "attention" },
              ]}
            />
            {entry.aliases.length > 0 ? <Text style={t.text.caption}>{`Loaded aliases: ${entry.aliases.join(", ")}`}</Text> : null}
            {diagnosis[entry.id] ? <CodeBlock>{diagnosis[entry.id]}</CodeBlock> : null}
          </View>
        </View>
      </Card>
    );
  };

  const providerOptions = heartbeatProviders.length > 0
    ? heartbeatProviders.map((provider) => ({ value: provider.id, label: provider.label }))
    : [
        { value: "claude", label: "Claude" },
        { value: "codex", label: "Codex" },
      ];
  const selectedHeartbeat = heartbeatById.get(providerTab);
  const selectedProvider = providerTab === "claude" || providerTab === "codex"
    ? providerCard(providerTab, selectedHeartbeat)
    : selectedHeartbeat
      ? singleProviderCard(selectedHeartbeat)
      : null;

  const providersSection = (
    <Section
      title="providers"
      trailing={
        <StatusPill
          status={heartbeatQuery.error ? "error" : heartbeatQuery.isFetching ? "busy" : "ok"}
          label={heartbeatQuery.data ? `heartbeat ${agoLabel(heartbeatQuery.data.checkedAt)}` : heartbeatQuery.error ? "heartbeat failed" : "connecting"}
        />
      }
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingBottom: t.space.xs }}>
        <Segmented options={providerOptions} value={providerTab} onChange={setProviderTab} />
      </ScrollView>
      {heartbeatQuery.error ? <ErrorText>{`Provider heartbeat failed: ${String(heartbeatQuery.error)}`}</ErrorText> : null}
      {selectedProvider}
    </Section>
  );

  return (
    <Screen t={t}>
      <Toolbar
        title="Agent Link"
        subtitle="Live provider and account registry every 30 seconds; model and auth checks stay manual."
        actions={
          <Button label="Refresh" variant="ghost" loading={scanQuery.isFetching || heartbeatQuery.isFetching} onPress={refresh} />
        }
      />

      {scanQuery.data?.needsRestart ? (
        <Notice tone="attention">
          Provider wiring changed — restart the Paseo daemon, when no agent is mid-task, to load it.
        </Notice>
      ) : null}
      {notice ? <Notice onDismiss={() => setNotice(null)}>{notice}</Notice> : null}
      {scanQuery.error ? <ErrorText>{String(scanQuery.error)}</ErrorText> : null}

      {scanQuery.data ? (
        <>
          {updateCard}
          {cliCard}
          {capacityCard}
          {routingCard}
          {providersSection}
        </>
      ) : scanQuery.isLoading ? (
        <Loading label="Reading accounts…" />
      ) : null}

      {limitsQuery.data ? (
        <Section
          title="limit sentry"
          trailing={
            <StatusPill
              status={limitsQuery.data.watching ? "ok" : "neutral"}
              label={limitsQuery.data.watching ? "watching" : "arming\u2026"}
            />
          }
        >
          <Card>
            <Row
              first
              title="Auto-resume agents that die on a limit"
              subtitle="A dead agent gets one nudge to continue; the relaunch routes to a healthy account. Kimi, Grok and other single-account providers are listed for manual resume instead."
              trailing={
                <Segmented
                  options={[
                    { value: "on", label: "Auto" },
                    { value: "off", label: "Manual" },
                  ]}
                  value={limitsQuery.data.auto ? "on" : "off"}
                  onChange={(value) => limitsAutoMutation.mutate(value === "on")}
                />
              }
            />
            {limitsQuery.data.events.map((event: LimitEvent) => (
              <Row
                key={event.agentId}
                title={event.title ?? event.agentId}
                subtitle={event.detail}
                meta={
                  <>
                    <Tag label={event.provider} />
                    <Tag label={agoLabel(Math.floor(new Date(event.at).getTime() / 1000)) } />
                  </>
                }
                trailing={
                  event.action === "auto-resumed" ? (
                    <StatusPill status="ok" label="resumed" />
                  ) : event.action === "resume-failed" ? (
                    <StatusPill status="error" label="resume failed" />
                  ) : (
                    <Button
                      label="Resume"
                      loading={limitsResumeMutation.isPending}
                      onPress={() => limitsResumeMutation.mutate(event.agentId)}
                    />
                  )
                }
              />
            ))}
            {limitsQuery.data.events.length === 0 ? (
              <Text style={t.text.caption}>No agent has died on a limit since the daemon started.</Text>
            ) : null}
          </Card>
        </Section>
      ) : null}

      {resourceQuery.data ? (
        <Section
          title="memory guard"
          trailing={
            <StatusPill
              status={resourceQuery.data.paused.length > 0 ? "attention" : resourceQuery.data.enabled ? "ok" : "neutral"}
              label={
                resourceQuery.data.paused.length > 0
                  ? `${resourceQuery.data.paused.length} paused`
                  : resourceQuery.data.enabled
                    ? "guarding"
                    : "off"
              }
            />
          }
        >
          <Card>
            <Row
              first
              title="Keep heavy Paseo type-checks in one lane"
              subtitle="Runs one TypeScript check at a time. At critical memory pressure it pauses the check, without killing it, then continues when macOS recovers. Terminal jobs are never touched."
              meta={
                <Facts
                  items={[
                    resourceQuery.data.freePercent === null
                      ? { value: "memory signal unavailable" }
                      : { value: `${resourceQuery.data.freePercent}% memory available` },
                    { value: `${resourceQuery.data.activeTypechecks} running` },
                  ]}
                />
              }
              trailing={
                <Segmented
                  options={[
                    { value: "on", label: "On" },
                    { value: "off", label: "Off" },
                  ]}
                  value={resourceQuery.data.enabled ? "on" : "off"}
                  onChange={(value) => resourceMutation.mutate(value === "on")}
                />
              }
            />
            {resourceQuery.data.paused.map((entry) => (
              <Row
                key={entry.pid}
                title={entry.label}
                subtitle={`PID ${entry.pid} · ${entry.rssMb >= 1024 ? `${(entry.rssMb / 1024).toFixed(1)} GB` : `${entry.rssMb} MB`} when paused`}
                trailing={<StatusPill status="attention" label="cooling down" />}
              />
            ))}
          </Card>
        </Section>
      ) : null}

      <Section title="agentrouter (optional)">
        <Card>
          <Row
            first
            title="One agent that picks the right model per task"
            subtitle="Runs a cheap base model that triages your task: small things it answers itself, bigger ones it delegates to the best provider/model through Paseo's own tools — and every reply ends with the provider/model it chose. Rules: ~/.agent-auth/router/rules.md. Account choice underneath stays automatic."
          />
          <Field
            label="Task"
            value={routerTask}
            onChangeText={setRouterTask}
            placeholder="What should it do?"
          />
          <Button
            label="Start AgentRouter"
            loading={routerLaunchMutation.isPending}
            disabled={routerTask.trim().length === 0}
            onPress={() => routerLaunchMutation.mutate(routerTask.trim())}
          />
          <Text style={t.text.caption}>
            Optional — nothing changes if you never press it. Delegation needs Paseo tools injected into agents
            (Settings → Agents → Enable Paseo tools).
          </Text>
        </Card>
      </Section>

      <Disclosure title="How this works">
        <Text style={t.text.body}>
          1. Install the router above, then pick it as the provider when you start an agent — each new agent lands on a
          live account, and resuming a chat always returns to the account that owns it.
        </Text>
        <Text style={t.text.body}>
          2. Add accounts with + Add account, and finish each browser sign-in with the command that row gives you.
        </Text>
        <CodeBlock>{"agent-link status\nagent-link auto\nagent-link login all\nagent-link cooldown"}</CodeBlock>
        {scanQuery.data && !scanQuery.data.agentAuthInstalled ? (
          <Text style={t.text.caption}>
            The agent-link CLI (github.com/itsjustanks/agent-link) turns those sign-ins into one command and adds
            hot-switching. This panel works without it.
          </Text>
        ) : null}
      </Disclosure>
    </Screen>
  );
}
