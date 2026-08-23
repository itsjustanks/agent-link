import type { PluginAgentPanelProps, PluginSurfaceProps } from "@getpaseo/plugin";
import { usePaseo, useRpc, useWorkspace } from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useMemo, useState } from "react";
import * as ReactNative from "react-native";
import { Clipboard, Platform, Text, View } from "react-native";
import {
  canvasCopy,
  canvasOpen,
  canvasRender,
  canvasServe,
  canvasSource,
  canvasState,
  canvasStop,
  type Artifact,
  type CanvasState,
} from "./canvas.shared";
import {
  Button,
  Card,
  CodeBlock,
  Disclosure,
  EmptyState,
  Facts,
  Field,
  Figure,
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
  useUi,
  type Status,
} from "./ui.client";

/**
 * The live escape hatch.
 *
 * A plugin surface is React Native, so there is no WebView component to reach
 * for — but on desktop and in the browser Paseo's "react-native" IS
 * react-native-web, whose `unstable_createElement` makes an arbitrary DOM node
 * and passes unknown props straight to it. Paseo renders its own HTML file
 * previews and its mermaid runtime through exactly this, so an iframe here is
 * the same mechanism the app already trusts, not a hack around it.
 *
 * On a phone the export does not exist and this returns null, which is why the
 * rasterised preview stays the default everywhere.
 */
const createDom = (ReactNative as unknown as {
  unstable_createElement?: (tag: string, props: Record<string, unknown>) => React.ReactElement;
}).unstable_createElement;

export const canGoLive = Platform.OS === "web" && typeof createDom === "function";

function LiveFrame({ url, height, title }: { url: string; height: number; title: string }) {
  if (!createDom) return null;
  return createDom("iframe", {
    src: url,
    title,
    // Scripts yes — a dashboard without them is a screenshot with extra steps.
    // No allow-same-origin: the page runs in an opaque origin, so it cannot
    // reach back into Paseo or read anything else this machine serves.
    sandbox: "allow-scripts allow-forms allow-popups",
    referrerPolicy: "no-referrer",
    style: { width: "100%", height, border: "none", borderRadius: 10, background: "white" },
  });
}

function ago(epoch: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - epoch);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const KIND_LABEL: Record<Artifact["kind"], string> = {
  html: "page",
  markdown: "report",
  svg: "diagram",
  image: "image",
};

/**
 * What an agent is told when you ask for a dashboard. The rules are the ones
 * that decide whether the result renders at all: one file, nothing fetched at
 * runtime, and a title — the panel rasterises it on the daemon with no network
 * guarantees and lists it by that title.
 */
function brief(request: string, name: string): string {
  return [
    `Build a self-contained HTML dashboard and save it as artifacts/${name}.html in this workspace.`,
    "",
    request.trim(),
    "",
    "Requirements:",
    "- One file. Inline all CSS and JavaScript; no CDN links, no external fonts, no runtime fetches.",
    "- Give it a <title> — that is the name it appears under.",
    "- Lay it out for a 1200px-wide page, and make it readable on a dark background.",
    "- Use real data you can read from this repository; where you cannot, label the number as an estimate.",
    "- When it is written, reply with just the path.",
  ].join("\n");
}

/**
 * One view, two homes: the sidebar surface sees every artifact on the machine,
 * and the agent panel sees only its own workspace's — and can post a render
 * straight into that agent's conversation, which is the one place a picture of
 * the thing being discussed actually belongs.
 */
