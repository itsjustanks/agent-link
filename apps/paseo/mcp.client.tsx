import type { PluginSurfaceProps, PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  mcpAdd,
  mcpApply,
  mcpAuth,
  mcpDefAll,
  mcpEditOne,
  mcpHealth,
  mcpMatrix,
  mcpRemove,
  mcpRename,
  mcpSync,
  type Destination,
  type McpDefRow,
  type McpHealth,
  type McpServerRow,
} from "./contracts.shared";
import { Badge, Btn, Dot, STATUS, makeStyles } from "./ui.client";

function shortLabel(dest: Destination): string {
  const who = dest.account ? dest.account.split("@")[0] : dest.provider;
  const primary = dest.label.includes("(primary)") ? " ·1°" : "";
  return `${dest.provider}:${who}${primary}`;
}

function healthTone(theme: PluginTheme, status: McpHealth["status"]) {
  if (status === "ok") return STATUS.green;
  if (status === "auth-required" || status === "warn") return STATUS.orange;
  if (status === "unknown") return theme.colors.foregroundMuted;
  return STATUS.red;
}

function healthLabel(status: McpHealth["status"]) {
  switch (status) {
    case "ok":
      return "healthy";
    case "auth-required":
      return "auth needed";
    case "binary-missing":
      return "binary missing";
    case "down":
      return "down";
    case "warn":
      return "warning";
    default:
      return "unknown";
  }
}

