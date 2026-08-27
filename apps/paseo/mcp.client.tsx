/**
 * The MCP surface: the list of servers beside one server's detail.
 *
 * Master–detail because every question asked here is about one server at a
 * time — where is it defined, what does each destination actually hold, who
 * has authorised it — and because an editor that opens anywhere other than
 * where the user clicked is an editor they will not find.
 *
 * The friction is placed on purpose: copying one definition over the others
 * and importing a definition that still holds a placeholder both ask twice,
 * while revealed secrets keep a notice on screen until they are masked again.
 */
import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useMemo, useState } from "react";
import { Linking, Text, View } from "react-native";
import { z } from "zod";
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
  type McpAuthAccount,
  type McpDefRow,
  type McpHealth,
  type McpServerRow,
} from "./contracts.shared";
import {
  ParsedServerSchema,
  mcpExport,
  mcpExportFile,
  mcpImportApply,
  mcpImportParse,
  mcpLogin,
  mcpLoginCancel,
  mcpLoginStatus,
  mcpLogout,
  mcpRawGet,
  mcpRawPut,
  type JsonIssue,
  type LoginSession,
  type RawDefRow,
} from "./mcpjson.shared";
import {
  Button,
  Card,
  CodeBlock,
  ConfirmButton,
  Coverage,
  Disclosure,
  EmptyState,
  ErrorText,
  Facts,
  Field,
  Loading,
  Notice,
  Row,
  Screen,
  Section,
  Segmented,
  SplitView,
  StatusPill,
  Tag,
  Toolbar,
  copyToClipboard,
  useTokens,
  useUi,
  type Status,
} from "./ui.client";

type ParsedServer = z.infer<typeof ParsedServerSchema>;
type PutResult = z.output<typeof mcpRawPut.output>;
type Flash = { tone: Status; text: string };
type Mode = "browse" | "add" | "import";
type Kind = "stdio" | "http";

// -------------------------------------------------------------------- helpers

function healthStatus(status: McpHealth["status"]): Status {
  if (status === "ok") return "ok";
  if (status === "auth-required" || status === "warn") return "attention";
  if (status === "unknown") return "neutral";
  return "error";
}

function healthWord(status: McpHealth["status"]): string {
  switch (status) {
    case "ok":
      return "healthy";
    case "auth-required":
      return "sign-in";
    case "warn":
      return "warning";
    case "binary-missing":
      return "no binary";
    case "down":
      return "down";
    default:
      return "unchecked";
  }
}

function sessionStatus(state: LoginSession["state"]): Status {
  if (state === "done") return "ok";
  if (state === "failed") return "error";
  if (state === "waiting") return "attention";
  return "busy";
}