function CanvasView({
  theme,
  layout,
  hostLabel,
  agentId,
  scopeDir,
}: {
  theme: PluginSurfaceProps["theme"];
  layout: PluginSurfaceProps["layout"];
  hostLabel?: string;
  agentId?: string;
  scopeDir?: string;
}) {
  const t = useUi(theme, layout.compact);
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const callState = useRpc(canvasState);
  const callRender = useRpc(canvasRender);
  const callServe = useRpc(canvasServe);
  const callStop = useRpc(canvasStop);
  const callOpen = useRpc(canvasOpen);
  const callCopy = useRpc(canvasCopy);
  const callSource = useRpc(canvasSource);

  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "create">("view");
  const [scale, setScale] = useState<"1" | "2">("2");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<{ tone: Status; text: string } | null>(null);
  const [request, setRequest] = useState("");
  const [name, setName] = useState("dashboard");
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [live, setLive] = useState(canGoLive);

  /**
   * The clipboard that matters is the one on the device reading this, not the
   * daemon's — so try the client first and only fall back to the host.
   */
  const copyLink = (url: string) => {
    let done = false;
    try {
      Clipboard.setString(url);
      done = true;
    } catch {
      done = false;
    }
    if (done) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
      return;
    }
    copyMutation.mutate(url);
  };

  const state = useQuery({
    queryKey: ["agent-link", "canvas"],
    queryFn: () => callState({}),
    // While a canvas is open its file is usually being rewritten by the agent
    // that made it. Re-scanning keeps mtime fresh, and the render query is
    // keyed on mtime, so the preview follows the file without being asked.
    refetchInterval: (result) =>
      result.state.data?.tunnel.state === "starting" ? 2_000 : selected ? 5_000 : false,
    refetchOnWindowFocus: true,
  });
  const apply = (next: CanvasState) => queryClient.setQueryData(["agent-link", "canvas"], next);
  const data = state.data;

  const artifacts = useMemo(() => {
    const all = data?.artifacts ?? [];
    return scopeDir ? all.filter((artifact) => artifact.path.startsWith(scopeDir)) : all;
  }, [data?.artifacts, scopeDir]);
  const current = artifacts.find((artifact) => artifact.path === selected) ?? null;
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return artifacts;
    return artifacts.filter((artifact) =>
      `${artifact.title} ${artifact.name} ${artifact.where} ${artifact.dir}`.toLowerCase().includes(needle),
    );
  }, [artifacts, search]);

  // Paseo's own palette goes into generated pages, so a rendered report looks
  // like it belongs in the app rather than like a browser print-out.
  const pageTheme = {
    background: theme.colors.surface0,
    foreground: theme.colors.foreground,
    muted: theme.colors.foregroundMuted,
    accent: theme.colors.accent,
  };

  // Live view needs the page actually served; do it the moment it is asked for
  // rather than making the user press a second button for plumbing.
  useEffect(() => {
    if (!live || !current || current.localUrl || current.publicUrl) return;
    if (serveMutation.isPending) return;
    serveMutation.mutate({ path: current.path, share: false });
  }, [live, current?.path, current?.localUrl, current?.publicUrl]);

  // A frame pointed at the daemon's loopback shows nothing when the daemon is
  // another machine, so ask before rendering one. no-cors resolves opaque on
  // success and rejects on a network error, which is all this needs to know.
  const reachable = useQuery({
    queryKey: ["agent-link", "canvas-reachable", current?.localUrl],
    queryFn: async () => {
      if (!current?.localUrl) return false;
      try {
        await fetch(current.localUrl, { mode: "no-cors", signal: AbortSignal.timeout(2_500) });
        return true;
      } catch {
        return false;
      }
    },
    enabled: live && Boolean(current?.localUrl),
    staleTime: 60_000,
    retry: false,
  });

  const render = useQuery({
    queryKey: ["agent-link", "canvas-render", current?.path, current?.modified, scale, theme.colors.surface0],
    queryFn: () =>
      callRender({ path: current!.path, width: 1200, scale: Number(scale), theme: pageTheme }),
    enabled: Boolean(current) && Boolean(data?.renderer.installed) && !live,
    staleTime: Infinity,
    retry: false,
  });

  const source = useQuery({
    queryKey: ["agent-link", "canvas-source", current?.path, current?.modified],
    queryFn: () => callSource({ path: current!.path }),
    enabled: false,
    retry: false,
  });

  const workspaces = useQuery({
    queryKey: ["agent-link", "canvas-workspaces"],
    queryFn: async () => {
      const result = (await paseo.workspaces.list({ page: { limit: 200 } })) as {
        entries: Array<Record<string, unknown>>;
      };
      return (result.entries ?? [])
        .filter((entry) => !entry.archivingAt)
        .map((entry) => ({ id: String(entry.id), name: String(entry.name ?? entry.id) }));
    },
    enabled: mode === "create",
  });

  const providers = useQuery({
    queryKey: ["agent-link", "canvas-providers"],
    queryFn: async () => {
      const { config } = (await paseo.config.get()) as { config: Record<string, unknown> };
      const shape = config as { providers?: Record<string, unknown>; agents?: { providers?: Record<string, unknown> } };
      // The daemon returns providers flattened; older shapes nest them.
      const ids = Object.keys(shape.providers ?? shape.agents?.providers ?? {});
      const preferred = ids.find((id) => id === "claude-auto") ?? ids.find((id) => id.startsWith("claude")) ?? ids[0];
      return { ids, preferred: preferred ?? "claude" };
    },
    enabled: mode === "create",
  });

  // Only agents whose working directory contains the artifact are offered —
  // posting a dashboard into an unrelated conversation helps nobody.
  const agents = useQuery({
    queryKey: ["agent-link", "canvas-agents"],
    queryFn: async () => {
      const result = (await paseo.agents.list({ page: { limit: 100 } })) as {
        entries: Array<Record<string, unknown>>;
      };
      return (result.entries ?? [])
        .filter((entry) => entry.status !== "closed")
        .map((entry) => ({
          id: String(entry.id),
          title: String(entry.title ?? entry.id),
          cwd: String(entry.cwd ?? ""),
          status: String(entry.status ?? ""),
        }));
    },
    enabled: !agentId,
  });

  const sendToChat = useMutation({
    mutationFn: async (input: { path: string; to: string; title: string }) => {
      // PNG rather than the panel's WebP: a chat attachment travels further
      // than this surface does.
      const shot = await callRender({
        path: input.path,
        width: 1200,
        scale: 2,
        theme: pageTheme,
        format: "png",
      });
      const handle = paseo.agents.ref(input.to) as unknown as {
        send: (text: string, options?: Record<string, unknown>) => Promise<unknown>;
      };
      await handle.send(input.title, { images: [{ data: shot.base64, mimeType: "image/png" }] });
      return input.title;
    },
    onSuccess: (title) =>
      setNotice({ tone: "ok", text: `Posted “${title}” into the conversation — the agent can see it too.` }),
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });

  const serveMutation = useMutation({
    mutationFn: (input: { path: string; share: boolean }) => callServe({ ...input, theme: pageTheme }),
    onSuccess: (next, input) => {
      apply(next);
      const artifact = next.artifacts.find((candidate) => candidate.path === input.path);
      if (input.share && next.tunnel.state === "failed") setNotice({ tone: "error", text: next.tunnel.error });
      else if (input.share && artifact?.publicUrl)
        setNotice({ tone: "ok", text: "Public link ready — anyone holding it can open this file." });
      else if (input.share)
        setNotice({ tone: "attention", text: "Opening a public link. Cloudflare takes a few seconds to publish the address." });
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });
  const stopMutation = useMutation({
    mutationFn: (path?: string) => callStop(path ? { path } : {}),
    onSuccess: apply,
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });
  const openMutation = useMutation({
    mutationFn: (url: string) => callOpen({ url }),
    onSuccess: (result) => setNotice({ tone: result.opened ? "ok" : "error", text: result.message }),
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });
  const copyMutation = useMutation({
    mutationFn: (url: string) => callCopy({ url }),
    onSuccess: () => setNotice({ tone: "ok", text: "Link copied on the daemon machine. It is also selectable above." }),
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });
  const rescan = useMutation({
    mutationFn: () => callState({ refresh: true }),
    onSuccess: apply,
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error("Pick a workspace for the new canvas.");
      const provider = providers.data?.preferred ?? "claude";
      const slug = (name.trim() || "dashboard").replace(/[^a-zA-Z0-9._-]/g, "-");
      const workspace = paseo.workspaces.ref(target.id) as unknown as {
        agents: { create: (options: Record<string, unknown>) => Promise<unknown> };
      };
      await workspace.agents.create({
        config: { provider },
        title: `Canvas: ${slug}`,
        prompt: brief(request, slug),
      });
      return slug;
    },
    onSuccess: (slug) => {
      setMode("view");
      setRequest("");
      setNotice({
        tone: "ok",
        text: `An agent is building ${slug}.html in ${target?.name}. Press Rescan when it reports back and it appears here.`,
      });
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message }),
  });

  // Land on something. An empty right-hand pane on a screen that has just
  // listed forty artifacts is a click asked for no reason — on a phone the
  // list is the whole screen, so there it stays.
  useEffect(() => {
    if (selected || mode === "create" || t.compact) return;
    const first = artifacts[0];
    if (first) setSelected(first.path);
  }, [artifacts, selected, mode, t.compact]);

  const tunnelState = data?.tunnel.state ?? "off";
  const tunnelStatus: Status =
    tunnelState === "on" ? "ok" : tunnelState === "starting" ? "busy" : tunnelState === "failed" ? "error" : "neutral";
  const sharing = (data?.serving.length ?? 0) > 0;

  const list = (
    <Card padded={false}>
      <View style={{ padding: t.space.md, gap: t.space.sm }}>
        <Field value={search} onChangeText={setSearch} placeholder={`Search ${artifacts.length} artifacts`} />
      </View>
      {filtered.length === 0 ? (
        <EmptyState
          title={artifacts.length === 0 ? "Nothing built yet" : "No match"}
          body={
            artifacts.length === 0
              ? "Anything an agent writes as .html, .md or .svg in a workspace — or in artifacts/, reports/, dashboards/ — shows up here. Or press New canvas and describe what you want."
              : "No artifact matches that search."
          }
        />
      ) : null}
      {filtered.slice(0, 200).map((artifact, index) => (
        <Row
          key={artifact.path}
          first={index === 0}
          selected={artifact.path === current?.path}
          onPress={() => {
            setSelected(artifact.path);
            setMode("view");
          }}
          title={artifact.title || artifact.name}
          subtitle={artifact.where}
          meta={
            <Facts
              items={[
                { value: KIND_LABEL[artifact.kind] },
                { value: ago(artifact.modified) },
                artifact.publicUrl ? { value: "shared", tone: "ok" } : null,
              ]}
            />
          }
        />
      ))}
    </Card>
  );

  const detail = mode === "create" ? (
    <Card>
      <Section title="New canvas">
        <Text style={t.text.body}>
          Describe the dashboard and an agent builds it in the workspace you choose, as a single self-contained page.
          It appears in this list when the agent has written it.
        </Text>
      </Section>
      <Field
        label="What should it show?"
        value={request}
        onChangeText={setRequest}
        multiline
        minHeight={110}
        placeholder="A dashboard of this repo's test suite: pass rate over the last 30 days, slowest tests, and which files changed most."
      />
      <Field label="File name" value={name} onChangeText={setName} hint={`Saved as artifacts/${(name.trim() || "dashboard").replace(/[^a-zA-Z0-9._-]/g, "-")}.html`} />
      <Section title="Workspace">
        {workspaces.isPending ? <Loading label="Reading workspaces…" /> : null}
        <View style={{ maxHeight: 220 }}>
          <Card level={2} padded={false}>
            {(workspaces.data ?? []).slice(0, 40).map((workspace, index) => (
              <Row
                key={workspace.id}
                first={index === 0}
                selected={target?.id === workspace.id}
                onPress={() => setTarget(workspace)}
                title={workspace.name}
              />
            ))}
          </Card>
        </View>
      </Section>
      <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "center" }}>
        <Button
          label="Build it"
          variant="primary"
          loading={create.isPending}
          disabled={!request.trim() || !target}
          onPress={() => create.mutate()}
        />
        <Button label="Cancel" variant="ghost" onPress={() => setMode("view")} />
        {providers.data ? <Tag label={`via ${providers.data.preferred}`} /> : null}
      </View>
    </Card>
  ) : !current ? (
    <Card>
      <EmptyState
        title="Pick an artifact"
        body="It renders here, inside Paseo — the page is rasterised on the daemon machine, so this works the same when the daemon is a server somewhere else. Sharing is separate: that hands out a live link to the real page."
        action={<Button label="New canvas" variant="primary" onPress={() => setMode("create")} />}
      />
    </Card>
  ) : (
    <View style={{ gap: t.space.md }}>
      <Card>
        <View style={{ flexDirection: t.compact ? "column" : "row", justifyContent: "space-between", gap: t.space.md }}>
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text style={t.text.heading} numberOfLines={2}>
              {current.title || current.name}
            </Text>
            <Facts
              items={[
                { value: KIND_LABEL[current.kind] },
                { value: size(current.bytes) },
                { value: ago(current.modified) },
              ]}
            />
            <Text selectable style={t.text.mono} numberOfLines={1}>
              {current.dir}/{current.name}
            </Text>
          </View>
          <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "flex-start", flexShrink: 0 }}>
            {canGoLive ? (
              <Segmented
                value={live ? "live" : "image"}
                onChange={(value) => setLive(value === "live")}
                options={[
                  { value: "live", label: "Live" },
                  { value: "image", label: "Image" },
                ]}
              />
            ) : null}
            {!live ? (
              <Segmented
                value={scale}
                onChange={setScale}
                options={[
                  { value: "1", label: "1×" },
                  { value: "2", label: "2×" },
                ]}
              />
            ) : null}
            <Button label="Refresh" variant="ghost" loading={render.isFetching} onPress={() => void render.refetch()} />
          </View>
        </View>

        {live ? (
          (() => {
            const frameUrl = reachable.data === false ? current.publicUrl : current.localUrl || current.publicUrl;
            if (!frameUrl) return <Loading label="Starting the page…" />;
            if (reachable.data === false && !current.publicUrl) {
              return (
                <Notice tone="attention">
                  This page is served by the machine running Paseo, which this device cannot reach. Get a link and the
                  live view works from anywhere — or switch to Image, which always works.
                </Notice>
              );
            }
            return (
              <View style={{ gap: t.space.sm }}>
                {/* Remounting on mtime is what makes it follow the agent: the
                    file changes, the frame reloads, no button involved. */}
                <LiveFrame
                  key={`${frameUrl}:${current.modified}`}
                  url={frameUrl}
                  height={t.compact ? 420 : 720}
                  title={current.title || current.name}
                />
                <Text style={t.text.caption}>
                  Live and interactive{reachable.data === false ? " over the shared link" : ""} — it reloads when the
                  agent rewrites the file.
                </Text>
              </View>
            );
          })()
        ) : data?.renderer.installed ? (
          <Figure
            uri={render.data?.dataUri}
            width={render.data?.width}
            height={render.data?.height}
            loading={render.isFetching}
            label={current.title || current.name}
            note={
              render.data?.truncated
                ? "Cut off at 12,000px — share it and open the link for the whole page."
                : render.data
                  ? `${render.data.width}×${render.data.height} · ${size(render.data.bytes)}${render.data.fromCache ? " · cached" : ` · ${render.data.ms}ms`}`
                  : undefined
            }
            placeholder={
              render.error ? (
                <View style={{ padding: t.space.lg }}>
                  <Notice tone="error">{(render.error as Error).message}</Notice>
                </View>
              ) : null
            }
          />
        ) : (
          <Notice tone="attention">
            <View style={{ gap: t.space.sm }}>
              <Text style={t.text.body}>{data?.renderer.note}</Text>
              <CodeBlock>{data?.renderer.install ?? ""}</CodeBlock>
            </View>
          </Notice>
        )}

        {/* What you came for, in order: put it in the conversation, or get a
            link someone else can open. Running a browser is a fallback for an
            interactive page, and it happens on the Paseo host rather than on
            whatever device is reading this — so it is last and it says so. */}
        <View style={{ flexDirection: "row", gap: t.space.sm, flexWrap: "wrap", alignItems: "center" }}>
          {agentId ? (
            <Button
              label="Send to chat"
              variant="primary"
              loading={sendToChat.isPending}
              onPress={() =>
                sendToChat.mutate({ path: current.path, to: agentId, title: current.title || current.name })
              }
            />
          ) : null}
          {current.publicUrl ? (
            <>
              <Button
                label={copied ? "Copied" : "Copy link"}
                variant={agentId ? "secondary" : "primary"}
                onPress={() => copyLink(current.publicUrl)}
              />
              <Button label="Stop sharing" variant="ghost" onPress={() => stopMutation.mutate(current.path)} />
            </>
          ) : (
            <Button
              label={tunnelState === "starting" ? "Making a link…" : "Get a link"}
              variant={agentId ? "secondary" : "primary"}
              loading={serveMutation.isPending || tunnelState === "starting"}
              onPress={() => serveMutation.mutate({ path: current.path, share: true })}
            />
          )}
        </View>

        {current.publicUrl ? (
          <Text selectable style={t.text.mono}>
            {current.publicUrl}
          </Text>
        ) : null}
      </Card>

      <Card>
        <Disclosure title="Open it in a real browser">
          <Text style={t.text.caption}>
            The preview above is a picture, so anything interactive — a filter, a chart tooltip — needs the real page.
            This launches a browser on the machine running Paseo{" "}
            {hostLabel ? `(${hostLabel})` : ""}, which is only useful if that is the machine you are sitting at.
            Otherwise get a link and open it here.
          </Text>
          <View style={{ flexDirection: "row", gap: t.space.sm, flexWrap: "wrap" }}>
            <Button
              label="Open on the Paseo host"
              variant="secondary"
              loading={openMutation.isPending || serveMutation.isPending}
              onPress={() => {
                if (current.localUrl) openMutation.mutate(current.localUrl);
                else
                  serveMutation
                    .mutateAsync({ path: current.path, share: false })
                    .then((next) => {
                      const url = next.artifacts.find((a) => a.path === current.path)?.localUrl;
                      if (url) openMutation.mutate(url);
                    })
                    .catch(() => undefined);
              }}
            />
            {current.localUrl ? (
              <Text selectable style={t.text.mono}>
                {current.localUrl}
              </Text>
            ) : null}
          </View>
        </Disclosure>
      </Card>

      {!agentId ? (
        <Card>
          <Disclosure title="Send this to an agent">
            {agents.isPending ? <Loading label="Looking for agents…" /> : null}
            {(agents.data ?? []).filter((agent) => !agent.cwd || current.path.startsWith(agent.cwd)).length === 0 ? (
              <Text style={t.text.caption}>
                No live agent is working in this artifact's folder. Open the Canvas panel beside an agent to post it
                into that conversation.
              </Text>
            ) : null}
            {(agents.data ?? [])
              .filter((agent) => !agent.cwd || current.path.startsWith(agent.cwd))
              .slice(0, 8)
              .map((agent, index) => (
                <Row
                  key={agent.id}
                  first={index === 0}
                  title={agent.title}
                  subtitle={agent.status}
                  trailing={
                    <Button
                      label="Send"
                      loading={sendToChat.isPending && sendToChat.variables?.to === agent.id}
                      onPress={() =>
                        sendToChat.mutate({ path: current.path, to: agent.id, title: current.title || current.name })
                      }
                    />
                  }
                />
              ))}
          </Disclosure>
        </Card>
      ) : null}

      {current.kind !== "image" ? (
        <Card>
          <Disclosure title="Source">
            <Button label={source.data ? "Reload" : "Read the file"} variant="ghost" onPress={() => void source.refetch()} />
            {source.isFetching ? <Loading /> : null}
            {source.data ? (
              <CodeBlock>
                {source.data.text.slice(0, 8000) + (source.data.truncated || source.data.text.length > 8000 ? "\n…" : "")}
              </CodeBlock>
            ) : null}
          </Disclosure>
        </Card>
      ) : null}
    </View>
  );

  return (
    <Screen t={t}>
      <Toolbar
        title="Canvas"
        subtitle="What your agents built — rendered here, or handed out as a link."
        actions={
          <>
            <Button label="New canvas" variant="primary" onPress={() => setMode("create")} />
            <Button label="Rescan" variant="ghost" loading={rescan.isPending} onPress={() => rescan.mutate()} />
          </>
        }
        below={
          sharing || tunnelState !== "off" ? (
            <Card level={2}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.md, flexWrap: "wrap" }}>
                <StatusPill
                  status={tunnelStatus}
                  label={
                    tunnelState === "on"
                      ? "Sharing live"
                      : tunnelState === "starting"
                        ? "Opening a link"
                        : tunnelState === "failed"
                          ? "Sharing failed"
                          : "Serving locally"
                  }
                />
                <Text style={[t.text.caption, { flex: 1, minWidth: 160 }]}>
                  {tunnelState === "on"
                    ? "Read from disk on every request, so the link always shows the current file. It stops when Paseo stops."
                    : tunnelState === "starting"
                      ? "Cloudflare takes a few seconds to publish the address. The link appears once it answers."
                      : data?.tunnel.error || `${data?.serving.length ?? 0} file(s) served on this machine.`}
                </Text>
                <Button label="Stop all" variant="danger" onPress={() => stopMutation.mutate(undefined)} />
              </View>
            </Card>
          ) : undefined
        }
      />

      {notice ? (
        <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>
          {notice.text}
        </Notice>
      ) : null}

      {state.isPending ? <Loading label="Looking for artifacts…" /> : null}
      {data?.error ? <Notice tone="attention">{data.error}</Notice> : null}

      <SplitView
        list={list}
        detail={detail}
        showDetail={Boolean(current) || mode === "create"}
      />

      {t.compact && (current || mode === "create") ? (
        <Button
          label="Back to all artifacts"
          variant="ghost"
          onPress={() => {
            setSelected(null);
            setMode("view");
          }}
        />
      ) : null}
    </Screen>
  );
}

export function CanvasSurface({ theme, layout, host }: PluginSurfaceProps) {
  return <CanvasView theme={theme} layout={layout} hostLabel={host?.label} />;
}

/**
 * The agent-context tab. Scoped to that agent's workspace and able to post a
 * render into its conversation, which is what makes a canvas part of the
 * discussion rather than a file you have to go and look at.
 */
export function CanvasPanel({ theme, layout, host, workspaceId, agentId }: PluginAgentPanelProps) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory || workspace.projectRootPath);
  return (
    <CanvasView
      theme={theme}
      layout={layout}
      hostLabel={host?.label}
      agentId={agentId}
      scopeDir={directory ?? undefined}
    />
  );
}
