import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type {
  Automation,
  AutomationId,
  CreateAutomationInput,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { readLocalApi } from "~/localApi";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

/**
 * Settings panel — scheduled automations.
 *
 * v1 surfaces:
 *  - List of existing automations with name, schedule summary, last-fired
 *    relative time, an enable toggle, a "Run now" tap, and delete.
 *  - Inline "Add" form: name + interval preset chips + project + thread +
 *    prompt textarea. ProjectId / ThreadId are entered as text because
 *    the cross-environment picker isn't on this screen yet — a small
 *    quality-of-life pass for v2.
 *
 * Only `send-prompt` is supported in v1. The contract also has a
 * `resume-and-prompt` action shape; once the bootstrap-thread helper is
 * extracted from `ws.ts` we'll add a second tab here.
 */

const INTERVAL_PRESETS: ReadonlyArray<{ label: string; minutes: number }> = [
  { label: "Every 5 min", minutes: 5 },
  { label: "Every 15 min", minutes: 15 },
  { label: "Every hour", minutes: 60 },
  { label: "Every 4 hours", minutes: 4 * 60 },
  { label: "Every 12 hours", minutes: 12 * 60 },
  { label: "Every 24 hours", minutes: 24 * 60 },
];

const automationsQueryKey = ["automations", "list"] as const;

function summariseSchedule(automation: Automation): string {
  const minutes = automation.schedule.minutes;
  if (minutes === 60) return "Every hour";
  if (minutes < 60) return `Every ${minutes} min`;
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    if (hours === 24) return "Every 24 hours";
    return `Every ${hours} hours`;
  }
  return `Every ${minutes} min`;
}

function relativeFrom(ms: number | null, now: number): string {
  if (ms === null) return "—";
  const diff = ms - now;
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return diff > 0 ? "in <1 min" : "just now";
  if (minutes < 60) return diff > 0 ? `in ${minutes} min` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return diff > 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return diff > 0 ? `in ${days}d` : `${days}d ago`;
}

