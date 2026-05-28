import { createFileRoute } from "@tanstack/react-router";
import type { ProjectId } from "@t3tools/contracts";

import { WikiPageDetail } from "../components/wiki/WikiPageDetail";

function WikiPageDetailRoute() {
  const { projectId, slug } = Route.useParams();
  return <WikiPageDetail projectId={projectId as ProjectId} slug={slug} />;
}

export const Route = createFileRoute("/wiki_/$projectId/page/$slug")({
  component: WikiPageDetailRoute,
});
