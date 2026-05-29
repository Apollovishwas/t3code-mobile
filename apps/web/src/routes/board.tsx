import { createFileRoute } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";

import { BoardPage } from "../components/board/BoardPage";
import { RouteErrorPanel } from "../components/RouteErrorPanel";
import { selectProjectsAcrossEnvironments, useStore } from "../store";

function BoardRoute() {
  const allProjects = useStore(useShallow(selectProjectsAcrossEnvironments));
  // The board page only needs `{ id, name }` — slimming the payload keeps
  // the page component decoupled from the store's full Project shape.
  const projects = allProjects.map((project) => ({
    id: project.id,
    name: project.name,
  }));
  return <BoardPage projects={projects} />;
}

export const Route = createFileRoute("/board")({
  component: BoardRoute,
  errorComponent: RouteErrorPanel,
});
