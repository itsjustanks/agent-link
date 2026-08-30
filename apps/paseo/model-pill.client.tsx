import {
  type PluginClientContext,
  type PluginComposerPillProps,
  useAgent,
  useRpc,
} from "@getpaseo/plugin";
import { Icon, Modal, useToast } from "@getpaseo/plugin/react-native";
import type { PaseoAgent, PaseoAgentListResult, PaseoAgentUpdate } from "@getpaseo/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  accountCapacity,
  agentContinue,
  providerHeartbeat,
  routerModels,
  routerTrace,
  setPreference,
  type CapacityAccount,
} from "./contracts.shared";
import { limitsResume, limitsStatus } from "./limits.shared";
import { friendlyModelName, resolveRuntimeModel, UNKNOWN_MODEL } from "./model.shared";
import { Button, ComboBox, ConfirmButton, Meter, StatusPill, TokensProvider, useUi, type Status } from "./ui.client";

const modalListeners = new Map<string, Set<() => void>>();

function requestAccountModal(agentId: string) {
  for (const open of modalListeners.get(agentId) ?? []) open();
}

function activeAnswerModel(nodes: Array<{ source: string; provider: string; model: string; status: string; account: string }>) {
  const answers = nodes.filter((node) => node.source === "paseo");
  return answers.find((node) => /running|working|start/i.test(node.status)) ?? answers.at(-1) ?? null;
}

export function AgentModelPill({ theme, layout, agentId }: PluginComposerPillProps) {
  const agent = useAgent(agentId, ({ provider, model, status }) => ({ provider, model, status }));
  const [open, setOpen] = useState(false);
  const identity = resolveRuntimeModel(agent?.provider, agent?.model);
  const isRouter = identity.provider === "agent-router";
  const agentActive = agent?.status === "running" || agent?.status === "initializing";
  const readTrace = useRpc(routerTrace);
  const trace = useQuery({
    queryKey: ["agent-link", "model-pill", agentId],
    queryFn: () => readTrace({ agentId }),
    enabled: isRouter || open,
    refetchInterval: open ? 15_000 : isRouter && agentActive ? 5_000 : false,
  });
  const answer = activeAnswerModel(trace.data?.nodes ?? []);
  const answerIdentity = answer ? resolveRuntimeModel(answer.provider, answer.model) : null;
  const label = isRouter
    ? answerIdentity && answerIdentity.model !== UNKNOWN_MODEL
      ? `AgentRouter → ${friendlyModelName(answerIdentity.model)}`
      : "AgentRouter · routing…"
    : friendlyModelName(identity.model);

  useEffect(() => {
    const listeners = modalListeners.get(agentId) ?? new Set<() => void>();
    const show = () => setOpen(true);
    listeners.add(show);
    modalListeners.set(agentId, listeners);
    return () => {
      listeners.delete(show);
      if (listeners.size === 0) modalListeners.delete(agentId);
    };
  }, [agentId]);

  return (
    <>
      <Icon name={isRouter ? "Route" : "Cpu"} size={14} color={theme.colors.foregroundMuted} />
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, flexShrink: 1 }}>
        {label}
      </Text>
      <AccountModal
        open={open}
        onOpenChange={setOpen}
        agentId={agentId}
        agentStatus={agent?.status ?? "idle"}
        provider={identity.provider}
        model={isRouter && answerIdentity ? answerIdentity.model : identity.model}
        isRouter={isRouter}
        canMoveAccount={trace.data?.canMoveAccount ?? false}
        currentAccount={answer?.account ?? trace.data?.nodes.find((node) => node.account)?.account ?? ""}
        theme={theme}
        compact={layout.compact}
        platform={layout.platform}
      />
    </>
  );
}

function accountStatus(entry: CapacityAccount): { label: string; tone: Status } {
  if (entry.state === "ready") return { label: "available", tone: "ok" };
  if (entry.state === "nearing") return { label: "nearing limit", tone: "attention" };
  if (entry.state === "parked") return { label: "cooling down", tone: "attention" };
  if (entry.state === "held") return { label: "blocked", tone: "error" };
  return { label: "limits unknown", tone: "neutral" };
}

function resetLabel(epoch: number | null): string {
  if (!epoch) return "reset not reported";
  const minutes = Math.max(0, Math.round((epoch * 1000 - Date.now()) / 60_000));
  const remaining = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `resets in ${remaining} · ${new Date(epoch * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}`;
}

