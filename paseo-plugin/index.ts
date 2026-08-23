import type { PluginContext } from "@getpaseo/plugin";
import { AgentSyncSurface } from "./agents.client";
import {
  diagnoseProvider,
  mcpAdd,
  mcpApply,
  mcpAuth,
  mcpDefAll,
  mcpEditOne,
  mcpHealth,
  mcpMatrix,
  mcpRemove,
  mcpSync,
  providerHealth,
  accountUsage,
  addAccount,
  scan,
  setCooldown,
  wireAuto,
  wireProvider,
} from "./contracts.shared";
import {
  handleDiagnoseProvider,
  handleMcpAdd,
  handleMcpApply,
  handleMcpAuth,
  handleMcpDefAll,
  handleMcpEditOne,
  handleMcpHealth,
  handleMcpMatrix,
  handleMcpRemove,
  handleMcpSync,
  handleProviderHealth,
  handleAccountUsage,
  handleAddAccount,
  handleScan,
  handleSetCooldown,
  handleWireAuto,
  handleWireProvider,
} from "./handlers.server";
import { McpSurface } from "./mcp.client";

export default function contribute(plugin: PluginContext) {
  plugin.handle(scan, handleScan);
  plugin.handle(wireProvider, handleWireProvider);
  plugin.handle(wireAuto, handleWireAuto);
  plugin.handle(setCooldown, handleSetCooldown);
  plugin.handle(addAccount, handleAddAccount);
  plugin.handle(accountUsage, handleAccountUsage);
  plugin.handle(diagnoseProvider, handleDiagnoseProvider);
  plugin.handle(providerHealth, handleProviderHealth);
  plugin.handle(mcpMatrix, handleMcpMatrix);
  plugin.handle(mcpAdd, handleMcpAdd);
  plugin.handle(mcpApply, handleMcpApply);
  plugin.handle(mcpAuth, handleMcpAuth);
  plugin.handle(mcpDefAll, handleMcpDefAll);
  plugin.handle(mcpEditOne, handleMcpEditOne);
  plugin.handle(mcpHealth, handleMcpHealth);
  plugin.handle(mcpRemove, handleMcpRemove);
  plugin.handle(mcpSync, handleMcpSync);

  plugin.addSurface("agent-sync", AgentSyncSurface);
  plugin.addSurface("mcp", McpSurface);
  plugin.addSidebarItem({ id: "agent-sync", title: "Agent Link", icon: "Users", surface: "agent-sync" });
  plugin.addSidebarItem({ id: "mcp", title: "MCP", icon: "Plug", surface: "mcp" });
  plugin.addCommandCenterItem({
    id: "open-agent-sync",
    title: "Open Agent Link (accounts & provider health)",
    icon: "Users",
    keywords: ["accounts", "providers", "auth", "health", "agent-link"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("agent-sync");
    },
  });
  plugin.addCommandCenterItem({
    id: "open-mcp",
    title: "Open MCP management",
    icon: "Plug",
    keywords: ["mcp", "servers", "add", "sync"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("mcp");
    },
  });
  return () => {};
}
