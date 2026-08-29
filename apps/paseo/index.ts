import type { PluginContext } from "@getpaseo/plugin";
import { AgentRoutingPanel, AgentSyncSurface } from "./agents.client";
import { cliInstall, cliStatus, cliUpdateApply, cliUpdateCheck } from "./cli.shared";
import { handleCliInstall, handleCliStatus, handleCliUpdateApply, handleCliUpdateCheck } from "./cli.server";
import {
  diagnoseProvider,
  providerHealth,
  providerHeartbeat,
  accountUsage,
  accountCapacity,
  probeAccounts,
  addAccount,
  removeAccount,
  routerInstall,
  routerConfigure,
  routerModels,
  routerStatus,
  routerTrace,
  agentContinue,
  scan,
  setCooldown,
  setPreference,
  wireAuto,
  wireProvider,
} from "./contracts.shared";
import {
  handleDiagnoseProvider,
  handleProviderHealth,
  handleProviderHeartbeat,
  handleAccountUsage,
  handleAccountCapacity,
  handleProbeAccounts,
  handleAddAccount,
  handleRemoveAccount,
  handleRouterInstall,
  handleRouterConfigure,
  handleRouterModels,
  handleRouterStatus,
  handleRouterTrace,
  handleAgentContinue,
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
import { toolchainConfigure, toolchainRemove, toolchainRun, toolchainSetEnabled, toolchainStatus } from "./toolchain.shared";
import {
  handleToolchainConfigure,
  handleToolchainRemove,
  handleToolchainRun,
  handleToolchainSetEnabled,
  handleToolchainStatus,
} from "./toolchain.server";
import { contributeModelPills } from "./model-pill.client";

// Every contract defined in a *.shared.ts must be registered here. One that is
// not simply fails when the panel calls it, with nothing in the logs to explain
// why — so this list is the thing to check first when a button does nothing.
export default function contribute(plugin: PluginContext) {
  plugin.handle(scan, handleScan);
  plugin.handle(wireProvider, handleWireProvider);
  plugin.handle(wireAuto, handleWireAuto);
  plugin.handle(routerStatus, handleRouterStatus);
  plugin.handle(routerInstall, handleRouterInstall);
  plugin.handle(routerConfigure, handleRouterConfigure);
  plugin.handle(routerModels, handleRouterModels);
  plugin.handle(routerTrace, handleRouterTrace);
  plugin.handle(agentContinue, handleAgentContinue);
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
  plugin.handle(cliStatus, handleCliStatus);
  plugin.handle(cliInstall, handleCliInstall);
  plugin.handle(cliUpdateCheck, handleCliUpdateCheck);
  plugin.handle(cliUpdateApply, handleCliUpdateApply);
  plugin.handle(limitsStatus, handleLimitsStatus);
  plugin.handle(limitsSetAuto, handleLimitsSetAuto);
  plugin.handle(limitsResume, handleLimitsResume);
  plugin.handle(resourceStatus, handleResourceStatus);
  plugin.handle(resourceSetEnabled, handleResourceSetEnabled);
  plugin.handle(toolchainStatus, handleToolchainStatus);
  plugin.handle(toolchainConfigure, handleToolchainConfigure);
  plugin.handle(toolchainRemove, handleToolchainRemove);
  plugin.handle(toolchainRun, handleToolchainRun);
  plugin.handle(toolchainSetEnabled, handleToolchainSetEnabled);

  plugin.addSurface("agent-sync", AgentSyncSurface);
  plugin.addWorkspacePanel({
    id: "agent-routing",
    title: "Model used",
    icon: "Route",
    context: "agent",
    Component: AgentRoutingPanel,
  });
  plugin.addClientSide(contributeModelPills);
  plugin.addSidebarItem({ id: "agent-sync", title: "Agent Link", icon: "Users", surface: "agent-sync" });
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
  // Server modules register their own start/shutdown work at import time, so
  // this entry never names a *.server binding outside a `plugin.handle(...)`
  // statement — see lifecycle.shared.ts for why that rule exists. Both calls are
  // no-ops in the client bundle.
  runStart();
  return runShutdown;
}
