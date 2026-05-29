import { createFileRoute } from "@tanstack/react-router";
import type { KanbanCardId } from "@t3tools/contracts";

import { CardDetailPage } from "../components/board/CardDetailPage";
import { RouteErrorPanel } from "../components/RouteErrorPanel";

function BoardCardRoute() {
  const { cardId } = Route.useParams();
  return <CardDetailPage cardId={cardId as KanbanCardId} />;
}

export const Route = createFileRoute("/board_/card/$cardId")({
  component: BoardCardRoute,
  errorComponent: RouteErrorPanel,
});
