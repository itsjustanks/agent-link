import type { PluginContext } from "@getpaseo/plugin";
import { AgentSyncSurface } from "./agents.client";
import { cliInstall, cliStatus, cliUpdateApply, cliUpdateCheck } from "./cli.shared";
import { handleCliInstall, handleCliStatus, handleCliUpdateApply, handleCliUpdateCheck } from "./cli.server";
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
  mcpWorkspace,
  providerHealth,
  providerHeartbeat,
  accountUsage,
  accountCapacity,
  probeAccounts,
  addAccount,
  removeAccount,
  routerInstall,
  routerStatus,
  scan,
  setCooldown,
  setPreference,
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
  handleMcpWorkspace,
  handleProviderHealth,
  handleProviderHeartbeat,
  handleAccountUsage,
  handleAccountCapacity,
  handleProbeAccounts,
  handleAddAccount,
  handleRemoveAccount,
  handleRouterInstall,
  handleRouterStatus,
  handleScan,
  handleSetCooldown,
  handleSetPreference,
  handleWireAuto,
  handleWireProvider,
} from "./handlers.server";
import { runShutdown, runStart } from "./lifecycle.shared";
import { limitsResume, limitsSetAuto, limitsStatus } from "./limits.shared";
import { handleLimitsResume, handleLimitsSetAuto, handleLimitsStatus } from "./limits.server";
import { resourceSetEnabled, resourceStatus } from "./resources.shared";
import { handleResourceSetEnabled, handleResourceStatus } from "./resources.server";
import { McpSurface, McpWorkspacePanel } from "./mcp.client";
import {
  mcpExport,
  mcpExportFile,
  mcpImportApply,
  mcpImportParse,
  mcpLogin,
  mcpLoginComplete,
  mcpLoginCancel,
  mcpLoginStatus,
  mcpLogout,
  mcpRawGet,
  mcpRawPut,
} from "./mcpjson.shared";
import {
  handleMcpExport,
  handleMcpExportFile,
  handleMcpImportApply,
  handleMcpImportParse,
  handleMcpLogin,
  handleMcpLoginComplete,
  handleMcpLoginCancel,
  handleMcpLoginStatus,
  handleMcpLogout,
  handleMcpRawGet,
  handleMcpRawPut,
} from "./mcpjson.server";

// Every contract defined in a *.shared.ts must be registered here. One that is
// not simply fails when the panel calls it, with nothing in the logs to explain
// why — so this list is the thing to check first when a button does nothing.
export default function contribute(plugin: PluginContext) {
  plugin.handle(scan, handleScan);
  plugin.handle(wireProvider, handleWireProvider);
  plugin.handle(wireAuto, handleWireAuto);
  plugin.handle(routerStatus, handleRouterStatus);
  plugin.handle(routerInstall, handleRouterInstall);
  plugin.handle(setCooldown, handleSetCooldown);
  plugin.handle(addAccount, handleAddAccount);
  plugin.handle(removeAccount, handleRemoveAccount);
  plugin.handle(setPreference, handleSetPreference);
  plugin.handle(accountUsage, handleAccountUsage);
  plugin.handle(accountCapacity, handleAccountCapacity);
  plugin.handle(probeAccounts, handleProbeAccounts);
  plugin.handle(diagnoseProvider, handleDiagnoseProvider);
  plugin.handle(providerHealth, handleProviderHealth);
  plugin.handle(providerHeartbeat, handleProviderHeartbeat);
  plugin.handle(mcpMatrix, handleMcpMatrix);
  plugin.handle(mcpAdd, handleMcpAdd);
  plugin.handle(mcpApply, handleMcpApply);
  plugin.handle(mcpAuth, handleMcpAuth);
  plugin.handle(mcpDefAll, handleMcpDefAll);
  plugin.handle(mcpEditOne, handleMcpEditOne);
  plugin.handle(mcpHealth, handleMcpHealth);
  plugin.handle(mcpRemove, handleMcpRemove);
  plugin.handle(mcpSync, handleMcpSync);
  plugin.handle(mcpWorkspace, handleMcpWorkspace);
  plugin.handle(cliStatus, handleCliStatus);
  plugin.handle(cliInstall, handleCliInstall);
  plugin.handle(cliUpdateCheck, handleCliUpdateCheck);
  plugin.handle(cliUpdateApply, handleCliUpdateApply);
  plugin.handle(mcpRawGet, handleMcpRawGet);
  plugin.handle(mcpRawPut, handleMcpRawPut);
  plugin.handle(mcpImportParse, handleMcpImportParse);
  plugin.handle(mcpImportApply, handleMcpImportApply);
  plugin.handle(mcpExport, handleMcpExport);
  plugin.handle(mcpExportFile, handleMcpExportFile);
  plugin.handle(mcpLogin, handleMcpLogin);
  plugin.handle(mcpLoginComplete, handleMcpLoginComplete);
  plugin.handle(mcpLoginStatus, handleMcpLoginStatus);
  plugin.handle(mcpLoginCancel, handleMcpLoginCancel);
  plugin.handle(mcpLogout, handleMcpLogout);
  plugin.handle(limitsStatus, handleLimitsStatus);
  plugin.handle(limitsSetAuto, handleLimitsSetAuto);
  plugin.handle(limitsResume, handleLimitsResume);
  plugin.handle(resourceStatus, handleResourceStatus);
  plugin.handle(resourceSetEnabled, handleResourceSetEnabled);

  plugin.addSurface("agent-sync", AgentSyncSurface);
  plugin.addSurface("mcp", McpSurface);
  plugin.addWorkspacePanel({
    id: "mcp-connections",
    title: "MCP connections",
    icon: "Plug",
    context: "workspace",
    Component: McpWorkspacePanel,
  });
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
    id: "open-workspace-mcp",
    title: "Open workspace MCP connections",
    icon: "Plug",
    keywords: ["mcp", "project", "oauth", "connections"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("mcp-connections");
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
  // Server modules register their own start/shutdown work at import time, so
  // this entry never names a *.server binding outside a `plugin.handle(...)`
  // statement — see lifecycle.shared.ts for why that rule exists. Both calls are
  // no-ops in the client bundle.
  runStart();
  return runShutdown;
}
