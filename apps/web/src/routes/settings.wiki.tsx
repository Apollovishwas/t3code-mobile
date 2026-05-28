import { createFileRoute } from "@tanstack/react-router";

import { WikiSettingsPanel } from "../components/settings/WikiSettingsPanel";

function SettingsWikiRoute() {
  return <WikiSettingsPanel />;
}

export const Route = createFileRoute("/settings/wiki")({
  component: SettingsWikiRoute,
});