function AccountModal({
  open,
  onOpenChange,
  agentId,
  agentStatus,
  provider,
  model,
  isRouter,
  canMoveAccount,
  currentAccount,
  theme,
  compact,
  platform,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  agentId: string;
  agentStatus: string;
  provider: string;
  model: string;
  isRouter: boolean;
  canMoveAccount: boolean;
  currentAccount: string;
  theme: PluginComposerPillProps["theme"];
  compact: boolean;
  platform: PluginComposerPillProps["layout"]["platform"];
}) {
  const t = useUi(theme, compact, platform);
  const toast = useToast();
  const queryClient = useQueryClient();
  const callCapacity = useRpc(accountCapacity);
  const callPreference = useRpc(setPreference);
  const callLimits = useRpc(limitsStatus);
  const callResume = useRpc(limitsResume);
  const callProviders = useRpc(providerHeartbeat);
  const callModels = useRpc(routerModels);
  const callContinue = useRpc(agentContinue);
  const [targetProvider, setTargetProvider] = useState("");
  const [targetModel, setTargetModel] = useState("");
  const [targetAccount, setTargetAccount] = useState("provider");
  const family = provider.replace(/-auto$/, "");
  const pooled = family === "claude" || family === "codex";
  const capacity = useQuery({
    queryKey: ["agent-link", "composer-capacity"],
    queryFn: () => callCapacity({}),
    enabled: open && !isRouter,
    refetchInterval: open && !isRouter ? 30_000 : false,
  });
  const limits = useQuery({
    queryKey: ["agent-link", "limits"],
    queryFn: () => callLimits({}),
    enabled: open,
  });
  const providers = useQuery({
    queryKey: ["agent-link", "composer-providers"],
    queryFn: () => callProviders({}),
    enabled: open && !isRouter,
    refetchInterval: open && !isRouter ? 30_000 : false,
  });
  const providerOptions = useMemo(
    () => (providers.data?.providers ?? []).filter((entry) => entry.available && (entry.id !== family || !canMoveAccount)).map((entry) => {
      const dynamic = entry.kind === "pooled" && Boolean(entry.autoProviderId);
      return {
        value: entry.id,
        label: dynamic ? `${entry.label} · account choice` : entry.label,
        description: entry.summary,
      };
    }),
    [canMoveAccount, family, providers.data?.providers],
  );
  useEffect(() => {
    if (!open || providerOptions.length === 0) return;
    if (providerOptions.some((entry) => entry.value === targetProvider)) return;
    setTargetProvider(providerOptions.find((entry) => entry.value !== provider)?.value ?? providerOptions[0]!.value);
  }, [open, provider, providerOptions, targetProvider]);
  const models = useQuery({
    queryKey: ["agent-link", "composer-models", targetProvider],
    queryFn: () => callModels({ provider: targetProvider }),
    enabled: open && !isRouter && Boolean(targetProvider),
  });
  const modelOptions = useMemo(
    () => (models.data?.models ?? []).map((entry) => ({ value: entry.id, label: entry.label, description: entry.description })),
    [models.data?.models],
  );
  useEffect(() => {
    if (!open || modelOptions.length === 0) return;
    if (modelOptions.some((entry) => entry.value === targetModel)) return;
    setTargetModel(modelOptions[0]!.value);
  }, [modelOptions, open, targetModel]);
  const entries = useMemo(
    () => pooled ? (capacity.data?.accounts ?? []).filter((entry) => entry.provider === family) : [],
    [capacity.data?.accounts, family, pooled],
  );
  const targetPooled = targetProvider === "claude" || targetProvider === "codex";
  const targetAccountOptions = useMemo(() => {
    if (!targetPooled) return [];
    const matching = (capacity.data?.accounts ?? []).filter((entry) => entry.provider === targetProvider);
    return [
      {
        value: "auto",
        label: "Automatic healthy account",
        description: "Uses health, priority and least recent use",
      },
      ...matching.map((entry) => ({
        value: entry.poolKey,
        label: entry.isPrimary ? `${entry.email} · primary` : entry.email,
        description: accountStatus(entry).label,
        disabled: entry.state === "held" || entry.state === "parked",
      })),
    ];
  }, [capacity.data?.accounts, targetPooled, targetProvider]);
  useEffect(() => {
    if (!open) return;
    if (!targetPooled) {
      setTargetAccount("provider");
      return;
    }
    if (!targetAccountOptions.some((entry) => entry.value === targetAccount)) setTargetAccount("auto");
  }, [open, targetAccount, targetAccountOptions, targetPooled]);
  const currentEvent = limits.data?.events.find((entry) => entry.agentId === agentId);
  const prefer = useMutation({
    mutationFn: (entry: CapacityAccount) => callPreference({ provider: entry.provider, email: entry.poolKey, preference: "preferred" }),
    onSuccess: (result) => {
      result.ok ? toast.show(result.message, { variant: "success" }) : toast.error(result.message);
      void queryClient.invalidateQueries({ queryKey: ["agent-link"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const move = useMutation({
    mutationFn: (entry: CapacityAccount) => callResume({ agentId, account: entry.poolKey }),
    onSuccess: (result) => {
      if (!result.ok) return toast.error(result.error ?? "Account change failed");
      toast.show("Chat moved and continuation requested.", { variant: "success" });
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ["agent-link"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const continueAgent = useMutation({
    mutationFn: () => callContinue({
      agentId,
      provider: targetProvider,
      model: targetModel,
      account: targetAccount,
      thinking: targetProvider.startsWith("codex") && targetModel === "gpt-5.6-sol" ? "ultra" : "high",
    }),
    onSuccess: (result) => {
      if (!result.ok) return toast.error(result.message);
      toast.show(result.message, { variant: "success", durationMs: 4_000 });
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Modal
      title={isRouter ? "AgentRouter route" : "Model and account"}
      icon={<Icon name="Route" size={18} color={theme.colors.foreground} />}
      open={open}
      onOpenChange={onOpenChange}
    >
      <Modal.Content>
        <TokensProvider value={t}>
          <ScrollView style={{ maxHeight: 620 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
            <View style={{ gap: 4 }}>
              <Text style={t.text.heading}>{isRouter ? `Answered by ${friendlyModelName(model)}` : friendlyModelName(model)}</Text>
              <Text style={t.text.caption}>
                {currentAccount
                  ? `${isRouter ? "Answering" : "Current"} sign-in: ${currentAccount}`
                  : "The sign-in has not been reported yet."}
              </Text>
              {!isRouter && pooled ? (
                <Text style={t.text.caption}>
                  {canMoveAccount
                    ? "Running turns stay pinned. After a turn stops, this routed chat can move accounts in the same tab."
                    : "This provider session is fixed. Switching providers preserves one active task and carries its live Paseo subagents forward."}
                </Text>
              ) : null}
            </View>
            {isRouter ? (
              <View style={{ padding: 12, borderRadius: t.radius.md, backgroundColor: t.color.surface2, gap: 4 }}>
                <Text style={t.text.bodyStrong}>One control tab, different answer routes</Text>
                <Text style={t.text.caption}>AgentRouter can choose another provider, model and account on the next turn. Name one in your message to override its saved route.</Text>
              </View>
            ) : !pooled ? (
              <View style={{ padding: 12, borderRadius: t.radius.md, backgroundColor: t.color.surface2, gap: 4 }}>
                <Text style={t.text.bodyStrong}>This provider has one visible sign-in</Text>
                <Text style={t.text.caption}>AgentLink can move native sessions between saved accounts only for Claude Code and Codex.</Text>
              </View>
            ) : null}
            {pooled && capacity.isLoading ? <Text style={t.text.caption}>Reading account limits…</Text> : null}
            {pooled && capacity.error ? <Text style={[t.text.caption, { color: t.color.danger }]}>{String(capacity.error)}</Text> : null}
            {entries.map((entry) => {
              const status = accountStatus(entry);
              const isCurrent = entry.poolKey === currentAccount || entry.email === currentAccount;
              const unavailable = entry.state === "held" || entry.state === "parked";
              return (
                <View key={`${entry.provider}-${entry.poolKey}`} style={{ padding: 12, borderRadius: t.radius.md, backgroundColor: t.color.surface2, gap: 10 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text numberOfLines={1} style={t.text.bodyStrong}>{entry.email}</Text>
                      <Text style={t.text.caption}>{entry.isPrimary ? "primary sign-in" : entry.poolKey}</Text>
                    </View>
                    <StatusPill status={isCurrent ? "busy" : status.tone} label={isCurrent ? "current" : status.label} />
                  </View>
                  {entry.windows.map((window, index) => {
                    const used = Math.max(0, Math.min(100, Math.round(window.usedPct)));
                    return (
                      <View key={`${window.label}-${index}`} style={{ gap: 4 }}>
                        <Meter fraction={used / 100} tone={used >= 99 ? "error" : used >= 85 ? "attention" : "ok"} label={`${window.label}: ${100 - used}% available`} />
                        <Text style={t.text.caption}>{resetLabel(window.resetsAt)}</Text>
                      </View>
                    );
                  })}
                  {entry.windows.length === 0 ? <Text style={t.text.caption}>{entry.detail || "No quota telemetry yet."}</Text> : null}
                  {!isCurrent ? (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      <Button
                        label="Prioritise new chats"
                        variant="ghost"
                        disabled={unavailable}
                        loading={prefer.isPending}
                        onPress={() => prefer.mutate(entry)}
                      />
                      {pooled && canMoveAccount && !unavailable && agentStatus !== "running" && agentStatus !== "initializing" ? (
                        <ConfirmButton
                          label="Move chat here"
                          confirmLabel="Confirm move & continue"
                          onConfirm={() => move.mutate(entry)}
                        />
                      ) : pooled && canMoveAccount ? (
                        <Button
                          label={agentStatus === "running" || agentStatus === "initializing" ? "Wait for current turn" : "Account unavailable"}
                          disabled
                          onPress={() => {}}
                        />
                      ) : null}
                    </View>
                  ) : null}
                </View>
              );
            })}
            {!isRouter ? <View style={{ padding: 12, borderRadius: t.radius.md, backgroundColor: t.color.surface2, gap: 10 }}>
              <View style={{ gap: 4 }}>
                <Text style={t.text.bodyStrong}>Continue this task</Text>
                <Text style={t.text.caption}>The new provider becomes the active task. This session moves underneath as history, and live Paseo subagents carry across.</Text>
              </View>
              <ComboBox
                label="Provider"
                value={targetProvider}
                onChange={(value) => {
                  setTargetProvider(value);
                  setTargetModel("");
                  setTargetAccount(value === "claude" || value === "codex" ? "auto" : "provider");
                }}
                options={providerOptions}
                placeholder="Choose provider"
                allowCustom={false}
              />
              {targetPooled ? (
                <ComboBox
                  label="Account"
                  value={targetAccount}
                  onChange={setTargetAccount}
                  options={targetAccountOptions}
                  placeholder="Choose account routing"
                  allowCustom={false}
                  hint="Automatic keeps failover; a named account pins the replacement session."
                />
              ) : null}
              <ComboBox
                label="Model"
                value={targetModel}
                onChange={setTargetModel}
                options={modelOptions}
                placeholder={models.isLoading ? "Loading models…" : "Choose model"}
                allowCustom={modelOptions.length === 0}
                hint={models.data?.message}
              />
              {targetProvider && targetModel && agentStatus !== "running" && agentStatus !== "initializing" ? (
                <ConfirmButton
                  label="Switch provider & continue"
                  confirmLabel="Continue this task"
                  variant="secondary"
                  onConfirm={() => continueAgent.mutate()}
                />
              ) : (
                <Button
                  label={agentStatus === "running" || agentStatus === "initializing" ? "Wait for current turn" : "Choose a route"}
                  disabled
                  onPress={() => {}}
                />
              )}
            </View> : null}
            {currentEvent ? (
              <View style={{ padding: 12, borderRadius: t.radius.md, backgroundColor: t.color.warningWash, gap: 4 }}>
                <Text style={t.text.bodyStrong}>Recovery</Text>
                <Text style={t.text.caption}>{currentEvent.detail}</Text>
                <Text style={t.text.caption}>
                  {`${currentEvent.attempts ?? 0} retry attempt${(currentEvent.attempts ?? 0) === 1 ? "" : "s"}${
                    currentEvent.targetAgentId ? ` · active agent ${currentEvent.targetAgentId}` : ""
                  }`}
                </Text>
              </View>
            ) : null}
          </ScrollView>
        </TokensProvider>
      </Modal.Content>
    </Modal>
  );
}

export function contributeModelPills(client: PluginClientContext) {
  const pills = new Map<string, { workspaceId: string; remove: () => void }>();
  let disposed = false;

  const install = (agent: Pick<PaseoAgent, "id" | "workspaceId">) => {
    if (!agent.workspaceId) return;
    const current = pills.get(agent.id);
    if (current?.workspaceId === agent.workspaceId) return;
    current?.remove();
    const workspaceId = agent.workspaceId;
    pills.set(agent.id, {
      workspaceId,
      remove: client.addComposerPill({
        id: "runtime-model",
        title: "Open model and account details",
        workspaceId,
        agentId: agent.id,
        Component: AgentModelPill,
        onPress() {
          requestAccountModal(agent.id);
        },
      }),
    });
  };

  const unsubscribe = client.paseo.agents.subscribe((update: PaseoAgentUpdate) => {
    if (update.kind === "remove") {
      pills.get(update.agentId)?.remove();
      pills.delete(update.agentId);
      return;
    }
    install(update.agent);
  });

  void client.paseo.agents
    .list({ scope: "active", page: { limit: 200 } })
    .then(({ entries }: PaseoAgentListResult) => {
      if (disposed) return;
      for (const entry of entries) install(entry.agent);
    })
    .catch(() => {
      // Live upserts still register pills when the initial directory read fails.
    });

  return () => {
    disposed = true;
    unsubscribe();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
}
