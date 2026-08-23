import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { canvasCopy, canvasOpen, canvasServe, canvasState, canvasStop, type Artifact, type CanvasState } from "./canvas.shared";
import { Badge, Btn, Dot, STATUS, makeStyles } from "./ui.client";

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

export function CanvasSurface({ theme, layout }: PluginSurfaceProps) {
  const queryClient = useQueryClient();
  const callState = useRpc(canvasState);
  const callServe = useRpc(canvasServe);
  const callStop = useRpc(canvasStop);
  const callOpen = useRpc(canvasOpen);
  const callCopy = useRpc(canvasCopy);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const Button = (props: React.ComponentProps<typeof Btn>) => <Btn compact={layout.compact} {...props} />;

  const query = useQuery({
    queryKey: ["agent-link", "canvas"],
    queryFn: () => callState({}),
    // A tunnel takes a few seconds to come up; poll while one is starting.
    refetchInterval: (result) => (result.state.data?.tunnel.state === "starting" ? 2_000 : false),
  });
  const apply = (next: CanvasState) => queryClient.setQueryData(["agent-link", "canvas"], next);

  const serveMutation = useMutation({
    mutationFn: (input: { path: string; share: boolean }) => callServe(input),
    onSuccess: (next, input) => {
      apply(next);
      const artifact = next.artifacts.find((candidate) => candidate.path === input.path);
      if (input.share && next.tunnel.state === "failed") setNotice(next.tunnel.error);
      else if (input.share && artifact?.publicUrl) setNotice("Public link ready — anyone with it can open this file.");
      else if (input.share) setNotice("Opening a public link. Cloudflare takes a few seconds to publish the address.");
      else if (artifact?.localUrl) setNotice("Serving locally. Open it on this machine, or press Share for a link.");
    },
    onError: (error: Error) => setNotice(error.message),
  });
  const stopMutation = useMutation({
    mutationFn: (path?: string) => callStop(path ? { path } : {}),
    onSuccess: apply,
  });
  const copy = async (url: string) => {
    await callCopy({ url });
    setCopied(url);
    setTimeout(() => setCopied((current) => (current === url ? null : current)), 1_500);
  };

  const data = query.data;
  const groups = useMemo(() => {
    const map = new Map<string, Artifact[]>();
    for (const artifact of data?.artifacts ?? []) {
      const list = map.get(artifact.where) ?? [];
      list.push(artifact);
      map.set(artifact.where, list);
    }
    return [...map.entries()];
  }, [data?.artifacts]);

  const tunnelState = data?.tunnel.state ?? "off";
  const tunnelColor =
    tunnelState === "on" ? STATUS.green : tunnelState === "starting" ? STATUS.orange : tunnelState === "failed" ? STATUS.red : theme.colors.foregroundMuted;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View style={{ gap: 2, flexShrink: 1 }}>
          <Text style={styles.title}>Canvas</Text>
          <Text style={styles.subtitle}>
            The HTML your agents write — dashboards, reports, diagrams. Preview one here, or hand out a link that works anywhere.
          </Text>
        </View>
        <View style={styles.row}>
          <Button label={query.isFetching ? "Scanning…" : "Rescan"} kind="quiet" theme={theme} onPress={() => void callState({ refresh: true }).then(apply)} />
          {(data?.serving.length ?? 0) > 0 ? (
            <Button label="Stop all" kind="danger" theme={theme} onPress={() => stopMutation.mutate(undefined)} />
          ) : null}
        </View>
      </View>

      {notice ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{notice}</Text>
        </View>
      ) : null}

      {/* What sharing needs, said once, before anyone presses a button. */}
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <View style={styles.row}>
            <Dot color={data?.cloudflared.installed ? tunnelColor : STATUS.orange} />
            <Text style={styles.strong}>
              {!data?.cloudflared.installed
                ? "Public links need cloudflared"
                : tunnelState === "on"
                  ? "Sharing is live"
                  : tunnelState === "starting"
                    ? "Opening a tunnel…"
                    : tunnelState === "failed"
                      ? "The tunnel failed"
                      : "Ready to share"}
            </Text>
          </View>
          {tunnelState === "on" ? <Badge label="public" theme={theme} tone="danger" /> : null}
        </View>

        {!data?.cloudflared.installed ? (
          <View style={{ gap: 6 }}>
            <Text style={styles.muted}>
              Local preview works without it. For a link other people can open, install cloudflared and press Share again:
            </Text>
            <Text selectable style={styles.monoText}>
              {data?.cloudflared.install ?? "brew install cloudflared"}
            </Text>
          </View>
        ) : (
          <Text style={styles.muted}>
            {tunnelState === "starting"
              ? "Cloudflare needs a few seconds to publish the address. The link appears once it answers — waiting saves you a failed lookup your machine would cache."
              : data?.tunnel.error || data?.cloudflared.note}
          </Text>
        )}

        {tunnelState === "on" ? (
          <View style={styles.rowBetween}>
            <Text selectable style={styles.monoText}>
              {data?.tunnel.url}
            </Text>
            <Button label="Stop sharing" kind="danger" theme={theme} onPress={() => stopMutation.mutate(undefined)} />
          </View>
        ) : null}
      </View>

      {data && data.artifacts.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.strong}>Nothing to show yet</Text>
          <Text style={styles.muted}>
            Ask an agent for a dashboard or report and save it as an .html file in the workspace root or an artifacts/ folder — it appears here.
          </Text>
          {data.roots.length > 0 ? <Text style={styles.monoText}>looked in: {data.roots.length} folder{data.roots.length === 1 ? "" : "s"}</Text> : null}
          {data.error ? <Text style={styles.danger}>{data.error}</Text> : null}
        </View>
      ) : null}

      {groups.map(([where, artifacts]) => (
        <View key={where} style={styles.card}>
          <Text style={styles.sectionTitle}>{where}</Text>
          {artifacts.map((artifact) => {
            const live = Boolean(artifact.localUrl);
            const url = artifact.publicUrl || artifact.localUrl;
            return (
              <View key={artifact.path} style={[styles.divider, { paddingTop: styles.gap, gap: 6 }]}>
                <View style={styles.rowBetween}>
                  <View style={{ gap: 2, flexShrink: 1 }}>
                    <View style={styles.row}>
                      <Dot color={artifact.publicUrl ? STATUS.green : live ? STATUS.orange : theme.colors.foregroundMuted + "88"} />
                      <Text style={styles.strong}>{artifact.title || artifact.name}</Text>
                      {artifact.publicUrl ? <Badge label="shared" theme={theme} tone="danger" /> : null}
                    </View>
                    <Text style={styles.monoText}>
                      {artifact.dir}/{artifact.name}
                    </Text>
                    <Text style={styles.muted}>
                      {size(artifact.bytes)} · {ago(artifact.modified)}
                    </Text>
                  </View>
                </View>

                <View style={styles.row}>
                  <Button
                    label={live ? "Open" : "Preview"}
                    theme={theme}
                    kind={live ? "primary" : "quiet"}
                    onPress={() => {
                      if (live) void callOpen({ url: artifact.localUrl }).then((result) => setNotice(result.message));
                      else serveMutation.mutate({ path: artifact.path, share: false });
                    }}
                  />
                  {artifact.publicUrl ? (
                    <>
                      <Button label={copied === artifact.publicUrl ? "Copied" : "Copy link"} kind="quiet" theme={theme} onPress={() => void copy(artifact.publicUrl)} />
                      <Button label="Unshare" kind="danger" theme={theme} onPress={() => stopMutation.mutate(artifact.path)} />
                    </>
                  ) : (
                    <Button
                      label={tunnelState === "starting" ? "Opening…" : "Share"}
                      kind="quiet"
                      theme={theme}
                      disabled={serveMutation.isPending || tunnelState === "starting"}
                      onPress={() => serveMutation.mutate({ path: artifact.path, share: true })}
                    />
                  )}
                  {live && !artifact.publicUrl ? (
                    <Button label="Stop" kind="quiet" theme={theme} onPress={() => stopMutation.mutate(artifact.path)} />
                  ) : null}
                </View>

                {url ? (
                  <Text selectable style={styles.monoText}>
                    {url}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      ))}

      <Text style={styles.muted}>
        Files are read from disk on request — nothing is uploaded or copied. A shared link is public while it is up and stops working when Paseo stops.
      </Text>
    </ScrollView>
  );
}
