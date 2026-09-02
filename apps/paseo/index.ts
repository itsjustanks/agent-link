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
