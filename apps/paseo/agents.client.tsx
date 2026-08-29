import type { PluginAgentPanelProps, PluginSurfaceProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { cliInstall, cliStatus, cliUpdateApply, cliUpdateCheck } from "./cli.shared";
import { limitsResume, limitsSetAuto, limitsStatus, type LimitEvent } from "./limits.shared";
import { resourceSetEnabled, resourceStatus } from "./resources.shared";
import {
  toolchainConfigure,
  toolchainRemove,
  toolchainRun,
  toolchainSetEnabled,
  toolchainStatus,
  type ToolchainProvider,
} from "./toolchain.shared";
import {
  accountUsage,
  accountCapacity,
  probeAccounts,
  addAccount,
  removeAccount,
  diagnoseProvider,
  providerHeartbeat,
  scan,
  setCooldown,
  setPreference,
  routerInstall,
  routerConfigure,
  routerModels,
  routerStatus,
  routerTrace,
  wireAuto,
  wireProvider,
  type AccountUsage,
  type CapacityAccount,
  type ProviderHeartbeat,
  type RouterProviderStatus,
  type AutoRouter,
  type Slot,
} from "./contracts.shared";
import {
  Button,
  Card,
  CodeBlock,
  ComboBox,
  ConfirmButton,
  ErrorText,
  Facts,
  Field,
  Loading,
  Meter,
  Notice,
  Row,
  Screen,
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
 * Operational areas are top-level tabs. Provider tabs exist only inside
 * Accounts, where routing is one list row and every account owns its quota,
 * activity, priority, cooldown, and repair actions.
 */

type ProviderId = "claude" | "codex";
type PanelTab = "accounts" | "limits" | "memory" | "router";
type RouterDraftTarget = { provider: string; model: string };
type RouterDraftGroup = { name: string; purpose: string; targets: RouterDraftTarget[] };

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

function CapacitySummary({ entry }: { entry: CapacityAccount }) {
  const t = useTokens();
  const tone = capacityTone(entry);
  const windows = entry.windows.slice(0, 2);
  return (
    <View style={{ gap: t.space.xs }}>
      <Facts
        items={[
          { value: capacityStateLabel(entry), tone },
          entry.plan ? { value: `${entry.plan} plan` } : null,
          entry.at > 0 ? { value: `usage updated ${agoLabel(entry.at)}` } : { value: "quota telemetry pending", tone: "attention" },
        ]}
      />
      {windows.map((window, index) => {
        const used = Math.max(0, Math.min(100, Math.round(window.usedPct)));
        const toneForWindow: Status = used >= 99 ? "error" : used >= 85 ? "attention" : "ok";
        return (
          <Meter
            key={`${window.label}-${window.durationMinutes ?? index}`}
            fraction={used / 100}
            tone={toneForWindow}
            label={`${window.label}: ${100 - used}% available${window.resetsAt ? ` · resets ${countdownLabel(window.resetsAt)}` : ""}`}
          />
        );
      })}
    </View>
  );
}

function CapacityDetail({ entry }: { entry: CapacityAccount }) {
  const t = useTokens();
  const tone = capacityTone(entry);
  const credit = creditLabel(entry);
  const freshest = entry.at > 0 ? `updated ${agoLabel(entry.at)}` : "not reported yet";
  return (
    <View style={{ gap: t.space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm }}>
        <Text style={t.text.bodyStrong}>Usage & capacity</Text>
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
          entry.model ? { value: entry.model } : null,
          credit ? { value: credit, tone: entry.credits?.hasCredits ? "ok" : "neutral" } : null,
        ]}
      />
    </View>
  );
}

type ToolchainDraft = {
  id: string;
  label: string;
  binary: string;
  versionArgs: string[];
  updateArgs: string[];
  processPattern: string;
};

function ToolchainRow({
  entry,
  first,
  busy,
  onSave,
  onRemove,
}: {
  entry: ToolchainProvider;
  first: boolean;
  busy: boolean;
  onSave: (draft: ToolchainDraft) => void;
  onRemove: (id: string) => void;
}) {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const [binary, setBinary] = useState(entry.binary || entry.id);
  const [versionArgs, setVersionArgs] = useState(entry.versionArgs.join("\n") || "--version");
  const [updateArgs, setUpdateArgs] = useState(entry.updateArgs.join("\n"));
  const [processPattern, setProcessPattern] = useState(entry.processPattern);
  useEffect(() => {
    setBinary(entry.binary || entry.id);
    setVersionArgs(entry.versionArgs.join("\n") || "--version");
    setUpdateArgs(entry.updateArgs.join("\n"));
    setProcessPattern(entry.processPattern);
  }, [entry]);
  const tone: Status = entry.managed ? (entry.installed ? "ok" : "attention") : "neutral";
  return (
    <Row
      first={first}
      title={entry.label}
      subtitle={entry.binary}
      tone={tone}
      meta={
        <Facts
          items={[
            { value: entry.version || (entry.installed ? "version unavailable" : "CLI not installed") },
            { value: entry.availableInPaseo ? "available in Paseo" : "not currently available" },
            { value: entry.managed ? (entry.builtIn ? "verified updater" : "custom updater") : "manual updates", tone: entry.managed ? "ok" : "attention" },
            entry.lastResult ? { value: `last: ${entry.lastResult}`, tone: entry.lastResult === "failed" ? "error" : undefined } : null,
          ]}
        />
      }
      trailing={<Button label={open ? "Hide" : entry.managed ? "Details" : "Configure"} variant="ghost" onPress={() => setOpen((value) => !value)} />}
      expanded={
        open ? (
          <View style={{ gap: t.space.sm }}>
            <CodeBlock copy={false}>{entry.binary}</CodeBlock>
            {entry.builtIn ? (
              <>
                <Facts items={[{ value: entry.binary }, { value: `update: ${entry.updateArgs.join(" ")}` }]} />
                <Text style={t.text.caption}>Built-in update recipes are release-tested. Live processes are skipped and retried on the next run.</Text>
              </>
            ) : (
              <>
                <Field label="Executable" value={binary} onChangeText={setBinary} placeholder={entry.id} mono />
                <View style={{ flexDirection: t.compact ? "column" : "row", gap: t.space.sm }}>
                  <View style={{ flex: 1 }}>
                    <Field label="Version arguments · one per line" value={versionArgs} onChangeText={setVersionArgs} multiline mono minHeight={72} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field label="Update arguments · one per line" value={updateArgs} onChangeText={setUpdateArgs} multiline mono minHeight={72} />
                  </View>
                </View>
                <Field label="Process match" value={processPattern} onChangeText={setProcessPattern} mono hint="The updater skips this provider whenever this process pattern or a live Paseo agent matches." />
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
                  <Button
                    label="Save updater"
                    variant="secondary"
                    loading={busy}
                    disabled={!binary.trim() || !updateArgs.trim() || !processPattern.trim()}
                    onPress={() => onSave({
                      id: entry.id,
                      label: entry.label,
                      binary: binary.trim(),
                      versionArgs: versionArgs.split("\n").map((value) => value.trim()).filter(Boolean),
                      updateArgs: updateArgs.split("\n").map((value) => value.trim()).filter(Boolean),
                      processPattern: processPattern.trim(),
                    })}
                  />
                  {entry.managed ? <ConfirmButton label="Use manual updates" confirmLabel="Remove updater" onConfirm={() => onRemove(entry.id)} /> : null}
                </View>
              </>
            )}
            {entry.detail ? <Text style={t.text.caption}>{entry.detail}</Text> : null}
          </View>
        ) : undefined
      }
    />
  );
}