/** A log or a stack trace is useful; twenty lines of it under the toolbar is not. */
function clampLines(text: string, limit: number): string {
  const lines = text.split("\n");
  if (lines.length <= limit) return text.trim();
  return `${lines.slice(0, limit).join("\n")}\n… ${lines.length - limit} more lines`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * "line 4, col 12 — message", the offending line, and a caret under the column.
 * A coordinate the reader has to count to is a coordinate they will get wrong.
 */
function formatIssue(source: string, issue: JsonIssue): string {
  if (issue.line < 1) return issue.message;
  const head = `line ${issue.line}, col ${issue.column} — ${issue.message}`;
  const line = source.split("\n")[issue.line - 1];
  if (line === undefined) return head;
  return `${head}\n${line}\n${" ".repeat(Math.max(0, issue.column - 1))}^`;
}

function loginCommand(account: McpAuthAccount, server: string): string {
  const variable = account.provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  return account.isPrimary
    ? `${account.provider} mcp login ${server}`
    : `${variable}="${account.dir}" ${account.provider} mcp login ${server}`;
}

// ----------------------------------------------------------------- fragments

function Issues({ source, issues }: { source: string; issues: JsonIssue[] }) {
  const t = useTokens();
  if (issues.length === 0) return null;
  return (
    <View style={{ gap: t.space.sm }}>
      {issues.map((issue, index) => (
        <CodeBlock key={`${issue.code}-${index}`} tone="error">
          {formatIssue(source, issue)}
        </CodeBlock>
      ))}
    </View>
  );
}

function Lines({ items }: { items: string[] }) {
  const t = useTokens();
  return (
    <View style={{ gap: t.space.xs }}>
      {items.map((item, index) => (
        <Text key={`${item}-${index}`} style={t.text.caption}>
          {item}
        </Text>
      ))}
    </View>
  );
}

/** A destination is picked by pressing its row; the word says which state it is in. */
function Targets({
  title,
  destinations,
  selected,
  onToggle,
  onAll,
  onNone,
}: {
  title: string;
  destinations: Destination[];
  selected: string[];
  onToggle: (id: string) => void;
  onAll: () => void;
  onNone: () => void;
}) {
  const t = useTokens();
  return (
    <Section
      title={`${title} — ${selected.length} of ${destinations.length}`}
      trailing={
        <View style={{ flexDirection: "row", gap: t.space.sm }}>
          <Button label="All" variant="ghost" onPress={onAll} />
          <Button label="None" variant="ghost" onPress={onNone} />
        </View>
      }
    >
      <Card padded={false}>
        {destinations.length === 0 ? (
          <EmptyState title="Nowhere to write" body="No CLI config was found on this machine to write a server into." />
        ) : null}
        {destinations.map((dest, index) => {
          const on = selected.includes(dest.id);
          return (
            <Row
              key={dest.id}
              first={index === 0}
              selected={on}
              onPress={() => onToggle(dest.id)}
              title={dest.label}
              subtitle={dest.configPath}
              trailing={on ? <Tag label="included" tone="ok" /> : <Tag label="skipped" />}
            />
          );
        })}
      </Card>
    </Section>
  );
}

function useTargetSet(destinations: Destination[]) {
  // null means "every destination", so a freshly loaded destination is included
  // rather than silently dropped from a selection made before it appeared.
  const [chosen, setChosen] = useState<string[] | null>(null);
  const ids = chosen ?? destinations.map((dest) => dest.id);
  return {
    ids,
    toggle: (id: string) =>
      setChosen((previous) => {
        const next = new Set(previous ?? destinations.map((dest) => dest.id));
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return [...next];
      }),
    all: () => setChosen(null),
    none: () => setChosen([]),
    reset: () => setChosen(null),
  };
}

// ------------------------------------------------------------------- editors

function FieldsEditor({
  row,
  saving,
  onDirty,
  onSave,
}: {
  row: McpDefRow;
  saving: boolean;
  onDirty: (dirty: boolean) => void;
  onSave: (input: { kind: Kind; url: string; command: string; kvLines: string }) => void;
}) {
  const t = useTokens();
  const [kind, setKind] = useState<Kind>(row.kind);
  const [url, setUrl] = useState(row.url);
  const [command, setCommand] = useState(row.command);
  const [kvLines, setKvLines] = useState(row.kvLines);
  const dirty = kind !== row.kind || url !== row.url || command !== row.command || kvLines !== row.kvLines;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  return (
    <View style={{ gap: t.space.md }}>
      <Segmented
        value={kind}
        onChange={setKind}
        options={[
          { value: "http", label: "HTTP" },
          { value: "stdio", label: "Command" },
        ]}
      />
      {kind === "http" ? (
        <Field label="URL" value={url} onChangeText={setUrl} placeholder="https://example.com/mcp" />
      ) : (
        <Field label="Command" value={command} onChangeText={setCommand} placeholder="npx -y some-mcp-server" />
      )}
      <Field
        label={kind === "http" ? "Headers" : "Environment"}
        value={kvLines}
        onChangeText={setKvLines}
        multiline
        mono
        placeholder={kind === "http" ? "Authorization=Bearer …" : "API_KEY=…"}
        hint="One KEY=value per line. A masked ••• value keeps this destination's stored secret."
      />
      <View style={{ flexDirection: "row", gap: t.space.sm }}>
        <Button
          label="Save this destination"
          variant="primary"
          loading={saving}
          disabled={!dirty}
          onPress={() => onSave({ kind, url, command, kvLines })}
        />
      </View>
    </View>
  );
}

/**
 * The JSON tab. Save stays shut until the buffer both differs and has come back
 * clean from the daemon, and any keystroke throws the verdict away — a pass from
 * two edits ago is not permission to write.
 */
function JsonEditor({
  seed,
  nativePreview,
  onDirty,
  onPut,
}: {
  seed: string;
  nativePreview: string;
  onDirty: (dirty: boolean) => void;
  onPut: (json: string, dryRun: boolean) => Promise<PutResult | null>;
}) {
  const t = useTokens();
  const [buffer, setBuffer] = useState(seed);
  const [baseline, setBaseline] = useState(seed);
  const [verdict, setVerdict] = useState<PutResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState<"validate" | "preview" | "save" | null>(null);
  const dirty = buffer !== baseline;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const run = async (job: "validate" | "preview" | "save") => {
    setBusy(job);
    const result = await onPut(buffer, job !== "save");
    setBusy(null);
    if (!result) return;
    setVerdict(result);
    setShowPreview(job === "preview");
    if (job === "save" && result.ok) setBaseline(buffer);
  };

  return (
    <View style={{ gap: t.space.md }}>
      <Field
        label="Definition"
        value={buffer}
        onChangeText={(next) => {
          setBuffer(next);
          setVerdict(null);
          setShowPreview(false);
        }}
        multiline
        mono
        minHeight={t.text.mono.lineHeight * 14}
        hint="Claude's shape, whatever the destination stores. Preview shows the translation."
      />
      <View style={{ flexDirection: "row", gap: t.space.sm }}>
        <Button label="Validate" loading={busy === "validate"} onPress={() => void run("validate")} />
        <Button label="Preview" loading={busy === "preview"} onPress={() => void run("preview")} />
        <Button
          label="Save"
          variant="primary"
          loading={busy === "save"}
          disabled={!dirty || !verdict?.ok}
          onPress={() => void run("save")}
        />
        <Button
          label="Revert"
          variant="ghost"
          disabled={!dirty}
          onPress={() => {
            setBuffer(baseline);
            setVerdict(null);
            setShowPreview(false);
          }}
        />
      </View>
      {verdict && !verdict.ok && verdict.issues.length === 0 ? <ErrorText>{verdict.message}</ErrorText> : null}
      {verdict ? <Issues source={buffer} issues={verdict.issues} /> : null}
      {verdict?.ok ? (
        <Text style={t.text.caption}>
          {dirty ? "Checked clean — Save is now open." : verdict.message || "Nothing left to write."}
        </Text>
      ) : null}
      {verdict && verdict.warnings.length > 0 ? <Lines items={verdict.warnings} /> : null}
      {showPreview && verdict ? (
        <>
          <Section title="What this destination will hold">
            <CodeBlock>{verdict.preview || nativePreview}</CodeBlock>
          </Section>
          {verdict.dropped.length > 0 ? (
            <Section title="Dropped — no equivalent in this format">
              <Lines items={verdict.dropped} />
            </Section>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function DestinationEditor({
  tab,
  onTab,
  defRow,
  rawRow,
  saving,
  otherCount,
  onSaveFields,
  onPut,
  onCopyEverywhere,
  onClose,
}: {
  tab: "fields" | "json";
  onTab: (tab: "fields" | "json") => void;
  defRow?: McpDefRow;
  rawRow?: RawDefRow;
  saving: boolean;
  otherCount: number;
  onSaveFields: (input: { kind: Kind; url: string; command: string; kvLines: string }) => void;
  onPut: (json: string, dryRun: boolean) => Promise<PutResult | null>;
  onCopyEverywhere: () => void;
  onClose: () => void;
}) {
  const t = useTokens();
  // Copying this definition over the others is only meaningful once it is the
  // definition on disk, so an unsaved buffer withdraws the offer.
  const [dirty, setDirty] = useState(false);
  return (
    <Card level={2}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm }}>
        <Segmented
          value={tab}
          onChange={onTab}
          options={[
            { value: "fields", label: "Fields" },
            { value: "json", label: "JSON" },
          ]}
        />
        <Button label="Close" variant="ghost" onPress={onClose} />
      </View>
      {tab === "fields" ? (
        !defRow ? (
          <Loading label="Reading this destination…" />
        ) : defRow.found ? (
          <FieldsEditor
            key={`${defRow.destId}-fields`}
            row={defRow}
            saving={saving}
            onDirty={setDirty}
            onSave={onSaveFields}
          />
        ) : (
          <ErrorText>This destination has no readable definition for that server.</ErrorText>
        )
      ) : !rawRow ? (
        <Loading label="Reading this destination…" />
      ) : rawRow.found ? (
        <JsonEditor
          key={`${rawRow.destId}-json`}
          seed={rawRow.json}
          nativePreview={rawRow.nativePreview}
          onDirty={setDirty}
          onPut={onPut}
        />
      ) : (
        <ErrorText>This destination has no readable definition for that server.</ErrorText>
      )}
      {otherCount > 0 ? (
        <View style={{ gap: t.space.xs }}>
          {dirty ? (
            <Text style={t.text.caption}>Save this destination before copying it over the others.</Text>
          ) : (
            <ConfirmButton
              label="Use for all destinations"
              confirmLabel={`Overwrite ${otherCount} destinations`}
              onConfirm={onCopyEverywhere}
            />
          )}
        </View>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------- auth

function AuthRows({
  server,
  accounts,
  destinations,
  presentIn,
  sessions,
  oauthCapable,
  daemonIsLocal,
  pendingDir,
  onAuthorise,
  onCancel,
  onSignOut,
  onCopied,
}: {
  server: string;
  accounts: McpAuthAccount[];
  destinations: Destination[];
  presentIn: string[];
  sessions: LoginSession[];
  oauthCapable: boolean;
  daemonIsLocal: boolean;
  pendingDir: string | null;
  onAuthorise: (account: McpAuthAccount) => void;
  onCancel: (key: string) => void;
  onSignOut: (account: McpAuthAccount) => void;
  onCopied: (ok: boolean) => void;
}) {
  const t = useTokens();
  const rows = accounts
    .map((account) => {
      const dest = destinations.find((entry) => entry.provider === account.provider && entry.account === account.email);
      const needs = account.needsAuth.includes(server);
      return {
        account,
        defined: dest ? presentIn.includes(dest.id) : false,
        needs,
        auth: account.authStatus[server] ?? (needs ? "not-connected" : "unknown"),
      };
    })
    .filter((row) => row.defined || row.needs);
  if (rows.length === 0 || !oauthCapable) return null;

  return (
    <Section title="OAuth connection">
      <Card padded={false}>
        {rows.map(({ account, auth }, index) => {
          const session = sessions.find(
            (entry) => entry.server === server && entry.account === account.email && entry.provider === account.provider,
          );
          const live = session?.state === "starting" || session?.state === "waiting";
          const connected = session?.state === "done" || auth === "connected";
          const unsupported = auth === "unsupported";
          const remote = !connected && !unsupported && !daemonIsLocal;
          const status: Status = connected ? "ok" : unsupported ? "neutral" : live ? "busy" : auth === "not-connected" ? "attention" : "neutral";
          const statusLabel = connected
            ? "connected"
            : unsupported
              ? "OAuth unsupported"
              : live
                ? "connecting"
                : auth === "not-connected"
                  ? "connect required"
                  : "not checked";
          return (
            <Row
              key={`${account.provider}-${account.dir}`}
              first={index === 0}
              title={account.email}
              subtitle={`${account.isPrimary ? "primary" : "routed"} ${account.provider === "claude" ? "Claude" : "Codex"} account`}
              trailing={
                connected ? (
                  <ConfirmButton label="Sign out" confirmLabel="Revoke this grant" onConfirm={() => onSignOut(account)} />
                ) : !unsupported && daemonIsLocal ? (
                  <Button
                    label="Connect OAuth"
                    loading={pendingDir === account.dir}
                    disabled={live}
                    onPress={() => onAuthorise(account)}
                  />
                ) : undefined
              }
              meta={<StatusPill status={status} label={statusLabel} />}
              expanded={
                remote || session || (!connected && !unsupported) ? (
                  <View style={{ gap: t.space.sm }}>
                    {remote ? (
                      <>
                        <Text style={t.text.caption}>
                          The browser callback lands on the daemon machine, not this one — run it there:
                        </Text>
                        <CodeBlock>{loginCommand(account, server)}</CodeBlock>
                      </>
                    ) : null}
                    {!remote && !session ? (
                      <Text style={t.text.caption}>
                        Connect opens this server's own browser sign-in. No token needs to be pasted into Agent Link.
                      </Text>
                    ) : null}
                    {session ? (
                      <>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
                          <StatusPill status={sessionStatus(session.state)} label={session.state} />
                          <Text style={[t.text.caption, { flex: 1, minWidth: 0 }]} numberOfLines={2}>
                            {session.message}
                          </Text>
                        </View>
                        {session.url ? <CodeBlock>{session.url}</CodeBlock> : null}
                        <View style={{ flexDirection: "row", gap: t.space.sm }}>
                          {session.url ? (
                            <>
                              <Button label="Open sign-in" onPress={() => void Linking.openURL(session.url)} />
                              <Button label="Copy link" onPress={() => onCopied(copyToClipboard(session.url))} />
                            </>
                          ) : null}
                          {live ? <Button label="Cancel" variant="ghost" onPress={() => onCancel(session.key)} /> : null}
                        </View>
                      </>
                    ) : null}
                  </View>
                ) : undefined
              }
            />
          );
        })}
      </Card>
    </Section>
  );
}

// -------------------------------------------------------------------- surface

export function McpSurface({ theme, layout }: PluginSurfaceProps) {
  const t = useUi(theme, layout.compact);
  const queryClient = useQueryClient();

  const callMatrix = useRpc(mcpMatrix);
  const callAuth = useRpc(mcpAuth);
  const callAdd = useRpc(mcpAdd);
  const callApply = useRpc(mcpApply);
  const callRemove = useRpc(mcpRemove);
  const callRename = useRpc(mcpRename);
  const callExport = useRpc(mcpExport);
  const callExportFile = useRpc(mcpExportFile);
  const callSync = useRpc(mcpSync);
  const callHealth = useRpc(mcpHealth);
  const callDefAll = useRpc(mcpDefAll);
  const callEditOne = useRpc(mcpEditOne);
  const callRawGet = useRpc(mcpRawGet);
  const callRawPut = useRpc(mcpRawPut);
  const callImportParse = useRpc(mcpImportParse);
  const callImportApply = useRpc(mcpImportApply);
  const callLogin = useRpc(mcpLogin);
  const callLoginStatus = useRpc(mcpLoginStatus);
  const callLoginCancel = useRpc(mcpLoginCancel);
  const callLogout = useRpc(mcpLogout);

  const [flash, setFlash] = useState<Flash | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "gaps" | "issues">("all");
  const [health, setHealth] = useState<Map<string, McpHealth> | null>(null);
  const [mode, setMode] = useState<Mode>("browse");
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editTab, setEditTab] = useState<"fields" | "json">("fields");
  const [revealed, setRevealed] = useState(false);
  const [renameTo, setRenameTo] = useState("");

  const [addName, setAddName] = useState("");
  const [addKind, setAddKind] = useState<Kind>("http");
  const [addUrl, setAddUrl] = useState("");
  const [addCommand, setAddCommand] = useState("");
  const [addKv, setAddKv] = useState("");

  const [blob, setBlob] = useState("");
  const [debouncedBlob, setDebouncedBlob] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [allowPlaceholders, setAllowPlaceholders] = useState(false);
  const [importResult, setImportResult] = useState<{
    written: string[];
    skipped: string[];
    issues: JsonIssue[];
  } | null>(null);

  const matrixQuery = useQuery({ queryKey: ["agent-link", "mcp-matrix"], queryFn: () => callMatrix({}) });
  const destinations = useMemo<Destination[]>(() => matrixQuery.data?.destinations ?? [], [matrixQuery.data]);
  const servers = useMemo<McpServerRow[]>(() => matrixQuery.data?.servers ?? [], [matrixQuery.data]);

  const addTargets = useTargetSet(destinations);
  const importTargets = useTargetSet(destinations);

  const authQuery = useQuery({ queryKey: ["agent-link", "mcp-auth"], queryFn: () => callAuth({}) });
  const rawQuery = useQuery({
    queryKey: ["agent-link", "mcp-raw", selected, revealed],
    queryFn: () => callRawGet({ name: selected as string, reveal: revealed }),
    enabled: Boolean(selected),
  });
  // The raw rows feed every destination line; the field rows are only read once
  // an editor is actually open.
  const defQuery = useQuery({
    queryKey: ["agent-link", "mcp-def", selected, revealed],
    queryFn: () => callDefAll({ name: selected as string, reveal: revealed }),
    enabled: Boolean(selected) && editing !== null,
  });

  const [liveLogin, setLiveLogin] = useState(false);
  const loginQuery = useQuery({
    queryKey: ["agent-link", "mcp-login-status"],
    queryFn: () => callLoginStatus({}),
    refetchInterval: liveLogin ? 2000 : false,
  });
  const sessions = useMemo<LoginSession[]>(() => loginQuery.data?.sessions ?? [], [loginQuery.data]);
  const daemonIsLocal = loginQuery.data?.daemonIsLocal ?? true;
  const anyLive = sessions.some((entry) => entry.state === "starting" || entry.state === "waiting");
  useEffect(() => setLiveLogin(anyLive), [anyLive]);
  // A grant that just landed changes who still needs one.
  const settled = sessions.filter((entry) => entry.state === "done").map((entry) => entry.key).join("|");
  useEffect(() => {
    if (!settled) return;
    void queryClient.invalidateQueries({ queryKey: ["agent-link", "mcp-auth"] });
  }, [settled, queryClient]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedBlob(blob), 400);
    return () => clearTimeout(timer);
  }, [blob]);
  const parseQuery = useQuery({
    queryKey: ["agent-link", "mcp-import-parse", debouncedBlob],
    queryFn: () => callImportParse({ blob: debouncedBlob }),
    enabled: mode === "import" && debouncedBlob.trim().length > 0,
  });
  const parsed = parseQuery.data;
  const parsedNames = (parsed?.servers ?? []).map((entry) => entry.name).join("|");
  useEffect(() => {
    setPicked(parsedNames ? parsedNames.split("|") : []);
    setImportResult(null);
  }, [parsedNames]);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["agent-link"] });
  const fail = (error: unknown) => setFlash({ tone: "error", text: clampLines(errorText(error), 12) });
  const report = (result: { ok: boolean; message: string }) => {
    setFlash({ tone: result.ok ? "ok" : "error", text: clampLines(result.message, 12) || (result.ok ? "Done." : "Refused.") });
    if (result.ok) invalidate();
  };

  const selectServer = (name: string) => {
    setMode("browse");
    setSelected(name);
    setEditing(null);
    setRevealed(false);
    setRenameTo("");
  };
  const closeEditor = () => {
    setEditing(null);
    setRevealed(false);
  };

  const addMutation = useMutation({
    mutationFn: () =>
      callAdd({
        name: addName.trim(),
        kind: addKind,
        command: addCommand,
        url: addUrl,
        kvLines: addKv,
        targets: addTargets.ids,
      }),
    onError: fail,
    onSuccess: (result) => {
      report(result);
      if (!result.ok) return;
      const name = addName.trim();
      setAddName("");
      setAddUrl("");
      setAddCommand("");
      setAddKv("");
      addTargets.reset();
      setMode("browse");
      setSelected(name);
    },
  });
  const applyMutation = useMutation({
    mutationFn: (input: { name: string; targets: string[]; sourceDestId?: string }) => callApply(input),
    onError: fail,
    onSuccess: report,
  });
  const removeMutation = useMutation({
    mutationFn: (input: { name: string; targets: string[] }) => callRemove(input),
    onError: fail,
    onSuccess: report,
  });
  // Export is two steps on purpose: the first produces the text (masked unless
  // secrets are revealed), the second writes it where the user can find it.
  const exportMutation = useMutation({
    mutationFn: async (input: { scope: "one" | "all"; name?: string }) => {
      const made = await callExport({ scope: input.scope, name: input.name, reveal: revealed });
      const saved = await callExportFile({ text: made.text, filename: made.filename });
      return { ...saved, containsSecrets: made.containsSecrets };
    },
    onSuccess: (result) =>
      setFlash({
        tone: result.ok ? "ok" : "error",
        text: result.ok
          ? `${result.message}${result.containsSecrets ? " It holds live credentials." : " Credentials are redacted, so it cannot be re-imported as-is."}`
          : result.message,
      }),
    onError: fail,
  });

  const renameMutation = useMutation({
    mutationFn: (input: { name: string; newName: string }) => callRename(input),
    onError: fail,
    onSuccess: (result, input) => {
      report(result);
      if (!result.ok) return;
      setRenameTo("");
      setSelected(input.newName);
      setEditing(null);
    },
  });
  const editOneMutation = useMutation({
    mutationFn: (input: { destId: string; kind: Kind; command: string; url: string; kvLines: string }) =>
      callEditOne({ name: selected as string, ...input }),
    onError: fail,
    onSuccess: report,
  });
  const syncMutation = useMutation({
    mutationFn: () => callSync({}),
    onError: fail,
    onSuccess: (result) => report({ ok: result.ok, message: result.log }),
  });
  const healthMutation = useMutation({
    mutationFn: () => callHealth({}),
    onError: fail,
    onSuccess: (result) => {
      setHealth(new Map(result.results.map((entry) => [entry.name, entry])));
      const bad = result.results.filter((entry) => entry.status !== "ok" && entry.status !== "unknown").length;
      setFlash({
        tone: bad > 0 ? "attention" : "ok",
        text: `Checked ${result.results.length} servers — ${bad} need attention.`,
      });
    },
  });
  const importMutation = useMutation({
    mutationFn: () =>
      callImportApply({
        servers: (parsed?.servers ?? [])
          .filter((entry) => picked.includes(entry.name))
          .map((entry) => ({ name: entry.name, json: entry.json })),
        targets: importTargets.ids,
        overwrite,
        allowPlaceholders,
      }),
    onError: fail,
    onSuccess: (result) => {
      report(result);
      setImportResult({ written: result.written, skipped: result.skipped, issues: result.issues });
    },
  });
  const loginMutation = useMutation({
    mutationFn: (input: { provider: "claude" | "codex"; accountDir: string; account: string; server: string }) =>
      callLogin(input),
    onError: fail,
    onSuccess: (result) => {
      setFlash({ tone: result.ok ? "ok" : "error", text: result.message });
      setLiveLogin(true);
      void queryClient.invalidateQueries({ queryKey: ["agent-link", "mcp-login-status"] });
    },
  });
  const loginCancelMutation = useMutation({
    mutationFn: (key: string) => callLoginCancel({ key }),
    onError: fail,
    onSuccess: (result) => {
      setFlash({ tone: result.ok ? "ok" : "error", text: result.message });
      void queryClient.invalidateQueries({ queryKey: ["agent-link", "mcp-login-status"] });
    },
  });
  const logoutMutation = useMutation({
    mutationFn: (input: { provider: "claude" | "codex"; accountDir: string; server: string }) => callLogout(input),
    onError: fail,
    onSuccess: report,
  });

  const putJson = async (destId: string, json: string, dryRun: boolean): Promise<PutResult | null> => {
    try {
      const result = await callRawPut({ name: selected as string, destId, json, dryRun });
      if (!dryRun) report(result);
      return result;
    } catch (error) {
      fail(error);
      return null;
    }
  };

  const query = search.trim().toLowerCase();
  const gapCount = servers.filter((server) => server.presentIn.length < destinations.length).length;
  const isIssue = (server: McpServerRow) => {
    const entry = health?.get(server.name);
    return Boolean(entry && entry.status !== "ok" && entry.status !== "unknown");
  };
  const issueCount = health ? servers.filter(isIssue).length : 0;
  const shown = servers.filter((server) => {
    if (query && !server.name.toLowerCase().includes(query)) return false;
    if (filter === "gaps" && server.presentIn.length >= destinations.length) return false;
    if (filter === "issues" && !isIssue(server)) return false;
    return true;
  });

  const server = selected ? servers.find((entry) => entry.name === selected) : undefined;
  const serverHealth = server ? health?.get(server.name) : undefined;
  const missing = server ? destinations.filter((dest) => !server.presentIn.includes(dest.id)) : [];
  const rawRows: RawDefRow[] = rawQuery.data?.rows ?? [];
  const defRows: McpDefRow[] = defQuery.data?.rows ?? [];
  const paneOwnsPrimary = mode !== "browse" || editing !== null;

  const toolbarActions = [
    <Button
      key="add"
      label="Add server"
      variant={paneOwnsPrimary ? "secondary" : "primary"}
      grow={layout.compact}
      onPress={() => {
        setMode("add");
        setEditing(null);
      }}
    />,
    <Button key="paste" label="Paste JSON" grow={layout.compact} onPress={() => setMode("import")} />,
    <Button
      key="sync"
      label="Sync accounts"
      grow={layout.compact}
      loading={syncMutation.isPending}
      onPress={() => syncMutation.mutate()}
    />,
    <Button
      key="health"
      label="Health check"
      grow={layout.compact}
      loading={healthMutation.isPending}
      onPress={() => healthMutation.mutate()}
    />,
    <Button key="refresh" label="Refresh" variant="ghost" grow={layout.compact} onPress={invalidate} />,
  ];

  const filters = (
    <View style={{ flexDirection: layout.compact ? "column" : "row", alignItems: layout.compact ? "stretch" : "center", gap: t.space.md }}>
      <View style={{ flex: layout.compact ? undefined : 1, minWidth: 0 }}>
        <Field value={search} onChangeText={setSearch} placeholder="Search servers" />
      </View>
      <Segmented
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: `All ${servers.length}` },
          { value: "gaps", label: `Gaps ${gapCount}` },
          { value: "issues", label: `Issues ${issueCount}`, disabled: !health },
        ]}
      />
    </View>
  );

  const list = (
    <Card padded={false}>
      {matrixQuery.isLoading ? <Loading label="Reading configs…" /> : null}
      {matrixQuery.error ? (
        <View style={{ padding: t.space.md }}>
          <ErrorText>{errorText(matrixQuery.error)}</ErrorText>
        </View>
      ) : null}
      {!matrixQuery.isLoading && shown.length === 0 ? (
        <EmptyState
          title="Nothing here"
          body={
            servers.length === 0
              ? "No MCP server is defined in any destination yet."
              : "No server matches this search and filter."
          }
        />
      ) : null}
      {shown.map((entry, index) => {
        const entryHealth = health?.get(entry.name);
        return (
          <Row
            key={entry.name}
            first={index === 0}
            selected={selected === entry.name}
            onPress={() => selectServer(entry.name)}
            title={entry.name}
            meta={
              <Coverage
                present={entry.presentIn.length}
                total={destinations.length}
                label={`${entry.presentIn.length} of ${destinations.length} destinations`}
              />
            }
            trailing={
              healthMutation.isPending ? (
                <StatusPill status="busy" label="checking" />
              ) : entryHealth ? (
                <StatusPill status={healthStatus(entryHealth.status)} label={healthWord(entryHealth.status)} />
              ) : undefined
            }
          />
        );
      })}
    </Card>
  );

  const back = layout.compact ? (
    <Button
      label="← All servers"
      variant="ghost"
      onPress={() => {
        setMode("browse");
        setSelected(null);
        setEditing(null);
      }}
    />
  ) : null;

  const emptyPane = (
    <View style={{ gap: t.space.lg }}>
      <EmptyState
        title="Pick a server"
        body={`${servers.length} servers across ${destinations.length} destinations. Choose one to see where it is defined, edit it per destination, or authorise it per account.`}
      />
      <Disclosure title="How this works">
        <Text style={t.text.body}>
          These are user-level servers — each CLI's global config, available in every project. A repo's own .mcp.json is
          project-level and is never touched here.
        </Text>
        <Text style={t.text.body}>
          Every destination keeps its own definition, so different auth per account is expected. Masked ••• values keep
          that destination's stored secret when you save.
        </Text>
        <Text style={t.text.body}>
          Definitions sync; grants do not. A server still has to be authorised once per account — that is what "not
          connected" means inside a session.
        </Text>
        <Text style={t.text.body}>Every write backs the target config up first.</Text>
        {authQuery.data && authQuery.data.projectServers.length > 0 ? (
          <Text style={t.text.body}>
            Project-scoped servers seen nearby, not managed here:{" "}
            {[...new Set(authQuery.data.projectServers.map((entry) => entry.name))].join(", ")}
          </Text>
        ) : null}
      </Disclosure>
    </View>
  );

  const addPane = (
    <View style={{ gap: t.space.lg }}>
      {back}
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm }}>
          <Text style={t.text.heading}>Add a server</Text>
          <Button label="Cancel" variant="ghost" onPress={() => setMode("browse")} />
        </View>
        <Field label="Name" value={addName} onChangeText={setAddName} placeholder="my-server" autoFocus />
        <Segmented
          value={addKind}
          onChange={setAddKind}
          options={[
            { value: "http", label: "HTTP" },
            { value: "stdio", label: "Command" },
          ]}
        />
        {addKind === "http" ? (
          <Field label="URL" value={addUrl} onChangeText={setAddUrl} placeholder="https://example.com/mcp" />
        ) : (
          <Field label="Command" value={addCommand} onChangeText={setAddCommand} placeholder="npx -y some-mcp-server" />
        )}
        <Field
          label={addKind === "http" ? "Headers" : "Environment"}
          value={addKv}
          onChangeText={setAddKv}
          multiline
          mono
          placeholder={addKind === "http" ? "Optional: Authorization=Bearer …" : "API_KEY=…"}
          hint={
            addKind === "http"
              ? "OAuth server? Leave this blank. After adding, open the server and choose Connect OAuth."
              : "One KEY=value per line."
          }
        />
      </Card>
      <Targets
        title="Write it to"
        destinations={destinations}
        selected={addTargets.ids}
        onToggle={addTargets.toggle}
        onAll={addTargets.all}
        onNone={addTargets.none}
      />
      <View style={{ flexDirection: "row", gap: t.space.sm }}>
        <Button
          label={`Add to ${addTargets.ids.length} destinations`}
          variant="primary"
          loading={addMutation.isPending}
          disabled={
            !addName.trim() ||
            addTargets.ids.length === 0 ||
            (addKind === "http" ? !addUrl.trim() : !addCommand.trim())
          }
          onPress={() => addMutation.mutate()}
        />
      </View>
    </View>
  );

  const pickedServers: ParsedServer[] = (parsed?.servers ?? []).filter((entry) => picked.includes(entry.name));
  const stillPlaceholders = pickedServers.filter((entry) => entry.hasPlaceholders.length > 0);
  const importPane = (
    <View style={{ gap: t.space.lg }}>
      {back}
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: t.space.sm }}>
          <Text style={t.text.heading}>Paste a server definition</Text>
          <Button label="Cancel" variant="ghost" onPress={() => setMode("browse")} />
        </View>
        <Field
          value={blob}
          onChangeText={setBlob}
          multiline
          mono
          minHeight={t.text.mono.lineHeight * 10}
          placeholder={'{ "mcpServers": { "example": { "type": "http", "url": "https://…" } } }'}
          hint="Straight from a README — code fences, comments and a wrapper key are handled."
        />
      </Card>
      {parseQuery.isFetching ? <Loading label="Reading it…" /> : null}
      {parseQuery.error ? <ErrorText>{errorText(parseQuery.error)}</ErrorText> : null}
      {parsed && parsed.normalisations.length > 0 ? (
        <Section title="Cleaned up on the way in">
          <Lines items={parsed.normalisations} />
        </Section>
      ) : null}
      {parsed && parsed.issues.length > 0 ? <Issues source={debouncedBlob} issues={parsed.issues} /> : null}
      {parsed && parsed.servers.length > 0 ? (
        <>
          <Section title={`Found ${parsed.servers.length}`}>
            <Card padded={false}>
              {parsed.servers.map((entry, index) => {
                const on = picked.includes(entry.name);
                return (
                  <Row
                    key={entry.name}
                    first={index === 0}
                    selected={on}
                    onPress={() =>
                      setPicked((previous) =>
                        previous.includes(entry.name)
                          ? previous.filter((name) => name !== entry.name)
                          : [...previous, entry.name],
                      )
                    }
                    title={entry.name}
                    subtitle={entry.summary}
                    meta={
                      <Facts
                        items={[
                          { value: entry.kind },
                          entry.hasPlaceholders.length > 0
                            ? { value: `fill in ${entry.hasPlaceholders.join(", ")}`, tone: "attention" as Status }
                            : null,
                        ]}
                      />
                    }
                    trailing={on ? <Tag label="import" tone="ok" /> : <Tag label="skip" />}
                  />
                );
              })}
            </Card>
          </Section>
          <Targets
            title="Write it to"
            destinations={destinations}
            selected={importTargets.ids}
            onToggle={importTargets.toggle}
            onAll={importTargets.all}
            onNone={importTargets.none}
          />
          <Section title="If a server of that name is already there">
            <Segmented
              value={overwrite ? "overwrite" : "keep"}
              onChange={(value) => setOverwrite(value === "overwrite")}
              options={[
                { value: "keep", label: "Keep what is there" },
                { value: "overwrite", label: "Overwrite it" },
              ]}
            />
          </Section>
          {stillPlaceholders.length > 0 ? (
            <Notice tone="attention">
              <View style={{ gap: t.space.sm }}>
                <Text style={t.text.body}>
                  {`Placeholders still in ${stillPlaceholders.map((entry) => entry.name).join(", ")} — imported as they are, they fail at connect time.`}
                </Text>
                <Segmented
                  value={allowPlaceholders ? "allow" : "block"}
                  onChange={(value) => setAllowPlaceholders(value === "allow")}
                  options={[
                    { value: "block", label: "Fix them first" },
                    { value: "allow", label: "Import anyway" },
                  ]}
                />
              </View>
            </Notice>
          ) : null}
          <View style={{ flexDirection: "row", gap: t.space.sm }}>
            <Button
              label={`Import ${pickedServers.length} into ${importTargets.ids.length} destinations`}
              variant="primary"
              loading={importMutation.isPending}
              disabled={
                pickedServers.length === 0 ||
                importTargets.ids.length === 0 ||
                (stillPlaceholders.length > 0 && !allowPlaceholders)
              }
              onPress={() => importMutation.mutate()}
            />
          </View>
        </>
      ) : null}
      {importResult ? (
        <>
          {importResult.written.length > 0 ? (
            <Section title="Written">
              <Lines items={importResult.written} />
            </Section>
          ) : null}
          {importResult.skipped.length > 0 ? (
            <Section title="Skipped">
              <Lines items={importResult.skipped} />
            </Section>
          ) : null}
          <Issues source={debouncedBlob} issues={importResult.issues} />
        </>
      ) : null}
    </View>
  );

  const serverPane = server ? (
    <View style={{ gap: t.space.lg }}>
      {back}
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
          <Text style={[t.text.display, { flexShrink: 1 }]} numberOfLines={1}>
            {server.name}
          </Text>
          <Tag label={server.transport} />
          {server.transport === "http" && server.authStyle === "oauth-or-none" ? <Tag label="OAuth available" /> : null}
          {serverHealth ? (
            <StatusPill status={healthStatus(serverHealth.status)} label={healthWord(serverHealth.status)} />
          ) : null}
        </View>
        <Facts
          items={[
            { value: `${server.presentIn.length} of ${destinations.length} destinations` },
            server.detail ? { value: server.detail } : null,
          ]}
        />
        {serverHealth && serverHealth.status !== "ok" && serverHealth.note ? (
          <Text style={t.text.body}>{serverHealth.note}</Text>
        ) : null}
        <View style={{ flexDirection: "row", gap: t.space.sm }}>
          {missing.length > 0 ? (
            <Button
              label={`Add to ${missing.length} missing`}
              loading={applyMutation.isPending}
              onPress={() => applyMutation.mutate({ name: server.name, targets: missing.map((dest) => dest.id) })}
            />
          ) : null}
          <Button
            label={revealed ? "Hide secrets" : "Reveal secrets"}
            onPress={() => setRevealed((value) => !value)}
          />
          {/* A panel cannot download, so an export is written next to the
              user's other files and the path is reported back. */}
          <Button
            label="Export"
            loading={exportMutation.isPending}
            onPress={() => exportMutation.mutate({ scope: "one", name: server.name })}
          />
        </View>
        <Disclosure title="Rename this server everywhere">
          <Field label="New name" value={renameTo} onChangeText={setRenameTo} placeholder={server.name} />
          <Button
            label="Rename everywhere"
            loading={renameMutation.isPending}
            disabled={!renameTo.trim() || renameTo.trim() === server.name}
            onPress={() => renameMutation.mutate({ name: server.name, newName: renameTo.trim() })}
          />
        </Disclosure>
      </Card>

      {revealed ? (
        <Notice tone="error">
          <View style={{ gap: t.space.sm }}>
            <Text style={t.text.body}>
              Secrets are in clear text on this pane. They re-mask when the editor closes or you leave this server.
            </Text>
            <View style={{ flexDirection: "row", gap: t.space.sm }}>
              <Button label="Hide secrets" onPress={() => setRevealed(false)} />
            </View>
          </View>
        </Notice>
      ) : null}

      {authQuery.data ? (
        <AuthRows
          server={server.name}
          accounts={authQuery.data.accounts}
          destinations={destinations}
          presentIn={server.presentIn}
          sessions={sessions}
          oauthCapable={server.transport === "http" && server.authStyle === "oauth-or-none"}
          daemonIsLocal={daemonIsLocal}
          pendingDir={loginMutation.isPending ? loginMutation.variables?.accountDir ?? null : null}
          onAuthorise={(account) =>
            loginMutation.mutate({
              provider: account.provider,
              accountDir: account.dir,
              account: account.email,
              server: server.name,
            })
          }
          onCancel={(key) => loginCancelMutation.mutate(key)}
          onSignOut={(account) =>
            logoutMutation.mutate({ provider: account.provider, accountDir: account.dir, server: server.name })
          }
          onCopied={(ok) =>
            setFlash(
              ok
                ? { tone: "ok", text: "Sign-in link copied." }
                : { tone: "attention", text: "No clipboard here — the link above is selectable." },
            )
          }
        />
      ) : null}

      <Section title="Destinations">
        <Card padded={false}>
          {destinations.map((dest, index) => {
            const present = server.presentIn.includes(dest.id);
            const rawRow = rawRows.find((entry) => entry.destId === dest.id);
            const defRow = defRows.find((entry) => entry.destId === dest.id);
            const open = editing === dest.id && present;
            return (
              <Row
                key={dest.id}
                first={index === 0}
                tone={present ? undefined : "attention"}
                title={dest.label}
                subtitle={
                  present
                    ? rawRow?.nativePreview ?? (rawQuery.isFetching ? "reading…" : undefined)
                    : "not defined here"
                }
                trailing={
                  present ? (
                    open ? undefined : (
                      <>
                        <Button
                          label="Edit"
                          onPress={() => {
                            setEditing(dest.id);
                            setEditTab("fields");
                          }}
                        />
                        <ConfirmButton
                          label="Remove"
                          confirmLabel="Remove from here"
                          onConfirm={() => removeMutation.mutate({ name: server.name, targets: [dest.id] })}
                        />
                      </>
                    )
                  ) : (
                    <Button
                      label="Add here"
                      loading={applyMutation.isPending && (applyMutation.variables?.targets ?? []).includes(dest.id)}
                      disabled={applyMutation.isPending}
                      onPress={() => applyMutation.mutate({ name: server.name, targets: [dest.id] })}
                    />
                  )
                }
                expanded={
                  open ? (
                    <DestinationEditor
                      tab={editTab}
                      onTab={setEditTab}
                      defRow={defRow}
                      rawRow={rawRow}
                      saving={editOneMutation.isPending}
                      otherCount={destinations.length - 1}
                      onSaveFields={(input) => editOneMutation.mutate({ destId: dest.id, ...input })}
                      onPut={(json, dryRun) => putJson(dest.id, json, dryRun)}
                      onCopyEverywhere={() =>
                        applyMutation.mutate({
                          name: server.name,
                          targets: destinations.filter((other) => other.id !== dest.id).map((other) => other.id),
                          sourceDestId: dest.id,
                        })
                      }
                      onClose={closeEditor}
                    />
                  ) : undefined
                }
              />
            );
          })}
        </Card>
      </Section>

    </View>
  ) : (
    emptyPane
  );

  const detail = mode === "add" ? addPane : mode === "import" ? importPane : selected ? serverPane : emptyPane;

  return (
    <Screen t={t}>
      <Toolbar
        title="MCP"
        subtitle="User-level servers, shared by every project on this machine."
        actions={
          layout.compact ? (
            <View style={{ gap: t.space.sm, flex: 1 }}>
              <View style={{ flexDirection: "row", gap: t.space.sm }}>{toolbarActions.slice(0, 2)}</View>
              <View style={{ flexDirection: "row", gap: t.space.sm }}>{toolbarActions.slice(2)}</View>
            </View>
          ) : (
            toolbarActions
          )
        }
        below={
          <View style={{ gap: t.space.md }}>
            {flash ? (
              <Notice tone={flash.tone} onDismiss={() => setFlash(null)}>
                {flash.text.includes("\n") ? <CodeBlock tone={flash.tone}>{flash.text}</CodeBlock> : flash.text}
              </Notice>
            ) : null}
            {filters}
          </View>
        }
      />
      <SplitView list={list} detail={detail} showDetail={mode !== "browse" || Boolean(selected)} />
    </Screen>
  );
}
