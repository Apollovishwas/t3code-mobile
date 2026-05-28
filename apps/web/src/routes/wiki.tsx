import { createFileRoute } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";

import { WikiPage } from "../components/wiki/WikiPage";
import { selectProjectsAcrossEnvironments, useStore } from "../store";

function WikiRoute() {
  const allProjects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const projects = allProjects.map((project) => ({
    id: project.id,
    name: project.name,
  }));
  return <WikiPage projects={projects} />;
}

export const Route = createFileRoute("/wiki")({
  component: WikiRoute,
});
