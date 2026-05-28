import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LinkIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { NoActiveThreadState } from "../components/NoActiveThreadState";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { useSavedEnvironmentRegistryStore } from "../environments/runtime";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../store";
import { APP_DISPLAY_NAME } from "~/branding";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const savedEnvironmentCount = useSavedEnvironmentRegistryStore(
    (state) => Object.keys(state.byId).length,
  );
  const navigate = useNavigate();
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));

  // "Always open the last chatted thread": redirect the index to the most
  // recently active (non-archived) thread once threads have hydrated.
  const mostRecentThread = useMemo(() => {
    let best: (typeof threads)[number] | undefined;
    let bestKey = "";
    for (const thread of threads) {
      if (thread.archivedAt) continue;
      const key = thread.updatedAt ?? thread.createdAt;
      if (best === undefined || key.localeCompare(bestKey) > 0) {
        best = thread;
        bestKey = key;
      }
    }
    return best;
  }, [threads]);

  useEffect(() => {
    if (mostRecentThread) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: mostRecentThread.environmentId,
          threadId: mostRecentThread.id,
        },
        replace: true,
      });
    }
  }, [mostRecentThread, navigate]);

  if (authGateState.status === "hosted-static" && savedEnvironmentCount === 0) {
    return <HostedStaticOnboardingState />;
  }

  return <NoActiveThreadState />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

function HostedStaticOnboardingState() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <LinkIcon className="size-5" />
              </div>
              <EmptyTitle className="text-foreground text-xl">
                Connect an environment to get started
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                Open a pairing link from your T3 Code desktop app or add a reachable backend
                manually. Your saved environments stay in this browser.
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button render={<a href="/settings/connections" />} size="sm">
                  <PlusIcon className="size-4" />
                  Add environment
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
