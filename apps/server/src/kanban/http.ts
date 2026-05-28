import {
  AutomationAction,
  AutomationId,
  AutomationIntervalSchedule,
  AutomationSchedule,
  CreateKanbanCardInput,
  DEFAULT_KANBAN_COLUMN,
  DEFAULT_KANBAN_PRIORITY,
  KanbanArtifactId,
  KanbanArtifactKind,
  KanbanCardId,
  KanbanColumn,
  KanbanNoteId,
  KanbanPriority,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { AutomationRepository } from "../persistence/Services/Automations.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { KanbanRepository } from "../persistence/Services/KanbanBoard.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { writeBoardMarkdownForProject } from "./boardMarkdown.ts";
import { CommandId, MessageId, IsoDateTime } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * HTTP API for the Kanban board.
 *
 * **v1 auth model: localhost / Tailscale-only.** These routes deliberately
 * skip the cookie-based owner-session check that orchestration uses
 * because they're called by Claude via Bash + curl from inside the server
 * environment — there's no browser session to authenticate against. The
 * security boundary is the network: T3 binds to 127.0.0.1 (or the user's
 * Tailscale tailnet), so anything that can reach this endpoint is already
 * the user.
 *
 * Surface (slice 3):
 *   - GET    /api/board/list?projectId=…[&column=ready]
 *   - POST   /api/board/cards
 *   - POST   /api/board/cards/:id/move
 *   - PATCH  /api/board/cards/:id          — title / description / priority
 *   - DELETE /api/board/cards/:id          — irreversible; user must intend
 *   - POST   /api/board/cards/:id/notes    — append journal entry
 *   - POST   /api/board/cards/:id/artifacts — diff / PR / log / commit / etc.
 *
 * Deferred: schedule / unschedule (rides on AutomationScheduler), Tasks
 * API mirror (filesystem write under ~/.claude/tasks/).
 */

class BoardHttpError extends Schema.TaggedErrorClass<BoardHttpError>()(
  "BoardHttpError",
  {
    status: Schema.Number,
    message: Schema.String,
  },
) {}

const respondToError = (error: BoardHttpError) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status }),
  );

// ---------------------------------------------------------------------------
// GET /api/board/projects
//
// Projects discovery — returns id + title + workspaceRoot for every
// project the projection knows about. Lets Claude resolve a cwd to a
// projectId on the first turn of a brand-new thread, before the thread
// itself is in the projection. Cheap; just hits the existing snapshot.
// ---------------------------------------------------------------------------

