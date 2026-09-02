import type { PluginContext } from "@getpaseo/plugin";
import { AgentSyncSurface } from "./agents.client";
import { accountLoginCancel, accountLoginSessions, accountLoginStart, accountLoginSubmit } from "./auth.shared";
import {
  handleAccountLoginCancel,
  handleAccountLoginSessions,
  handleAccountLoginStart,
  handleAccountLoginSubmit,
} from "./auth.server";
import { cliInstall, cliStatus, cliUpdateApply, cliUpdateCheck } from "./cli.shared";
import { handleCliInstall, handleCliStatus, handleCliUpdateApply, handleCliUpdateCheck } from "./cli.server";
import {
  diagnoseProvider,
  providerHealth,
  providerHeartbeat,
  routerConfigure,
  routerModels,
  routerStatus,
  accountUsage,
  accountCapacity,
  probeAccounts,
  addAccount,
  removeAccount,
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
  handleRouterConfigure,
  handleRouterModels,
  handleRouterStatus,
  handleAccountUsage,
  handleAccountCapacity,
  handleProbeAccounts,
  handleAddAccount,
  handleRemoveAccount,
  handleScan,
  handleSetCooldown,
  handleSetPreference,
  handleWireAuto,
  handleWireProvider,
} from "./handlers.server";
import { runShutdown, runStart } from "./lifecycle.shared";
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

// Register only contracts reachable from the current AgentLink surface.
// Retired routing and continuation contracts are intentionally not active.
export default function contribute(plugin: PluginContext) {
  plugin.handle(accountLoginSessions, handleAccountLoginSessions);
  plugin.handle(accountLoginStart, handleAccountLoginStart);
  plugin.handle(accountLoginSubmit, handleAccountLoginSubmit);
  plugin.handle(accountLoginCancel, handleAccountLoginCancel);
  plugin.handle(scan, handleScan);
  plugin.handle(wireProvider, handleWireProvider);
  plugin.handle(wireAuto, handleWireAuto);
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
  plugin.handle(routerStatus, handleRouterStatus);
  plugin.handle(routerConfigure, handleRouterConfigure);
  plugin.handle(routerModels, handleRouterModels);
  plugin.handle(cliStatus, handleCliStatus);
  plugin.handle(cliInstall, handleCliInstall);
  plugin.handle(cliUpdateCheck, handleCliUpdateCheck);
  plugin.handle(cliUpdateApply, handleCliUpdateApply);
  plugin.handle(resourceStatus, handleResourceStatus);
  plugin.handle(resourceSetEnabled, handleResourceSetEnabled);
  plugin.handle(toolchainStatus, handleToolchainStatus);
  plugin.handle(toolchainConfigure, handleToolchainConfigure);
  plugin.handle(toolchainRemove, handleToolchainRemove);
  plugin.handle(toolchainRun, handleToolchainRun);
  plugin.handle(toolchainSetEnabled, handleToolchainSetEnabled);

  plugin.addSurface("agent-sync", AgentSyncSurface);
  plugin.addSidebarItem({ id: "agent-sync", title: "AgentLink", icon: "Users", surface: "agent-sync" });
  plugin.addCommandCenterItem({
    id: "open-agent-sync",
    title: "Open AgentLink (accounts, orchestration & provider health)",
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