export function McpSurface({ theme, layout }: PluginSurfaceProps) {
  const queryClient = useQueryClient();
  const callMatrix = useRpc(mcpMatrix);
  const callAdd = useRpc(mcpAdd);
  const callApply = useRpc(mcpApply);
  const callAuth = useRpc(mcpAuth);
  const callRemove = useRpc(mcpRemove);
  const callSync = useRpc(mcpSync);
  const callDefAll = useRpc(mcpDefAll);
  const callEditOne = useRpc(mcpEditOne);
  const callRename = useRpc(mcpRename);
  const callHealth = useRpc(mcpHealth);
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  // Every button inherits the compact (touch) sizing without repeating it.
  const Button = (props: React.ComponentProps<typeof Btn>) => <Btn compact={layout.compact} {...props} />;

  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterTab, setFilterTab] = useState<"all" | "gaps" | "issues">("all");
  const [health, setHealth] = useState<Map<string, McpHealth> | null>(null);
  const [healthRunning, setHealthRunning] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<{ name: string; destId: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  // editor state: which server, its per-destination rows, reveal, selected row
  const [editServer, setEditServer] = useState<string | null>(null);
  const [editRows, setEditRows] = useState<McpDefRow[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [editDest, setEditDest] = useState<string | null>(null);
  const [rowUrl, setRowUrl] = useState("");
  const [rowCommand, setRowCommand] = useState("");
  const [rowKv, setRowKv] = useState("");
  const [rowKind, setRowKind] = useState<"stdio" | "http">("http");
  const [renameTo, setRenameTo] = useState("");

  // add form
  const [showAdd, setShowAdd] = useState(false);
  const [formName, setFormName] = useState("");
  const [formKind, setFormKind] = useState<"stdio" | "http">("http");
  const [formUrl, setFormUrl] = useState("");
  const [formCommand, setFormCommand] = useState("");
  const [formKv, setFormKv] = useState("");
  const [formTargets, setFormTargets] = useState<Set<string>>(new Set());

  const matrixQuery = useQuery({ queryKey: ["superpowers", "mcp-matrix"], queryFn: () => callMatrix({}) });
  const authQuery = useQuery({ queryKey: ["superpowers", "mcp-auth"], queryFn: () => callAuth({}) });
  const destinations = matrixQuery.data?.destinations ?? [];
  const servers = matrixQuery.data?.servers ?? [];
  const destById = (id: string) => destinations.find((dest) => dest.id === id);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["superpowers"] });
  const onResult = (result: { message?: string; log?: string }) => {
    setMessage(result.message ?? result.log ?? null);
    setPendingRemove(null);
    refresh();
  };

  const closeEditor = () => {
    setEditServer(null);
    setEditRows([]);
    setEditDest(null);
    setRevealed(false);
  };

  const loadEditor = (name: string, reveal: boolean) => {
    void callDefAll({ name, reveal }).then((result) => {
      setEditServer(name);
      setEditRows(result.rows);
      setRevealed(reveal);
      setEditDest(null);
      setExpanded(name);
    });
  };

  const selectRow = (row: McpDefRow) => {
    setEditDest(row.destId);
    setRowKind(row.kind);
    setRowUrl(row.url);
    setRowCommand(row.command);
    setRowKv(row.kvLines);
  };

  const addMutation = useMutation({
    mutationFn: () => {
      const targets = formTargets.size > 0 ? [...formTargets] : destinations.map((dest) => dest.id);
      return callAdd({ name: formName.trim(), kind: formKind, command: formCommand, url: formUrl, kvLines: formKv, targets });
    },
    onSuccess: (result) => {
      onResult(result);
      if (result.ok) {
        setShowAdd(false);
        setFormName("");
        setFormUrl("");
        setFormCommand("");
        setFormKv("");
        setFormTargets(new Set());
      }
    },
  });
  const editOneMutation = useMutation({
    mutationFn: (destId: string) =>
      callEditOne({
        name: editServer as string,
        destId,
        kind: rowKind,
        command: rowCommand,
        url: rowUrl,
        kvLines: rowKv,
      }),
    onSuccess: (result) => {
      onResult(result);
      if (result.ok && editServer) loadEditor(editServer, revealed);
    },
  });
  const renameMutation = useMutation({
    mutationFn: (serverName: string) => callRename({ name: serverName, newName: renameTo.trim() }),
    onSuccess: (result) => {
      onResult(result);
      if (result.ok) {
        closeEditor();
        setRenameTo("");
      }
    },
  });
  const applyMutation = useMutation({
    mutationFn: (input: { name: string; targets: string[]; sourceDestId?: string }) => callApply(input),
    onSuccess: (result) => {
      onResult(result);
      if (editServer) loadEditor(editServer, revealed);
    },
  });
  const removeMutation = useMutation({
    mutationFn: (input: { name: string; targets: string[] }) => callRemove(input),
    onSuccess: onResult,
  });
  const syncMutation = useMutation({ mutationFn: () => callSync({}), onSuccess: onResult });

  const runHealth = () => {
    setHealthRunning(true);
    void callHealth({})
      .then((result) => setHealth(new Map(result.results.map((entry) => [entry.name, entry]))))
      .finally(() => setHealthRunning(false));
  };

  const filtered = servers.filter((server) => {
    if (search && !server.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterTab === "gaps" && server.presentIn.length >= destinations.length) return false;
    if (filterTab === "issues") {
      const entry = health?.get(server.name);
      if (!entry || entry.status === "ok" || entry.status === "unknown") return false;
    }
    return true;
  });

  const inputStyle = styles.input;
  // On a phone the destination row stacks: label above, actions below, so the
  // label is never squeezed to nothing by the buttons.
  const tableRow = {
    flexDirection: layout.compact ? ("column" as const) : ("row" as const),
    alignItems: layout.compact ? ("flex-start" as const) : ("center" as const),
    gap: layout.compact ? 4 : 8,
    paddingVertical: layout.compact ? 6 : 4,
    borderTopWidth: 1,
    borderTopColor: theme.colors.foregroundMuted + "1f",
  };

  const renderEditor = (serverName: string) => (
    <View style={{ gap: 8 }}>
      <View style={styles.rowBetween}>
        <Text style={styles.strong}>Edit '{serverName}' — per destination</Text>
        <View style={styles.row}>
          <Button
            label={revealed ? "Hide secrets" : "Reveal secrets"}
            kind="quiet"
            theme={theme}
            onPress={() => loadEditor(serverName, !revealed)}
          />
          <Button label="Close editor" kind="quiet" theme={theme} onPress={closeEditor} />
        </View>
      </View>
      <Text style={styles.muted}>
        Each destination keeps its own definition — different auth per account is expected. Masked (•••) values keep that
        destination's stored secret on save.
      </Text>
      <View style={styles.row}>
        <TextInput
          placeholder="rename to…"
          placeholderTextColor={theme.colors.foregroundMuted}
          value={renameTo}
          onChangeText={setRenameTo}
          autoCapitalize="none"
          style={[inputStyle, { minWidth: 160 }]}
        />
        <Button
          label={renameMutation.isPending ? "Renaming…" : "Rename everywhere"}
          kind="quiet"
          theme={theme}
          disabled={renameMutation.isPending || !renameTo.trim()}
          onPress={() => renameMutation.mutate(serverName)}
        />
      </View>
      {editRows.every((row) => !row.found) ? (
        <Text style={styles.danger}>No destination has a readable definition for this server.</Text>
      ) : null}
      {editRows
        .filter((row) => row.found)
        .map((row) => {
          const dest = destById(row.destId);
          if (!dest) return null;
          const selected = editDest === row.destId;
          return (
            <View key={row.destId} style={{ gap: 6 }}>
              <View style={tableRow}>
                <Text style={[styles.text, { flex: 1 }]} numberOfLines={1}>
                  {dest.label}
                </Text>
                <Badge label={row.kind} theme={theme} />
                {selected ? null : <Button label="Edit" kind="quiet" theme={theme} onPress={() => selectRow(row)} />}
                <Button
                  label="Use for ALL"
                  kind="quiet"
                  theme={theme}
                  onPress={() =>
                    applyMutation.mutate({
                      name: serverName,
                      targets: destinations.filter((d) => d.id !== row.destId).map((d) => d.id),
                      sourceDestId: row.destId,
                    })
                  }
                />
              </View>
              {selected ? (
                <View style={{ gap: 6, paddingLeft: 8 }}>
                  {rowKind === "http" ? (
                    <TextInput value={rowUrl} onChangeText={setRowUrl} autoCapitalize="none" style={inputStyle} placeholder="https://…" placeholderTextColor={theme.colors.foregroundMuted} />
                  ) : (
                    <TextInput value={rowCommand} onChangeText={setRowCommand} autoCapitalize="none" style={inputStyle} placeholder="command args…" placeholderTextColor={theme.colors.foregroundMuted} />
                  )}
                  <TextInput
                    value={rowKv}
                    onChangeText={setRowKv}
                    autoCapitalize="none"
                    multiline
                    numberOfLines={3}
                    style={[inputStyle, { minHeight: 56, fontFamily: styles.mono }]}
                    placeholder={rowKind === "http" ? "Authorization=Bearer …" : "API_KEY=…"}
                    placeholderTextColor={theme.colors.foregroundMuted}
                  />
                  <View style={styles.row}>
                    <Button
                      label={editOneMutation.isPending ? "Saving…" : "Save this destination"}
                      theme={theme}
                      onPress={() => editOneMutation.mutate(row.destId)}
                      disabled={editOneMutation.isPending}
                    />
                    <Button label="Cancel" kind="quiet" theme={theme} onPress={() => setEditDest(null)} />
                  </View>
                </View>
              ) : (
                <Text style={[styles.monoText, { paddingLeft: 8 }]} numberOfLines={2}>
                  {row.kind === "http" ? row.url : row.command}
                  {row.kvLines ? `\n${row.kvLines}` : ""}
                </Text>
              )}
            </View>
          );
        })}
      {editRows.some((row) => !row.found) ? (
        <View style={styles.row}>
          <Text style={styles.muted}>Missing in:</Text>
          {editRows
            .filter((row) => !row.found)
            .map((row) => {
              const dest = destById(row.destId);
              return dest ? (
                <Button
                  key={row.destId}
                  label={`+ ${shortLabel(dest)}`}
                  kind="quiet"
                  theme={theme}
                  onPress={() => applyMutation.mutate({ name: serverName, targets: [row.destId] })}
                />
              ) : null;
            })}
        </View>
      ) : null}
    </View>
  );

  const tab = (id: "all" | "gaps" | "issues", label: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Filter: ${label}`}
      onPress={() => setFilterTab(id)}
      style={{
        paddingVertical: 4,
        paddingHorizontal: 12,
        borderRadius: 999,
        backgroundColor: filterTab === id ? theme.colors.accent : "transparent",
        borderWidth: 1,
        borderColor: filterTab === id ? theme.colors.accent : theme.colors.foregroundMuted + "44",
      }}
    >
      <Text style={{ color: filterTab === id ? theme.colors.accentForeground : theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
        {label}
      </Text>
    </Pressable>
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} stickyHeaderIndices={[1]}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>MCP</Text>
        <View style={styles.row}>
          <Button label={healthRunning ? "Checking…" : "Health check"} onPress={runHealth} theme={theme} kind="quiet" disabled={healthRunning} />
          <Button label={showAdd ? "Close" : "Add server"} onPress={() => setShowAdd((v) => !v)} theme={theme} />
          <Button label={syncMutation.isPending ? "Syncing…" : "Sync accounts"} onPress={() => syncMutation.mutate()} theme={theme} kind="quiet" disabled={syncMutation.isPending} />
          <Button label="Refresh" onPress={refresh} theme={theme} kind="quiet" />
        </View>
      </View>

      <View style={{ backgroundColor: theme.colors.surface0, paddingVertical: 6, gap: 8 }}>
        <View style={styles.row}>
          <TextInput
            placeholder="Search servers…"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            style={[inputStyle, { flex: 1, minWidth: 140 }]}
          />
          {tab("all", `All (${servers.length})`)}
          {tab("gaps", "Gaps")}
          {tab("issues", "Issues")}
        </View>
        <Text style={styles.muted}>
          🟢 healthy · 🟠 auth needed · 🔴 down · ⚪ unchecked — {filtered.length}/{servers.length} shown · {destinations.length} destinations
        </Text>
      </View>

      <Text style={styles.muted}>
        These are USER-LEVEL servers (each provider's global config) — available in every project. Project-level servers
        (a repo's own .mcp.json) belong to that repo and are not touched here.
      </Text>

      {filterTab === "issues" && !health ? (
        <Text style={styles.muted}>Run Health check first — Issues shows servers that fail it.</Text>
      ) : null}

      {editServer ? <View style={styles.card}>{renderEditor(editServer)}</View> : null}

      {showAdd ? (
        <View style={styles.card}>
          <Text style={styles.strong}>Add MCP server</Text>
          <TextInput placeholder="name (e.g. my-server)" placeholderTextColor={theme.colors.foregroundMuted} value={formName} onChangeText={setFormName} autoCapitalize="none" style={inputStyle} />
          <View style={styles.row}>
            <Button label={`type: ${formKind}`} kind="quiet" theme={theme} onPress={() => setFormKind((k) => (k === "http" ? "stdio" : "http"))} />
          </View>
          {formKind === "http" ? (
            <TextInput placeholder="https://example.com/mcp" placeholderTextColor={theme.colors.foregroundMuted} value={formUrl} onChangeText={setFormUrl} autoCapitalize="none" style={inputStyle} />
          ) : (
            <TextInput placeholder="command with args, e.g. npx -y some-mcp-server" placeholderTextColor={theme.colors.foregroundMuted} value={formCommand} onChangeText={setFormCommand} autoCapitalize="none" style={inputStyle} />
          )}
          <TextInput
            placeholder={formKind === "http" ? "headers: Authorization=Bearer …" : "env: API_KEY=…"}
            placeholderTextColor={theme.colors.foregroundMuted}
            value={formKv}
            onChangeText={setFormKv}
            autoCapitalize="none"
            multiline
            numberOfLines={2}
            style={[inputStyle, { minHeight: 48 }]}
          />
          <Text style={styles.muted}>Targets — none selected = all:</Text>
          <View style={styles.row}>
            {destinations.map((dest) => {
              const selected = formTargets.has(dest.id);
              return (
                <Pressable
                  key={dest.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${dest.label}: ${selected ? "selected" : "not selected"}`}
                  onPress={() =>
                    setFormTargets((previous) => {
                      const next = new Set(previous);
                      if (next.has(dest.id)) next.delete(dest.id);
                      else next.add(dest.id);
                      return next;
                    })
                  }
                  style={{
                    borderWidth: 1,
                    borderColor: selected ? theme.colors.accent : theme.colors.foregroundMuted + "55",
                    backgroundColor: selected ? theme.colors.accent + "22" : "transparent",
                    borderRadius: 999,
                    paddingVertical: 3,
                    paddingHorizontal: 9,
                  }}
                >
                  <Text style={{ color: selected ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 10, fontWeight: "600" }}>
                    {shortLabel(dest)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.row}>
            <Button
              label={addMutation.isPending ? "Adding…" : formTargets.size > 0 ? `Add to ${formTargets.size} selected` : "Add to ALL"}
              theme={theme}
              onPress={() => addMutation.mutate()}
              disabled={addMutation.isPending || !formName.trim()}
            />
          </View>
        </View>
      ) : null}

      {authQuery.data ? (
        <View style={styles.card}>
          <Text style={styles.strong}>Authentication by account</Text>
          <Text style={styles.muted}>
            A server has to be authorized once per account — that is what "not connected" means. Definitions sync; grants
            do not.
          </Text>
          {authQuery.data.accounts.map((account) => (
            <View key={account.dir} style={{ gap: 3, paddingTop: 4 }}>
              <View style={styles.row}>
                <Dot color={account.needsAuth.length === 0 ? theme.colors.accent : theme.colors.statusDanger} />
                <Text style={styles.strong}>{account.email}</Text>
                {account.isPrimary ? <Badge label="primary" theme={theme} tone="accent" /> : null}
                <Text style={styles.muted}>
                  {account.definedServers} servers ·{" "}
                  {account.needsAuth.length === 0 ? "all authorized" : `${account.needsAuth.length} need sign-in`}
                </Text>
              </View>
              {account.needsAuth.length > 0 ? (
                <>
                  <Text style={styles.danger}>{account.needsAuth.join(", ")}</Text>
                  <Text style={styles.monoText}>
                    {account.isPrimary
                      ? `claude mcp login ${account.needsAuth[0]}`
                      : `CLAUDE_CONFIG_DIR="${account.dir}" claude mcp login ${account.needsAuth[0]}`}
                  </Text>
                </>
              ) : null}
            </View>
          ))}
          {authQuery.data.projectServers.length > 0 ? (
            <Text style={styles.muted}>
              Project-scoped servers (defined in a repo's .mcp.json, not managed here):{" "}
              {[...new Set(authQuery.data.projectServers.map((entry) => entry.name))].join(", ")}
            </Text>
          ) : null}
        </View>
      ) : null}

      {message ? <Text style={styles.monoText}>{message}</Text> : null}
      {matrixQuery.isLoading ? <Text style={styles.muted}>Reading configs…</Text> : null}
      {matrixQuery.error ? <Text style={styles.danger}>{String(matrixQuery.error)}</Text> : null}

      {filtered.map((server) => {
        const serverHealth = health?.get(server.name);
        const isOpen = expanded === server.name;
        return (
          <View key={server.name} style={styles.card}>
            <View style={styles.rowBetween}>
                <View style={styles.row}>
                  <Dot color={serverHealth ? healthTone(theme, serverHealth.status) : theme.colors.foregroundMuted} />
                  <Text style={styles.strong}>{server.name}</Text>
                  <Badge label={server.transport} theme={theme} />
                  <Badge label={server.authStyle === "inline-credentials" ? "creds inline" : "OAuth / none"} theme={theme} />
                  {serverHealth ? <Badge label={healthLabel(serverHealth.status)} theme={theme} tone={serverHealth.status === "ok" ? "accent" : serverHealth.status === "unknown" ? undefined : "danger"} /> : null}
                  <Text style={styles.muted}>
                    {server.presentIn.length}/{destinations.length}
                  </Text>
                </View>
                <View style={styles.row}>
                  <Button label={isOpen ? "Hide" : "Details"} kind="quiet" theme={theme} onPress={() => setExpanded(isOpen ? null : server.name)} />
                  <Button label="Edit" theme={theme} onPress={() => loadEditor(server.name, false)} />
                  {server.presentIn.length < destinations.length ? (
                    <Button
                      label="Add to all"
                      kind="quiet"
                      theme={theme}
                      onPress={() =>
                        applyMutation.mutate({
                          name: server.name,
                          targets: destinations.filter((dest) => !server.presentIn.includes(dest.id)).map((dest) => dest.id),
                        })
                      }
                    />
                  ) : null}
                </View>
              </View>
            {serverHealth && serverHealth.status !== "ok" ? <Text style={styles.danger}>{serverHealth.note}</Text> : null}
            {serverHealth?.status === "auth-required" ? (
              <Text style={styles.muted}>
                Authenticate per provider (OAuth is per account): Claude Code — run /mcp inside a session on that account;
                other CLIs — their own MCP login flow.
              </Text>
            ) : null}
            {server.detail ? <Text style={styles.monoText}>{server.detail}</Text> : null}

            {isOpen ? (
                <View>
                  {destinations.map((dest) => {
                    const present = server.presentIn.includes(dest.id);
                    const confirming = pendingRemove?.name === server.name && pendingRemove.destId === dest.id;
                    return (
                      <View key={dest.id} style={tableRow}>
                        <Text style={[styles.text, layout.compact ? { width: "100%" as const } : { flex: 1 }]} numberOfLines={1}>
                          <Text style={present ? { color: theme.colors.accent } : styles.muted}>{present ? "✓ " : "— "}</Text>
                          {dest.label}
                        </Text>
                        {confirming ? (
                          <>
                            <Button label="Confirm remove" kind="danger" theme={theme} onPress={() => removeMutation.mutate({ name: server.name, targets: [dest.id] })} />
                            <Button label="Cancel" kind="quiet" theme={theme} onPress={() => setPendingRemove(null)} />
                          </>
                        ) : present ? (
                          <Button label="Remove" kind="quiet" theme={theme} onPress={() => setPendingRemove({ name: server.name, destId: dest.id })} />
                        ) : (
                          <Button label="Add" kind="quiet" theme={theme} onPress={() => applyMutation.mutate({ name: server.name, targets: [dest.id] })} />
                        )}
                      </View>
                    );
                  })}
                </View>
            ) : null}
          </View>
        );
      })}

      <Text style={styles.muted}>
        Tap a server to expand its destination table; Edit shows each destination's own definition. Every write backs up
        the target config first.
      </Text>
    </ScrollView>
  );
}