export const kanbanProjectsRouteLayer = HttpRouter.add(
  "GET",
  "/api/board/projects",
  Effect.gen(function* () {
    const snapshot = yield* ProjectionSnapshotQuery;
    const shell = yield* snapshot.getShellSnapshot().pipe(
      Effect.mapError(
        (cause) =>
          new BoardHttpError({
            status: 500,
            message: `Failed to read shell snapshot: ${String(cause)}`,
          }),
      ),
    );
    const projects = shell.projects.map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
    }));
    return HttpServerResponse.jsonUnsafe({ projects }, { status: 200 });
  }).pipe(Effect.catchTag("BoardHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// GET /api/board/list?projectId=…[&column=ready]
// ---------------------------------------------------------------------------

export const kanbanListRouteLayer = HttpRouter.add(
  "GET",
  "/api/board/list",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://localhost");
    const projectIdRaw = url.searchParams.get("projectId");
    if (!projectIdRaw) {
      return yield* new BoardHttpError({
        status: 400,
        message: "Missing required query parameter: projectId",
      });
    }
    const projectId = projectIdRaw as ProjectId;
    const columnRaw = url.searchParams.get("column");
    const repo = yield* KanbanRepository;
    const cards = yield* repo
      .listByProject(
        columnRaw
          ? { projectId, column: columnRaw as KanbanColumn }
          : { projectId },
      )
      .pipe(Effect.mapError((cause) => new BoardHttpError({
        status: 500,
        message: `Failed to load cards: ${String(cause)}`,
      })));
    return HttpServerResponse.jsonUnsafe({ cards }, { status: 200 });
  }).pipe(Effect.catchTag("BoardHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// POST /api/board/cards
// ---------------------------------------------------------------------------

export const kanbanCreateCardRouteLayer = HttpRouter.add(
  "POST",
  "/api/board/cards",
  Effect.gen(function* () {
    const input = yield* HttpServerRequest.schemaBodyJson(CreateKanbanCardInput).pipe(
      Effect.mapError(
        (cause) =>
          new BoardHttpError({
            status: 400,
            message: `Invalid card payload: ${String(cause)}`,
          }),
      ),
    );
    const repo = yield* KanbanRepository;
    const uuid = yield* Random.nextUUIDv4;
    const id = KanbanCardId.make(`card-${uuid}`);
    const now = yield* Clock.currentTimeMillis;
    yield* repo
      .insertCard({
        id,
        projectId: input.projectId,
        title: input.title,
        description: input.description,
        column: input.column ?? DEFAULT_KANBAN_COLUMN,
        priority: input.priority ?? DEFAULT_KANBAN_PRIORITY,
        sortOrder: now,
        tasksMirrorId: null,
        createdAtMs: now,
      })
      .pipe(Effect.mapError((cause) => new BoardHttpError({
        status: 500,
        message: `Failed to insert card: ${String(cause)}`,
      })));
    // Auto-bind the creating thread if provided — Claude includes it
    // when calling from inside a thread, so Run Now and scheduled
    // runs have a target without an extra PUT.
    if (input.threadId !== undefined) {
      yield* repo
        .updateCard({
          id,
          threadId: input.threadId,
          lastThreadId: input.threadId,
          updatedAtMs: now,
        })
        .pipe(Effect.ignoreCause({ log: true }));
    }
    const created = yield* repo.getCard({ id }).pipe(
      Effect.mapError((cause) => new BoardHttpError({
        status: 500,
        message: `Failed to read back card: ${String(cause)}`,
      })),
    );
    yield* writeBoardMarkdownForProject(input.projectId);
    return yield* Option.match(created, {
      onNone: () =>
        Effect.fail(
          new BoardHttpError({
            status: 500,
            message: "Card vanished after insert",
          }),
        ),
      onSome: (card) =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ card }, { status: 201 })),
    });
  }).pipe(Effect.catchTag("BoardHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// POST /api/board/cards/:id/move
// ---------------------------------------------------------------------------

const MoveBody = Schema.Struct({
  column: KanbanColumn,
  note: Schema.optionalKey(TrimmedNonEmptyString),
});

export const kanbanMoveCardRouteLayer = HttpRouter.add(
  "POST",
  "/api/board/cards/:id/move",
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const cardIdRaw = params.id;
    if (!cardIdRaw) {
      return yield* new BoardHttpError({ status: 400, message: "Missing :id parameter" });
    }
    const cardId = cardIdRaw as KanbanCardId;
    const body = yield* HttpServerRequest.schemaBodyJson(MoveBody).pipe(
      Effect.mapError(
        (cause) =>
          new BoardHttpError({
            status: 400,
            message: `Invalid move payload: ${String(cause)}`,
          }),
      ),
    );
    const repo = yield* KanbanRepository;
    const now = yield* Clock.currentTimeMillis;
    yield* repo
      .updateCard({
        id: cardId,
        column: body.column,
        ...(body.column === "done" ? { doneAtMs: now, needsReview: false } : {}),
        updatedAtMs: now,
      })
      .pipe(Effect.mapError((cause) => new BoardHttpError({
        status: 500,
        message: `Failed to move card: ${String(cause)}`,
      })));
    // Auto-journal entry for column moves so the UI shows a trail.
    if (body.note !== undefined || body.column === "done") {
      const noteUuid = yield* Random.nextUUIDv4;
      const noteText = body.note ?? `Moved to ${body.column}`;
      yield* repo
        .insertNote({
          id: KanbanNoteId.make(`note-${noteUuid}`),
          cardId,
          text: noteText,
          author: "agent",
          createdAtMs: now,
        })
        .pipe(Effect.ignoreCause({ log: true }));
    }
    const after = yield* repo.getCard({ id: cardId }).pipe(
      Effect.mapError((cause) => new BoardHttpError({
        status: 500,
        message: `Failed to read back card: ${String(cause)}`,
      })),
    );
    return yield* Option.match(after, {
      onNone: () =>
        Effect.fail(
          new BoardHttpError({
            status: 404,
            message: `No card with id ${cardId}`,
          }),
        ),
      onSome: (card) =>
        Effect.gen(function* () {
          yield* writeBoardMarkdownForProject(card.projectId);
          return HttpServerResponse.jsonUnsafe({ card }, { status: 200 });
        }),
    });
  }).pipe(Effect.catchTag("BoardHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// PATCH /api/board/cards/:id
// ---------------------------------------------------------------------------

const UpdateBody = Schema.Struct({
  title: Schema.optionalKey(TrimmedNonEmptyString),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  priority: Schema.optionalKey(KanbanPriority),
  needsReview: Schema.optionalKey(Schema.Boolean),
});

export const kanbanUpdateCardRouteLayer = HttpRouter.add(
  "PATCH",
  "/api/board/cards/:id",
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const cardIdRaw = params.id;
    if (!cardIdRaw) {
      return yield* new BoardHttpError({ status: 400, message: "Missing :id parameter" });
    }
    const cardId = cardIdRaw as KanbanCardId;
    const body = yield* HttpServerRequest.schemaBodyJson(UpdateBody).pipe(
      Effect.mapError(
        (cause) =>
          new BoardHttpError({
            status: 400,
            message: `Invalid patch payload: ${String(cause)}`,
          }),
      ),
    );
    const now = yield* Clock.currentTimeMillis;
    const repo = yield* KanbanRepository;
    yield* repo
      .updateCard({
        id: cardId,
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.needsReview !== undefined ? { needsReview: body.needsReview } : {}),
        updatedAtMs: now,
      })
      .pipe(Effect.mapError((cause) => new BoardHttpError({
        status: 500,
        message: `Failed to update card: ${String(cause)}`,
      })));
    const after = yield* repo.getCard({ id: cardId }).pipe(
      Effect.mapError((cause) => new BoardHttpError({
        status: 500,
        message: `Failed to read back card: ${String(cause)}`,
      })),
    );
    return yield* Option.match(after, {
      onNone: () =>
        Effect.fail(new BoardHttpError({ status: 404, message: `No card with id ${cardId}` })),
      onSome: (card) =>
        Effect.gen(function* () {
          yield* writeBoardMarkdownForProject(card.projectId);
          return HttpServerResponse.jsonUnsafe({ card }, { status: 200 });
        }),
    });
  }).pipe(Effect.catchTag("BoardHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// DELETE /api/board/cards/:id
// ---------------------------------------------------------------------------

export const kanbanDeleteCardRouteLayer = HttpRouter.add(
  "DELETE",
  "/api/board/cards/:id",
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const cardIdRaw = params.id;
    if (!cardIdRaw) {
      return yield* new BoardHttpError({ status: 400, message: "Missing :id parameter" });
    }
    const cardId = cardIdRaw as KanbanCardId;
    const repo = yield* KanbanRepository;
    // Look up the card BEFORE deletion to know which project's
    // board.md to refresh after.
    const beforeDelete = yield* repo
      .getCard({ id: cardId })
      .pipe(Effect.mapError((cause) => new BoardHttpError({
        status: 500,
        message: `Failed to read card: ${String(cause)}`,
      })));
    const projectIdToRefresh = Option.match(beforeDelete, {
      onNone: () => null,
      onSome: (card) => card.projectId,
    });
    const deleted = yield* repo
      .deleteCard({ id: cardId })
      .pipe(Effect.mapError((cause) => new BoardHttpError({
        status: 500,
        message: `Failed to delete card: ${String(cause)}`,
      })));
    if (!deleted) {
      return yield* new BoardHttpError({
        status: 404,
        message: `No card with id ${cardId} to delete`,
      });
    }
    if (projectIdToRefresh !== null) {
      yield* writeBoardMarkdownForProject(projectIdToRefresh);
    }
    return HttpServerResponse.jsonUnsafe({ deleted: true }, { status: 200 });
  }).pipe(Effect.catchTag("BoardHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// POST /api/board/cards/:id/notes
// ---------------------------------------------------------------------------

const AddNoteBody = Schema.Struct({
  text: TrimmedNonEmptyString,
});

export const kanbanAddNoteRouteLayer = HttpRouter.add(
  "POST",
  "/api/board/cards/:id/notes",
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const cardIdRaw = params.id;
    if (!cardIdRaw) {
      return yield* new BoardHttpError({ status: 400, message: "Missing :id parameter" });
    }
    const cardId = cardIdRaw as KanbanCardId;
    const body = yield* HttpServerRequest.schemaBodyJson(AddNoteBody).pipe(
      Effect.mapError(
        (cause) =>
          new BoardHttpError({
            status: 400,
            message: `Invalid note payload: ${String(cause)}`,
          }),
      ),
    );
    const repo = yield* KanbanRepository;
    const uuid = yield* Random.nextUUIDv4;
    const now = yield* Clock.currentTimeMillis;
    yield* repo
      .insertNote({
        id: KanbanNoteId.make(`note-${uuid}`),
        cardId,
        text: body.text,
        author: "agent",
        createdAtMs: now,
      })
      .pipe(Effect.mapError((cause) => new BoardHttpError({
        status: 500,
        message: `Failed to insert note: ${String(cause)}`,
      })));
    // Refresh markdown so the journal entry is visible to anyone
    // grepping the repo. Best-effort; failure logs but doesn't fail.
    const cardForRefresh = yield* repo.getCard({ id: cardId }).pipe(
      Effect.mapError((cause) => new BoardHttpError({
        status: 500,
        message: `Failed to read card for refresh: ${String(cause)}`,
      })),
    );
    yield* Option.match(cardForRefresh, {
      onNone: () => Effect.void,
      onSome: (card) => writeBoardMarkdownForProject(card.projectId),
    });
    return HttpServerResponse.jsonUnsafe(
      { note: { id: `note-${uuid}`, cardId, text: body.text, author: "agent", createdAt: now } },
      { status: 201 },
    );
  }).pipe(Effect.catchTag("BoardHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// POST /api/board/cards/:id/artifacts
// ---------------------------------------------------------------------------

const AttachArtifactBody = Schema.Struct({
  kind: KanbanArtifactKind,
  payload: Schema.String,
});

// ---------------------------------------------------------------------------
// POST /api/board/cards/:id/run
//
// Manually trigger one fire of a card, bypassing any schedule. Mirrors
// what AutomationScheduler does for `run-card` actions: dispatch the
// card's title + description as a fresh prompt into the bound thread,
// move the card to in_progress, and stamp updated_at.
//
// Requires a bound thread — without one, the prompt has nowhere to go.
// 400 (no-thread) is the only "expected" failure mode; everything else
// is a 500.
// ---------------------------------------------------------------------------

export const kanbanRunCardRouteLayer = HttpRouter.add(
  "POST",
  "/api/board/cards/:id/run",
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const cardIdRaw = params.id;
    if (!cardIdRaw) {
      return yield* new BoardHttpError({ status: 400, message: "Missing :id parameter" });
    }
    const cardId = cardIdRaw as KanbanCardId;
    const repo = yield* KanbanRepository;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const now = yield* Clock.currentTimeMillis;
    const cardOpt = yield* repo.getCard({ id: cardId }).pipe(
      Effect.mapError(
        (cause) =>
          new BoardHttpError({ status: 500, message: `Failed to read card: ${String(cause)}` }),
      ),
    );
    const card = Option.getOrUndefined(cardOpt);
    if (!card) {
      return yield* new BoardHttpError({ status: 404, message: `No card with id ${cardId}` });
    }
    if (!card.threadId) {
      return yield* new BoardHttpError({
        status: 400,
        message:
          "This card has no bound thread. Bind a thread first (PUT /api/board/cards/:id/thread) or open a thread from the board, then try again.",
      });
    }
    const promptParts: string[] = [];
    promptParts.push(`(Manual run of board card "${card.title}".)`);
    if (card.description && card.description.trim().length > 0) {
      promptParts.push("");
      promptParts.push(card.description);
    }
    const promptText = promptParts.join("\n");
    const commandId = CommandId.make(`board-run:${cardId}:${now}`);
    const messageId = MessageId.make(`board-run-${cardId}-${now}`);
    const createdAt = yield* Effect.map(DateTime.now, DateTime.formatIso).pipe(
      Effect.map(IsoDateTime.make),
    );
    yield* orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId,
        threadId: card.threadId,
        message: {
          messageId,
          role: "user",
          text: promptText,
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new BoardHttpError({
              status: 500,
              message: `Failed to dispatch run: ${String(cause)}`,
            }),
        ),
      );
    // Move to in_progress so the board reflects the run starting.
    yield* repo
      .updateCard({
        id: cardId,
        column: "in_progress",
        lastThreadId: card.threadId,
        updatedAtMs: now,
      })
      .pipe(Effect.ignoreCause({ log: true }));
    yield* writeBoardMarkdownForProject(card.projectId);
    return HttpServerResponse.jsonUnsafe({ dispatched: true }, { status: 200 });
  }).pipe(Effect.catchTag("BoardHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// PUT /api/board/cards/:id/thread
//
// Bind (or unbind) a thread to a card. The bound thread is the target for
// any scheduled fires of the card.
// ---------------------------------------------------------------------------

const BindThreadBody = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
});

export const kanbanBindThreadRouteLayer = HttpRouter.add(
  "PUT",
  "/api/board/cards/:id/thread",
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const cardIdRaw = params.id;
    if (!cardIdRaw) {
      return yield* new BoardHttpError({ status: 400, message: "Missing :id parameter" });
    }
    const cardId = cardIdRaw as KanbanCardId;
    const body = yield* HttpServerRequest.schemaBodyJson(BindThreadBody).pipe(
      Effect.mapError(
        (cause) =>
          new BoardHttpError({
            status: 400,
            message: `Invalid bind-thread payload: ${String(cause)}`,
          }),
      ),
    );
    const repo = yield* KanbanRepository;
    const now = yield* Clock.currentTimeMillis;
    // Preserve lastThreadId when unbinding so the UI can still surface
    // "most recent thread for this card" — useful for "open thread".
    const beforeOpt = yield* repo.getCard({ id: cardId }).pipe(
      Effect.mapError(
        (cause) =>
          new BoardHttpError({ status: 500, message: `Failed to read card: ${String(cause)}` }),
      ),
    );
    const before = Option.getOrUndefined(beforeOpt);
    if (!before) {
      return yield* new BoardHttpError({ status: 404, message: `No card with id ${cardId}` });
    }
    yield* repo
      .updateCard({
        id: cardId,
        threadId: body.threadId,
        ...(body.threadId !== null ? { lastThreadId: body.threadId } : {}),
        updatedAtMs: now,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new BoardHttpError({
              status: 500,
              message: `Failed to update card thread: ${String(cause)}`,
            }),
        ),
      );
    yield* writeBoardMarkdownForProject(before.projectId);
    const after = yield* repo.getCard({ id: cardId }).pipe(
      Effect.mapError(
        (cause) =>
          new BoardHttpError({
            status: 500,
            message: `Failed to read back card: ${String(cause)}`,
          }),
      ),
    );
    return yield* Option.match(after, {
      onNone: () =>
        Effect.fail(new BoardHttpError({ status: 404, message: `No card with id ${cardId}` })),
      onSome: (card) =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ card }, { status: 200 })),
    });
  }).pipe(Effect.catchTag("BoardHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// POST /api/board/cards/:id/schedule
//
// Set or replace a card's schedule. Creates an Automation row with
// action.kind = "run-card" that the AutomationScheduler picks up on its
// 30s tick. The card stores both the schedule JSON (for UI display) and
// the automation id (for clean unscheduling).
// ---------------------------------------------------------------------------

const ScheduleBody = Schema.Struct({
  schedule: AutomationSchedule,
});

const encodeAutomationSchedule = Schema.encodeUnknownEffect(
  Schema.fromJsonString(AutomationSchedule),
);
const encodeAutomationAction = Schema.encodeUnknownEffect(
  Schema.fromJsonString(AutomationAction),
);

export const kanbanScheduleCardRouteLayer = HttpRouter.add(
  "POST",
  "/api/board/cards/:id/schedule",
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const cardIdRaw = params.id;
    if (!cardIdRaw) {
      return yield* new BoardHttpError({ status: 400, message: "Missing :id parameter" });
    }
    const cardId = cardIdRaw as KanbanCardId;
    const body = yield* HttpServerRequest.schemaBodyJson(ScheduleBody).pipe(
      Effect.mapError(
        (cause) =>
          new BoardHttpError({
            status: 400,
            message: `Invalid schedule payload: ${String(cause)}`,
          }),
      ),
    );
    const repo = yield* KanbanRepository;
    const automations = yield* AutomationRepository;
    const now = yield* Clock.currentTimeMillis;
    const cardOpt = yield* repo.getCard({ id: cardId }).pipe(
      Effect.mapError(
        (cause) =>
          new BoardHttpError({ status: 500, message: `Failed to read card: ${String(cause)}` }),
      ),
    );
    const card = Option.getOrUndefined(cardOpt);
    if (!card) {
      return yield* new BoardHttpError({ status: 404, message: `No card with id ${cardId}` });
    }
    // Replace any existing schedule — delete the previous automation row
    // first so we don't end up with orphans.
    if (card.scheduleAutomationId) {
      yield* automations
        .deleteById({ id: card.scheduleAutomationId })
        .pipe(Effect.ignoreCause({ log: true }));
    }
    // Insert a new automation row. The action JSON points at the card so
    // edits to the card description / thread propagate without rewrite.
    const automationUuid = yield* Random.nextUUIDv4;
    const newAutomationId = AutomationId.make(`auto-${automationUuid}`);
    const actionJson = yield* encodeAutomationAction({
      kind: "run-card",
      cardId: cardId as string,
    });
    const scheduleJson = yield* encodeAutomationSchedule(body.schedule);
    const nextRunAtMs = now + (body.schedule as AutomationIntervalSchedule).minutes * 60_000;
    yield* automations
      .insert({
        id: newAutomationId,
        name: `Card: ${card.title}`,
        projectId: card.projectId,
        status: "enabled",
        scheduleJson,
        actionJson,
        nextRunAtMs,
        createdAtMs: now,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new BoardHttpError({
              status: 500,
              message: `Failed to insert automation: ${String(cause)}`,
            }),
        ),
      );
    yield* repo
      .updateCard({
        id: cardId,
        scheduleJson,
        scheduleAutomationId: newAutomationId,
        updatedAtMs: now,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new BoardHttpError({
              status: 500,
              message: `Failed to link automation to card: ${String(cause)}`,
            }),
        ),
      );
    yield* writeBoardMarkdownForProject(card.projectId);
    const after = yield* repo.getCard({ id: cardId }).pipe(
      Effect.mapError(
        (cause) =>
          new BoardHttpError({
            status: 500,
            message: `Failed to read back card: ${String(cause)}`,
          }),
      ),
    );
    return yield* Option.match(after, {
      onNone: () =>
        Effect.fail(new BoardHttpError({ status: 404, message: `No card with id ${cardId}` })),
      onSome: (card) =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ card }, { status: 200 })),
    });
  }).pipe(Effect.catchTag("BoardHttpError", respondToError)),
);

