import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { accountUsage, addAccount, diagnoseProvider, providerHealth, scan, setCooldown, wireAuto, wireProvider, type Slot } from "./contracts.shared";
import { Badge, Btn, Dot, Meter, Spark, STATUS, makeStyles } from "./ui.client";

export function AgentSyncSurface({ theme, layout }: PluginSurfaceProps) {
  const queryClient = useQueryClient();
  const callScan = useRpc(scan);
  const callWire = useRpc(wireProvider);
  const callDiagnose = useRpc(diagnoseProvider);
  const callHealth = useRpc(providerHealth);
  const callWireAuto = useRpc(wireAuto);
  const callCooldown = useRpc(setCooldown);
  const callAddAccount = useRpc(addAccount);
  const callUsage = useRpc(accountUsage);
  const [diagnosis, setDiagnosis] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [addingFor, setAddingFor] = useState<"claude" | "codex" | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  // Every button inherits the compact (touch) sizing without repeating it.
  const Button = (props: React.ComponentProps<typeof Btn>) => <Btn compact={layout.compact} {...props} />;

  const scanQuery = useQuery({ queryKey: ["superpowers", "scan"], queryFn: () => callScan({}) });
  // Diagnostics spawn a real process per provider — for ACP providers (kimi,
  // grok) that starts an agent session. Only on request, never on mount.
  // Aggregating transcripts costs real IO, so it is on request like health.
  const usageQuery = useQuery({
    queryKey: ["superpowers", "account-usage"],
    queryFn: () => callUsage({ days: 7 }),
    enabled: false,
  });
  const healthQuery = useQuery({
    queryKey: ["superpowers", "provider-health"],
    queryFn: () => callHealth({}),
    enabled: false,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["superpowers"] });

  const wireMutation = useMutation({
    mutationFn: (slot: Slot) => callWire({ provider: slot.provider, email: slot.email, dir: slot.dir }),
    onSuccess: refresh,
  });
  const autoMutation = useMutation({
    mutationFn: (provider: "claude" | "codex") => callWireAuto({ provider }),
    onSuccess: (result) => {
      setNotice(result.message);
      refresh();
    },
  });
  const addMutation = useMutation({
    mutationFn: (input: { provider: "claude" | "codex"; email: string }) => callAddAccount(input),
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
    mutationFn: (input: { provider: "claude" | "codex"; email: string; minutes: number }) => callCooldown(input),
    onSuccess: (result) => {
      setNotice(result.message);
      refresh();
    },
  });

  const slots = scanQuery.data?.slots ?? [];
  const primaries = scanQuery.data?.primaryAccounts;
  const healthById = new Map((healthQuery.data?.providers ?? []).map((provider) => [provider.id, provider]));

  // A rate limit belongs to an ACCOUNT, so two entries signed into the same
  // account are one pool wearing two hats — the failure mode where you think
  // you have a spare pool and don't.
  const accountUses = new Map<string, number>();
  const countAccount = (provider: string, email: string) => {
    if (!email) return;
    const key = `${provider}:${email}`;
    accountUses.set(key, (accountUses.get(key) ?? 0) + 1);
  };
  countAccount("claude", primaries?.claude ?? "");
  countAccount("codex", primaries?.codex ?? "");
  for (const slot of slots) countAccount(slot.provider, slot.actualEmail || slot.email);
  const isShared = (provider: string, email: string) => (accountUses.get(`${provider}:${email}`) ?? 0) > 1;
  const distinctPools = [...accountUses.keys()].length;
  const totalEntries = [...accountUses.values()].reduce((sum, count) => sum + count, 0);

  const tableRow = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    paddingVertical: 4,
    borderTopWidth: 1,
    borderTopColor: theme.colors.foregroundMuted + "1a",
  };

  const maxLaunches = Math.max(1, ...slots.map((entry) => entry.launches));
  const agoLabel = (epoch: number) => {
    const mins = Math.max(0, Math.round((Date.now() - epoch * 1000) / 60000));
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
  };

  const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
  const usageFor = (email: string) => {
    const row = (usageQuery.data?.accounts ?? []).find((entry) => entry.email === email);
    if (!row) return null;
    if (row.sessions === 0) return <Text style={styles.muted}>7 days: no sessions</Text>;
    // Cache reads are input the account did not pay full price for.
    const totalIn = row.inputTokens + row.cacheReadTokens + row.cacheCreationTokens;
    const cachePct = totalIn > 0 ? Math.round((row.cacheReadTokens / totalIn) * 100) : 0;
    return (
      <View style={{ gap: 3 }}>
        <View style={styles.row}>
          <Spark values={row.daily} color={theme.colors.accent} theme={theme} />
          <Text style={styles.muted}>
            {row.sessions} {row.sessions === 1 ? "session" : "sessions"} · {fmt(row.outputTokens)} out · {cachePct}% cached
          </Text>
        </View>
        {row.limitHits > 0 ? (
          <Text style={styles.danger}>
            {row.limitHits} limit {row.limitHits === 1 ? "refusal" : "refusals"} in 7 days
            {row.limitLast > 0 ? ` · last ${agoLabel(row.limitLast)}` : ""} — park it or probe the model
          </Text>
        ) : null}
        <View style={styles.row}>
          {row.models.slice(0, 4).map((model) => (
            <Badge key={model} label={model.replace("claude-", "")} theme={theme} />
          ))}
          {row.topProject ? <Text style={styles.muted}>mostly {row.topProject}</Text> : null}
        </View>
      </View>
    );
  };

  const slotDot = (slot: Slot) => (slot.wrongAccount ? STATUS.red : slot.loggedIn ? STATUS.green : STATUS.orange);

  const diagnoseBtn = (providerId: string, key: string) => (
    <Button
      label="Diagnose"
      kind="quiet"
      theme={theme}
      onPress={() => {
        void callDiagnose({ providerId }).then((result) =>
          setDiagnosis((previous) => ({ ...previous, [key]: previous[key] ? "" : result.summary })),
        );
      }}
    />
  );

  const providerCard = (
    provider: "claude" | "codex" | "kimi" | "grok",
    title: string,
    rows: React.ReactNode,
  ) => {
    const health = healthById.get(provider);
    const auto = (scanQuery.data?.autoRouters ?? []).find((entry) => entry.provider === provider);
    return (
      <View key={provider} style={styles.card}>
        <View style={styles.rowBetween}>
          <View style={styles.row}>
            <Dot color={health ? (health.ok ? STATUS.green : STATUS.red) : theme.colors.foregroundMuted} />
            <Text style={styles.strong}>{title}</Text>
            {health ? (
              <Text style={health.ok ? styles.muted : styles.danger}>{health.summary}</Text>
            ) : (
              <Text style={styles.muted}>{healthQuery.isFetching ? "checking…" : ""}</Text>
            )}
          </View>
          {diagnoseBtn(provider, provider)}
        </View>
        {diagnosis[provider] ? <Text style={styles.monoText}>{diagnosis[provider]}</Text> : null}
        {auto ? (
          accountRow(
            `auto-${provider}`,
            auto.wiredProviderId ? STATUS.green : theme.colors.foregroundMuted,
            "Dynamic Agent Link",
            auto.wiredProviderId
              ? `installed as "${provider === "claude" ? "Claude" : "Codex"} (Dynamic Agent Link)" · new agents rotate across these accounts`
              : auto.launcherExists
                ? `install one provider that rotates new agents across these accounts`
                : "run `agent-link auto` in a terminal to enable",
            false,
            auto.wiredProviderId ? undefined : auto.launcherExists ? (
              <Button label="Install" theme={theme} onPress={() => autoMutation.mutate(provider as "claude" | "codex")} />
            ) : undefined,
          )
        ) : null}
        {rows}
        {provider === "claude" || provider === "codex" ? (
          addingFor === provider ? (
            <View style={{ gap: 6, paddingTop: 6 }}>
              <TextInput
                placeholder={`new ${provider} account email`}
                placeholderTextColor={theme.colors.foregroundMuted}
                value={newEmail}
                onChangeText={setNewEmail}
                autoCapitalize="none"
                style={{
                  borderWidth: 1,
                  borderColor: theme.colors.foregroundMuted + "44",
                  borderRadius: 7,
                  paddingVertical: 6,
                  paddingHorizontal: 9,
                  color: theme.colors.foreground,
                  fontSize: 12,
                }}
              />
              <View style={styles.row}>
                <Button
                  label={addMutation.isPending ? "Starting…" : "Create & sign in"}
                  theme={theme}
                  disabled={addMutation.isPending || !newEmail.trim()}
                  onPress={() => addMutation.mutate({ provider, email: newEmail.trim() })}
                />
                <Button label="Cancel" kind="quiet" theme={theme} onPress={() => setAddingFor(null)} />
              </View>
              <Text style={styles.muted}>
Creates the slot and gives you the one command to finish the browser sign-in — that step needs a terminal because the CLI asks you to paste a code back.
              </Text>
            </View>
          ) : (
            <View style={tableRow}>
              <Text style={[styles.muted, { flex: 1 }]}>Add another account to this provider</Text>
              <Button label="+ Add account" kind="quiet" theme={theme} onPress={() => { setAddingFor(provider); setNewEmail(""); }} />
            </View>
          )
        ) : null}
      </View>
    );
  };

  // Two lines per account: who it is on top, everything else muted underneath.
  // Badges used to squeeze the email out of the row entirely on a narrow panel.
  const accountRow = (
    key: string,
    dot: string,
    email: string,
    meta: string,
    warn: boolean,
    action?: React.ReactNode,
    extra?: React.ReactNode,
    usage?: React.ReactNode,
  ) => (
    <View key={key} style={{ paddingVertical: 6, borderTopWidth: 1, borderTopColor: theme.colors.foregroundMuted + "1a" }}>
      <View style={styles.rowBetween}>
        <View style={[styles.row, { flexShrink: 1 }]}>
          <Dot color={dot} />
          <Text style={[styles.strong, { flexShrink: 1 }]} numberOfLines={1}>
            {email}
          </Text>
        </View>
        {action}
      </View>
      <View style={[styles.row, { paddingLeft: 17 }]}>
        <Text style={warn ? styles.danger : styles.muted}>{meta}</Text>
        {extra}
      </View>
      {usage}
    </View>
  );

  const slotRow = (slot: Slot) => {
    const shared = slot.loggedIn && isShared(slot.provider, slot.actualEmail || slot.email);
    const parked = slot.cooldownUntil > 0;
    const bits: string[] = [];
    if (!slot.loggedIn) bits.push("login needed");
    else if (slot.wrongAccount) bits.push(`signed in as ${slot.actualEmail}`);
    else if (parked)
      bits.push(
        `parked ${Math.max(1, Math.round((slot.cooldownUntil * 1000 - Date.now()) / 60000))}m — ${
          slot.parkReason || "routing skips it"
        }`,
      );
    else bits.push("in rotation");
    if (slot.source === "external") bits.push("external folder");
    if (slot.wiredProviderId) bits.push(`provider: ${slot.wiredProviderId}`);
    if (shared) bits.push("shares one quota with another entry");
    if (slot.creditNote) bits.push(slot.creditNote);
    if (slot.settingsDrift.length > 0) bits.push(`settings differ from primary: ${slot.settingsDrift.join(", ")} — press Sync`);
    else if (slot.outputStyle) bits.push(`style: ${slot.outputStyle}`);
    return accountRow(
      slot.dir,
      slotDot(slot),
      slot.email,
      bits.join(" · "),
      shared || slot.wrongAccount || !slot.loggedIn || slot.creditNote !== "",
      slot.loggedIn ? (
        <Button
          label={parked ? "Resume" : "Park 3h"}
          kind="quiet"
          theme={theme}
          onPress={() =>
            cooldownMutation.mutate({ provider: slot.provider, email: slot.email, minutes: parked ? 0 : 180 })
          }
        />
      ) : undefined,
      slot.wiredProviderId ? diagnoseBtn(slot.wiredProviderId, slot.dir) : undefined,
      slot.loggedIn ? (
        <View style={{ paddingLeft: 17, paddingTop: 2, gap: 3 }}>
        <View style={styles.row}>
          <Meter
            fraction={maxLaunches > 0 ? slot.launches / maxLaunches : 0}
            color={parked ? STATUS.orange : theme.colors.accent}
            theme={theme}
          />
          <Text style={styles.muted}>
            {slot.launches} {slot.launches === 1 ? "launch" : "launches"}
            {slot.lastUsed > 0 ? ` · ${agoLabel(slot.lastUsed)}` : ""}
          </Text>
        </View>
        {usageFor(slot.actualEmail || slot.email)}
        </View>
      ) : undefined,
    );
  };

  const primaryRow = (provider: "claude" | "codex") => {
    const info = (scanQuery.data?.primaries ?? []).find((entry) => entry.provider === provider);
    const account = (provider === "claude" ? primaries?.claude : primaries?.codex) ?? "";
    const shared = account !== "" && isShared(provider, account);
    const parked = (info?.cooldownUntil ?? 0) > 0;
    const bits = [`primary — what plain \`${provider}\` uses`];
    if (info?.duplicated) bits.push("duplicated by an account below");
    else if (parked)
      bits.push(`parked ${Math.max(1, Math.round(((info?.cooldownUntil ?? 0) * 1000 - Date.now()) / 60000))}m — routing skips it`);
    else bits.push(`in rotation · ${info?.launches ?? 0} launches`);
    if (shared) bits.push("shares one quota with an account below");
    const credit = provider === "claude" ? (scanQuery.data?.primaryCreditNote ?? "") : "";
    if (credit) bits.push(credit);
    return accountRow(
      `primary-${provider}`,
      account ? (parked ? STATUS.red : STATUS.green) : STATUS.orange,
      account || "not logged in",
      bits.join(" · "),
      shared || credit !== "" || parked,
      account ? (
        <Button
          label={parked ? "Resume" : "Park 3h"}
          kind="quiet"
          theme={theme}
          onPress={() => cooldownMutation.mutate({ provider, email: "primary", minutes: parked ? 0 : 180 })}
        />
      ) : undefined,
      undefined,
      account ? <View style={{ paddingLeft: 17, paddingTop: 2 }}>{usageFor(account)}</View> : undefined,
    );
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Agent Link</Text>
        <View style={styles.row}>
          <Button
            label={usageQuery.isFetching ? "Reading…" : "7-day usage"}
            onPress={() => void usageQuery.refetch()}
            theme={theme}
            kind="quiet"
            disabled={usageQuery.isFetching}
          />
          <Button
            label={healthQuery.isFetching ? "Checking…" : "Check health"}
            onPress={() => void healthQuery.refetch()}
            theme={theme}
            kind="quiet"
            disabled={healthQuery.isFetching}
          />
          <Button label="Refresh" onPress={refresh} theme={theme} kind="quiet" />
        </View>
      </View>
      <Text style={styles.subtitle}>
        Every provider and the accounts under it. A rate limit belongs to an account, so two entries on the same account
        share one limit.
      </Text>
      <Text style={styles.muted}>status: 🟢 logged in / healthy · 🟠 login needed · 🔴 wrong account / failing</Text>
      <View style={styles.card}>
        <Text style={styles.strong}>
          {totalEntries} logged-in {totalEntries === 1 ? "entry" : "entries"} → {distinctPools} independent quota{" "}
          {distinctPools === 1 ? "pool" : "pools"}
        </Text>
        <Text style={styles.muted}>
          A rate limit belongs to an account. Wire the auto-router once and every new agent goes to the least-recently-used
          healthy account; accounts that are parked or out of credit are skipped automatically. Running agents are never
          re-routed, and resuming a chat always returns to the account that owns it.
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="How to use this" onPress={() => setShowHelp((v) => !v)}>
          <Text style={{ color: theme.colors.accent, fontSize: styles.compact ? 11 : 12, fontWeight: "600" }}>
            {showHelp ? "Hide the basics" : "How do I use this?"}
          </Text>
        </Pressable>
        {showHelp ? (
          <View style={{ gap: 4 }}>
            <Text style={styles.muted}>1. Install the Dynamic Agent Link provider below, then pick it in Paseo when starting agents.</Text>
            <Text style={styles.muted}>2. Add accounts with + Add account; finish the browser sign-in with the command it gives you.</Text>
            <Text style={styles.muted}>3. Accounts refused for a limit park themselves — later launches skip them with no action from you.</Text>
            <Text style={styles.muted}>4. 7-day usage reads each account's own transcripts: sessions, tokens and models it ran.</Text>
            <Text style={styles.muted}>5. An account can be healthy yet refuse a specific model. Check with: agent-link probe claude claude-fable-5 --park</Text>
            <Text style={styles.muted}>6. The MCP tab manages servers across every account and provider at once.</Text>
            <Text style={styles.monoText}>terminal equivalents: agent-link status · agent-link auto · agent-link cooldown</Text>
          </View>
        ) : null}
      </View>

      {scanQuery.data?.needsRestart ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            Provider wiring changed — restart the Paseo daemon (when no agents are mid-task) to load new providers.
          </Text>
        </View>
      ) : null}
      {notice ? <Text style={styles.monoText}>{notice}</Text> : null}
      {scanQuery.error ? <Text style={styles.danger}>{String(scanQuery.error)}</Text> : null}
      {wireMutation.error ? <Text style={styles.danger}>{String(wireMutation.error)}</Text> : null}

      {providerCard(
        "claude",
        "Claude Code",
        <>
          {primaryRow("claude")}
          {slots.filter((slot) => slot.provider === "claude").map(slotRow)}
        </>,
      )}
      {providerCard(
        "codex",
        "Codex",
        <>
          {primaryRow("codex")}
          {slots.filter((slot) => slot.provider === "codex").map(slotRow)}
        </>,
      )}
      {providerCard("kimi", "Kimi Code", null)}
      {providerCard("grok", "Grok", null)}

      {slots.some((slot) => !slot.loggedIn || slot.wrongAccount) ? (
        scanQuery.data?.agentAuthInstalled ? (
          <Text style={styles.monoText}>{"fix logins in a terminal: agent-link login all"}</Text>
        ) : (
          <Text style={styles.monoText}>
            {'fix logins in a terminal (per account):\nCLAUDE_CONFIG_DIR="<slot folder>" claude auth login --email <email>\nCODEX_HOME="<slot folder>" codex login'}
          </Text>
        )
      ) : null}
      {scanQuery.data && !scanQuery.data.agentAuthInstalled ? (
        <Text style={styles.muted}>
          Optional: the agent-link CLI (github.com/itsjustanks/agent-link) turns logins into one command and adds
          hot-switching — this panel works fine without it.
        </Text>
      ) : null}
    </ScrollView>
  );
}
