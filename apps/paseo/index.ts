import type { PluginContext } from "@getpaseo/plugin";
import { AgentSyncSurface } from "./agents.client";
import { CanvasPanel, CanvasSurface } from "./canvas.client";
import { cliInstall, cliStatus } from "./cli.shared";
import { handleCliInstall, handleCliStatus } from "./cli.server";
import { canvasCopy, canvasOpen, canvasRender, canvasServe, canvasSource, canvasState, canvasStop } from "./canvas.shared";
import {
  canvasShutdown,
  handleCanvasCopy,
  handleCanvasOpen,
  handleCanvasRender,
  handleCanvasServe,
  handleCanvasSource,
  handleCanvasState,
  handleCanvasStop,
} from "./canvas.server";
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
  mcpLoginShutdown,
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
  plugin.handle(canvasState, handleCanvasState);
  plugin.handle(canvasServe, handleCanvasServe);
  plugin.handle(canvasStop, handleCanvasStop);
  plugin.handle(canvasOpen, handleCanvasOpen);
  plugin.handle(canvasCopy, handleCanvasCopy);
  plugin.handle(canvasRender, handleCanvasRender);
  plugin.handle(canvasSource, handleCanvasSource);
  plugin.handle(cliStatus, handleCliStatus);
  plugin.handle(cliInstall, handleCliInstall);
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

  plugin.addSurface("agent-sync", AgentSyncSurface);
  plugin.addSurface("mcp", McpSurface);
  plugin.addSurface("canvas", CanvasSurface);
  plugin.addSidebarItem({ id: "agent-sync", title: "Agent Link", icon: "Users", surface: "agent-sync" });
  plugin.addSidebarItem({ id: "mcp", title: "MCP", icon: "Plug", surface: "mcp" });
  plugin.addSidebarItem({ id: "canvas", title: "Canvas", icon: "LayoutDashboard", surface: "canvas" });
  // The same view beside an agent: its workspace's artifacts, and a way to put
  // one into the conversation being had about it.
  plugin.addWorkspacePanel({
    id: "canvas-panel",
    title: "Canvas",
    icon: "LayoutDashboard",
    context: "agent",
    Component: CanvasPanel,
  });
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
  plugin.addCommandCenterItem({
    id: "open-canvas-here",
    title: "Canvas for this agent",
    icon: "LayoutDashboard",
    keywords: ["canvas", "artifact", "dashboard", "send to chat", "preview"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("canvas-panel");
    },
  });
  plugin.addCommandCenterItem({
    id: "open-canvas",
    title: "Open Canvas (share an agent's dashboard)",
    icon: "LayoutDashboard",
    keywords: ["canvas", "artifact", "dashboard", "report", "share", "tunnel"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("canvas");
    },
  });
  // The local server and any quick tunnel belong to this process, and nothing
  // they serve should outlive it.
  return () => {
    canvasShutdown();
    // A login child is deliberately kept alive across its RPC, so nothing else
    // would ever reap it.
    mcpLoginShutdown();
  };
}