// ---------------------------------------------------------------------------
// DELETE /api/board/cards/:id/schedule
//
// Remove a card's schedule — clears the card's schedule fields and
// deletes the underlying automation row.
// ---------------------------------------------------------------------------

export const kanbanUnscheduleCardRouteLayer = HttpRouter.add(
  "DELETE",
  "/api/board/cards/:id/schedule",
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const cardIdRaw = params.id;
    if (!cardIdRaw) {
      return yield* new BoardHttpError({ status: 400, message: "Missing :id parameter" });
    }
    const cardId = cardIdRaw as KanbanCardId;
    const repo = yield* KanbanRepository;
    const automations = yield* AutomationRepository;
    const now = yield* Clock.currentTimeMillis;
    const cardOpt = yield* repo.getCard({ id: cardId }).pipe(
      Effect.mapError(
        (cause) =>
          new BoardHttpError({ status: 500, message: `Failed to read card: ${String(cause)}` }),
      ),
    );
    const card = Option.getOrUndefined(cardOpt);
    if (!card) {
      return yield* new BoardHttpError({ status: 404, message: `No card with id ${cardId}` });
    }
    if (card.scheduleAutomationId) {
      yield* automations
        .deleteById({ id: card.scheduleAutomationId })
        .pipe(Effect.ignoreCause({ log: true }));
    }
    yield* repo
      .updateCard({
        id: cardId,
        scheduleJson: null,
        scheduleAutomationId: null,
        updatedAtMs: now,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new BoardHttpError({
              status: 500,
              message: `Failed to clear card schedule: ${String(cause)}`,
            }),
        ),
      );
    yield* writeBoardMarkdownForProject(card.projectId);
    return HttpServerResponse.jsonUnsafe({ unscheduled: true }, { status: 200 });
  }).pipe(Effect.catchTag("BoardHttpError", respondToError)),
);

