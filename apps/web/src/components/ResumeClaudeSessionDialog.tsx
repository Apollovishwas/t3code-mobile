import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeftIcon, FolderIcon, HistoryIcon, LoaderIcon, Trash2Icon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { scopeProjectRef } from "@t3tools/client-runtime";
import type { ScopedProjectRef } from "@t3tools/contracts";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { useSidebar } from "./ui/sidebar";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import { useHandleNewThread } from "../hooks/useHandleNewThread";

interface FolderItem {
  readonly cwd: string;
  readonly sessionCount: number;
  readonly lastActivity: string;
}

interface SessionItem {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string;
  readonly lastActivity: string;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function shortenPath(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join("/")}`;
}

export function ResumeClaudeSessionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const { handleNewThread } = useHandleNewThread();
  const { setOpenMobile } = useSidebar();

  const [step, setStep] = useState<"folders" | "sessions">("folders");
  const [folders, setFolders] = useState<ReadonlyArray<FolderItem>>([]);
  const [sessions, setSessions] = useState<ReadonlyArray<SessionItem>>([]);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // First T3 project (if any) whose cwd matches a folder — only matched folders
  // are resumable, since a new thread needs a project to run in.
  const projectRefByCwd = useMemo(() => {
    const map = new Map<string, ScopedProjectRef>();
    for (const project of projects) {
      if (!map.has(project.cwd)) {
        map.set(project.cwd, scopeProjectRef(project.environmentId, project.id));
      }
    }
    return map;
  }, [projects]);

  useEffect(() => {
    if (!open) return;
    setStep("folders");
    setSelectedCwd(null);
    setSessions([]);
    setError(null);
    setLoading(true);
    let cancelled = false;
    fetch("/api/claude-sessions/folders")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { folders?: ReadonlyArray<FolderItem> }) => {
        if (!cancelled) setFolders(data.folders ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load Claude session folders.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const selectFolder = useCallback((cwd: string) => {
    setSelectedCwd(cwd);
    setStep("sessions");
    setSessions([]);
    setError(null);
    setLoading(true);
    let cancelled = false;
    fetch(`/api/claude-sessions?cwd=${encodeURIComponent(cwd)}&limit=10`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { sessions?: ReadonlyArray<SessionItem> }) => {
        if (!cancelled) setSessions(data.sessions ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load sessions for this folder.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const deleteSession = useCallback(async (session: SessionItem) => {
    const confirmed =
      typeof window === "undefined" ||
      window.confirm(`Permanently delete this Claude session transcript?\n\n${session.title}`);
    if (!confirmed) {
      return;
    }
    try {
      const response = await fetch("/api/claude-sessions/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: session.sessionId }),
      });
      if (response.ok) {
        setSessions((prev) => prev.filter((s) => s.sessionId !== session.sessionId));
      }
    } catch (error) {
      console.warn("Failed to delete Claude session", error);
    }
  }, []);

  const createFromSession = useCallback(
    async (session: SessionItem) => {
      const projectRef = projectRefByCwd.get(session.cwd);
      if (!projectRef) return;
      setCreating(true);
      try {
        await handleNewThread(projectRef, {
          resumeSessionId: session.sessionId,
          resumeSessionTitle: session.title,
        });
        onOpenChange(false);
        // On phones the sidebar is a full-screen overlay; close it so the new
        // draft/composer is visible instead of staying hidden behind it.
        setOpenMobile(false);
      } finally {
        setCreating(false);
      }
    },
    [handleNewThread, onOpenChange, projectRefByCwd],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HistoryIcon className="size-4" aria-hidden />
            Resume a Claude session
          </DialogTitle>
          <DialogDescription>
            {step === "folders"
              ? "Pick a folder, then choose a past Claude session to continue in a new thread."
              : selectedCwd}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="min-h-64">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <LoaderIcon className="size-4 animate-spin" aria-hidden />
              Loading…
            </div>
          ) : error ? (
            <div className="py-12 text-center text-sm text-destructive-foreground">{error}</div>
          ) : step === "folders" ? (
            folders.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No Claude sessions found on this machine.
              </div>
            ) : (
              <ul className="flex flex-col gap-1">
                {folders.map((folder) => {
                  const resumable = projectRefByCwd.has(folder.cwd);
                  return (
                    <li key={folder.cwd}>
                      <button
                        type="button"
                        disabled={!resumable}
                        title={
                          resumable
                            ? folder.cwd
                            : "Add this folder as a project before resuming its sessions."
                        }
                        onClick={() => selectFolder(folder.cwd)}
                        className="flex w-full items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {shortenPath(folder.cwd)}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {folder.sessionCount} session{folder.sessionCount === 1 ? "" : "s"}
                            {resumable ? "" : " · not a project yet"}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {formatRelative(folder.lastActivity)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )
          ) : sessions.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No sessions in this folder.
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {sessions.map((session) => (
                <li key={session.sessionId} className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={creating}
                    onClick={() => void createFromSession(session)}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/50 disabled:opacity-50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {session.title}
                      </span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">
                        {session.sessionId.slice(0, 8)}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatRelative(session.lastActivity)}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label="Delete session"
                    title="Delete this session permanently"
                    disabled={creating}
                    onClick={() => void deleteSession(session)}
                    className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive-foreground disabled:opacity-50"
                  >
                    <Trash2Icon className="size-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
        {step === "sessions" ? (
          <div className="flex items-center justify-between border-t border-border px-4 py-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setStep("folders");
                setError(null);
              }}
            >
              <ChevronLeftIcon className="size-4" aria-hidden />
              Back to folders
            </Button>
            <span className="text-xs text-muted-foreground">
              {creating ? "Creating thread…" : "Select a session to resume"}
            </span>
          </div>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
