import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  ArrowLeftIcon,
  BookOpenIcon,
  ChevronRightIcon,
  PlayIcon,
  RefreshCwIcon,
  SearchIcon,
  TerminalIcon,
} from "lucide-react";
import type {
  ProjectId,
  WikiPageSummary,
  WikiStatus,
  WikiTopicTreeNode,
} from "@t3tools/contracts";

import { cn } from "~/lib/utils";

/**
 * Read-only Wiki page — browse a project's Almanac wiki on mobile or
 * desktop. Writes happen through the agent (capture/garden), not here.
 *
 * Three states surface on first paint:
 *   - "not-initialized": no .almanac/ → InstallPanel + run-init hint
 *   - "unsupported-schema": .almanac/ present but wrong version → upgrade hint
 *   - "ready": browse + search + topic-tree
 */

const STORAGE_KEY = "t3.wiki.lastProjectId";

interface WikiPageProps {
  readonly projects?: ReadonlyArray<{ id: ProjectId; name: string }>;
}

interface StatusResponse {
  readonly status: WikiStatus;
}

interface PagesResponse {
  readonly pages: ReadonlyArray<WikiPageSummary>;
}

interface SearchResponse {
  readonly hits: ReadonlyArray<WikiPageSummary>;
}

interface TopicsResponse {
  readonly topics: ReadonlyArray<WikiTopicTreeNode>;
}

interface DetectResponse {
  readonly almanac: {
    readonly state: "found" | "missing" | "broken";
    readonly version: string | null;
    readonly detail: string | null;
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }
  return response.json() as Promise<T>;
}

