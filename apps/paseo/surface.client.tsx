import type { PluginSurfaceProps, PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Clipboard, Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { CliHijack, Connection, RouterStatus } from "./contracts.shared";
import {
  routerAliasRemove,
  routerAliasSet,
  routerConnectComplete,
  routerConnectPoll,
  routerConnectStart,
  routerConnectionRemove,
  routerModelExpose,
  routerRouteCli,
  routerSettingsSave,
  routerStart,
  routerStatus,
  routerSyncModels,
  routerUsageStats,
  routerCatalogSync,
  routerConnectionHealth,
  routerRequestLogs,
  routerConnectionOrder,
  routerConnectionPrioritySet,
  routerConnectionActiveSet,
  routerHolds,
  routerClearHold,
  routerTestModel,
  routerTuning,
  routerTuningSet,
  routerLogs,
  routerKeys,
  routerKeyCreate,
  routerKeyDelete,
  routerKeyReveal,
  routerCombos,
  routerComboSave,
  routerComboDelete,
  routerPasswordChange,
  routerPowerUps,
  routerPowerUpApply,
  routerSyncSelection,
  routerSyncSelectionSet,
  routerTunnel,
  routerTunnelSet,
  routerLocalForward,
  routerLocalForwardStatus,
  routerLocalForwardStop,
  routerRequireApiKey,
} from "./contracts.shared";
import { cliForModel, formatReset, groupModelIds, parseOauthPaste, providerLabel, quotaTone } from "./router.logic";

type Theme = PluginTheme;

// ------------------------------------------------------------- primitives

function Card({ theme, children }: { theme: Theme; children: React.ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: 14,
        gap: 10,
        marginBottom: 12,
      }}
    >
      {children}
    </View>
  );
}

function Step({ theme, index, title, hint }: { theme: Theme; index: number; title: string; hint?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          backgroundColor: theme.colors.surface2,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "700" }}>{index}</Text>
      </View>
      <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600", flex: 1 }}>{title}</Text>
      {hint ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{hint}</Text> : null}
    </View>
  );
}

