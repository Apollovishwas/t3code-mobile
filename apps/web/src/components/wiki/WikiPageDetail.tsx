import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, FileIcon, LinkIcon } from "lucide-react";
import type { ProjectId, WikiPage } from "@t3tools/contracts";

import ChatMarkdown from "../ChatMarkdown";

interface PageDetailResponse {
  readonly page: WikiPage;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }
  return response.json() as Promise<T>;
}

export function WikiPageDetail({
  projectId,
  slug,
}: {
  readonly projectId: ProjectId;
  readonly slug: string;
}) {
  const query = useQuery({
    queryKey: ["wiki", "page", projectId, slug],
    queryFn: () =>
      fetchJson<PageDetailResponse>(
        `/api/wiki/page?projectId=${projectId}&slug=${encodeURIComponent(slug)}`,
      ),
  });

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-x-hidden bg-background">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2 sm:px-4 sm:py-3">
        <Link
          to="/wiki"
          aria-label="Back to wiki"
          className="-ml-1 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground hover:cursor-pointer hover:bg-muted hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
          <span className="hidden text-xs sm:inline">Wiki</span>
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {query.data?.page.title ?? slug}
        </h1>
      </header>
      {query.isLoading ? (
        <div className="flex-1 px-6 py-10 text-center text-sm text-muted-foreground">
          Loading page…
        </div>
      ) : query.isError ? (
        <div className="flex-1 px-6 py-10 text-center text-sm text-muted-foreground">
          {(query.error as Error).message}
        </div>
      ) : query.data ? (
        <div className="flex min-h-0 flex-1 overflow-y-auto">
          <article className="mx-auto w-full max-w-3xl px-3 py-4 sm:px-6 sm:py-6">
            {query.data.page.summary ? (
              <p className="mb-4 text-sm italic text-muted-foreground">
                {query.data.page.summary}
              </p>
            ) : null}

            <div className="mb-4 flex flex-wrap gap-1">
              {query.data.page.topics.map((t) => (
                <span
                  key={t}
                  className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                >
                  {t}
                </span>
              ))}
              {query.data.page.archivedAt ? (
                <span className="rounded-sm bg-amber-500/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-700">
                  archived
                </span>
              ) : null}
            </div>

            <div className="prose prose-sm prose-neutral max-w-none dark:prose-invert">
              {/*
               * Wiki pages are user-trusted: their content was produced by
               * the agent + reviewed via git in the project repo. Render
               * through the same markdown pipeline chat uses so headings,
               * code blocks, and links work the way the user expects.
               */}
              <ChatMarkdown text={query.data.page.body} cwd={undefined} />
            </div>

            {query.data.page.backlinks.length > 0 ? (
              <section className="mt-8 border-t border-border pt-4">
                <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <LinkIcon className="size-3.5" />
                  Backlinks ({query.data.page.backlinks.length})
                </h2>
                <ul className="space-y-1.5">
                  {query.data.page.backlinks.map((b) => (
                    <li key={b.slug}>
                      <Link
                        to="/wiki/$projectId/page/$slug"
                        params={{ projectId, slug: b.slug }}
                        className="text-sm text-primary hover:underline"
                      >
                        {b.title}
                      </Link>
                      {b.summary ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          — {b.summary.slice(0, 100)}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {query.data.page.fileRefs.length > 0 ? (
              <section className="mt-6 border-t border-border pt-4">
                <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <FileIcon className="size-3.5" />
                  File refs ({query.data.page.fileRefs.length})
                </h2>
                <ul className="space-y-1 font-mono text-xs">
                  {query.data.page.fileRefs.map((ref) => (
                    <li key={ref.path} className="text-muted-foreground">
                      {ref.path}
                      {ref.isDir ? "/" : ""}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {query.data.page.outgoingLinks.length > 0 ? (
              <section className="mt-6 border-t border-border pt-4">
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Links out
                </h2>
                <ul className="space-y-1">
                  {query.data.page.outgoingLinks.map((target) => (
                    <li key={target}>
                      <Link
                        to="/wiki/$projectId/page/$slug"
                        params={{ projectId, slug: target }}
                        className="text-sm text-primary hover:underline"
                      >
                        {target}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </article>
        </div>
      ) : null}
    </div>
  );
}
