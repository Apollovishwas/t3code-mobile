import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  BookOpenIcon,
  KanbanSquareIcon,
  MessagesSquareIcon,
  SettingsIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { haptic } from "~/lib/haptics";
import { useSidebar } from "./ui/sidebar";

/**
 * Mobile-only bottom tab bar — the native-app navigation pattern. Only
 * rendered on phone viewports (the caller gates on `useIsMobile`); iPad
 * and desktop keep the left sidebar.
 *
 * Layout coordination: while mounted it sets `--bottom-nav-inset` on the
 * document root so the app-shell height calc in AppSidebarLayout reserves
 * space and content never hides behind the bar. When the on-screen
 * keyboard opens (visualViewport shrinks) the bar slides away and the
 * inset is cleared — the composer drops straight to the keyboard, exactly
 * like a native messaging app.
 */

const TAB_INSET = "calc(3.5rem + env(safe-area-inset-bottom))";
const KEYBOARD_OPEN_THRESHOLD_PX = 120;

interface TabDef {
  readonly key: string;
  readonly label: string;
  readonly icon: typeof MessagesSquareIcon;
  /** Match the active tab against the current pathname. */
  readonly isActive: (pathname: string) => boolean;
}

const TABS: ReadonlyArray<TabDef> = [
  {
    key: "threads",
    label: "Threads",
    icon: MessagesSquareIcon,
    isActive: (p) =>
      p === "/" || p.startsWith("/_chat") || (!p.startsWith("/board") && !p.startsWith("/wiki") && !p.startsWith("/settings")),
  },
  {
    key: "board",
    label: "Board",
    icon: KanbanSquareIcon,
    isActive: (p) => p.startsWith("/board"),
  },
  {
    key: "wiki",
    label: "Wiki",
    icon: BookOpenIcon,
    isActive: (p) => p.startsWith("/wiki"),
  },
  {
    key: "settings",
    label: "Settings",
    icon: SettingsIcon,
    isActive: (p) => p.startsWith("/settings"),
  },
];

export function BottomTabBar() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (l) => l.pathname });
  const { setOpenMobile } = useSidebar();
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  // Reserve shell height while the bar is visible; release it when the
  // keyboard opens (bar hidden) and on unmount. AppSidebarLayout's height
  // calc reads `--bottom-nav-inset` so content never hides behind the bar.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--bottom-nav-inset", keyboardOpen ? "0px" : TAB_INSET);
    return () => {
      root.style.setProperty("--bottom-nav-inset", "0px");
    };
  }, [keyboardOpen]);

  // Detect the on-screen keyboard via the gap between the layout viewport
  // and the visual viewport, so the bar can slide away while typing.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const gap = root.clientHeight - viewport.height - viewport.offsetTop;
        setKeyboardOpen(gap > KEYBOARD_OPEN_THRESHOLD_PX);
      });
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    update();
    return () => {
      cancelAnimationFrame(raf);
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);

  const onTap = (tab: TabDef) => {
    haptic("tap");
    switch (tab.key) {
      case "threads":
        // The thread list lives in the off-canvas sidebar drawer on phone.
        // If we're already on the chat surface, surface the list; otherwise
        // navigate home first.
        if (pathname === "/" || pathname.startsWith("/_chat")) {
          setOpenMobile(true);
        } else {
          void navigate({ to: "/" });
        }
        break;
      case "board":
        void navigate({ to: "/board" });
        break;
      case "wiki":
        void navigate({ to: "/wiki" });
        break;
      case "settings":
        void navigate({ to: "/settings" });
        break;
    }
  };

  return (
    <nav
      aria-label="Primary"
      className={cn(
        "fixed inset-x-0 bottom-0 z-30 md:hidden",
        "border-t border-border bg-card/95 backdrop-blur-sm",
        "transition-transform duration-200 ease-out",
        keyboardOpen && "translate-y-full",
      )}
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="flex h-14 items-stretch">
        {TABS.map((tab) => {
          const active = tab.isActive(pathname);
          const Icon = tab.icon;
          return (
            <li key={tab.key} className="flex-1">
              <button
                type="button"
                onClick={() => onTap(tab)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-full w-full flex-col items-center justify-center gap-0.5",
                  // 44px+ touch target via full-height flex cell.
                  active ? "text-primary" : "text-muted-foreground",
                  "transition-colors active:bg-muted/60",
                )}
              >
                <Icon className={cn("size-5", active && "scale-110")} aria-hidden />
                <span className="text-[10px] font-medium leading-none">{tab.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