export function WikiPage({ projects }: WikiPageProps) {
  const [selectedProjectId, setSelectedProjectIdRaw] = useState<ProjectId | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return (window.localStorage.getItem(STORAGE_KEY) as ProjectId | null) ?? null;
    } catch {
      return null;
    }
  });
  const setSelectedProjectId = (id: ProjectId | null) => {
    setSelectedProjectIdRaw(id);
    try {
      if (id) window.localStorage.setItem(STORAGE_KEY, id);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  };
  const [search, setSearch] = useState("");
  const [topicFilter, setTopicFilter] = useState<string | null>(null);

  const projectsList = projects ?? [];
  const effectiveProjectId: ProjectId | null =
    selectedProjectId ?? projectsList[0]?.id ?? null;

  const statusQuery = useQuery({
    queryKey: ["wiki", "status", effectiveProjectId],
    queryFn: () =>
      fetchJson<StatusResponse>(`/api/wiki/status?projectId=${effectiveProjectId}`),
    enabled: effectiveProjectId !== null,
  });

  const detectQuery = useQuery({
    queryKey: ["wiki", "detect"],
    queryFn: () => fetchJson<DetectResponse>(`/api/wiki/detect`),
    // Detection result rarely changes — refresh on focus, not on tick.
    refetchInterval: false,
  });

  const ready = statusQuery.data?.status.state === "ready";

  const topicsQuery = useQuery({
    queryKey: ["wiki", "topics", effectiveProjectId],
    queryFn: () => fetchJson<TopicsResponse>(`/api/wiki/topics?projectId=${effectiveProjectId}`),
    enabled: ready && effectiveProjectId !== null,
  });

  const pagesQuery = useQuery({
    queryKey: ["wiki", "list", effectiveProjectId, topicFilter],
    queryFn: () => {
      const params = new URLSearchParams({ projectId: String(effectiveProjectId) });
      if (topicFilter) params.set("topic", topicFilter);
      return fetchJson<PagesResponse>(`/api/wiki/list?${params}`);
    },
    enabled: ready && effectiveProjectId !== null,
  });

  const searchQuery = useQuery({
    queryKey: ["wiki", "search", effectiveProjectId, search],
    queryFn: () => {
      const params = new URLSearchParams({
        projectId: String(effectiveProjectId),
        q: search,
      });
      return fetchJson<SearchResponse>(`/api/wiki/search?${params}`);
    },
    enabled: ready && effectiveProjectId !== null && search.trim().length > 0,
  });

  const visiblePages = search.trim().length > 0
    ? searchQuery.data?.hits ?? []
    : pagesQuery.data?.pages ?? [];

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-x-hidden bg-background">
      <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 sm:px-4 sm:py-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <Link
            to="/"
            aria-label="Back to threads"
            className="-ml-1 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground hover:cursor-pointer hover:bg-muted hover:text-foreground"
          >
            <ArrowLeftIcon className="size-4" />
            <span className="hidden text-xs sm:inline">Threads</span>
          </Link>
          <BookOpenIcon className="size-4 shrink-0 text-muted-foreground" />
          <h1 className="truncate text-sm font-semibold">Wiki</h1>
        </div>
        <div className="flex items-center gap-2">
          {projectsList.length > 1 ? (
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-xs"
              value={effectiveProjectId ?? ""}
              onChange={(event) =>
                setSelectedProjectId((event.target.value || null) as ProjectId | null)
              }
              aria-label="Pick project"
            >
              {projectsList.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            onClick={() => {
              statusQuery.refetch();
              topicsQuery.refetch();
              pagesQuery.refetch();
              if (search.trim()) searchQuery.refetch();
            }}
            aria-label="Refresh"
            className="rounded-md border border-border px-1.5 py-1 text-xs hover:bg-muted"
          >
            <RefreshCwIcon className="size-3.5" />
          </button>
        </div>
      </header>

      {effectiveProjectId === null ? (
        <EmptyState message="No projects yet — add one to start a wiki." />
      ) : statusQuery.isLoading ? (
        <EmptyState message="Loading wiki status…" />
      ) : statusQuery.isError ? (
        <EmptyState
          message={`Failed to load wiki status: ${(statusQuery.error as Error).message}`}
        />
      ) : statusQuery.data?.status.state === "not-initialized" ? (
        <InstallPanel
          workspaceRoot={statusQuery.data.status.workspaceRoot}
          detected={detectQuery.data?.almanac}
          projectId={effectiveProjectId}
        />
      ) : statusQuery.data?.status.state === "unsupported-schema" ? (
        <EmptyState
          message={`Almanac schema version ${statusQuery.data.status.schemaVersion} is newer than T3 supports (we read version 3). Update T3 or downgrade Almanac.`}
        />
      ) : (
        <div className="flex min-h-0 flex-1 min-w-0">
          {/* Topic tree — hides on mobile under a `details` disclosure */}
          <aside className="hidden w-56 shrink-0 border-r border-border bg-card/40 sm:flex sm:flex-col">
            <TopicSidebar
              topics={topicsQuery.data?.topics ?? []}
              selected={topicFilter}
              onSelect={setTopicFilter}
            />
          </aside>

          <main className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
              <input
                type="search"
                placeholder="Search this wiki (FTS5)…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              {topicFilter ? (
                <button
                  type="button"
                  onClick={() => setTopicFilter(null)}
                  className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                >
                  {topicFilter} ×
                </button>
              ) : null}
            </div>

            <details className="border-b border-border px-3 py-2 sm:hidden">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Topics ({topicsQuery.data?.topics.length ?? 0})
              </summary>
              <div className="pt-2">
                <TopicSidebar
                  topics={topicsQuery.data?.topics ?? []}
                  selected={topicFilter}
                  onSelect={setTopicFilter}
                />
              </div>
            </details>

            <ul className="flex-1 divide-y divide-border overflow-y-auto">
              {visiblePages.length === 0 ? (
                <li className="px-3 py-6 text-sm text-muted-foreground">
                  {search.trim()
                    ? "No matches."
                    : topicFilter
                      ? `No pages under topic "${topicFilter}".`
                      : "No pages yet — ask Claude to capture this thread."}
                </li>
              ) : null}
              {visiblePages.map((page) => (
                <li key={page.slug}>
                  <Link
                    to="/wiki/$projectId/page/$slug"
                    params={{ projectId: effectiveProjectId as string, slug: page.slug }}
                    className="flex items-start gap-2 px-3 py-3 hover:bg-muted/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{page.title}</div>
                      {page.summary ? (
                        <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {page.summary}
                        </div>
                      ) : null}
                      <div className="mt-1 flex flex-wrap gap-1">
                        {page.topics.map((t) => (
                          <span
                            key={t}
                            className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                          >
                            {t}
                          </span>
                        ))}
                        {page.archivedAt ? (
                          <span className="rounded-sm bg-amber-500/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-700">
                            archived
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <ChevronRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>

            {statusQuery.data?.status.state === "ready" ? (
              <footer className="border-t border-border bg-card/40 px-3 py-2 text-[11px] text-muted-foreground">
                {statusQuery.data.status.health.pageCount} pages
                {" · "}
                {statusQuery.data.status.health.topicCount} topics
                {statusQuery.data.status.health.staleCount > 0
                  ? ` · ${statusQuery.data.status.health.staleCount} stale`
                  : null}
                {statusQuery.data.status.health.orphanCount > 0
                  ? ` · ${statusQuery.data.status.health.orphanCount} orphan`
                  : null}
                {statusQuery.data.status.health.brokenLinkCount > 0
                  ? ` · ${statusQuery.data.status.health.brokenLinkCount} broken`
                  : null}
              </footer>
            ) : null}
          </main>
        </div>
      )}
    </div>
  );
}

function EmptyState({ message }: { readonly message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center">
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

interface InitResponse {
  readonly result: {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
  };
}

function InstallPanel({
  workspaceRoot,
  detected,
  projectId,
}: {
  readonly workspaceRoot: string;
  readonly detected: DetectResponse["almanac"] | undefined;
  readonly projectId: ProjectId;
}) {
  const queryClient = useQueryClient();
  const initMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/wiki/init", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const body = (await response.json()) as InitResponse | { error: string };
      if (!response.ok) {
        throw new Error("error" in body ? body.error : `HTTP ${response.status}`);
      }
      const result = (body as InitResponse).result;
      if (result.exitCode !== 0) {
        throw new Error(
          `almanac init exited ${result.exitCode}: ${result.stderr || result.stdout}`,
        );
      }
      return result;
    },
    onSuccess: () => {
      // Refetch status — should flip to "ready" once .almanac/index.db lands.
      queryClient.invalidateQueries({ queryKey: ["wiki", "status", projectId] });
      queryClient.invalidateQueries({ queryKey: ["wiki", "topics", projectId] });
      queryClient.invalidateQueries({ queryKey: ["wiki", "list", projectId] });
    },
  });

  const canInit = detected?.state === "found";

  // `detected` is kept on the props for backward compat with B10 but the
  // server-side detect endpoint now always reports `found` for the DIY
  // markdown backend. We could drop the check entirely; we keep it so
  // ancient cached PWA bundles don't break.
  void detected;

  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-lg space-y-4 text-sm">
        <div className="flex items-center gap-2">
          <TerminalIcon className="size-4 text-muted-foreground" />
          <h2 className="font-semibold">No wiki yet for this project</h2>
        </div>
        <p className="text-muted-foreground">
          T3 stores wiki pages as markdown in{" "}
          <code className="rounded-sm bg-muted px-1">
            {workspaceRoot}/.t3/wiki/
          </code>
          . Click below to create the folder; the agent maintains pages from then
          on, using your existing Claude Code subscription — no API key, no
          external CLI, no extra billing.
        </p>
        <button
          type="button"
          onClick={() => initMutation.mutate()}
          disabled={initMutation.isPending}
          className="flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          <PlayIcon className="size-4" />
          {initMutation.isPending ? "Initialising…" : "Initialise wiki here"}
        </button>
        <p className="text-[11px] text-muted-foreground">
          Creates <code>.t3/wiki/index.md</code>. Commit it to git so the wiki
          survives clones. Ask Claude in any thread to write the first real
          page.
        </p>
        {initMutation.isError ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-700">
            <div className="font-medium">Init failed</div>
            <pre className="mt-1 whitespace-pre-wrap break-words">
              {(initMutation.error as Error).message}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TopicSidebar({
  topics,
  selected,
  onSelect,
}: {
  readonly topics: ReadonlyArray<WikiTopicTreeNode>;
  readonly selected: string | null;
  readonly onSelect: (slug: string | null) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto p-2">
      <ul className="space-y-0.5 text-sm">
        <li>
          <button
            type="button"
            onClick={() => onSelect(null)}
            className={cn(
              "w-full rounded-md px-2 py-1 text-left text-xs",
              selected === null ? "bg-primary/10 text-primary" : "hover:bg-muted",
            )}
          >
            All pages
          </button>
        </li>
        {topics.map((topic) => (
          <TopicRow
            key={topic.slug}
            topic={topic}
            depth={0}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  );
}

function TopicRow({
  topic,
  depth,
  selected,
  onSelect,
}: {
  readonly topic: WikiTopicTreeNode;
  readonly depth: number;
  readonly selected: string | null;
  readonly onSelect: (slug: string | null) => void;
}) {
  const indent = useMemo(() => `${depth * 0.75}rem`, [depth]);
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(topic.slug)}
        style={{ paddingLeft: `calc(0.5rem + ${indent})` }}
        className={cn(
          "flex w-full items-center justify-between rounded-md py-1 pr-2 text-left text-xs",
          selected === topic.slug ? "bg-primary/10 text-primary" : "hover:bg-muted",
        )}
      >
        <span className="truncate">{topic.title}</span>
        <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">{topic.pageCount}</span>
      </button>
      {topic.children.length > 0 ? (
        <ul className="space-y-0.5">
          {topic.children.map((child) => (
            <TopicRow
              key={child.slug}
              topic={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