export const kanbanAttachArtifactRouteLayer = HttpRouter.add(
  "POST",
  "/api/board/cards/:id/artifacts",
  Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const cardIdRaw = params.id;
    if (!cardIdRaw) {
      return yield* new BoardHttpError({ status: 400, message: "Missing :id parameter" });
    }
    const cardId = cardIdRaw as KanbanCardId;
    const body = yield* HttpServerRequest.schemaBodyJson(AttachArtifactBody).pipe(
      Effect.mapError(
        (cause) =>
          new BoardHttpError({
            status: 400,
            message: `Invalid artifact payload: ${String(cause)}`,
          }),
      ),
    );
    const repo = yield* KanbanRepository;
    const uuid = yield* Random.nextUUIDv4;
    const now = yield* Clock.currentTimeMillis;
    yield* repo
      .insertArtifact({
        id: KanbanArtifactId.make(`artifact-${uuid}`),
        cardId,
        kind: body.kind,
        payload: body.payload,
        createdAtMs: now,
      })
      .pipe(Effect.mapError((cause) => new BoardHttpError({
        status: 500,
        message: `Failed to insert artifact: ${String(cause)}`,
      })));
    // Artifact attachment doesn't change the card title/column, but we
    // still refresh the markdown so the journal stays accurate. Cheap
    // and means board.md always reflects what the agent has produced.
    const cardForRefresh = yield* repo.getCard({ id: cardId }).pipe(
      Effect.mapError((cause) => new BoardHttpError({
        status: 500,
        message: `Failed to read card for refresh: ${String(cause)}`,
      })),
    );
    yield* Option.match(cardForRefresh, {
      onNone: () => Effect.void,
      onSome: (card) => writeBoardMarkdownForProject(card.projectId),
    });
    return HttpServerResponse.jsonUnsafe(
      {
        artifact: {
          id: `artifact-${uuid}`,
          cardId,
          kind: body.kind,
          payload: body.payload,
          createdAt: now,
        },
      },
      { status: 201 },
    );
  }).pipe(Effect.catchTag("BoardHttpError", respondToError)),
);

