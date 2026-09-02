import type { PluginSurfaceProps, PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
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
} from "./contracts.shared";
import { formatReset, groupModelIds, parseOauthPaste, providerLabel, quotaTone } from "./router.logic";

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

  const status = useQuery({
    queryKey: ["agent-link", "router-status"],
    queryFn: () => callStatus({}),
    refetchInterval: 15_000,
  });

  const [message, setMessage] = useState<string>("");
  const [showSettings, setShowSettings] = useState(false);
  const [url, setUrl] = useState("");
  const [password, setPassword] = useState("");
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

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["agent-link", "router-status"] });
  const run = <Input, Output extends { message?: string; ok?: boolean }>(fn: (input: Input) => Promise<Output>) =>
    useMutation({
      mutationFn: fn,
      onSuccess: (result) => {
        if (result?.message) setMessage(result.message);
        refresh();
      },
      onError: (error: unknown) => setMessage(error instanceof Error ? error.message : String(error)),
    });

  const startMutation = run(callStart);
  const saveMutation = run(callSaveSettings);
  const routeMutation = run(callRouteCli);
  const syncMutation = run(callSyncModels);
  const removeMutation = run(callRemoveConnection);
  const exposeMutation = run(callExpose);
  const aliasSetMutation = run(callAliasSet);
  const aliasRemoveMutation = run(callAliasRemove);

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
      const done = result.ok === true || result.status === "done";
      if (done) {
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

  const data = status.data;
  const busy = status.isLoading && !data;
  const gap = layout.compact ? 8 : 12;

  if (busy) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  const hijackFor = (cli: "claude" | "codex"): CliHijack | undefined => data?.hijack.find((entry) => entry.cli === cli);
  const grouped = groupModelIds(data?.models.ids ?? []);
  const byProvider = new Map<string, Connection[]>();
  for (const connection of data?.connections ?? []) {
    const list = byProvider.get(connection.provider) ?? [];
    list.push(connection);
    byProvider.set(connection.provider, list);
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: gap + 4 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "700", marginBottom: 4 }}>AgentLink</Text>
      <Note theme={theme}>
        Your accounts, quotas and fallback live in 9router. This panel sets it up and points Paseo's Claude and Codex
        providers at it.
      </Note>
      {message ? (
        <View style={{ marginTop: 10, padding: 10, borderRadius: 8, backgroundColor: theme.colors.surface2 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{message}</Text>
        </View>
      ) : null}

      <View style={{ height: gap }} />

      {/* 1 — 9router itself */}
      <Card theme={theme}>
        <Step theme={theme} index={1} title="9router" hint={data?.version ? `v${data.version.current}` : undefined} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <Chip theme={theme} label={data?.binary.path ? "installed" : "not installed"} tone={data?.binary.path ? "success" : "danger"} />
          <Chip theme={theme} label={data?.running ? "running" : "stopped"} tone={data?.running ? "success" : "warning"} />
          {data?.auth.ok ? <Chip theme={theme} label="signed in" tone="success" /> : <Chip theme={theme} label="dashboard login needed" tone="warning" />}
          {data?.apiKey.present ? <Chip theme={theme} label={`key ···${data.apiKey.last4 ?? ""}`} /> : <Chip theme={theme} label="no api key" tone="warning" />}
          {data?.version?.hasUpdate ? <Chip theme={theme} label={`update ${data.version.latest}`} tone="warning" /> : null}
        </View>
        {!data?.binary.path ? <Note theme={theme}>Install it first: npm i -g 9router</Note> : null}
        {data?.auth.error ? <Note theme={theme} tone="warning">{data.auth.error}</Note> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {!data?.running ? (
            <Button theme={theme} label="Start 9router" tone="primary" busy={startMutation.isPending} onPress={() => startMutation.mutate({})} />
          ) : null}
          <Button
            theme={theme}
            label="Open dashboard"
            onPress={() => {
              const target = data?.dashboardUrl ?? "";
              Clipboard.setString(target);
              setMessage(`Dashboard URL copied. Open a Paseo browser tab (⌘⇧B) and paste it — ${target}`);
            }}
          />
          <Button theme={theme} label={showSettings ? "Hide settings" : "Settings"} onPress={() => setShowSettings((open) => !open)} />
        </View>
        {showSettings ? (
          <View style={{ gap: 8 }}>
            <Note theme={theme}>Saved at {data?.settingsPath}. The password is only used for 9router's own API.</Note>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Field theme={theme} value={url} onChangeText={setUrl} placeholder={data?.url ?? "http://127.0.0.1:20128"} />
              <Field theme={theme} value={password} onChangeText={setPassword} placeholder="dashboard password" secure />
              <Button
                theme={theme}
                label="Save"
                tone="primary"
                busy={saveMutation.isPending}
                onPress={() => {
                  saveMutation.mutate({ ...(url ? { url } : {}), ...(password ? { password } : {}) });
                  setPassword("");
                }}
              />
            </View>
          </View>
        ) : null}
      </Card>

      {/* 2 — accounts */}
      <Card theme={theme}>
        <Step theme={theme} index={2} title="Accounts" hint={`${data?.connections.length ?? 0} connected`} />
        {(data?.connections.length ?? 0) === 0 ? (
          <Note theme={theme}>No accounts yet. Connect one below, or add any of 9router's other providers from the dashboard.</Note>
        ) : null}
        {[...byProvider.entries()].map(([provider, list]) => (
          <View key={provider} style={{ gap: 8 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700" }}>{providerLabel(provider)}</Text>
            {list.map((connection) => (
              <View
                key={connection.id}
                style={{
                  borderColor: theme.colors.border,
                  borderWidth: 1,
                  borderRadius: 8,
                  padding: 10,
                  gap: 6,
                  backgroundColor: theme.colors.surface0,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>
                    {connection.name}
                  </Text>
                  <Chip theme={theme} label={`priority ${connection.priority}`} />
                  {connection.usage?.plan ? <Chip theme={theme} label={connection.usage.plan} /> : null}
                  {connection.usage?.limitReached ? <Chip theme={theme} label="limit reached" tone="danger" /> : null}
                  {connection.testStatus ? (
                    <Chip theme={theme} label={connection.testStatus} tone={connection.testStatus === "active" ? "success" : "warning"} />
                  ) : null}
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
          <Button
            theme={theme}
            label="Connect Claude"
            busy={connectMutation.isPending && connectMutation.variables === "claude"}
            onPress={() => connectMutation.mutate("claude")}
          />
          <Button
            theme={theme}
            label="Connect Codex"
            busy={connectMutation.isPending && connectMutation.variables === "codex"}
            onPress={() => connectMutation.mutate("codex")}
          />
        </View>
        {signIn ? (
          <View style={{ gap: 8, padding: 10, borderRadius: 8, backgroundColor: theme.colors.surface2 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
              Signing in to {signIn.provider === "claude" ? "Claude" : "Codex"}
            </Text>
            <Note theme={theme}>
              {signIn.mode === "poll"
                ? "Finish the sign-in in your browser, then check for it here."
                : "Approve in your browser, copy the code it shows, and paste it below."}
            </Note>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Button theme={theme} label="Copy sign-in link" onPress={() => Clipboard.setString(signIn.authUrl)} />
              {signIn.mode === "paste-code" ? (
                <Field theme={theme} value={pasted} onChangeText={setPasted} placeholder="paste code or callback URL" />
              ) : null}
              <Button
                theme={theme}
                label={signIn.mode === "poll" ? "Check" : "Finish"}
                tone="primary"
                busy={finishMutation.isPending}
                onPress={() => finishMutation.mutate()}
              />
              <Button theme={theme} label="Cancel" onPress={() => setSignIn(null)} />
            </View>
          </View>
        ) : null}
      </Card>

      {/* 3 — the hijack */}
      <Card theme={theme}>
        <Step theme={theme} index={3} title="Route the CLIs through 9router" />
        <Note theme={theme}>
          9router rewrites each CLI's own config, so every launch of that binary goes through it — including the ones
          Paseo starts, and every terminal on this machine.
        </Note>
        {(["claude", "codex"] as const).map((cli) => {
          const entry = hijackFor(cli);
          const name = cli === "claude" ? "Claude Code" : "Codex";
          return (
            <View key={cli} style={{ gap: 6 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>{name}</Text>
                {!entry?.installed ? (
                  <Chip theme={theme} label="not installed" tone="warning" />
                ) : (
                  <Chip theme={theme} label={entry.routed ? "through 9router" : "direct"} tone={entry.routed ? "success" : "neutral"} />
                )}
                <Button
                  theme={theme}
                  label={entry?.routed ? "Restore direct" : `Route ${name}`}
                  tone={entry?.routed ? "default" : "primary"}
                  disabled={!entry?.installed || !data?.running}
                  busy={routeMutation.isPending && routeMutation.variables?.cli === cli}
                  onPress={() => routeMutation.mutate({ cli, routed: !entry?.routed })}
                />
              </View>
              {entry?.routed && entry.configPath ? <Note theme={theme}>Writes {entry.configPath}</Note> : null}
            </View>
          );
        })}
      </Card>

      {/* 4 — models in Paseo */}
      <Card theme={theme}>
        <Step theme={theme} index={4} title="Models in Paseo" hint={`${data?.models.count ?? 0} available`} />
        <Note theme={theme}>
          Lists 9router's models on Paseo's own Claude and Codex providers, so they appear in the model picker of a
          normal chat.
        </Note>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <Chip
            theme={theme}
            label={data?.paseo.modelsInSync ? "listed in Paseo" : "not listed yet"}
            tone={data?.paseo.modelsInSync ? "success" : "warning"}
          />
          {(data?.paseo.staleProviders.length ?? 0) > 0 ? (
            <Chip theme={theme} label={`${data?.paseo.staleProviders.length} old provider(s)`} tone="warning" />
          ) : null}
          <Button
            theme={theme}
            label="Sync models into Paseo"
            tone="primary"
            disabled={!data?.running}
            busy={syncMutation.isPending}
            onPress={() => syncMutation.mutate({})}
          />
        </View>
        {grouped.map((group) => (
          <View key={group.prefix} style={{ gap: 3 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700" }}>
              {group.label} · {group.ids.length}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{group.ids.join("  ")}</Text>
          </View>
        ))}
        {(data?.combos.length ?? 0) > 0 ? (
          <Note theme={theme}>Combos: {data?.combos.map((combo) => combo.name).join(", ")}</Note>
        ) : null}

        <View style={{ height: 4 }} />
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>Expose a model</Text>
        <Note theme={theme}>
          9router ships a fixed catalogue. Add one it does not list yet — e.g. cc + claude-fable-5-1.
        </Note>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Field theme={theme} value={exposeAlias} onChangeText={setExposeAlias} placeholder="cc" />
          <Field theme={theme} value={exposeId} onChangeText={setExposeId} placeholder="claude-fable-5-1" />
          <Field theme={theme} value={exposeName} onChangeText={setExposeName} placeholder="Claude Fable 5.1" />
          <Button
            theme={theme}
            label="Expose"
            busy={exposeMutation.isPending}
            disabled={!exposeAlias || !exposeId}
            onPress={() => {
              exposeMutation.mutate({ providerAlias: exposeAlias, id: exposeId, ...(exposeName ? { name: exposeName } : {}) });
              setExposeId("");
              setExposeName("");
            }}
          />
        </View>
        {(data?.models.custom.length ?? 0) > 0 ? (
          <Note theme={theme}>
            Custom: {data?.models.custom.map((model) => `${model.providerAlias}/${model.id}`).join(", ")}
          </Note>
        ) : null}

        <View style={{ height: 4 }} />
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>Aliases</Text>
        <Note theme={theme}>
          Map a plain model name onto a 9router model, so a tool asking for claude-opus-5 reaches the cc/ pool.
        </Note>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Field theme={theme} value={aliasFrom} onChangeText={setAliasFrom} placeholder="claude-opus-5" />
          <Field theme={theme} value={aliasTo} onChangeText={setAliasTo} placeholder="cc/claude-opus-5" />
          <Button
            theme={theme}
            label="Add alias"
            busy={aliasSetMutation.isPending}
            disabled={!aliasFrom || !aliasTo}
            onPress={() => {
              aliasSetMutation.mutate({ alias: aliasFrom, model: aliasTo });
              setAliasFrom("");
              setAliasTo("");
            }}
          />
        </View>
        {(data?.aliases ?? []).map((alias) => (
          <View key={alias.alias} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, flex: 1 }}>
              {alias.alias} → {alias.model}
            </Text>
            <Button theme={theme} label="Remove" onPress={() => aliasRemoveMutation.mutate({ alias: alias.alias })} />
          </View>
        ))}
      </Card>

      <Note theme={theme}>
        Routing a subscription sign-in through a local proxy is outside Anthropic's and OpenAI's consumer terms. That
        choice is yours to make.
      </Note>
    </ScrollView>
  );
}
