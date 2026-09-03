import type { PluginContext } from "@getpaseo/plugin";
import {
  routerAliasRemove,
  routerAliasSet,
  routerConnectComplete,
  routerConnectPoll,
  routerConnectStart,
  routerConnectionRemove,
  routerModelExpose,
  routerModelUnexpose,
  routerRouteCli,
  routerSettingsSave,
  routerStart,
  routerStatus,
  routerSyncModels,
  routerUsageStats,
  routerHolds,
  routerClearHold,
  routerComboCreate,
  routerTestModel,
  routerTuning,
  routerTuningSet,
  routerLogs,
  routerKeys,
  routerKeyCreate,
  routerKeyDelete,
  routerKeyReveal,
  routerCombos,
  routerComboSave,
  routerComboDelete,
  routerPasswordChange,
  routerPowerUps,
  routerPowerUpApply,
  routerSyncSelection,
  routerSyncSelectionSet,
  routerTunnel,
  routerTunnelSet,
  routerLocalForward,
  routerLocalForwardStatus,
  routerLocalForwardStop,
  routerRequireApiKey,
  routerCatalogSync,
  routerConnectionHealth,
  routerRequestLogs,
} from "./contracts.shared";
import {
  handleRouterAliasRemove,
  handleRouterAliasSet,
  handleRouterConnectComplete,
  handleRouterConnectPoll,
  handleRouterConnectStart,
  handleRouterConnectionRemove,
  handleRouterModelExpose,
  handleRouterModelUnexpose,
  handleRouterRouteCli,
  handleRouterSettingsSave,
  handleRouterStart,
  handleRouterStatus,
  handleRouterSyncModels,
  handleRouterUsageStats,
  handleRouterHolds,
  handleRouterClearHold,
  handleRouterComboCreate,
  handleRouterTestModel,
  handleRouterTuning,
  handleRouterTuningSet,
  handleRouterLogs,
  handleRouterKeys,
  handleRouterKeyCreate,
  handleRouterKeyDelete,
  handleRouterKeyReveal,
  handleRouterCombos,
  handleRouterComboSave,
  handleRouterComboDelete,
  handleRouterPasswordChange,
  handleRouterPowerUps,
  handleRouterPowerUpApply,
  handleRouterSyncSelection,
  handleRouterSyncSelectionSet,
  handleRouterTunnel,
  handleRouterTunnelSet,
  handleRouterLocalForward,
  handleRouterLocalForwardStatus,
  handleRouterLocalForwardStop,
  handleRouterRequireApiKey,
  handleRouterCatalogSync,
  handleRouterConnectionHealth,
  handleRouterRequestLogs,
} from "./handlers.server";
import { AgentLinkSurface } from "./surface.client";

export default function contribute(plugin: PluginContext) {
  plugin.handle(routerStatus, handleRouterStatus);
  plugin.handle(routerStart, handleRouterStart);
  plugin.handle(routerSettingsSave, handleRouterSettingsSave);
  plugin.handle(routerRouteCli, handleRouterRouteCli);
  plugin.handle(routerSyncModels, handleRouterSyncModels);
  plugin.handle(routerConnectStart, handleRouterConnectStart);
  plugin.handle(routerConnectPoll, handleRouterConnectPoll);
  plugin.handle(routerConnectComplete, handleRouterConnectComplete);
  plugin.handle(routerConnectionRemove, handleRouterConnectionRemove);
  plugin.handle(routerModelExpose, handleRouterModelExpose);
  plugin.handle(routerModelUnexpose, handleRouterModelUnexpose);
  plugin.handle(routerAliasSet, handleRouterAliasSet);
  plugin.handle(routerAliasRemove, handleRouterAliasRemove);
  plugin.handle(routerUsageStats, handleRouterUsageStats);
  plugin.handle(routerHolds, handleRouterHolds);
  plugin.handle(routerClearHold, handleRouterClearHold);
  plugin.handle(routerComboCreate, handleRouterComboCreate);
  plugin.handle(routerTestModel, handleRouterTestModel);
  plugin.handle(routerTuning, handleRouterTuning);
  plugin.handle(routerTuningSet, handleRouterTuningSet);
  plugin.handle(routerLogs, handleRouterLogs);
  plugin.handle(routerKeys, handleRouterKeys);
  plugin.handle(routerKeyCreate, handleRouterKeyCreate);
  plugin.handle(routerKeyDelete, handleRouterKeyDelete);
  plugin.handle(routerKeyReveal, handleRouterKeyReveal);
  plugin.handle(routerCombos, handleRouterCombos);
  plugin.handle(routerComboSave, handleRouterComboSave);
  plugin.handle(routerComboDelete, handleRouterComboDelete);
  plugin.handle(routerPasswordChange, handleRouterPasswordChange);
  plugin.handle(routerPowerUps, handleRouterPowerUps);
  plugin.handle(routerPowerUpApply, handleRouterPowerUpApply);
  plugin.handle(routerSyncSelection, handleRouterSyncSelection);
  plugin.handle(routerSyncSelectionSet, handleRouterSyncSelectionSet);
  plugin.handle(routerTunnel, handleRouterTunnel);
  plugin.handle(routerTunnelSet, handleRouterTunnelSet);
  plugin.handle(routerLocalForward, handleRouterLocalForward);
  plugin.handle(routerLocalForwardStop, handleRouterLocalForwardStop);
  plugin.handle(routerLocalForwardStatus, handleRouterLocalForwardStatus);
  plugin.handle(routerRequireApiKey, handleRouterRequireApiKey);
  plugin.handle(routerCatalogSync, handleRouterCatalogSync);
  plugin.handle(routerConnectionHealth, handleRouterConnectionHealth);
  plugin.handle(routerRequestLogs, handleRouterRequestLogs);

  plugin.addSurface("agent-link", AgentLinkSurface);
  plugin.addSidebarItem({ id: "agent-link", title: "9Router", icon: "Users", surface: "agent-link" });
  plugin.addCommandCenterItem({
    id: "open-agent-link",
    title: "Open 9Router Agent Link (accounts, quotas & models)",
    icon: "Users",
    keywords: ["9router", "accounts", "quota", "models", "router", "agent-link"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("agent-link");
    },
  });

  return () => {};
}
