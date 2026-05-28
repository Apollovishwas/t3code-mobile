import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BookOpenIcon, PlayIcon, RefreshCwIcon, TrashIcon } from "lucide-react";

import { useStore, selectProjectsAcrossEnvironments } from "~/store";
import { useShallow } from "zustand/react/shallow";

interface WikiSchedule {
  readonly projectId: string;
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  readonly startedAtMs: number;
  readonly lastFiredAtMs: number | null;
  readonly lastOutcome:
    | { kind: "success"; capturedMessages: number }
    | { kind: "skipped"; reason: string }
    | { kind: "failed"; error: string }
    | null;
}

interface SchedulesResponse {
  readonly schedules: ReadonlyArray<WikiSchedule>;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Wiki settings — its own panel, distinct from Automations as the
 * user requested. In-memory schedules in v1; schedules reset on
 * server restart and the panel re-creates them when re-enabled.
 */
export function WikiSettingsPanel() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const queryClient = useQueryClient();
  const schedulesQuery = useQuery({
    queryKey: ["wiki", "schedules"],
    queryFn: () => fetchJson<SchedulesResponse>("/api/wiki/schedules"),
    refetchInterval: 15_000,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["wiki", "schedules"] });

  const upsertMutation = useMutation({
    mutationFn: (input: { projectId: string; enabled: boolean; intervalMinutes: number }) =>
      fetchJson("/api/wiki/schedules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (projectId: string) =>
      fetchJson(`/api/wiki/schedules?projectId=${encodeURIComponent(projectId)}`, {
        method: "DELETE",
      }),
    onSuccess: invalidate,
  });

  const gardenMutation = useMutation({
    mutationFn: (projectId: string) =>
      fetchJson("/api/wiki/garden", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      }),
  });

  const scheduleMap = new Map((schedulesQuery.data?.schedules ?? []).map((s) => [s.projectId, s]));

  return (
    <div className="mx-auto w-full max-w-3xl px-3 py-4 sm:px-6 sm:py-6">
      <div className="mb-4 flex items-center gap-2">
        <BookOpenIcon className="size-5" />
        <h1 className="text-lg font-semibold">Wiki</h1>
      </div>
      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        T3 reads each project's <code className="rounded-sm bg-muted px-1">.almanac/</code>{" "}
        wiki — a living docs cache maintained by{" "}
        <a
          href="https://github.com/AlmanacCode/codealmanac"
          className="text-primary underline"
          target="_blank"
          rel="noreferrer"
        >
          codealmanac
        </a>
        . Enable a sweep per-project to have T3 ingest the most-recent thread on a schedule.
        <br />
        <span className="text-amber-700">v1 limit: schedules reset on server restart.</span>
      </p>

      {projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">No projects yet.</p>
      ) : (
        <ul className="space-y-3">
          {projects.map((project) => {
            const schedule = scheduleMap.get(project.id);
            return (
              <li
                key={project.id}
                className="rounded-md border border-border bg-card px-3 py-3"
              >
                <ProjectScheduleRow
                  projectId={project.id}
                  projectName={project.name}
                  schedule={schedule}
                  busy={upsertMutation.isPending || deleteMutation.isPending}
                  onUpsert={(input) =>
                    upsertMutation.mutate({ projectId: project.id, ...input })
                  }
                  onRemove={() => deleteMutation.mutate(project.id)}
                  onGarden={() => gardenMutation.mutate(project.id)}
                  gardenBusy={gardenMutation.isPending}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ProjectScheduleRow({
  projectId,
  projectName,
  schedule,
  busy,
  onUpsert,
  onRemove,
  onGarden,
  gardenBusy,
}: {
  readonly projectId: string;
  readonly projectName: string;
  readonly schedule: WikiSchedule | undefined;
  readonly busy: boolean;
  readonly onUpsert: (input: { enabled: boolean; intervalMinutes: number }) => void;
  readonly onRemove: () => void;
  readonly onGarden: () => void;
  readonly gardenBusy: boolean;
}) {
  const [intervalMinutes, setIntervalMinutes] = useState<number>(
    schedule?.intervalMinutes ?? 360,
  );
  const enabled = schedule?.enabled ?? false;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{projectName}</div>
          <div className="truncate text-[11px] text-muted-foreground">{projectId}</div>
        </div>
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) =>
              onUpsert({ enabled: event.target.checked, intervalMinutes })
            }
            disabled={busy}
          />
          enabled
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">every</span>
        <input
          type="number"
          min={5}
          max={60 * 24}
          step={5}
          value={intervalMinutes}
          onChange={(event) => setIntervalMinutes(Number(event.target.value) || 60)}
          onBlur={() =>
            schedule && onUpsert({ enabled, intervalMinutes })
          }
          disabled={busy}
          className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs"
        />
        <span className="text-xs text-muted-foreground">minutes</span>
        <div className="ml-auto flex gap-1">
          <button
            type="button"
            onClick={onGarden}
            disabled={gardenBusy}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
          >
            <PlayIcon className="size-3" />
            {gardenBusy ? "Gardening…" : "Garden now"}
          </button>
          {schedule ? (
            <button
              type="button"
              onClick={onRemove}
              disabled={busy}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
              aria-label="Forget schedule"
            >
              <TrashIcon className="size-3" />
            </button>
          ) : null}
        </div>
      </div>
      {schedule?.lastOutcome ? (
        <div className="rounded-md bg-muted/50 px-2 py-1.5 text-[11px] text-muted-foreground">
          <RefreshCwIcon className="mr-1 inline size-3" />
          {schedule.lastOutcome.kind === "success" ? (
            <>Last fired: captured {schedule.lastOutcome.capturedMessages} message(s).</>
          ) : schedule.lastOutcome.kind === "skipped" ? (
            <>Last tick skipped: {schedule.lastOutcome.reason}</>
          ) : (
            <>Last tick failed: {schedule.lastOutcome.error}</>
          )}
          {schedule.lastFiredAtMs ? (
            <> · {new Date(schedule.lastFiredAtMs).toLocaleString()}</>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
