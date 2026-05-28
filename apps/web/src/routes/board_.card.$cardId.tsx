import { createFileRoute } from "@tanstack/react-router";
import type { KanbanCardId } from "@t3tools/contracts";

import { CardDetailPage } from "../components/board/CardDetailPage";

function BoardCardRoute() {
  const { cardId } = Route.useParams();
  return <CardDetailPage cardId={cardId as KanbanCardId} />;
}

export const Route = createFileRoute("/board_/card/$cardId")({
  component: BoardCardRoute,
});