function Chip({ theme, label, tone = "neutral" }: { theme: Theme; label: string; tone?: "success" | "warning" | "danger" | "neutral" }) {
  const color =
    tone === "success"
      ? theme.colors.statusSuccess
      : tone === "warning"
        ? theme.colors.statusWarning
        : tone === "danger"
          ? theme.colors.statusDanger
          : theme.colors.foregroundMuted;
  return (
    <View style={{ borderColor: color, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

function Button({
  theme,
  label,
  onPress,
  tone = "default",
  busy,
  disabled,
}: {
  theme: Theme;
  label: string;
  onPress: () => void;
  tone?: "default" | "primary" | "danger";
  busy?: boolean;
  disabled?: boolean;
}) {
  const inactive = disabled || busy;
  const background = tone === "primary" ? theme.colors.accent : theme.colors.surface2;
  const color = tone === "primary" ? theme.colors.accentForeground : tone === "danger" ? theme.colors.statusDanger : theme.colors.foreground;
  return (
    <Pressable
      onPress={inactive ? undefined : onPress}
      style={{
        backgroundColor: background,
        borderColor: theme.colors.border,
        borderWidth: tone === "primary" ? 0 : 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 7,
        opacity: inactive ? 0.5 : 1,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
      }}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : null}
      <Text style={{ color, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

function Field({
  theme,
  value,
  onChangeText,
  placeholder,
  secure,
}: {
  theme: Theme;
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  secure?: boolean;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      secureTextEntry={secure}
      autoCapitalize="none"
      autoCorrect={false}
      style={{
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 7,
        color: theme.colors.foreground,
        fontSize: 13,
        minWidth: 160,
        flexGrow: 1,
      }}
    />
  );
}

function Note({ theme, children, tone = "muted" }: { theme: Theme; children: React.ReactNode; tone?: "muted" | "warning" }) {
  return (
    <Text
      style={{
        color: tone === "warning" ? theme.colors.statusWarning : theme.colors.foregroundMuted,
        fontSize: 12,
        lineHeight: 17,
      }}
    >
      {children}
    </Text>
  );
}

function QuotaBar({ theme, quota }: { theme: Theme; quota: RouterStatus["connections"][number]["usage"] extends null ? never : NonNullable<Connection["usage"]>["quotas"][number] }) {
  const tone = quotaTone(quota);
  const color =
    tone === "success"
      ? theme.colors.statusSuccess
      : tone === "warning"
        ? theme.colors.statusWarning
        : tone === "danger"
          ? theme.colors.statusDanger
          : theme.colors.foregroundMuted;
  const reset = formatReset(quota.resetAt);
  return (
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{quota.label}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {quota.unlimited ? "unlimited" : `${Math.round(quota.remainingPercentage)}% left`}
          {reset ? ` · ${reset}` : ""}
        </Text>
      </View>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
        <View style={{ width: `${Math.max(2, Math.min(100, quota.remainingPercentage))}%`, height: 4, backgroundColor: color }} />
      </View>
    </View>
  );
}

// ------------------------------------------------------------------ surface

const TABS = [
  { id: "setup", label: "Setup" },
  { id: "accounts", label: "Accounts" },
  { id: "models", label: "Models" },
  { id: "keys", label: "Keys" },
  { id: "tuning", label: "Tuning" },
  { id: "powerups", label: "Power-ups" },
  { id: "usage", label: "Usage" },
  { id: "logs", label: "Logs" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** 9router's first-run password. Prefilled so setup is one press, not a lookup. */
const DEFAULT_PASSWORD = "123456";

function Tabs({ theme, active, onSelect, badge }: { theme: Theme; active: TabId; onSelect: (id: TabId) => void; badge: Partial<Record<TabId, string>> }) {
  return (
    <View style={{ flexDirection: "row", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
      {TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <Pressable
            key={tab.id}
            onPress={() => onSelect(tab.id)}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 999,
              backgroundColor: selected ? theme.colors.accent : theme.colors.surface1,
              borderColor: theme.colors.border,
              borderWidth: selected ? 0 : 1,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Text
              style={{
                color: selected ? theme.colors.accentForeground : theme.colors.foregroundMuted,
                fontSize: 13,
                fontWeight: "600",
              }}
            >
              {tab.label}
            </Text>
            {badge[tab.id] ? (
              <View style={{ backgroundColor: selected ? theme.colors.accentForeground : theme.colors.surface2, borderRadius: 999, paddingHorizontal: 6 }}>
                <Text style={{ color: selected ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 10, fontWeight: "700" }}>
                  {badge[tab.id]}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function Toggle({
  theme,
  label,
  hint,
  on,
  busy,
  disabled,
  onToggle,
}: {
  theme: Theme;
  label: string;
  hint?: string;
  on: boolean;
  busy?: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <View style={{ gap: 3 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>{label}</Text>
        <Chip theme={theme} label={on ? "on" : "off"} tone={on ? "success" : "neutral"} />
        <Button theme={theme} label={on ? "Turn off" : "Turn on"} busy={busy} disabled={disabled} onPress={onToggle} />
      </View>
      {hint ? <Note theme={theme}>{hint}</Note> : null}
    </View>
  );
}

function Row({ theme, label, value, tone }: { theme: Theme; label: string; value: string; tone?: "success" | "warning" | "danger" }) {
  const color =
    tone === "success"
      ? theme.colors.statusSuccess
      : tone === "warning"
        ? theme.colors.statusWarning
        : tone === "danger"
          ? theme.colors.statusDanger
          : theme.colors.foreground;
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color, fontSize: 12, fontWeight: "600", flexShrink: 1, textAlign: "right" }}>{value}</Text>
    </View>
  );
}

/**
 * Durations here are read at a glance, not measured, so precision past the
 * second unit is noise: "2d 4h" answers "has it been stable?" better than
 * "2d 4h 17m 3s".
 */
function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Relative age, for "last seen" style values. */
function formatAgo(iso: string | null): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  return `${formatDuration((Date.now() - then) / 1000)} ago`;
}

export function AgentLinkSurface({ theme, layout }: PluginSurfaceProps) {
  const queryClient = useQueryClient();
  const callStatus = useRpc(routerStatus);
  const callStart = useRpc(routerStart);
  const callSaveSettings = useRpc(routerSettingsSave);
  const callRouteCli = useRpc(routerRouteCli);
  const callSyncModels = useRpc(routerSyncModels);
  const callConnectStart = useRpc(routerConnectStart);
  const callConnectPoll = useRpc(routerConnectPoll);
  const callConnectComplete = useRpc(routerConnectComplete);
  const callRemoveConnection = useRpc(routerConnectionRemove);
  const callExpose = useRpc(routerModelExpose);
  const callAliasSet = useRpc(routerAliasSet);
  const callAliasRemove = useRpc(routerAliasRemove);
  const callUsageStats = useRpc(routerUsageStats);
  const callCatalogSync = useRpc(routerCatalogSync);
  const callConnectionHealth = useRpc(routerConnectionHealth);
  const callRequestLogs = useRpc(routerRequestLogs);
  const callConnectionOrder = useRpc(routerConnectionOrder);
  const callPrioritySet = useRpc(routerConnectionPrioritySet);
  const callActiveSet = useRpc(routerConnectionActiveSet);
  const callHolds = useRpc(routerHolds);
  const callClearHold = useRpc(routerClearHold);
  const callTestModel = useRpc(routerTestModel);
  const callTuning = useRpc(routerTuning);
  const callTuningSet = useRpc(routerTuningSet);
  const callLogs = useRpc(routerLogs);
  const callKeys = useRpc(routerKeys);
  const callKeyCreate = useRpc(routerKeyCreate);
  const callKeyDelete = useRpc(routerKeyDelete);
  const callKeyReveal = useRpc(routerKeyReveal);
  const callCombos = useRpc(routerCombos);
  const callComboSave = useRpc(routerComboSave);
  const callComboDelete = useRpc(routerComboDelete);
  const callPasswordChange = useRpc(routerPasswordChange);
  const callPowerUps = useRpc(routerPowerUps);
  const callPowerUpApply = useRpc(routerPowerUpApply);
  const callSyncSelection = useRpc(routerSyncSelection);
  const callSyncSelectionSet = useRpc(routerSyncSelectionSet);
  const callTunnel = useRpc(routerTunnel);
  const callTunnelSet = useRpc(routerTunnelSet);
  const callRequireApiKey = useRpc(routerRequireApiKey);
  const callForward = useRpc(routerLocalForward);
  const callForwardStop = useRpc(routerLocalForwardStop);
  const callForwardStatus = useRpc(routerLocalForwardStatus);

  const status = useQuery({
    queryKey: ["agent-link-9router", "router-status"],
    queryFn: () => callStatus({}),
    refetchInterval: 15_000,
  });
  const data = status.data;
  const live = data?.running === true && data.auth.ok;

  const [tab, setTab] = useState<TabId>("setup");
  const [message, setMessage] = useState<string>("");
  // 9router ships with this password; prefilling it means Save works immediately
  // on a fresh install, and it is still editable for anyone who changed it.
  const [url, setUrl] = useState("");
  const [password, setPassword] = useState(DEFAULT_PASSWORD);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [signIn, setSignIn] = useState<{
    provider: "claude" | "codex";
    mode: "paste-code" | "poll";
    authUrl: string;
    state: string;
    codeVerifier: string | null;
    redirectUri: string;
  } | null>(null);
  const [pasted, setPasted] = useState("");
  const [exposeAlias, setExposeAlias] = useState("cc");
  const [exposeId, setExposeId] = useState("");
  const [exposeName, setExposeName] = useState("");
  const [aliasFrom, setAliasFrom] = useState("");
  const [aliasTo, setAliasTo] = useState("");
  const [comboName, setComboName] = useState("");
  const [comboModels, setComboModels] = useState<string[]>([]);
  const [keyName, setKeyName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ model: string; ok: boolean; message: string } | null>(null);

  const order = useQuery({
    queryKey: ["agent-link-9router", "connection-order"],
    queryFn: () => callConnectionOrder({}),
    enabled: live && tab === "accounts",
  });
  // Connection health is what explains a model that will not answer, so it
  // loads with the Accounts tab rather than behind a button.
  const health = useQuery({
    queryKey: ["agent-link-9router", "connection-health"],
    queryFn: () => callConnectionHealth({}),
    enabled: live && tab === "accounts",
    refetchInterval: tab === "accounts" ? 20_000 : false,
  });
  const requestLogs = useQuery({
    queryKey: ["agent-link-9router", "request-logs"],
    queryFn: () => callRequestLogs({ limit: 25, errorsOnly: true }),
    enabled: live && tab === "logs",
    refetchInterval: tab === "logs" ? 8_000 : false,
  });
  const usage = useQuery({
    queryKey: ["agent-link-9router", "usage-stats"],
    queryFn: () => callUsageStats({}),
    enabled: live && tab === "usage",
    refetchInterval: 30_000,
  });
  const tuning = useQuery({
    queryKey: ["agent-link-9router", "tuning"],
    queryFn: () => callTuning({}),
    enabled: live && tab === "tuning",
  });
  const logs = useQuery({
    queryKey: ["agent-link-9router", "logs"],
    queryFn: () => callLogs({ limit: 200 }),
    enabled: live && tab === "logs",
    refetchInterval: tab === "logs" ? 4_000 : false,
  });
  const keys = useQuery({
    queryKey: ["agent-link-9router", "keys"],
    queryFn: () => callKeys({}),
    enabled: live && tab === "keys",
  });
  const combos = useQuery({
    queryKey: ["agent-link-9router", "combos"],
    queryFn: () => callCombos({}),
    enabled: live && (tab === "keys" || tab === "models"),
  });
  const powerUps = useQuery({
    queryKey: ["agent-link-9router", "power-ups"],
    queryFn: () => callPowerUps({}),
    enabled: tab === "powerups",
  });
  const syncSelection = useQuery({
    queryKey: ["agent-link-9router", "sync-selection"],
    queryFn: () => callSyncSelection({}),
    enabled: tab === "models",
  });
  const tunnel = useQuery({
    queryKey: ["agent-link-9router", "tunnel"],
    queryFn: () => callTunnel({}),
    enabled: live && tab === "setup",
    // A tunnel takes a few seconds to publish its URL, so poll while open.
    refetchInterval: tab === "setup" ? 8_000 : false,
  });
  const holds = useQuery({
    queryKey: ["agent-link-9router", "holds"],
    queryFn: () => callHolds({}),
    enabled: live,
    refetchInterval: 30_000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["agent-link-9router"] });
  };
  const feedback = {
    onSuccess: (result: { message?: string }) => {
      if (result?.message) setMessage(result.message);
      refresh();
    },
    onError: (error: unknown) => setMessage(error instanceof Error ? error.message : String(error)),
  };

  const startMutation = useMutation({ mutationFn: callStart, ...feedback });
  const saveMutation = useMutation({ mutationFn: callSaveSettings, ...feedback });
  const routeMutation = useMutation({ mutationFn: callRouteCli, ...feedback });
  const syncMutation = useMutation({ mutationFn: callSyncModels, ...feedback });
  const catalogSyncMutation = useMutation({ mutationFn: callCatalogSync, ...feedback });
  const priorityMutation = useMutation({ mutationFn: callPrioritySet, ...feedback });
  const activeMutation = useMutation({ mutationFn: callActiveSet, ...feedback });
  const removeMutation = useMutation({ mutationFn: callRemoveConnection, ...feedback });
  const exposeMutation = useMutation({ mutationFn: callExpose, ...feedback });
  const aliasSetMutation = useMutation({ mutationFn: callAliasSet, ...feedback });
  const aliasRemoveMutation = useMutation({ mutationFn: callAliasRemove, ...feedback });
  const clearHoldMutation = useMutation({ mutationFn: callClearHold, ...feedback });
  const tuningMutation = useMutation({ mutationFn: callTuningSet, ...feedback });
  const keyCreateMutation = useMutation({ mutationFn: callKeyCreate, ...feedback });
  const keyDeleteMutation = useMutation({ mutationFn: callKeyDelete, ...feedback });
  const comboSaveMutation = useMutation({ mutationFn: callComboSave, ...feedback });
  const comboDeleteMutation = useMutation({ mutationFn: callComboDelete, ...feedback });
  const passwordMutation = useMutation({ mutationFn: callPasswordChange, ...feedback });
  const powerUpMutation = useMutation({ mutationFn: callPowerUpApply, ...feedback });
  const selectionMutation = useMutation({ mutationFn: callSyncSelectionSet, ...feedback });
  const tunnelMutation = useMutation({ mutationFn: callTunnelSet, ...feedback });
  const requireKeyMutation = useMutation({ mutationFn: callRequireApiKey, ...feedback });
  const keyRevealMutation = useMutation({
    mutationFn: callKeyReveal,
    onSuccess: (result) => {
      // The only path that materialises a full key, and it goes straight to the
      // clipboard rather than onto the screen.
      if (result.ok && result.key) Clipboard.setString(result.key);
      setMessage(result.message);
    },
    onError: (error: unknown) => setMessage(error instanceof Error ? error.message : String(error)),
  });
  const testMutation = useMutation({
    mutationFn: callTestModel,
    onSuccess: (result, input) => setTestResult({ model: input.model, ok: result.ok, message: result.message }),
    onError: (error: unknown, input) =>
      setTestResult({ model: input.model, ok: false, message: error instanceof Error ? error.message : String(error) }),
  });

  const connectMutation = useMutation({
    mutationFn: (provider: "claude" | "codex") => callConnectStart({ provider }),
    onSuccess: (result) => {
      setSignIn(result);
      setPasted("");
      setMessage("");
      void Linking.openURL(result.authUrl).catch(() => {
        Clipboard.setString(result.authUrl);
        setMessage("Could not open a browser — the sign-in link is on your clipboard.");
      });
    },
    onError: (error: unknown) => setMessage(error instanceof Error ? error.message : String(error)),
  });

  const finishMutation = useMutation({
    mutationFn: async () => {
      if (!signIn) throw new Error("No sign-in in progress.");
      if (signIn.mode === "poll") return callConnectPoll({ provider: signIn.provider, state: signIn.state });
      const parsed = parseOauthPaste(pasted);
      if (!parsed) throw new Error("Paste the code (or the full callback URL) from the sign-in page.");
      return callConnectComplete({
        provider: signIn.provider,
        code: parsed.code,
        state: parsed.state ?? signIn.state,
        codeVerifier: signIn.codeVerifier ?? "",
        redirectUri: signIn.redirectUri,
      });
    },
    onSuccess: (result: { ok?: boolean; status?: string; error?: string | null }) => {
      if (result.ok === true || result.status === "done") {
        setSignIn(null);
        setPasted("");
        setMessage("Account connected.");
      } else if (result.status === "pending") {
        setMessage("Waiting for the browser sign-in to finish…");
      } else {
        setMessage(result.error ?? "Sign-in did not complete.");
      }
      refresh();
    },
    onError: (error: unknown) => setMessage(error instanceof Error ? error.message : String(error)),
  });

  if (status.isLoading && !data) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  const gap = layout.compact ? 8 : 12;
  const hijackFor = (cli: "claude" | "codex") => data?.hijack.find((entry) => entry.cli === cli);
  const grouped = groupModelIds(data?.models.ids ?? []);
  const holdCount = holds.data?.count ?? 0;

  // The setup checklist doubles as the wizard: each step knows whether it is
  // done, so a fresh install reads top-to-bottom and a working one is all ticks.
  const steps = [
    { done: Boolean(data?.binary.path), label: "9router installed" },
    { done: Boolean(data?.running), label: "9router running" },
    { done: Boolean(data?.auth.ok), label: "Dashboard password saved" },
    { done: (data?.connections.length ?? 0) > 0, label: "At least one account connected" },
    { done: data?.hijack.some((entry) => entry.routed) === true, label: "A CLI routed through 9router" },
  ];
  const remaining = steps.filter((step) => !step.done).length;

  const byProvider = new Map<string, Connection[]>();
  for (const connection of data?.connections ?? []) {
    const list = byProvider.get(connection.provider) ?? [];
    list.push(connection);
    byProvider.set(connection.provider, list);
  }

  const openLink = (target: string) => {
    void Linking.openURL(target).catch(() => {
      Clipboard.setString(target);
      setMessage(`Copied ${target}`);
    });
  };

  // The dashboard is bound to the ROUTER's loopback. Opening its URL opens it on
  // whichever machine the app runs on, so for a remote daemon the link reaches
  // this machine's port instead — the wrong router, or nothing. The forward
  // below makes the same URL mean the right thing.
  const forward = useQuery({
    queryKey: ["agent-link-9router", "local-forward"],
    queryFn: () => callForwardStatus({}),
    refetchInterval: 20_000,
  });

  const [forwardHost, setForwardHost] = useState("");
  const [forwardKey, setForwardKey] = useState("");
  const [forwardMinutes, setForwardMinutes] = useState("5");
  const [forwardCountdown, setForwardCountdown] = useState<string | null>(null);

  // Tick locally rather than polling: the expiry is known, and a countdown that
  // only moves every 20s reads as broken.
  const expiresAt = forward.data?.expiresAt ?? null;
  useEffect(() => {
    if (!expiresAt) {
      setForwardCountdown(null);
      return;
    }
    const tick = () => {
      const left = Date.parse(expiresAt) - Date.now();
      if (Number.isNaN(left) || left <= 0) {
        setForwardCountdown("closing…");
        void forward.refetch();
        return;
      }
      const total = Math.round(left / 1000);
      setForwardCountdown(`${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`);
    };
    tick();
    const handle = setInterval(tick, 1000);
    return () => clearInterval(handle);
  }, [expiresAt]);

  const openUrl = (target: string, hint: string) => {
    void Linking.openURL(target).catch(() => {
      Clipboard.setString(target);
      setMessage(`Copied ${target} — ${hint}`);
    });
  };

  const openDashboard = () => {
    // Prefer a live forward: it is the only URL that reaches a remote router.
    const forwarded = forward.data?.open ? forward.data.url : null;
    const target = forwarded ?? data?.dashboardUrl ?? "";
    openUrl(target, "paste it into a Paseo browser tab (⌘⇧B).");
  };

  const openForward = () => {
    const host = forwardHost.trim();
    if (!host) {
      setMessage("Enter the daemon's SSH target first, e.g. user@host.");
      return;
    }
    const minutes = Number.parseInt(forwardMinutes, 10);
    void callForward({
      sshTarget: host,
      sshPort: null,
      identityFile: forwardKey.trim() || null,
      remotePort: 20128,
      ttlMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 5,
    })
      .then((result) => {
        setMessage(result.message);
        void forward.refetch();
        if (result.ok && result.url) openUrl(result.url, "open it in a Paseo browser tab (⌘⇧B).");
      })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)));
  };

  const closeForward = () => {
    void callForwardStop({})
      .then((result) => {
        setMessage(result.message);
        void forward.refetch();
      })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)));
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: gap + 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "700", flex: 1 }}>9Router</Text>
        {data?.running ? <Chip theme={theme} label={`v${data.version?.current ?? "?"}`} /> : null}
        <Chip theme={theme} label={data?.running ? "running" : "stopped"} tone={data?.running ? "success" : "warning"} />
      </View>
      <Note theme={theme}>
        Accounts, quotas, rotation and fallback live in 9router. It rewrites each CLI's own config, so a routed binary
        goes through it everywhere — Paseo's chats included.
      </Note>

      <View style={{ height: gap }} />
      <Tabs
        theme={theme}
        active={tab}
        onSelect={setTab}
        badge={{
          setup: remaining > 0 ? String(remaining) : undefined,
          accounts: holdCount > 0 ? String(holdCount) : undefined,
          models: data?.models.count ? String(data.models.count) : undefined,
          keys: keys.data?.keys.length ? String(keys.data.keys.length) : undefined,
        }}
      />

      {message ? (
        <Pressable onPress={() => setMessage("")}>
          <View style={{ marginBottom: 12, padding: 10, borderRadius: 8, backgroundColor: theme.colors.surface2 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{message}</Text>
          </View>
        </Pressable>
      ) : null}

      {/* ------------------------------------------------------------- SETUP */}
      {tab === "setup" ? (
        <>
          <Card theme={theme}>
            <Step theme={theme} index={1} title="Checklist" hint={remaining === 0 ? "all done" : `${remaining} left`} />
            {steps.map((step) => (
              <View key={step.label} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ color: step.done ? theme.colors.statusSuccess : theme.colors.foregroundMuted, fontSize: 13 }}>
                  {step.done ? "●" : "○"}
                </Text>
                <Text style={{ color: step.done ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 13 }}>
                  {step.label}
                </Text>
              </View>
            ))}
          </Card>

          {!data?.binary.path ? (
            <Card theme={theme}>
              <Step theme={theme} index={2} title="Install 9router" />
              <Note theme={theme}>Run this in a terminal, then come back and press Start.</Note>
              <View style={{ padding: 10, borderRadius: 8, backgroundColor: theme.colors.surface2 }}>
                <Text style={{ color: theme.colors.foreground, fontSize: 12, fontFamily: "Menlo" }}>
                  npm install -g 9router
                </Text>
              </View>
              <Button
                theme={theme}
                label="Copy command"
                onPress={() => {
                  Clipboard.setString("npm install -g 9router");
                  setMessage("Copied: npm install -g 9router");
                }}
              />
            </Card>
          ) : null}

          {data && data.warnings.length > 0 ? (
            <Card theme={theme}>
              <Step theme={theme} index={0} title="Needs attention" />
              {data.warnings.map((w) => (
                <Note key={w.id} theme={theme} tone="warning">
                  {w.severity === "danger" ? "⚠ " : ""}{w.title}. {w.detail}
                </Note>
              ))}
            </Card>
          ) : null}

          <Card theme={theme}>
            <Step theme={theme} index={data?.binary.path ? 2 : 3} title="Server" hint={data?.url} />
            <View style={{ gap: 5 }}>
              <Row theme={theme} label="Binary" value={data?.binary.path ?? "not installed"} tone={data?.binary.path ? "success" : "danger"} />
              <Row theme={theme} label="Status" value={data?.running ? "running" : "stopped"} tone={data?.running ? "success" : "warning"} />
              {data?.uptime.running ? (
                <>
                  <Row theme={theme} label="Uptime" value={formatDuration(data.uptime.uptimeSeconds)} tone="success" />
                  <Row theme={theme} label="Memory" value={data.uptime.rssMb !== null ? `${data.uptime.rssMb} MB` : "—"} />
                </>
              ) : (
                <Row theme={theme} label="Last seen" value={formatAgo(data?.uptime.lastSeenAt ?? null)} tone="warning" />
              )}
              {data && data.uptime.previousRunSeconds !== null ? (
                <Row theme={theme} label="Previous run" value={formatDuration(data.uptime.previousRunSeconds)} />
              ) : null}
              {data && data.uptime.restartsToday > 0 ? (
                <Row
                  theme={theme}
                  label="Restarts today"
                  value={String(data.uptime.restartsToday)}
                  tone={data.uptime.restartsToday >= 3 ? "danger" : "warning"}
                />
              ) : null}
              <Row theme={theme} label="API key" value={data?.apiKey.present ? `···${data.apiKey.last4 ?? ""}` : "none"} tone={data?.apiKey.present ? "success" : "warning"} />
              {data?.version?.hasUpdate ? <Row theme={theme} label="Update" value={`${data.version.latest} available`} tone="warning" /> : null}
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {!data?.running ? (
                <Button theme={theme} label="Start 9router" tone="primary" disabled={!data?.binary.path} busy={startMutation.isPending} onPress={() => startMutation.mutate({ action: "start" })} />
              ) : (
                <>
                  <Button theme={theme} label="Restart" busy={startMutation.isPending && startMutation.variables?.action === "restart"} onPress={() => startMutation.mutate({ action: "restart" })} />
                  <Button theme={theme} label="Stop" busy={startMutation.isPending && startMutation.variables?.action === "stop"} onPress={() => startMutation.mutate({ action: "stop" })} />
                </>
              )}
              <Button theme={theme} label="Open dashboard" onPress={openDashboard} />
              <Button
                theme={theme}
                label="Copy URL"
                onPress={() => {
                  Clipboard.setString(data?.dashboardUrl ?? "");
                  setMessage("Dashboard URL copied. A Paseo browser tab is ⌘⇧B.");
                }}
              />
            </View>
            {forward.data?.open ? (
              <Note theme={theme} tone="warning">
                Forwarding {forward.data.target} to 127.0.0.1:{forward.data.localPort}
                {forwardCountdown ? ` — closes in ${forwardCountdown}` : ""}. "Open dashboard" now reaches that
                router, not this one.
              </Note>
            ) : null}
          </Card>

          <Card theme={theme}>
            <Step theme={theme} index={0} title="Remote dashboard" hint={forward.data?.open ? "forwarding" : undefined} />
            <Note theme={theme}>
              A dashboard is bound to its own machine's loopback, so opening the link from here reaches THIS
              machine's port — the wrong router, or nothing at all. Forward the remote port over SSH and the same
              link resolves where you are sitting. Nothing is published; the forward closes itself when the timer
              runs out.
            </Note>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Field theme={theme} value={forwardHost} onChangeText={setForwardHost} placeholder="user@host" />
              <Field theme={theme} value={forwardKey} onChangeText={setForwardKey} placeholder="~/.ssh/id_ed25519 (optional)" />
              <Field theme={theme} value={forwardMinutes} onChangeText={setForwardMinutes} placeholder="minutes (5)" />
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {forward.data?.open ? (
                <>
                  <Button theme={theme} label={`Open (${forwardCountdown ?? "open"})`} tone="primary" onPress={openDashboard} />
                  <Button theme={theme} label="Close forward" tone="danger" onPress={closeForward} />
                </>
              ) : (
                <Button theme={theme} label="Forward and open" tone="primary" onPress={openForward} />
              )}
            </View>
            <Note theme={theme}>
              Always name a key when the host runs fail2ban: without one, ssh offers every key the agent holds and
              a host that refuses too many can ban this machine for its ban window.
            </Note>
          </Card>

          <Card theme={theme}>
            <Step theme={theme} index={data?.binary.path ? 3 : 4} title="Dashboard password" hint={data?.auth.ok ? "connected" : undefined} />
            <Note theme={theme}>
              This panel reads your accounts and quotas through 9router's own API, which wants the dashboard password.
              A fresh install uses {DEFAULT_PASSWORD} — it is prefilled below. Change it in the dashboard and save the
              new one here.
            </Note>
            {data?.auth.error ? <Note theme={theme} tone="warning">{data.auth.error}</Note> : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Field theme={theme} value={url} onChangeText={setUrl} placeholder={data?.url ?? "http://127.0.0.1:20128"} />
              <Field theme={theme} value={password} onChangeText={setPassword} placeholder="dashboard password" secure />
              <Button
                theme={theme}
                label={data?.auth.ok ? "Save" : "Connect"}
                tone="primary"
                busy={saveMutation.isPending}
                disabled={!data?.running}
                onPress={() => saveMutation.mutate({ ...(url ? { url } : {}), ...(password ? { password } : {}) })}
              />
            </View>
            <Note theme={theme}>Stored at {data?.settingsPath} (mode 600). The key is never shown in full.</Note>
            {data?.auth.ok ? (
              <View style={{ gap: 6 }}>
                <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>Change it</Text>
                <Note theme={theme}>
                  Leaving 9router on its shipped password means anyone who can reach this port owns your accounts.
                </Note>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <Field theme={theme} value={newPassword} onChangeText={setNewPassword} placeholder="new password" secure />
                  <Button
                    theme={theme}
                    label="Change password"
                    busy={passwordMutation.isPending}
                    disabled={!live || newPassword.length < 6}
                    onPress={() => {
                      passwordMutation.mutate({ currentPassword: password, newPassword });
                      setPassword(newPassword);
                      setNewPassword("");
                    }}
                  />
                </View>
              </View>
            ) : null}
          </Card>

          <Card theme={theme}>
            <Step theme={theme} index={data?.binary.path ? 4 : 5} title="Route the CLIs" />
            <Note theme={theme}>
              Routing rewrites that CLI's own config, so every launch on this machine goes through 9router — not just
              Paseo's. Paseo's stock Claude and Codex chats pick it up with no further wiring. 9router routes more
              tools than these two; the rest are switched from its dashboard.
            </Note>
            {(data?.hijack ?? []).map((entry) => (
              <View key={entry.cli} style={{ gap: 4, opacity: entry.installed ? 1 : 0.55 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>{entry.label}</Text>
                  {!entry.installed ? (
                    <Chip theme={theme} label="not installed" />
                  ) : (
                    <Chip theme={theme} label={entry.routed ? "through 9router" : "direct"} tone={entry.routed ? "success" : "neutral"} />
                  )}
                  {entry.installed && entry.supported ? (
                    <Button
                      theme={theme}
                      label={entry.routed ? "Restore direct" : "Route"}
                      tone={entry.routed ? "default" : "primary"}
                      disabled={!live}
                      busy={routeMutation.isPending && routeMutation.variables?.cli === entry.cli}
                      onPress={() => routeMutation.mutate({ cli: entry.cli, routed: !entry.routed })}
                    />
                  ) : null}
                </View>
                {entry.routed && entry.configPath ? <Note theme={theme}>Writes {entry.configPath}</Note> : null}
                {entry.note ? <Note theme={theme}>{entry.note}</Note> : null}
              </View>
            ))}
            <Button theme={theme} label="Route the others in the dashboard" onPress={openDashboard} />
            {data?.clientVersion.advertised ? (
              <View style={{ gap: 4, padding: 10, borderRadius: 8, backgroundColor: theme.colors.surface2 }}>
                <Text style={{ color: theme.colors.statusWarning, fontSize: 13, fontWeight: "600" }}>
                  9router identifies as Claude Code {data.clientVersion.advertised}
                </Text>
                <Note theme={theme}>
                  {data.clientVersion.installed
                    ? `You have ${data.clientVersion.installed}. `
                    : ""}
                  9router sends its own hardcoded client version, so a model Anthropic gates behind a newer Claude
                  Code fails on every account — and 9router then parks them, which outlives the cause. Clear the
                  holds under Accounts once 9router ships a bump.
                </Note>
              </View>
            ) : null}
          </Card>


          <Card theme={theme}>
            <Step theme={theme} index={data?.binary.path ? 5 : 6} title="Remote access" hint="optional" />
            <Note theme={theme}>
              A tunnel publishes 9router past this machine, so the same accounts answer from anywhere. It is also a
              proxy holding live subscription credentials, so the key requirement below is not optional in practice —
              without it, anyone with the URL spends your quota.
            </Note>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>
                API key required on /v1
              </Text>
              <Chip
                theme={theme}
                label={tunnel.data?.requireApiKey ? "required" : "open"}
                tone={tunnel.data?.requireApiKey ? "success" : "danger"}
              />
              <Button
                theme={theme}
                label={tunnel.data?.requireApiKey ? "Make open" : "Require a key"}
                tone={tunnel.data?.requireApiKey ? "default" : "primary"}
                disabled={!live}
                busy={requireKeyMutation.isPending}
                onPress={() => requireKeyMutation.mutate({ required: !tunnel.data?.requireApiKey })}
              />
            </View>
            {(tunnel.data?.tunnels ?? []).map((entry) => (
              <View key={entry.provider} style={{ gap: 4 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>
                    {entry.provider === "cloudflare" ? "Cloudflare tunnel" : "Tailscale"}
                  </Text>
                  <Chip
                    theme={theme}
                    label={entry.running ? "published" : entry.enabled ? "starting" : "off"}
                    tone={entry.running ? "warning" : "neutral"}
                  />
                  <Button
                    theme={theme}
                    label={entry.enabled ? "Stop" : "Publish"}
                    tone={entry.enabled ? "default" : "primary"}
                    disabled={!live}
                    busy={tunnelMutation.isPending && tunnelMutation.variables?.provider === entry.provider}
                    onPress={() => tunnelMutation.mutate({ provider: entry.provider, enabled: !entry.enabled })}
                  />
                </View>
                {entry.url ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, flex: 1 }} numberOfLines={1}>
                      {entry.url}
                    </Text>
                    <Button
                      theme={theme}
                      label="Copy"
                      onPress={() => {
                        Clipboard.setString(entry.url);
                        setMessage("Public URL copied. Treat it as a credential.");
                      }}
                    />
                  </View>
                ) : null}
                {entry.note ? <Note theme={theme}>{entry.note}</Note> : null}
              </View>
            ))}
          </Card>

          <Note theme={theme}>
            Routing a subscription sign-in through a local proxy is outside Anthropic's and OpenAI's consumer terms.
            That choice is yours to make.
          </Note>
        </>
      ) : null}

      {/* ---------------------------------------------------------- ACCOUNTS */}
      {tab === "accounts" ? (
        <>
          <Card theme={theme}>
            <Step theme={theme} index={0} title="Order accounts" hint={`${order.data?.connections.length ?? 0}`} />
            <Note theme={theme}>
              9router tries accounts in priority order, lowest first, so this decides which one answers. Park an
              account to rest it without deleting it — its tokens are kept.
            </Note>
            {(order.data?.connections ?? []).map((connection) => (
              <View
                key={connection.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  padding: 8,
                  borderRadius: 8,
                  backgroundColor: theme.colors.surface2,
                  opacity: connection.isActive ? 1 : 0.55,
                }}
              >
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, width: 22 }}>
                  {connection.priority}
                </Text>
                <Text style={{ color: theme.colors.foreground, fontSize: 12, flex: 1 }} numberOfLines={1}>
                  {providerLabel(connection.provider)} · {connection.label}
                </Text>
                <Button
                  theme={theme}
                  label="↑"
                  disabled={connection.priority <= 1 || priorityMutation.isPending}
                  onPress={() =>
                    priorityMutation.mutate({ id: connection.id, priority: connection.priority - 1 })
                  }
                />
                <Button
                  theme={theme}
                  label="↓"
                  disabled={connection.priority >= 99 || priorityMutation.isPending}
                  onPress={() =>
                    priorityMutation.mutate({ id: connection.id, priority: connection.priority + 1 })
                  }
                />
                <Button
                  theme={theme}
                  label={connection.isActive ? "Park" : "Use"}
                  busy={activeMutation.isPending}
                  onPress={() => activeMutation.mutate({ id: connection.id, isActive: !connection.isActive })}
                />
              </View>
            ))}
          </Card>
          <Card theme={theme}>
            <Step theme={theme} index={0} title="Account health" hint={`${health.data?.connections.length ?? 0}`} />
            <Note theme={theme}>
              What decides whether a model answers lives on the account, not the model. An expired token, an
              active backoff, or a model lock pinning the account to one model are all invisible in the picker.
            </Note>
            {(health.data?.connections ?? []).map((connection) => {
              const expiring = connection.expiresInMinutes !== null && connection.expiresInMinutes < 60;
              return (
                <View
                  key={connection.id}
                  style={{ gap: 4, padding: 8, borderRadius: 8, backgroundColor: theme.colors.surface2 }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", flex: 1 }}>
                      {providerLabel(connection.provider)} · {connection.email || connection.name || connection.id.slice(0, 8)}
                    </Text>
                    <Chip
                      theme={theme}
                      label={connection.isActive ? "active" : "inactive"}
                      tone={connection.isActive ? "success" : "neutral"}
                    />
                  </View>
                  {connection.modelLocks.length > 0 ? (
                    <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>
                      Locked to {connection.modelLocks.join(", ")} — requests to this account answer with that
                      model whatever was asked for.
                    </Text>
                  ) : null}
                  {connection.backoffLevel > 0 ? (
                    <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }}>
                      Backoff level {connection.backoffLevel} — 9router is resting this account.
                    </Text>
                  ) : null}
                  {connection.expiresInMinutes !== null ? (
                    <Text
                      style={{
                        color: expiring ? theme.colors.statusWarning : theme.colors.foregroundMuted,
                        fontSize: 11,
                      }}
                    >
                      {connection.expiresInMinutes < 0
                        ? `Token expired ${Math.abs(connection.expiresInMinutes)}m ago`
                        : `Token valid for ${connection.expiresInMinutes}m`}
                    </Text>
                  ) : null}
                  {connection.lastError ? (
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={2}>
                      {connection.lastError}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </Card>
          {holdCount > 0 ? (
            <Card theme={theme}>
              <Step theme={theme} index={0} title="Parked accounts" hint={`${holdCount}`} />
              <Note theme={theme}>
                9router stops using an account after an error and keeps the hold until it expires. If you have fixed
                the cause, clear it here rather than waiting.
              </Note>
              {(holds.data?.holds ?? []).map((hold, index) => (
                <View key={`${hold.provider}-${hold.connectionName}-${index}`} style={{ gap: 4, padding: 8, borderRadius: 8, backgroundColor: theme.colors.surface2 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", flex: 1 }}>
                      {providerLabel(hold.provider)} · {hold.connectionName}
                    </Text>
                    <Button
                      theme={theme}
                      label="Clear"
                      busy={clearHoldMutation.isPending}
                      onPress={() => clearHoldMutation.mutate({ provider: hold.provider, model: hold.model, connectionId: hold.connectionId })}
                    />
                  </View>
                  {hold.lastError ? (
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }} numberOfLines={3}>
                      {hold.lastError}
                    </Text>
                  ) : null}
                </View>
              ))}
            </Card>
          ) : null}

          <Card theme={theme}>
            <Step theme={theme} index={0} title="Connected" hint={`${data?.connections.length ?? 0}`} />
            {!live ? <Note theme={theme} tone="warning">Finish Setup first — accounts need the dashboard password.</Note> : null}
            {live && (data?.connections.length ?? 0) === 0 ? (
              <Note theme={theme}>No accounts yet. Connect one below, or add any other provider from the dashboard.</Note>
            ) : null}
            {[...byProvider.entries()].map(([provider, list]) => (
              <View key={provider} style={{ gap: 8 }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700" }}>
                  {providerLabel(provider)} · {list.length}
                </Text>
                {list.map((connection) => (
                  <View
                    key={connection.id}
                    style={{ borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, padding: 10, gap: 6, backgroundColor: theme.colors.surface0 }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>{connection.name}</Text>
                      <Chip theme={theme} label={`#${connection.priority}`} />
                      {connection.usage?.plan ? <Chip theme={theme} label={connection.usage.plan} /> : null}
                      {connection.usage?.limitReached ? <Chip theme={theme} label="limit reached" tone="danger" /> : null}
                    </View>
                    {(connection.usage?.quotas ?? []).map((quota) => (
                      <QuotaBar key={quota.label} theme={theme} quota={quota} />
                    ))}
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      {confirmRemove === connection.id ? (
                        <>
                          <Button
                            theme={theme}
                            label="Really remove"
                            tone="danger"
                            busy={removeMutation.isPending}
                            onPress={() => {
                              removeMutation.mutate({ id: connection.id });
                              setConfirmRemove(null);
                            }}
                          />
                          <Button theme={theme} label="Cancel" onPress={() => setConfirmRemove(null)} />
                        </>
                      ) : (
                        <Button theme={theme} label="Remove" onPress={() => setConfirmRemove(connection.id)} />
                      )}
                    </View>
                  </View>
                ))}
              </View>
            ))}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Button theme={theme} label="Connect Claude" disabled={!live} busy={connectMutation.isPending && connectMutation.variables === "claude"} onPress={() => connectMutation.mutate("claude")} />
              <Button theme={theme} label="Connect Codex" disabled={!live} busy={connectMutation.isPending && connectMutation.variables === "codex"} onPress={() => connectMutation.mutate("codex")} />
              <Button theme={theme} label="More in dashboard" onPress={openDashboard} />
            </View>
            {signIn ? (
              <View style={{ gap: 8, padding: 10, borderRadius: 8, backgroundColor: theme.colors.surface2 }}>
                <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
                  Signing in to {signIn.provider === "claude" ? "Claude" : "Codex"}
                </Text>
                <Note theme={theme}>
                  {signIn.mode === "poll"
                    ? "Finish the sign-in in your browser, then press Check."
                    : "Approve in your browser, copy the code it shows, and paste it below."}
                </Note>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  <Button theme={theme} label="Copy link" onPress={() => Clipboard.setString(signIn.authUrl)} />
                  {signIn.mode === "paste-code" ? (
                    <Field theme={theme} value={pasted} onChangeText={setPasted} placeholder="paste code or callback URL" />
                  ) : null}
                  <Button theme={theme} label={signIn.mode === "poll" ? "Check" : "Finish"} tone="primary" busy={finishMutation.isPending} onPress={() => finishMutation.mutate()} />
                  <Button theme={theme} label="Cancel" onPress={() => setSignIn(null)} />
                </View>
              </View>
            ) : null}
          </Card>
        </>
      ) : null}

      {/* ------------------------------------------------------------ MODELS */}
      {tab === "models" ? (
        <>
          <Card theme={theme}>
            <Step theme={theme} index={0} title="In Paseo's picker" hint={data?.paseo.modelsInSync ? "in sync" : undefined} />
            <Note theme={theme}>
              Sync writes a single 9Router provider carrying every model 9router serves — Claude, Codex, and every
              other connected pool — because 9router translates them all into one wire format. Paseo's own Claude and
              Codex providers also keep their matching models, so a chat pinned to one of those keeps working.
            </Note>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <Chip theme={theme} label={`${data?.paseo.listedModels.claude.length ?? 0} Claude`} tone={data?.paseo.listedModels.claude.length ? "success" : "neutral"} />
              <Chip theme={theme} label={`${data?.paseo.listedModels.codex.length ?? 0} Codex`} tone={data?.paseo.listedModels.codex.length ? "success" : "neutral"} />
              <Button theme={theme} label="Refresh catalogue" disabled={!data?.running} busy={catalogSyncMutation.isPending} onPress={() => catalogSyncMutation.mutate({})} />
              <Button theme={theme} label="Sync into Paseo" tone="primary" disabled={!data?.running} busy={syncMutation.isPending} onPress={() => syncMutation.mutate({})} />
            </View>
            {(data?.paseo.staleProviders.length ?? 0) > 0 ? (
              <Note theme={theme} tone="warning">Old provider entries still present: {data?.paseo.staleProviders.join(", ")} — Sync removes them.</Note>
            ) : null}
            <Note theme={theme}>
              Sync publishes a snapshot. If 9router has learned a model since the last one, press Refresh
              catalogue first — otherwise the new model stays invisible to Paseo however often you sync.
            </Note>
            <Note theme={theme}>
              {(syncSelection.data?.selected.length ?? 0) === 0
                ? `Syncing all ${data?.models.count ?? 0} models. Tap below to choose a shorter list instead.`
                : `Syncing ${syncSelection.data?.selected.length} chosen model(s).`}
            </Note>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {(data?.models.ids ?? []).slice(0, 60).map((id) => {
                  const chosen = syncSelection.data?.selected.includes(id) ?? false;
                  return (
                    <Pressable
                      key={id}
                      onPress={() => {
                        const current = syncSelection.data?.selected ?? [];
                        const next = chosen ? current.filter((entry) => entry !== id) : [...current, id];
                        selectionMutation.mutate({ selected: next });
                      }}
                      style={{
                        paddingHorizontal: 8,
                        paddingVertical: 4,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: chosen ? theme.colors.accent : theme.colors.border,
                        backgroundColor: chosen ? theme.colors.accent : "transparent",
                      }}
                    >
                      <Text style={{ color: chosen ? theme.colors.accentForeground : theme.colors.foregroundMuted, fontSize: 11 }}>{id}</Text>
                    </Pressable>
                  );
                })}
            </View>
            {(syncSelection.data?.selected.length ?? 0) > 0 ? (
              <Button theme={theme} label="Sync everything instead" onPress={() => selectionMutation.mutate({ selected: [] })} />
            ) : null}
          </Card>

          <Card theme={theme}>
            <Step theme={theme} index={0} title="Available" hint={`${data?.models.count ?? 0}`} />
            {grouped.map((group) => (
              <View key={group.prefix} style={{ gap: 4 }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700" }}>
                  {group.label} · {group.ids.length}
                </Text>
                {group.ids.slice(0, 8).map((id) => (
                  <View key={id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, flex: 1 }} numberOfLines={1}>
                      {id}
                    </Text>
                    <Button
                      theme={theme}
                      label="Test"
                      busy={testMutation.isPending && testMutation.variables?.model === id}
                      onPress={() => testMutation.mutate({ model: id })}
                    />
                  </View>
                ))}
                {group.ids.length > 8 ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>+{group.ids.length - 8} more in the dashboard</Text>
                ) : null}
              </View>
            ))}
            {testResult ? (
              <View style={{ padding: 8, borderRadius: 8, backgroundColor: theme.colors.surface2, gap: 3 }}>
                <Text style={{ color: testResult.ok ? theme.colors.statusSuccess : theme.colors.statusDanger, fontSize: 12, fontWeight: "600" }}>
                  {testResult.ok ? "✓" : "✗"} {testResult.model}
                </Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{testResult.message}</Text>
              </View>
            ) : null}
          </Card>

          <Card theme={theme}>
            <Step theme={theme} index={0} title="Expose a model" />
            <Note theme={theme}>
              9router ships a fixed catalogue, so a model it does not know yet is invisible until you add it — this is
              how cc/claude-fable-5-1 got here.
            </Note>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Field theme={theme} value={exposeAlias} onChangeText={setExposeAlias} placeholder="cc" />
              <Field theme={theme} value={exposeId} onChangeText={setExposeId} placeholder="claude-fable-5-1" />
              <Field theme={theme} value={exposeName} onChangeText={setExposeName} placeholder="Claude Fable 5.1" />
              <Button
                theme={theme}
                label="Expose"
                busy={exposeMutation.isPending}
                disabled={!live || !exposeAlias || !exposeId}
                onPress={() => {
                  exposeMutation.mutate({ providerAlias: exposeAlias, id: exposeId, ...(exposeName ? { name: exposeName } : {}) });
                  setExposeId("");
                  setExposeName("");
                }}
              />
            </View>
            {(data?.models.custom.length ?? 0) > 0 ? (
              <Note theme={theme}>Custom: {data?.models.custom.map((model) => `${model.providerAlias}/${model.id}`).join(", ")}</Note>
            ) : null}
          </Card>

          <Card theme={theme}>
            <Step theme={theme} index={0} title="Aliases" />
            <Note theme={theme}>
              Map a plain model name onto a 9router model. With one of these, Paseo's stock picker entries route
              through 9router without listing anything.
            </Note>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Field theme={theme} value={aliasFrom} onChangeText={setAliasFrom} placeholder="claude-opus-5" />
              <Field theme={theme} value={aliasTo} onChangeText={setAliasTo} placeholder="cc/claude-opus-5" />
              <Button
                theme={theme}
                label="Add"
                busy={aliasSetMutation.isPending}
                disabled={!live || !aliasFrom || !aliasTo}
                onPress={() => {
                  aliasSetMutation.mutate({ alias: aliasFrom, model: aliasTo });
                  setAliasFrom("");
                  setAliasTo("");
                }}
              />
            </View>
            {(data?.aliases ?? []).map((alias) => (
              <View key={alias.alias} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, flex: 1 }} numberOfLines={1}>
                  {alias.alias} → {alias.model}
                </Text>
                <Button theme={theme} label="Remove" onPress={() => aliasRemoveMutation.mutate({ alias: alias.alias })} />
              </View>
            ))}
          </Card>

          <Card theme={theme}>
            <Step theme={theme} index={0} title="Combos" hint={`${data?.combos.length ?? 0}`} />
            <Note theme={theme}>
              A combo is an ordered fallback list that behaves like one model. Build one from the models listed in
              Paseo and it survives an exhausted account without you choosing again.
            </Note>
            {(data?.combos ?? []).map((combo) => (
              <Text key={combo.name} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                {combo.name}: {combo.models.join(" → ")}
              </Text>
            ))}
            <Note theme={theme}>Combos are built in the dashboard, where you can order and name them properly.</Note>
            <Button theme={theme} label="Open dashboard" onPress={openDashboard} />
          </Card>
        </>
      ) : null}



      {/* -------------------------------------------------------------- KEYS */}
      {tab === "keys" ? (
        <>
          <Card theme={theme}>
            <Step theme={theme} index={0} title="API keys" hint={`${keys.data?.keys.length ?? 0}`} />
            <Note theme={theme}>
              Anything pointed at {data?.url}/v1 authenticates with one of these. Give each tool its own, so revoking
              one does not sign the others out.
            </Note>
            {!live ? <Note theme={theme} tone="warning">Finish Setup first.</Note> : null}
            {(keys.data?.keys ?? []).map((entry) => (
              <View
                key={entry.id}
                style={{ borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, padding: 10, gap: 6, backgroundColor: theme.colors.surface0 }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>{entry.name}</Text>
                  <Chip theme={theme} label={`···${entry.last4}`} />
                  {!entry.isActive ? <Chip theme={theme} label="inactive" tone="warning" /> : null}
                </View>
                <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                  <Button theme={theme} label="Copy key" busy={keyRevealMutation.isPending} onPress={() => keyRevealMutation.mutate({ id: entry.id })} />
                  {confirmDelete === entry.id ? (
                    <>
                      <Button
                        theme={theme}
                        label="Really delete"
                        tone="danger"
                        busy={keyDeleteMutation.isPending}
                        onPress={() => {
                          keyDeleteMutation.mutate({ id: entry.id });
                          setConfirmDelete(null);
                        }}
                      />
                      <Button theme={theme} label="Cancel" onPress={() => setConfirmDelete(null)} />
                    </>
                  ) : (
                    <Button theme={theme} label="Delete" onPress={() => setConfirmDelete(entry.id)} />
                  )}
                </View>
              </View>
            ))}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Field theme={theme} value={keyName} onChangeText={setKeyName} placeholder="name, e.g. Zed" />
              <Button
                theme={theme}
                label="Create key"
                busy={keyCreateMutation.isPending}
                disabled={!live || !keyName}
                onPress={() => {
                  keyCreateMutation.mutate({ name: keyName });
                  setKeyName("");
                }}
              />
            </View>
          </Card>

          <Card theme={theme}>
            <Step theme={theme} index={0} title="Combos" hint={`${combos.data?.combos.length ?? 0}`} />
            <Note theme={theme}>
              A combo is an ordered fallback list that behaves like a single model: when the first is exhausted or
              erroring, 9router moves down the list without you choosing again.
            </Note>
            {(combos.data?.combos ?? []).map((combo) => (
              <View
                key={combo.id}
                style={{ borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, padding: 10, gap: 6, backgroundColor: theme.colors.surface0 }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>{combo.name}</Text>
                  {combo.kind ? <Chip theme={theme} label={combo.kind} /> : null}
                  <Button theme={theme} label="Delete" busy={comboDeleteMutation.isPending} onPress={() => comboDeleteMutation.mutate({ id: combo.id })} />
                </View>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{combo.models.join("  →  ")}</Text>
              </View>
            ))}
            <Note theme={theme}>Build one by tapping models in order, first choice first.</Note>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {(data?.models.ids ?? [])
                .filter((id) => cliForModel(id) !== "other")
                .slice(0, 24)
                .map((id) => {
                  const position = comboModels.indexOf(id);
                  return (
                    <Pressable
                      key={id}
                      onPress={() =>
                        setComboModels((current) =>
                          current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
                        )
                      }
                      style={{
                        paddingHorizontal: 8,
                        paddingVertical: 4,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: position >= 0 ? theme.colors.accent : theme.colors.border,
                        backgroundColor: position >= 0 ? theme.colors.accent : "transparent",
                      }}
                    >
                      <Text style={{ color: position >= 0 ? theme.colors.accentForeground : theme.colors.foregroundMuted, fontSize: 11 }}>
                        {position >= 0 ? `${position + 1}. ` : ""}
                        {id}
                      </Text>
                    </Pressable>
                  );
                })}
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Field theme={theme} value={comboName} onChangeText={setComboName} placeholder="combo name" />
              <Button
                theme={theme}
                label={`Save combo (${comboModels.length})`}
                tone="primary"
                busy={comboSaveMutation.isPending}
                disabled={!live || !comboName || comboModels.length === 0}
                onPress={() => {
                  comboSaveMutation.mutate({ name: comboName, models: comboModels });
                  setComboName("");
                  setComboModels([]);
                }}
              />
              {comboModels.length > 0 ? <Button theme={theme} label="Clear" onPress={() => setComboModels([])} /> : null}
            </View>
          </Card>
        </>
      ) : null}

      {/* ------------------------------------------------------------ TUNING */}
      {tab === "tuning" ? (
        <>
          <Card theme={theme}>
            <Step theme={theme} index={0} title="Token savers" />
            <Note theme={theme}>
              These rewrite what reaches the model, so they trade fidelity for tokens. 9router applies them to every
              request it routes — including this chat, once a CLI is routed.
            </Note>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Button theme={theme} label="RTK" onPress={() => openLink("https://github.com/rtk-ai/rtk")} />
              <Button theme={theme} label="Caveman" onPress={() => openLink("https://github.com/JuliusBrussee/caveman")} />
              <Button theme={theme} label="Ponytail" onPress={() => openLink("https://github.com/DietrichGebert/ponytail")} />
              <Button theme={theme} label="Token savers in the dashboard" onPress={() => openLink(`${data?.url ?? ""}/dashboard/token-saver`)} />
            </View>
            {!live ? <Note theme={theme} tone="warning">Finish Setup first.</Note> : null}
            {tuning.isLoading ? <ActivityIndicator color={theme.colors.accent} /> : null}
            {tuning.data ? (
              <View style={{ gap: 12 }}>
                <Toggle
                  theme={theme}
                  label="RTK"
                  hint="Compresses tool output (git diff, grep, build logs) before it is sent. Usually the cheapest win. — github.com/rtk-ai/rtk"
                  on={tuning.data.rtkEnabled}
                  busy={tuningMutation.isPending}
                  disabled={!live}
                  onToggle={() => tuningMutation.mutate({ rtkEnabled: !tuning.data.rtkEnabled })}
                />
                <Toggle
                  theme={theme}
                  label={`Caveman (${tuning.data.cavemanLevel})`}
                  hint="Rewrites the system prompt in terse english. Saves a lot, and changes how the model writes. — github.com/JuliusBrussee/caveman"
                  on={tuning.data.cavemanEnabled}
                  busy={tuningMutation.isPending}
                  disabled={!live}
                  onToggle={() => tuningMutation.mutate({ cavemanEnabled: !tuning.data.cavemanEnabled })}
                />
                {tuning.data.cavemanEnabled ? (
                  <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                    {["lite", "full"].map((level) => (
                      <Button
                        key={level}
                        theme={theme}
                        label={level}
                        tone={tuning.data.cavemanLevel === level ? "primary" : "default"}
                        disabled={!live}
                        onPress={() => tuningMutation.mutate({ cavemanLevel: level })}
                      />
                    ))}
                  </View>
                ) : null}
                <Toggle
                  theme={theme}
                  label={`Ponytail (${tuning.data.ponytailLevel})`}
                  hint="Injects a YAGNI-first coding style so replies stay short. — github.com/DietrichGebert/ponytail"
                  on={tuning.data.ponytailEnabled}
                  busy={tuningMutation.isPending}
                  disabled={!live}
                  onToggle={() => tuningMutation.mutate({ ponytailEnabled: !tuning.data.ponytailEnabled })}
                />
                <Toggle
                  theme={theme}
                  label="Headroom"
                  hint={`Context compression through a separate service at ${tuning.data.headroomUrl}. Needs that service running.`}
                  on={tuning.data.headroomEnabled}
                  busy={tuningMutation.isPending}
                  disabled={!live}
                  onToggle={() => tuningMutation.mutate({ headroomEnabled: !tuning.data.headroomEnabled })}
                />
              </View>
            ) : null}
          </Card>

          {tuning.data ? (
            <Card theme={theme}>
              <Step theme={theme} index={0} title="Routing" />
              <Note theme={theme}>
                How 9router picks among the accounts in a pool, and how a combo falls through its list.
              </Note>
              <View style={{ gap: 5 }}>
                <Row theme={theme} label="Combo strategy" value={tuning.data.comboStrategy} />
                <Row theme={theme} label="Sticky round-robin limit" value={String(tuning.data.stickyRoundRobinLimit)} />
                <Row theme={theme} label="API key required on /v1" value={tuning.data.requireApiKey ? "yes" : "no"} tone={tuning.data.requireApiKey ? "success" : "warning"} />
              </View>
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                {["fallback", "roundrobin"].map((strategy) => (
                  <Button
                    key={strategy}
                    theme={theme}
                    label={strategy}
                    tone={tuning.data.comboStrategy === strategy ? "primary" : "default"}
                    disabled={!live}
                    onPress={() => tuningMutation.mutate({ comboStrategy: strategy })}
                  />
                ))}
              </View>
              <Note theme={theme}>Per-provider strategies and capacity adapters live in the dashboard.</Note>
              <Button theme={theme} label="Open dashboard" onPress={openDashboard} />
            </Card>
          ) : null}
        </>
      ) : null}

      {/* -------------------------------------------------------------- LOGS */}
      {tab === "logs" ? (
        <>
          <Card theme={theme}>
            <Step
              theme={theme}
              index={0}
              title="Failed requests"
              hint={requestLogs.data ? `${requestLogs.data.requests.length}` : undefined}
            />
            <Note theme={theme}>
              The console below is 9router talking to itself; this is the request as the caller saw it. A model
              that "does not work" usually has one row here with the status and the upstream reason.
            </Note>
            {requestLogs.isLoading ? <ActivityIndicator color={theme.colors.accent} /> : null}
            {(requestLogs.data?.requests.length ?? 0) === 0 && !requestLogs.isLoading ? (
              <Note theme={theme}>No failed requests recorded.</Note>
            ) : null}
            {(requestLogs.data?.requests ?? []).map((request, index) => (
              <View
                key={`${request.id}-${index}`}
                style={{ gap: 2, padding: 8, borderRadius: 8, backgroundColor: theme.colors.surface2 }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", flex: 1 }}>
                    {request.model || "unknown model"}
                  </Text>
                  {request.status !== null ? (
                    <Chip theme={theme} label={`${request.status}`} tone="danger" />
                  ) : null}
                </View>
                {request.error ? (
                  <Text style={{ color: theme.colors.statusWarning, fontSize: 11 }} numberOfLines={3}>
                    {request.error}
                  </Text>
                ) : null}
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
                  {[request.at, request.provider, request.latencyMs !== null ? `${request.latencyMs}ms` : ""]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </View>
            ))}
          </Card>
          <Card theme={theme}>
          <Step theme={theme} index={0} title="9router console" hint={logs.data ? `${logs.data.lines.length} lines` : undefined} />
          <Note theme={theme}>
            Live from 9router, newest last, refreshed every 4s. This is where a routing failure explains itself — the
            account it chose, the upstream error, what RTK saved.
          </Note>
          {!live ? <Note theme={theme} tone="warning">Finish Setup first.</Note> : null}
          {logs.isLoading ? <ActivityIndicator color={theme.colors.accent} /> : null}
          <View style={{ backgroundColor: theme.colors.surface0, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, padding: 8, gap: 2 }}>
            {(logs.data?.lines ?? []).slice(-120).map((line, index) => (
              <Text
                key={`${index}-${line.slice(0, 24)}`}
                style={{
                  color: /error|failed|✗|⚠/i.test(line)
                    ? theme.colors.statusDanger
                    : /DONE|✓/i.test(line)
                      ? theme.colors.statusSuccess
                      : theme.colors.foregroundMuted,
                  fontSize: 10,
                  fontFamily: "Menlo",
                }}
              >
                {line}
              </Text>
            ))}
            {(logs.data?.lines.length ?? 0) === 0 && !logs.isLoading ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Nothing logged yet.</Text>
            ) : null}
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button theme={theme} label="Refresh" busy={logs.isFetching} onPress={() => void logs.refetch()} />
            <Button
              theme={theme}
              label="Copy"
              onPress={() => {
                Clipboard.setString((logs.data?.lines ?? []).join("\n"));
                setMessage("Console copied.");
              }}
            />
          </View>
          </Card>
        </>
      ) : null}


      {/* ---------------------------------------------------------- POWER-UPS */}
      {tab === "powerups" ? (
        <Card theme={theme}>
          <Step theme={theme} index={0} title="Power-ups" />
          <Note theme={theme}>
            These change software this plugin does not own. Each one is reversible here and re-checked from disk every
            time this tab opens, because a package upgrade silently undoes them.
          </Note>
          {powerUps.isLoading ? <ActivityIndicator color={theme.colors.accent} /> : null}
          {(powerUps.data?.powerUps ?? []).map((entry) => (
            <View
              key={entry.id}
              style={{ borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, padding: 10, gap: 6, backgroundColor: theme.colors.surface0 }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>{entry.title}</Text>
                {entry.action === "toggle" ? (
                  <Chip theme={theme} label={entry.applied ? "applied" : "not applied"} tone={entry.applied ? "success" : "neutral"} />
                ) : null}
                <Button
                  theme={theme}
                  label={entry.action === "run" ? "Run" : entry.applied ? "Revert" : "Apply"}
                  tone={entry.action === "run" || !entry.applied ? "primary" : "default"}
                  disabled={!entry.available}
                  busy={powerUpMutation.isPending && powerUpMutation.variables?.id === entry.id}
                  onPress={() => powerUpMutation.mutate({ id: entry.id, apply: !entry.applied })}
                />
              </View>
              <Note theme={theme}>{entry.detail}</Note>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{entry.status}</Text>
              <Note theme={theme} tone="warning">{entry.caution}</Note>
            </View>
          ))}
          <Note theme={theme}>
            Background on the version gate: platform.claude.com/docs/en/models/fable-5-1/migration-guide and
            github.com/decolua/9router/issues/3711
          </Note>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button theme={theme} label="Migration guide" onPress={() => openLink("https://platform.claude.com/docs/en/models/fable-5-1/migration-guide")} />
            <Button theme={theme} label="9router issue 3711" onPress={() => openLink("https://github.com/decolua/9router/issues/3711")} />
          </View>
        </Card>
      ) : null}

      {/* ------------------------------------------------------------- USAGE */}
      {tab === "usage" ? (
        <>
          <Card theme={theme}>
            <Step theme={theme} index={0} title="Totals" hint="since install" />
            {!live ? <Note theme={theme} tone="warning">Finish Setup first — usage needs the dashboard password.</Note> : null}
            {usage.isLoading ? <ActivityIndicator color={theme.colors.accent} /> : null}
            {usage.data ? (
              <View style={{ gap: 5 }}>
                <Row theme={theme} label="Requests" value={usage.data.totalRequests.toLocaleString()} />
                <Row theme={theme} label="Cost (what these would have cost on API pricing)" value={`$${usage.data.totalCost.toFixed(2)}`} />
                <Row theme={theme} label="Prompt tokens" value={usage.data.totalPromptTokens.toLocaleString()} />
                <Row theme={theme} label="Cached tokens" value={usage.data.totalCachedTokens.toLocaleString()} />
                <Row theme={theme} label="Completion tokens" value={usage.data.totalCompletionTokens.toLocaleString()} />
              </View>
            ) : null}
          </Card>

          {usage.data && usage.data.byProvider.length > 0 ? (
            <Card theme={theme}>
              <Step theme={theme} index={0} title="By provider" />
              {usage.data.byProvider.map((entry) => (
                <Row key={entry.provider} label={providerLabel(entry.provider)} theme={theme} value={`${entry.requests} req · $${entry.cost.toFixed(2)}`} />
              ))}
            </Card>
          ) : null}

          {usage.data && usage.data.byModel.length > 0 ? (
            <Card theme={theme}>
              <Step theme={theme} index={0} title="By model" hint="top 12" />
              {usage.data.byModel.map((entry) => (
                <Row key={entry.model} label={entry.model} theme={theme} value={`${entry.requests} req · $${entry.cost.toFixed(2)}`} />
              ))}
            </Card>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}
