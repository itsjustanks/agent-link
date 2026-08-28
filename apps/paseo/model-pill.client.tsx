import {
  Icon,
  type PluginClientContext,
  type PluginComposerPillProps,
  useAgent,
  useRpc,
} from "@getpaseo/plugin";
import type { PaseoAgent, PaseoAgentListResult, PaseoAgentUpdate } from "@getpaseo/client";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { Text } from "react-native";
import { routerTrace } from "./contracts.shared";
import { friendlyModelName, resolveRuntimeModel, UNKNOWN_MODEL } from "./model.shared";

function activeAnswerModel(nodes: Array<{ source: string; provider: string; model: string; status: string }>) {
  const answers = nodes.filter((node) => node.source === "paseo");
  return answers.find((node) => /running|working|start/i.test(node.status)) ?? answers.at(-1) ?? null;
}

export function AgentModelPill({ theme, agentId }: PluginComposerPillProps) {
  const agent = useAgent(agentId, ({ provider, model }) => ({ provider, model }));
  const identity = resolveRuntimeModel(agent?.provider, agent?.model);
  const isRouter = identity.provider === "agent-router";
  const readTrace = useRpc(routerTrace);
  const trace = useQuery({
    queryKey: ["agent-link", "model-pill", agentId],
    queryFn: () => readTrace({ agentId }),
    enabled: isRouter,
    refetchInterval: isRouter ? 15_000 : false,
  });
  const answer = activeAnswerModel(trace.data?.nodes ?? []);
  const answerIdentity = answer ? resolveRuntimeModel(answer.provider, answer.model) : null;
  const label = isRouter
    ? answerIdentity && answerIdentity.model !== UNKNOWN_MODEL
      ? `AgentRouter → ${friendlyModelName(answerIdentity.model)}`
      : "AgentRouter · routing…"
    : friendlyModelName(identity.model);

  return (
    <>
      <Icon name={isRouter ? "Route" : "Cpu"} size={14} color={theme.colors.foregroundMuted} />
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, flexShrink: 1 }}>
        {label}
      </Text>
    </>
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
        title: "Open model and routing evidence",
        workspaceId,
        agentId: agent.id,
        Component: AgentModelPill,
        onPress() {
          client.openPanel("agent-routing", { workspaceId, agentId: agent.id });
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
