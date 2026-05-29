import { createFileRoute } from "@tanstack/react-router";

import { AutomationsSettingsPanel } from "../components/settings/AutomationsSettingsPanel";
import { RouteErrorPanel } from "../components/RouteErrorPanel";

function SettingsAutomationsRoute() {
  return <AutomationsSettingsPanel />;
}

export const Route = createFileRoute("/settings/automations")({
  component: SettingsAutomationsRoute,
  errorComponent: RouteErrorPanel,
});