export function AutomationsSettingsPanel() {
  const queryClient = useQueryClient();
  const localApi = readLocalApi();
  const automationsQuery = useQuery({
    queryKey: automationsQueryKey,
    queryFn: async () => {
      if (!localApi) throw new Error("Local backend unavailable");
      return localApi.automations.list();
    },
    refetchInterval: 15_000,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: automationsQueryKey });

  const toggleMutation = useMutation({
    mutationFn: async (args: { id: AutomationId; enabled: boolean }) => {
      if (!localApi) throw new Error("Local backend unavailable");
      return localApi.automations.update({ id: args.id, enabled: args.enabled });
    },
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: AutomationId) => {
      if (!localApi) throw new Error("Local backend unavailable");
      return localApi.automations.delete(id);
    },
    onSuccess: invalidate,
  });

  const runNowMutation = useMutation({
    mutationFn: async (id: AutomationId) => {
      if (!localApi) throw new Error("Local backend unavailable");
      return localApi.automations.runNow(id);
    },
    onSuccess: invalidate,
  });

  const createMutation = useMutation({
    mutationFn: async (input: CreateAutomationInput) => {
      if (!localApi) throw new Error("Local backend unavailable");
      return localApi.automations.create(input);
    },
    onSuccess: invalidate,
  });

  const now = Date.now();
  const automations = automationsQuery.data ?? [];

  return (
    <SettingsPageContainer>
      <SettingsSection title="Scheduled automations">
        <div className="flex flex-col gap-3 p-3">
          <p className="text-xs text-muted-foreground">
            Recurring prompts fired by the server. Each fire goes through the same
            turn pipeline a manual send uses — push notifications + activity
            stream all work normally.
          </p>
          {automationsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : automations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No automations yet. Add one below.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {automations.map((automation) => (
                <li
                  key={automation.id}
                  className="rounded-lg border border-border bg-card p-3 text-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={
                            "inline-block size-2 shrink-0 rounded-full " +
                            (automation.status === "enabled"
                              ? "bg-green-500"
                              : automation.status === "failing"
                                ? "bg-rose-500"
                                : "bg-muted-foreground/40")
                          }
                          aria-hidden="true"
                        />
                        <span className="truncate font-medium text-foreground">
                          {automation.name}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {summariseSchedule(automation)}
                        {" · last fired "}
                        {relativeFrom(automation.lastRunAt, now)}
                        {automation.status === "enabled" ? (
                          <>
                            {" · next "}
                            {relativeFrom(automation.nextRunAt, now)}
                          </>
                        ) : null}
                      </div>
                      {automation.lastErrorMessage ? (
                        <p className="mt-1 text-xs text-rose-600 dark:text-rose-300">
                          {automation.lastErrorMessage}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        className="rounded-full border border-border bg-background px-2 py-1 text-xs hover:cursor-pointer hover:bg-muted"
                        onClick={() => runNowMutation.mutate(automation.id)}
                        disabled={runNowMutation.isPending}
                      >
                        Run now
                      </button>
                      <button
                        type="button"
                        className={
                          "rounded-full px-2 py-1 text-xs hover:cursor-pointer " +
                          (automation.status === "enabled"
                            ? "border border-border bg-background hover:bg-muted"
                            : "border border-primary/40 bg-primary/10 text-primary")
                        }
                        onClick={() =>
                          toggleMutation.mutate({
                            id: automation.id,
                            enabled: automation.status !== "enabled",
                          })
                        }
                        disabled={toggleMutation.isPending}
                      >
                        {automation.status === "enabled" ? "Pause" : "Enable"}
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${automation.name}`}
                        className="rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-600 hover:cursor-pointer hover:bg-rose-500/15 dark:text-rose-300"
                        onClick={() => {
                          if (
                            window.confirm(`Delete automation "${automation.name}"?`)
                          ) {
                            deleteMutation.mutate(automation.id);
                          }
                        }}
                        disabled={deleteMutation.isPending}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <AddAutomationForm
            onCreate={(input) => createMutation.mutate(input)}
            isPending={createMutation.isPending}
          />
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

interface AddAutomationFormProps {
  readonly onCreate: (input: CreateAutomationInput) => void;
  readonly isPending: boolean;
}

function AddAutomationForm({ onCreate, isPending }: AddAutomationFormProps) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState("");
  const [minutes, setMinutes] = useState<number>(INTERVAL_PRESETS[2]!.minutes); // hourly default
  const [projectIdStr, setProjectIdStr] = useState("");
  const [threadIdStr, setThreadIdStr] = useState("");
  const [prompt, setPrompt] = useState("");

  if (!expanded) {
    return (
      <button
        type="button"
        className="self-start rounded-full border border-border bg-background px-3 py-1.5 text-sm hover:cursor-pointer hover:bg-muted"
        onClick={() => setExpanded(true)}
      >
        + Add automation
      </button>
    );
  }

  const canSubmit =
    !isPending &&
    name.trim().length > 0 &&
    projectIdStr.trim().length > 0 &&
    threadIdStr.trim().length > 0 &&
    prompt.trim().length > 0;

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-dashed border-border bg-card p-3 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        onCreate({
          name: name.trim() as CreateAutomationInput["name"],
          projectId: projectIdStr.trim() as unknown as ProjectId,
          enabled: true,
          schedule: { kind: "interval", minutes },
          action: {
            kind: "send-prompt",
            threadId: threadIdStr.trim() as unknown as ThreadId,
            prompt: prompt.trim() as CreateAutomationInput["action"] extends {
              prompt: infer P;
            }
              ? P
              : never,
          },
        });
        // Reset & close.
        setName("");
        setProjectIdStr("");
        setThreadIdStr("");
        setPrompt("");
        setExpanded(false);
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Name</span>
        <input
          type="text"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          placeholder="Daily triage"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </label>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Schedule</span>
        <div className="flex flex-wrap gap-1.5">
          {INTERVAL_PRESETS.map((preset) => (
            <button
              key={preset.minutes}
              type="button"
              className={
                "rounded-full border px-2.5 py-1 text-xs hover:cursor-pointer " +
                (minutes === preset.minutes
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-background hover:bg-muted")
              }
              onClick={() => setMinutes(preset.minutes)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">
          Project id <span className="text-muted-foreground/60">(from the sidebar URL)</span>
        </span>
        <input
          type="text"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm font-mono"
          placeholder="prj-…"
          value={projectIdStr}
          onChange={(event) => setProjectIdStr(event.target.value)}
          required
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">
          Thread id <span className="text-muted-foreground/60">(open the thread; copy id from URL)</span>
        </span>
        <input
          type="text"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm font-mono"
          placeholder="thr-…"
          value={threadIdStr}
          onChange={(event) => setThreadIdStr(event.target.value)}
          required
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Prompt to send</span>
        <textarea
          className="min-h-20 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          placeholder="Run the tests and fix anything red."
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          required
        />
      </label>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          className="rounded-full border border-border bg-background px-3 py-1.5 text-sm hover:cursor-pointer hover:bg-muted"
          onClick={() => setExpanded(false)}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-full bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:cursor-pointer disabled:opacity-50"
          disabled={!canSubmit}
        >
          {isPending ? "Saving…" : "Save automation"}
        </button>
      </div>
    </form>
  );
}
