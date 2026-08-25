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
import { runShutdown, runStart } from "./lifecycle.shared";
import { limitsResume, limitsSetAuto, limitsStatus } from "./limits.shared";
import { handleLimitsResume, handleLimitsSetAuto, handleLimitsStatus } from "./limits.server";
import { McpSurface } from "./mcp.client";
import {
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
} from "./mcpjson.shared";
import {
  handleMcpExport,
  handleMcpExportFile,
  handleMcpImportApply,
  handleMcpImportParse,
  handleMcpLogin,
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
  plugin.handle(mcpLoginStatus, handleMcpLoginStatus);
  plugin.handle(mcpLoginCancel, handleMcpLoginCancel);
  plugin.handle(mcpLogout, handleMcpLogout);
  plugin.handle(limitsStatus, handleLimitsStatus);
  plugin.handle(limitsSetAuto, handleLimitsSetAuto);
  plugin.handle(limitsResume, handleLimitsResume);

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
  // Server modules register their own start/shutdown work at import time, so
  // this entry never names a *.server binding outside a `plugin.handle(...)`
  // statement — see lifecycle.shared.ts for why that rule exists. Both calls are
  // no-ops in the client bundle.
  runStart();
  return runShutdown;
}