function RouterTargetEditor({
  target,
  providerOptions,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  target: RouterDraftTarget;
  providerOptions: RouterProviderStatus["providerOptions"];
  index: number;
  count: number;
  onChange: (target: RouterDraftTarget) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useTokens();
  const callModels = useRpc(routerModels);
  const models = useQuery({
    queryKey: ["agent-link", "router-models", target.provider],
    queryFn: () => callModels({ provider: target.provider }),
    enabled: /^[a-z][a-z0-9-]*$/.test(target.provider),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const provider = providerOptions.find((option) => option.id === target.provider);
  return (
    <View style={{ padding: t.space.sm, borderRadius: t.radius.sm, backgroundColor: t.color.surface2, gap: t.space.sm }}>
      <View style={{ flexDirection: t.compact ? "column" : "row", gap: t.space.sm }}>
        <View style={{ flex: 1 }}>
          <ComboBox
            label={`${index + 1}. Provider`}
            value={target.provider}
            onChange={(value) => onChange({ provider: value, model: value === target.provider ? target.model : "" })}
            options={providerOptions.map((option) => ({
              value: option.id,
              label: option.label,
              description: option.available ? "available now" : "currently unavailable",
            }))}
            placeholder="Choose a Paseo provider"
            hint={provider ? (provider.available ? "Available in Paseo now." : "Configured but unavailable; fallback will skip it.") : "Custom provider IDs are allowed."}
          />
        </View>
        <View style={{ flex: 1 }}>
          <ComboBox
            label="Model"
            value={target.model}
            onChange={(value) => onChange({ ...target, model: value })}
            options={(models.data?.models ?? []).map((model) => ({ value: model.id, label: model.label, description: model.description }))}
            placeholder={models.isFetching ? "Loading models…" : "Choose a model"}
            hint={models.data?.message ?? "Paseo will load this provider's model catalog."}
          />
        </View>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
        <Button label="Move up" variant="ghost" disabled={index === 0} onPress={() => onMove(-1)} />
        <Button label="Move down" variant="ghost" disabled={index === count - 1} onPress={() => onMove(1)} />
        <ConfirmButton label="Remove target" confirmLabel="Remove" onConfirm={onRemove} />
      </View>
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
  const callRouterStatus = useRpc(routerStatus);
  const callRouterInstall = useRpc(routerInstall);
  const callRouterConfigure = useRpc(routerConfigure);
  const callCooldown = useRpc(setCooldown);
  const callAddAccount = useRpc(addAccount);
  const callRemoveAccount = useRpc(removeAccount);
  const callSetPreference = useRpc(setPreference);
  const callUsage = useRpc(accountUsage);
  const callCapacity = useRpc(accountCapacity);
  const callProbe = useRpc(probeAccounts);
  const callLimitsStatus = useRpc(limitsStatus);
  const callLimitsSetAuto = useRpc(limitsSetAuto);
  const callLimitsResume = useRpc(limitsResume);
  const callResourceStatus = useRpc(resourceStatus);
  const callResourceSetEnabled = useRpc(resourceSetEnabled);
  const callToolchainStatus = useRpc(toolchainStatus);
  const callToolchainConfigure = useRpc(toolchainConfigure);
  const callToolchainRemove = useRpc(toolchainRemove);
  const callToolchainRun = useRpc(toolchainRun);
  const callToolchainSetEnabled = useRpc(toolchainSetEnabled);

  const [diagnosis, setDiagnosis] = useState<Record<string, string>>({});
  const [diagnosing, setDiagnosing] = useState<string | null>(null);
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [addingFor, setAddingFor] = useState<ProviderId | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [panelTab, setPanelTab] = useState<PanelTab>("router");
  const [providerTab, setProviderTab] = useState("claude");
  const [probeLogs, setProbeLogs] = useState<Record<string, string>>({});
  const [routerController, setRouterController] = useState<"claude-auto" | "claude">("claude-auto");
  const [routerModel, setRouterModel] = useState("claude-fable-5");
  const [routerGroups, setRouterGroups] = useState<RouterDraftGroup[]>([]);
  const [routerRules, setRouterRules] = useState("");
  const [routerDirty, setRouterDirty] = useState(false);

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
  const routerProviderQuery = useQuery({
    queryKey: ["agent-link", "router-provider"],
    queryFn: () => callRouterStatus({}),
    refetchInterval: 30000,
  });
  const toolchainQuery = useQuery({
    queryKey: ["agent-link", "toolchain"],
    queryFn: () => callToolchainStatus({}),
    refetchInterval: 60_000,
  });
  const resourceMutation = useMutation({
    mutationFn: (enabled: boolean) => callResourceSetEnabled({ enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agent-link", "resources"] }),
  });
  const routerProviderMutation = useMutation({
    mutationFn: () => callRouterInstall({}),
    onSuccess: (result) => {
      setNotice(result.message);
      void queryClient.invalidateQueries({ queryKey: ["agent-link"] });
    },
  });
  const routerConfigureMutation = useMutation({
    mutationFn: (input: {
      controllerProvider: "claude-auto" | "claude";
      controllerModel: string;
      targetGroups: RouterProviderStatus["targetGroups"];
      userRules: string;
    }) => callRouterConfigure(input),
    onSuccess: (result) => {
      setNotice(result.message);
      setRouterDirty(false);
      void queryClient.invalidateQueries({ queryKey: ["agent-link"] });
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const toolchainConfigureMutation = useMutation({
    mutationFn: (input: ToolchainDraft) => callToolchainConfigure(input),
    onSuccess: (result) => {
      setNotice(result.message);
      queryClient.setQueryData(["agent-link", "toolchain"], result.status);
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const toolchainRemoveMutation = useMutation({
    mutationFn: (id: string) => callToolchainRemove({ id }),
    onSuccess: (result) => {
      setNotice(result.message);
      queryClient.setQueryData(["agent-link", "toolchain"], result.status);
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const toolchainRunMutation = useMutation({
    mutationFn: () => callToolchainRun({}),
    onSuccess: (result) => {
      setNotice(result.message);
      globalThis.setTimeout(() => void queryClient.invalidateQueries({ queryKey: ["agent-link", "toolchain"] }), 3000);
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const toolchainEnabledMutation = useMutation({
    mutationFn: (enabled: boolean) => callToolchainSetEnabled({ enabled }),
    onSuccess: (result) => {
      setNotice(result.message);
      queryClient.setQueryData(["agent-link", "toolchain"], result.status);
    },
    onError: (error: Error) => setNotice(error.message),
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

  const probeMutation = useMutation({
    mutationFn: (provider: ProviderId) => callProbe({ provider, model: "", parkFailures: true }),
    onSuccess: (result, provider) => {
      setNotice(result.message);
      setProbeLogs((previous) => ({ ...previous, [provider]: result.log }));
      void queryClient.invalidateQueries({ queryKey: ["agent-link", "scan"] });
      void queryClient.invalidateQueries({ queryKey: ["agent-link", "account-capacity"] });
    },
    onError: (error: Error) => setNotice(error.message),
  });

  const slots = scanQuery.data?.slots ?? [];
  const routingSlots = slots.filter((slot) => slot.source === "agent-link");
  const primaryAccounts = scanQuery.data?.primaryAccounts;
  const routers = scanQuery.data?.autoRouters ?? [];
  const heartbeatProviders = heartbeatQuery.data?.providers ?? [];
  const heartbeatById = new Map(heartbeatProviders.map((provider) => [provider.id, provider]));
  const primaryInfo = (provider: ProviderId) => (scanQuery.data?.primaries ?? []).find((entry) => entry.provider === provider);
  const primaryEmail = (provider: ProviderId) => (provider === "claude" ? primaryAccounts?.claude : primaryAccounts?.codex) ?? "";

  const lastRouteForAccount = (provider: ProviderId, email: string) =>
    (scanQuery.data?.recentRoutes ?? []).find((route) => {
      if (route.provider !== provider) return false;
      if (route.email === "primary") return primaryEmail(provider) === email;
      const target = routingSlots.find((slot) => slot.provider === provider && slot.email === route.email);
      return Boolean(target && (target.actualEmail || target.email) === email);
    });
  const routeLocation = (cwd: string) => cwd.split("/").filter(Boolean).pop() || cwd;

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

  useEffect(() => {
    if (heartbeatProviders.length > 0 && !heartbeatProviders.some((provider) => provider.id === providerTab)) {
      setProviderTab(heartbeatProviders[0]!.id);
    }
  }, [heartbeatProviders, providerTab]);
  useEffect(() => {
    const state = routerProviderQuery.data;
    if (!state || routerDirty) return;
    setRouterController(state.controllerProvider);
    setRouterModel(state.controllerModel);
    setRouterRules(state.userRules);
    setRouterGroups(
      state.targetGroups.map((group) => ({
        name: group.name,
        purpose: group.purpose,
        targets: group.targets.map((target) => ({ provider: target.provider, model: target.model })),
      })),
    );
  }, [routerProviderQuery.data, routerDirty]);

  const updateRouterGroup = (index: number, patch: Partial<RouterDraftGroup>) => {
    setRouterDirty(true);
    setRouterGroups((groups) => groups.map((group, groupIndex) => (groupIndex === index ? { ...group, ...patch } : group)));
  };
  const updateRouterTarget = (groupIndex: number, targetIndex: number, target: RouterDraftTarget) => {
    setRouterDirty(true);
    setRouterGroups((groups) => groups.map((group, currentGroup) => currentGroup === groupIndex ? {
      ...group,
      targets: group.targets.map((entry, currentTarget) => currentTarget === targetIndex ? target : entry),
    } : group));
  };
  const moveRouterTarget = (groupIndex: number, targetIndex: number, direction: -1 | 1) => {
    setRouterDirty(true);
    setRouterGroups((groups) => groups.map((group, currentGroup) => {
      if (currentGroup !== groupIndex) return group;
      const nextIndex = targetIndex + direction;
      if (nextIndex < 0 || nextIndex >= group.targets.length) return group;
      const targets = [...group.targets];
      [targets[targetIndex], targets[nextIndex]] = [targets[nextIndex]!, targets[targetIndex]!];
      return { ...group, targets };
    }));
  };
  const saveRouter = () => {
    const names = new Set<string>();
    const targetGroups: RouterProviderStatus["targetGroups"] = [];
    for (const group of routerGroups) {
      const name = group.name.trim().toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(name) || names.has(name)) {
        setNotice("Route group names must be unique lowercase slugs, such as planning or browser-check.");
        return;
      }
      names.add(name);
      const targets = group.targets.map((target) => ({ provider: target.provider.trim(), model: target.model.trim() }));
      if (!group.purpose.trim() || targets.some((target) => !/^[a-z][a-z0-9-]*$/.test(target.provider) || !target.model) || targets.length === 0) {
        setNotice(`Fix ${name || "the unnamed route"}: choose a provider and model for every target.`);
        return;
      }
      targetGroups.push({ name, purpose: group.purpose.trim(), selector: "in_order", targets });
    }
    if (targetGroups.length === 0) {
      setNotice("Add at least one orchestration group.");
      return;
    }
    if (!routerModel.trim()) {
      setNotice("Choose a controller model.");
      return;
    }
    routerConfigureMutation.mutate({
      controllerProvider: routerController,
      controllerModel: routerModel,
      targetGroups,
      userRules: routerRules,
    });
  };
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

  const usageFor = (provider: ProviderId, email: string): AccountUsage | null =>
    (usageQuery.data?.accounts ?? []).find((entry) => entry.provider === provider && entry.email === email) ?? null;

  const pad = t.compact ? t.space.md : t.space.lg;
  const toggleRow = (key: string) => {
    const opening = !openRows[key];
    setOpenRows((previous) => ({ ...previous, [key]: !previous[key] }));
    if (opening && !key.startsWith("router-") && !usageQuery.data && !usageQuery.isFetching) void usageQuery.refetch();
  };
  const runDiagnose = (providerId: string, key: string) => {
    setDiagnosing(key);
    void callDiagnose({ providerId })
      .then((result) => setDiagnosis((previous) => ({ ...previous, [key]: previous[key] ? "" : result.summary })))
      .finally(() => setDiagnosing(null));
  };

  // ------------------------------------------------------------------ routing

  const capacityAccounts = capacityQuery.data?.accounts ?? [];
  const capacityFor = (provider: ProviderId, poolKey: string, email: string): CapacityAccount | null =>
    capacityAccounts.find(
      (entry) => entry.provider === provider && (entry.poolKey === poolKey || (entry.email === email && entry.isPrimary === (poolKey === "primary"))),
    ) ?? null;

  const routerPending = (provider: ProviderId) =>
    routers.some((entry) => entry.provider === provider && !entry.wiredProviderId && entry.launcherExists);

  const inRotation = (provider: ProviderId) => {
    const info = primaryInfo(provider);
    const own = primaryEmail(provider) && info && !info.duplicated && !info.blocked && info.cooldownUntil === 0 ? 1 : 0;
    return own + routingSlots.filter((slot) => slot.provider === provider && slot.loggedIn && !slot.wrongAccount && !slot.blocked && slot.cooldownUntil === 0).length;
  };

  const routerRow = (entry: AutoRouter, first = false) => {
    const key = `router-${entry.provider}`;
    const open = Boolean(openRows[key]);
    const next = (scanQuery.data?.nextUp ?? []).find((item) => item.provider === entry.provider)?.email ?? "";
    const count = inRotation(entry.provider);
    const routeHistory = (scanQuery.data?.recentRoutes ?? []).filter((route) => route.provider === entry.provider).slice(0, 5);
    const pending = !entry.wiredProviderId && entry.launcherExists;
    return (
      <Row
        key={key}
        first={first}
        tone={entry.wiredProviderId ? "ok" : "attention"}
        title="Automatic routing"
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
              next ? { value: `next new launch: ${next}` } : { value: "no account available", tone: "attention" },
              { value: "forecast, not a pinned agent" },
            ]}
          />
        }
        trailing={
          <>
            {pending ? (
              <Button
                label="Install routing"
                variant="primary"
                loading={routerMutation.isPending}
                onPress={() => routerMutation.mutate([entry.provider])}
              />
            ) : (
              <StatusPill status={entry.wiredProviderId ? "ok" : "attention"} label={entry.wiredProviderId ? "routing" : "off"} />
            )}
            <Button label={open ? "Hide" : "Details"} variant="ghost" onPress={() => toggleRow(key)} />
          </>
        }
        expanded={
          open ? (
            <View style={{ gap: t.space.sm }}>
              <Text style={t.text.caption}>
                This forecast is not tied to a project. Every new provider process re-checks holds, cooldowns and cached quota before choosing; the history below only records where earlier launches happened.
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.xs }}>
                <Tag label="quota health" tone="ok" />
                <Tag label="priority groups" />
                <Tag label="LRU selector" />
                <Tag label="cooldown filtering" tone="attention" />
              </View>
              {!entry.launcherExists ? (
                <View style={{ gap: t.space.xs }}>
                  <Text style={t.text.caption}>Create the launcher in a terminal:</Text>
                  <CodeBlock tone="attention">agent-link auto</CodeBlock>
                </View>
              ) : null}
              {routeHistory.length > 0 ? (
                <View style={{ gap: t.space.xs }}>
                  <Text style={t.text.bodyStrong}>Recent launches</Text>
                  {routeHistory.map((route, index) => (
                    <Text key={`${route.at}-${route.email}-${index}`} style={t.text.caption}>
                      {`${agoLabel(route.at)} · ${route.email === "primary" ? primaryEmail(entry.provider) : route.email}${route.model ? ` · ${route.model}` : ""} · ${route.agentId ? `Paseo ${route.agentId}` : "non-Paseo launch"}${route.cwd ? ` · ${routeLocation(route.cwd)}` : ""}`}
                    </Text>
                  ))}
                </View>
              ) : (
                <Text style={t.text.caption}>Decision history appears after the next routed launch.</Text>
              )}
              {routerMutation.error ? <ErrorText>{String(routerMutation.error)}</ErrorText> : null}
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
    ) : cli.data?.installed ? (
      <Card padded={false}>
        <Row
          first
          title="AgentLink CLI"
          subtitle={cli.data.path}
          meta={<Facts items={[{ value: `v${cli.data.version}` }, { value: cli.data.routersReady ? "routing launchers ready" : "routing launchers missing", tone: cli.data.routersReady ? "ok" : "attention" }]} />}
          trailing={<StatusPill status="ok" label="installed" />}
        />
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
            `Agent Link ${update.data.installedVersion ? `v${update.data.installedVersion}` : "legacy install"} → v${update.data.latestVersion}. Updating fetches that published release, typechecks it, and reinstalls this panel — Paseo itself is untouched.`}
        </Text>
        <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "center", flexWrap: "wrap" }}>
          <Button label="Update now" variant="primary" loading={applyUpdate.isPending} onPress={() => applyUpdate.mutate()} />
          <Text style={t.text.caption}>or in a terminal: agent-link update</Text>
        </View>
      </Card>
    ) : null;

  const toolchainCard = toolchainQuery.data ? (
    <Card padded={false}>
      <View style={{ padding: pad, gap: t.space.md }}>
        <View style={{ flexDirection: t.compact ? "column" : "row", alignItems: t.compact ? "stretch" : "center", justifyContent: "space-between", gap: t.space.sm }}>
          <View style={{ flex: 1, minWidth: 0, gap: t.space.xs }}>
            <Text style={t.text.heading}>Provider CLI updates</Text>
            <Text style={t.text.caption}>Every Paseo provider appears below. Verified recipes update automatically; any other CLI can be given a safe argument-by-argument updater.</Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: t.space.sm }}>
            <Segmented
              options={[{ value: "on", label: "Daily" }, { value: "off", label: "Manual" }]}
              value={toolchainQuery.data.enabled ? "on" : "off"}
              onChange={(value) => toolchainEnabledMutation.mutate(value === "on")}
            />
            <Button label="Check now" variant="secondary" loading={toolchainRunMutation.isPending} onPress={() => toolchainRunMutation.mutate()} />
          </View>
        </View>
        <Facts
          items={[
            { value: toolchainQuery.data.schedule, tone: toolchainQuery.data.enabled ? "ok" : "neutral" },
            { value: "live providers are always skipped", tone: "ok" },
          ]}
        />
      </View>
      {toolchainQuery.data.providers.map((provider, index) => (
        <ToolchainRow
          key={provider.id}
          entry={provider}
          first={index === 0}
          busy={toolchainConfigureMutation.isPending || toolchainRemoveMutation.isPending}
          onSave={(draft) => toolchainConfigureMutation.mutate(draft)}
          onRemove={(id) => toolchainRemoveMutation.mutate(id)}
        />
      ))}
    </Card>
  ) : toolchainQuery.isLoading ? (
    <Loading label="Reading provider updaters…" />
  ) : toolchainQuery.error ? (
    <ErrorText>{`Provider updater status failed: ${String(toolchainQuery.error)}`}</ErrorText>
  ) : null;

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

  const activityDetail = (provider: ProviderId, row: AccountUsage) => (
    <View style={{ gap: t.space.sm }}>
      <Text style={t.text.bodyStrong}>Activity · last 7 days</Text>
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
          <Text style={t.text.caption}>Use Probe accounts above to test service, cool refusals, and release accounts that pass.</Text>
        </View>
      ) : null}
    </View>
  );

  const loginCommand = (slot: Slot): string => {
    if (scanQuery.data?.agentAuthInstalled) return `agent-link login ${slot.provider} ${slot.email}`;
    return slot.provider === "claude"
      ? `CLAUDE_CONFIG_DIR="${slot.dir}" claude auth login --email ${slot.email}`
      : `CODEX_HOME="${slot.dir}" codex login`;
  };

  const parkButton = (provider: ProviderId, email: string, parked: boolean, held = false) =>
    held && provider === "claude" ? (
      <ConfirmButton
        label="Probe to release"
        confirmLabel="Spend one small turn per account"
        onConfirm={() => probeMutation.mutate(provider)}
      />
    ) : (
      <Button
      label={parked ? "Release" : "Park 3h"}
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
    const usage = usageFor(slot.provider, slot.actualEmail || slot.email);
    const capacity = capacityFor(slot.provider, slot.email, slot.actualEmail || slot.email);
    const pinning = pinMutation.variables?.dir === slot.dir;
    const lastRoute = lastRouteForAccount(slot.provider, slot.actualEmail || slot.email);
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
        {capacity ? <CapacityDetail entry={capacity} /> : null}
        {capacityQuery.error ? <ErrorText>{`Capacity failed to load: ${String(capacityQuery.error)}`}</ErrorText> : null}
        <Facts
          items={[
            { value: slot.source === "external" ? "external folder" : "agent-link slot" },
            slot.outputStyle ? { value: `style: ${slot.outputStyle}` } : null,
            slot.settingsDrift.length > 0
              ? { value: `settings differ from primary: ${slot.settingsDrift.join(", ")}`, tone: "attention" }
              : null,
            lastRoute?.cwd ? { value: `last used in ${routeLocation(lastRoute.cwd)}` } : null,
          ]}
        />
        {lastRoute?.agentId ? <CodeBlock>{`Paseo agent ${lastRoute.agentId}${lastRoute.cwd ? `\n${lastRoute.cwd}` : ""}`}</CodeBlock> : null}
        {slot.source === "agent-link" ? preferenceControl(slot.provider, slot.email, slot.preference) : null}
        <CodeBlock>{slot.dir}</CodeBlock>
        {usage ? activityDetail(slot.provider, usage) : null}
        {!usage && usageQuery.isFetching ? <Text style={t.text.caption}>Reading 7-day activity…</Text> : null}
        {usageQuery.error ? <ErrorText>{`Activity failed to load: ${String(usageQuery.error)}`}</ErrorText> : null}
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
    const parked = slot.cooldownUntil > 0 || slot.blocked;
    const shared = slot.loggedIn && isShared(slot.provider, slot.actualEmail || slot.email);
    const usage = usageFor(slot.provider, slot.actualEmail || slot.email);
    const capacity = capacityFor(slot.provider, slot.email, slot.actualEmail || slot.email);
    const lastRoute = lastRouteForAccount(slot.provider, slot.actualEmail || slot.email);
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
          ? "held until probe passes"
          : parked
            ? `parked ${remainingLabel(slot.cooldownUntil)}`
            : slot.creditNote
              ? "credit limited"
              : "in rotation";
    const facts: Array<{ value: string; tone?: Status } | null> = [
      slot.lastUsed > 0 ? { value: `last agent ${agoLabel(slot.lastUsed)}` } : null,
      lastRoute?.agentId ? { value: `Paseo ${lastRoute.agentId}` } : null,
      lastRoute?.cwd ? { value: routeLocation(lastRoute.cwd) } : null,
      slot.creditNote ? { value: slot.creditNote, tone: "attention" } : null,
      usage && usage.limitHits > 0 ? { value: plural(usage.limitHits, "limit refusal", "limit refusals"), tone: "error" } : null,
      slot.modelHolds.length > 0 ? { value: `unavailable: ${slot.modelHolds.join(", ")}`, tone: "attention" } : null,
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
              {nextUpKeys[slot.provider] === slot.dir ? <Tag label="next new launch" tone="busy" /> : null}
              {shared ? <Tag label="shared quota" tone="attention" /> : null}
              {slot.modelHolds.map((model) => <Tag key={model} label={`${model} limited`} tone="attention" />)}
            </View>
            <Facts items={facts.slice(0, 5)} />
            {capacity ? <CapacitySummary entry={capacity} /> : null}
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
            {slot.loggedIn ? parkButton(slot.provider, slot.email, parked, slot.blocked) : null}
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
    const parked = (info?.cooldownUntil ?? 0) > 0 || Boolean(info?.blocked);
    const shared = account !== "" && isShared(provider, account);
    const credit = provider === "claude" ? scanQuery.data?.primaryCreditNote ?? "" : "";
    const usage = account ? usageFor(provider, account) : null;
    const capacity = account ? capacityFor(provider, "primary", account) : null;
    const launches = info?.launches ?? 0;
    const lastRoute = lastRouteForAccount(provider, account);
    const status: Status = !account ? "attention" : parked ? "neutral" : credit || info?.duplicated ? "attention" : "ok";
    const label = !account
      ? "sign-in needed"
      : info?.blocked
        ? "held until probe passes"
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
              {nextUpKeys[provider] === key ? <Tag label="next new launch" tone="busy" /> : null}
              {shared ? <Tag label="shared quota" tone="attention" /> : null}
              {info?.modelHolds.map((model) => <Tag key={model} label={`${model} limited`} tone="attention" />)}
            </View>
            <Facts
              items={[
                credit ? { value: credit, tone: "attention" } : null,
                info?.duplicated ? { value: "an account below holds it too — routing uses that row", tone: "attention" } : null,
                lastRoute?.agentId ? { value: `Paseo ${lastRoute.agentId}` } : null,
                lastRoute?.cwd ? { value: `last used in ${routeLocation(lastRoute.cwd)}` } : null,
                usage && usage.limitHits > 0
                  ? { value: plural(usage.limitHits, "limit refusal", "limit refusals"), tone: "error" }
                  : null,
              ]}
            />
            {capacity ? <CapacitySummary entry={capacity} /> : null}
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
            {account ? parkButton(provider, "primary", parked, Boolean(info?.blocked)) : null}
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
              {capacity ? <CapacityDetail entry={capacity} /> : null}
              {capacityQuery.error ? <ErrorText>{`Capacity failed to load: ${String(capacityQuery.error)}`}</ErrorText> : null}
              {info ? preferenceControl(provider, "primary", info.preference) : null}
              {lastRoute?.agentId ? <CodeBlock>{`Paseo agent ${lastRoute.agentId}${lastRoute.cwd ? `\n${lastRoute.cwd}` : ""}`}</CodeBlock> : null}
              {usage ? activityDetail(provider, usage) : null}
              {!usage && usageQuery.isFetching ? <Text style={t.text.caption}>Reading 7-day activity…</Text> : null}
              {usageQuery.error ? <ErrorText>{`Activity failed to load: ${String(usageQuery.error)}`}</ErrorText> : null}
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
                {/* The provider's router install is the primary action; once it
                    is wired, finishing this account is what's left. */}
                <Button
                  label="Create & sign in"
                  variant={routerPending(provider) ? "secondary" : "primary"}
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
    const router = routers.find((entry) => entry.provider === provider);
    const providerCapacity = capacityAccounts.filter((entry) => entry.provider === provider);
    const ready = providerCapacity.filter((entry) => entry.state === "ready").length;
    const constrained = providerCapacity.filter(
      (entry) => entry.state === "nearing" || entry.state === "parked" || entry.state === "held",
    ).length;
    const providerPools = [...accountUses.entries()].filter(([key]) => key.startsWith(`${provider}:`));
    const totalEntries = providerPools.reduce((sum, [, count]) => sum + count, 0);
    return (
      <Card key={provider} padded={false} tone={constrained > 0 ? "attention" : undefined}>
        <View>
          <View style={{ padding: pad, gap: t.space.sm }}>
            <View
              style={{
                flexDirection: t.compact ? "column" : "row",
                alignItems: t.compact ? "stretch" : "flex-start",
                justifyContent: "space-between",
                gap: t.space.sm,
              }}
            >
              <View style={{ flex: 1, minWidth: 0, gap: t.space.xs }}>
                <Text numberOfLines={1} style={t.text.heading}>{`${CARD_TITLE[provider]} accounts`}</Text>
                <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: t.space.sm }}>
                  <StatusPill status={state.status} label={state.label} />
                  <Facts
                    items={[
                      { value: plural(totalEntries, "signed-in entry", "signed-in entries") },
                      { value: plural(providerPools.length, "quota pool", "quota pools"), tone: totalEntries > providerPools.length ? "attention" : undefined },
                      { value: plural(ready, "account available", "accounts available"), tone: ready > 0 ? "ok" : "attention" },
                      constrained > 0 ? { value: plural(constrained, "account constrained", "accounts constrained"), tone: "attention" } : null,
                    ]}
                  />
                </View>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: t.space.sm }}>
                <Button
                  label={usageQuery.data ? "Refresh activity" : "Load 7-day activity"}
                  variant="ghost"
                  loading={usageQuery.isFetching}
                  onPress={() => void usageQuery.refetch()}
                />
                <Button
                  label="Deep check"
                  variant="ghost"
                  loading={diagnosing === provider}
                  disabled={diagnosing !== null}
                  onPress={() => runDiagnose(provider, provider)}
                />
                {provider === "claude" ? (
                  probeMutation.isPending ? (
                    <StatusPill status="busy" label="probing accounts" />
                  ) : (
                    <ConfirmButton
                      label="Probe accounts"
                      confirmLabel="Spend one small turn per account"
                      onConfirm={() => probeMutation.mutate(provider)}
                    />
                  )
                ) : null}
              </View>
            </View>
            <Text style={t.text.caption}>
              {heartbeat?.summary ?? "Waiting for the Paseo provider registry."} Quota stays with each account below; opening Details loads its 7-day activity.
            </Text>
            {totalEntries > providerPools.length ? (
              <Notice tone="attention">One login appears twice, so those rows share the same quota.</Notice>
            ) : null}
            {capacityQuery.error ? <ErrorText>{`Capacity failed to load: ${String(capacityQuery.error)}`}</ErrorText> : null}
            {usageQuery.error ? <ErrorText>{`Activity failed to load: ${String(usageQuery.error)}`}</ErrorText> : null}
            {diagnosis[provider] ? <CodeBlock>{diagnosis[provider]}</CodeBlock> : null}
            {probeLogs[provider] ? <CodeBlock>{probeLogs[provider]}</CodeBlock> : null}
          </View>
          {router ? (
            routerRow(router, true)
          ) : (
            <Row
              first
              tone="attention"
              title="Automatic routing"
              subtitle="Waiting for routing state."
              trailing={<StatusPill status="busy" label="loading" />}
            />
          )}
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
    <View style={{ gap: t.space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingBottom: t.space.xs }}>
          <Segmented options={providerOptions} value={providerTab} onChange={setProviderTab} />
        </ScrollView>
        <StatusPill
          status={heartbeatQuery.error ? "error" : heartbeatQuery.isFetching ? "busy" : "ok"}
          label={heartbeatQuery.data ? `heartbeat ${agoLabel(heartbeatQuery.data.checkedAt)}` : heartbeatQuery.error ? "heartbeat failed" : "connecting"}
        />
      </View>
      {heartbeatQuery.error ? <ErrorText>{`Provider heartbeat failed: ${String(heartbeatQuery.error)}`}</ErrorText> : null}
      {selectedProvider}
    </View>
  );

  const panelOptions: Array<{ value: PanelTab; label: string }> = [
    { value: "router", label: "AgentRouter" },
    { value: "accounts", label: "Accounts" },
    { value: "limits", label: "Limit sentry" },
    { value: "memory", label: "Memory guard" },
  ];

  const selectedController = routerProviderQuery.data?.controllerOptions.find((option) => option.provider === routerController);
  const controllerModels = selectedController?.models ?? [];
  const panelSubtitle: Record<PanelTab, string> = {
    router: "Interpret once, delegate to a concrete Paseo provider/model, and keep the route auditable.",
    accounts: "Provider availability, account quota, routing pools, CLI locations, and safe software updates.",
    limits: "Detect real quota refusals, cool the affected account, and resume through a healthy route.",
    memory: "Pause only Paseo-owned compiler work under pressure, then continue it without killing the agent.",
  };

  return (
    <Screen t={t}>
      <Toolbar
        title="Agent Link"
        subtitle={panelSubtitle[panelTab]}
        actions={
          <Button label="Refresh" variant="ghost" loading={scanQuery.isFetching || heartbeatQuery.isFetching} onPress={refresh} />
        }
      />

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingBottom: t.space.xs }}>
        <Segmented options={panelOptions} value={panelTab} onChange={setPanelTab} />
      </ScrollView>

      {scanQuery.data?.needsRestart ? (
        <Notice tone="attention">
          Provider wiring changed — restart the Paseo daemon, when no agent is mid-task, to load it.
        </Notice>
      ) : null}
      {notice ? <Notice onDismiss={() => setNotice(null)}>{notice}</Notice> : null}
      {scanQuery.error ? <ErrorText>{String(scanQuery.error)}</ErrorText> : null}

      {panelTab === "accounts" && scanQuery.data ? (
        <>
          {updateCard}
          {cliCard}
          {toolchainCard}
          {providersSection}
        </>
      ) : panelTab === "accounts" && scanQuery.isLoading ? (
        <Loading label="Reading accounts…" />
      ) : null}

      {panelTab === "limits" && limitsQuery.data ? (
        <Card padded={false}>
          <View style={{ padding: pad, gap: t.space.xs }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm }}>
              <Text style={t.text.heading}>Limit sentry</Text>
              <StatusPill
                status={
                  limitsQuery.data.scanner.error
                    ? "attention"
                    : limitsQuery.data.scanner.active || limitsQuery.data.watching
                      ? "ok"
                      : "neutral"
                }
                label={
                  limitsQuery.data.scanner.error
                    ? "watchdog issue"
                    : limitsQuery.data.scanner.active
                    ? "host watchdog"
                    : limitsQuery.data.watching
                      ? "panel watcher"
                      : "arming\u2026"
                }
              />
            </View>
            <Text style={t.text.caption}>
              {limitsQuery.data.scanner.error
                ? `Every-provider scan failed: ${limitsQuery.data.scanner.error}`
                : limitsQuery.data.scanner.active
                ? `Every-provider scan active · last checked ${agoLabel(Math.floor(new Date(limitsQuery.data.scanner.lastScanAt ?? 0).getTime() / 1000))}`
                : "Open-panel detection is active; install the host watchdog for unattended every-provider scans."}
            </Text>
          </View>
            <Row
              first
              title="Recover only when continuity is provable"
              subtitle="Routed Claude, Codex and AgentRouter chats keep their transcript and get one retry on a healthy account. Direct, Kimi, Grok and other single-account providers are detected and held for an explicit retry or handoff—never hammered."
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
                    {event.account ? <Tag label={event.account} tone="attention" /> : null}
                    {event.model ? <Tag label={event.model} /> : null}
                    <Tag label={agoLabel(Math.floor(new Date(event.at).getTime() / 1000)) } />
                  </>
                }
                trailing={
                  event.action === "auto-resumed" ? (
                    <StatusPill status="ok" label="retry sent" />
                  ) : event.action === "recovery-queued" ? (
                    <StatusPill status="busy" label="recovery queued" />
                  ) : event.action === "resume-failed" ? (
                    <StatusPill status="error" label="resume failed" />
                  ) : (
                    <Button
                      label="Retry now"
                      loading={limitsResumeMutation.isPending}
                      onPress={() => limitsResumeMutation.mutate(event.agentId)}
                    />
                  )
                }
              />
            ))}
            {limitsQuery.data.events.length === 0 ? (
              <View style={{ padding: pad }}>
                <Text style={t.text.caption}>No agent has died on a limit since the daemon started.</Text>
              </View>
            ) : null}
        </Card>
      ) : panelTab === "limits" ? (
        <Loading label="Reading limit sentry…" />
      ) : null}

      {panelTab === "memory" && resourceQuery.data ? (
        <Card padded={false}>
          <View style={{ padding: pad, gap: t.space.xs }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm }}>
              <Text style={t.text.heading}>Memory guard</Text>
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
            </View>
            <Text style={t.text.caption}>Live Paseo-owned TypeScript checks only; this is not a list of every check ever started.</Text>
          </View>
            <Row
              first
              title="Keep heavy Paseo type-checks in one lane"
              subtitle="Treats each shell/package-runner/compiler chain as one job. One compiler runs at a time; under memory pressure it pauses, keeps its agent alive, then continues when macOS recovers. Terminal jobs are never touched."
              meta={
                <Facts
                  items={[
                    resourceQuery.data.freePercent === null
                      ? { value: "memory signal unavailable" }
                      : { value: `${resourceQuery.data.freePercent}% memory available` },
                    { value: `${resourceQuery.data.activeTypechecks} compiler job${resourceQuery.data.activeTypechecks === 1 ? "" : "s"} running` },
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
            {resourceQuery.data.events.length > 0 ? (
              <View style={{ padding: pad, gap: t.space.xs }}>
                <Text style={t.text.bodyStrong}>Recent guard actions</Text>
                {resourceQuery.data.events.slice(0, 5).map((event, index) => (
                  <Text key={`${event.at}-${event.pid}-${index}`} style={t.text.caption}>
                    {`${agoLabel(Math.floor(new Date(event.at).getTime() / 1000))} · ${event.action} PID ${event.pid} · ${event.reason}`}
                  </Text>
                ))}
              </View>
            ) : null}
        </Card>
      ) : panelTab === "memory" ? (
        <Loading label="Reading memory guard…" />
      ) : null}

      {panelTab === "router" && routerProviderQuery.data ? (
        <Card padded={false}>
          <View style={{ padding: pad, gap: t.space.md }}>
            <View style={{ flexDirection: t.compact ? "column" : "row", alignItems: t.compact ? "stretch" : "center", justifyContent: "space-between", gap: t.space.sm }}>
              <View style={{ flex: 1, minWidth: 0, gap: t.space.xs }}>
                <Text style={t.text.heading}>AgentRouter</Text>
                <Text style={t.text.caption}>
                  One Paseo provider that interprets the prompt, chooses an ordered route, then launches the concrete provider/model that performs the work.
                </Text>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
                <StatusPill
                  status={routerProviderQuery.data.loaded ? "ok" : routerProviderQuery.data.configured ? "attention" : "neutral"}
                  label={routerProviderQuery.data.loaded ? "ready" : routerProviderQuery.data.configured ? "reload required" : "not installed"}
                />
                <Button
                  label={routerProviderQuery.data.installed ? "Save routes" : "Save & install"}
                  variant="primary"
                  loading={routerConfigureMutation.isPending}
                  onPress={saveRouter}
                />
              </View>
            </View>
            <Facts
              items={[
                { value: "interpret" },
                { value: "health filter" },
                { value: "ordered fallback" },
                { value: "auditable Paseo child", tone: "ok" },
              ]}
            />
          </View>
          <Row
            first
            title="Controller"
            subtitle="The controller only interprets and delegates; it never performs the requested task. Fable is the planning-safe default."
            expanded={
              <View style={{ gap: t.space.md }}>
                <ComboBox
                  label="Controller account source"
                  options={routerProviderQuery.data.controllerOptions.map((option) => ({
                    value: option.provider,
                    label: option.label,
                    description: option.available ? "available now" : "currently unavailable",
                    disabled: !option.available,
                  }))}
                  value={routerController}
                  allowCustom={false}
                  onChange={(value) => {
                    if (value !== "claude-auto" && value !== "claude") return;
                    setRouterController(value);
                    setRouterDirty(true);
                  }}
                  hint="The account pool spreads new controller launches across healthy Claude accounts; primary pins one account."
                />
                <ComboBox
                  label="Controller model"
                  value={routerModel}
                  onChange={(value) => {
                    setRouterModel(value);
                    setRouterDirty(true);
                  }}
                  options={controllerModels.map((model) => ({ value: model.id, label: model.label }))}
                  hint="This model interprets the request. The selected target below performs the work."
                />
                <Notice tone="attention">
                  The boot controller is Claude-compatible because one Paseo adapter must start first. Once running, its targets can be any native, custom, or ACP provider.
                </Notice>
              </View>
            }
          />
          {routerGroups.map((group, index) => {
            const groupKey = `router-group-${index}`;
            const open = Boolean(openRows[groupKey]);
            return (
              <Row
              key={`${group.name}-${index}`}
              title={`${index + 1}. ${group.name || "Unnamed route"}`}
              subtitle="Targets run top to bottom; unavailable or genuinely failed targets fall through."
              meta={<Facts items={[{ value: plural(group.targets.length, "target", "targets") }, group.targets[0] ? { value: `first: ${group.targets[0].provider}/${group.targets[0].model}` } : null]} />}
              trailing={
                <>
                  <Button label={open ? "Done" : "Edit"} variant="ghost" onPress={() => toggleRow(groupKey)} />
                  {routerGroups.length > 1 ? (
                    <ConfirmButton
                      label="Remove"
                      confirmLabel="Remove route"
                      onConfirm={() => {
                        setRouterGroups((groups) => groups.filter((_, groupIndex) => groupIndex !== index));
                        setRouterDirty(true);
                      }}
                    />
                  ) : null}
                </>
              }
              expanded={
                open ? <View style={{ gap: t.space.sm }}>
                  <View style={{ flexDirection: t.compact ? "column" : "row", gap: t.space.sm }}>
                    <View style={{ flex: 1 }}>
                      <Field label="Route name" value={group.name} onChangeText={(value) => updateRouterGroup(index, { name: value })} placeholder="planning" />
                    </View>
                    <View style={{ flex: 2 }}>
                      <Field label="When to use it" value={group.purpose} onChangeText={(value) => updateRouterGroup(index, { purpose: value })} placeholder="Product and implementation plans" />
                    </View>
                  </View>
                  <View style={{ gap: t.space.sm }}>
                    {group.targets.map((target, targetIndex) => (
                      <RouterTargetEditor
                        key={`${index}-${targetIndex}`}
                        target={target}
                        providerOptions={routerProviderQuery.data.providerOptions}
                        index={targetIndex}
                        count={group.targets.length}
                        onChange={(next) => updateRouterTarget(index, targetIndex, next)}
                        onMove={(direction) => moveRouterTarget(index, targetIndex, direction)}
                        onRemove={() => {
                          if (group.targets.length === 1) {
                            setNotice("Each route group needs at least one target.");
                            return;
                          }
                          updateRouterGroup(index, { targets: group.targets.filter((_, current) => current !== targetIndex) });
                        }}
                      />
                    ))}
                    <Button
                      label="Add fallback target"
                      variant="secondary"
                      onPress={() => updateRouterGroup(index, { targets: [...group.targets, { provider: "", model: "" }] })}
                    />
                  </View>
                </View> : undefined
              }
            />
            );
          })}
          <View style={{ padding: pad, gap: t.space.md }}>
            <Button
              label="Add route group"
              variant="secondary"
              onPress={() => {
                setRouterGroups((groups) => [...groups, { name: `route-${groups.length + 1}`, purpose: "Describe when this route should be used", targets: [{ provider: "", model: "" }] }]);
                setRouterDirty(true);
              }}
            />
            <Field
              label="Global routing rules"
              value={routerRules}
              onChangeText={(value) => {
                setRouterRules(value);
                setRouterDirty(true);
              }}
              multiline
              mono
              minHeight={120}
              hint="Applied after the managed groups. Named provider/model requests still win."
            />
            <Facts
              items={[
                { value: routerProviderQuery.data.message, tone: routerProviderQuery.data.loaded ? "ok" : "attention" },
                routerDirty ? { value: "unsaved changes", tone: "attention" } : { value: "saved" },
              ]}
            />
            <CodeBlock>{`launcher: ${routerProviderQuery.data.launcherPath}\nrules: ${routerProviderQuery.data.rulesPath}`}</CodeBlock>
            {!routerProviderQuery.data.loaded && routerProviderQuery.data.configured ? (
              <Button
                label="Repair provider files"
                variant="ghost"
                loading={routerProviderMutation.isPending}
                onPress={() => routerProviderMutation.mutate()}
              />
            ) : null}
          </View>
        </Card>
      ) : panelTab === "router" ? (
        <Loading label="Reading AgentRouter provider…" />
      ) : null}

      {panelTab === "router" ? (
        <Card>
          <Text style={t.text.heading}>How to use it</Text>
          <Text style={t.text.bodyStrong}>1. Choose the interpreter</Text>
          <Text style={t.text.body}>Use the Claude account pool for resilient controller launches. Fable is the default because interpreting and planning routes need judgment, not the cheapest model.</Text>
          <Text style={t.text.bodyStrong}>2. Define ordered routes</Text>
          <Text style={t.text.body}>Each group describes a kind of work. Add providers and models in preferred order; unavailable or genuinely failed targets fall through to the next entry.</Text>
          <Text style={t.text.bodyStrong}>3. Start AgentRouter in Paseo</Text>
          <Text style={t.text.body}>Choose AgentRouter → Automatic route. It states the selected provider/model, creates an auditable Paseo child, then relays that child's result.</Text>
          <Text style={t.text.heading}>What stays fixed?</Text>
          <Text style={t.text.body}>Running processes never switch accounts or models. Routing happens at launch; a failed resumable session is ended, then relaunched through a healthy account.</Text>
          <Text style={t.text.heading}>Why can a launch still hit a limit?</Text>
          <Text style={t.text.body}>Some providers do not expose fresh quota without a paid call. AgentLink uses the latest telemetry, records real refusals, cools that account, and tries the next configured target.</Text>
          <Text style={t.text.heading}>Probe versus update</Text>
          <Text style={t.text.body}>Probe spends one tiny model turn to prove account quota. Provider update only checks or replaces an idle CLI binary. Plugin update compares published Agent Link release numbers. They are independent.</Text>
          <Text style={t.text.heading}>Direct provider or AgentRouter?</Text>
          <Text style={t.text.body}>Choose a direct Paseo provider when you already know the model. Use AgentRouter when you want one entry point to interpret, delegate, fall back, and leave route evidence.</Text>
          {scanQuery.data && !scanQuery.data.agentAuthInstalled ? (
            <Text style={t.text.caption}>Install the AgentLink CLI to add dynamic routing and terminal account controls.</Text>
          ) : null}
        </Card>
      ) : null}
    </Screen>
  );
}

function routeNodeStatus(status: string): Status {
  const normalized = status.toLowerCase();
  if (normalized.includes("error") || normalized.includes("fail")) return "error";
  if (normalized.includes("run") || normalized.includes("work") || normalized.includes("start")) return "busy";
  if (normalized.includes("complete") || normalized.includes("finish") || normalized.includes("close")) return "ok";
  if (normalized.includes("cancel") || normalized.includes("archive")) return "neutral";
  return "attention";
}

export function AgentRoutingPanel({ theme, layout, agentId }: PluginAgentPanelProps) {
  const t = useUi(theme, layout.compact);
  const callRouterTrace = useRpc(routerTrace);
  const trace = useQuery({
    queryKey: ["agent-link", "router-trace", agentId],
    queryFn: () => callRouterTrace({ agentId }),
    refetchInterval: 15_000,
  });

  if (trace.isLoading) return <Screen t={t}><Loading label="Reading routing evidence…" /></Screen>;
  if (trace.error) return <Screen t={t}><ErrorText>{trace.error instanceof Error ? trace.error.message : String(trace.error)}</ErrorText></Screen>;
  if (!trace.data) return null;

  return (
    <Screen t={t}>
      <Toolbar
        title="Routing evidence"
        subtitle="Control and answer models are shown separately. Provider-internal work is never presented as an auditable route."
      />
      <Notice tone={trace.data.isAgentRouter && !trace.data.nodes.some((node) => node.source === "paseo") ? "attention" : "neutral"}>
        {trace.data.summary}
      </Notice>
      <Card padded={false}>
        {trace.data.nodes.map((node, index) => (
          <Row
            key={`${node.source}-${node.id}`}
            first={index === 0}
            title={node.title}
            subtitle={node.note}
            meta={
              <Facts
                items={[
                  { value: node.source === "control" ? "control plane" : node.source === "paseo" ? "answer model" : "model hidden" },
                  { value: `${node.provider} / ${node.model}` },
                  { value: `account: ${node.account}` },
                  { value: `agent: ${node.id}` },
                ]}
              />
            }
            trailing={<StatusPill status={routeNodeStatus(node.status)} label={node.status} />}
          />
        ))}
      </Card>
    </Screen>
  );
}
