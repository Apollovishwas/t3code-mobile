import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import ThreadSidebar from "./Sidebar";
import { BottomTabBar } from "./BottomTabBar";
import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";
import { useIsMobile } from "~/hooks/useMediaQuery";
import {
  clearShortcutModifierState,
  syncShortcutModifierStateFromKeyboardEvent,
} from "../shortcutModifierState";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

/**
 * Minimum width the main content must keep when resizing the sidebar. On wide
 * (desktop) viewports this is the full 40rem; on narrower tablet/iPad widths it
 * scales down so the sidebar remains shrinkable instead of being locked at its
 * default width (the fixed 40rem would otherwise leave less than the sidebar's
 * own minimum, rejecting every drag width).
 */
function mainContentMinWidth(wrapperWidth: number): number {
  return Math.min(THREAD_MAIN_CONTENT_MIN_WIDTH, wrapperWidth * 0.55);
}
export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      syncShortcutModifierStateFromKeyboardEvent(event);
    };
    const onWindowKeyUp = (event: KeyboardEvent) => {
      syncShortcutModifierStateFromKeyboardEvent(event);
    };
    const onWindowBlur = () => {
      clearShortcutModifierState();
    };

    window.addEventListener("keydown", onWindowKeyDown, true);
    window.addEventListener("keyup", onWindowKeyUp, true);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
      window.removeEventListener("keyup", onWindowKeyUp, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        void navigate({ to: "/settings" });
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  return (
    // Shell height subtracts BOTH the on-screen-keyboard inset and the
    // mobile bottom-tab-bar inset (set by BottomTabBar while mounted, 0 on
    // iPad/desktop or when the keyboard is open) so route content always
    // lays out above the bar and never hides behind it.
    <SidebarProvider
      className="h-[calc(100dvh-var(--keyboard-inset,0px)-var(--bottom-nav-inset,0px))]! min-h-0!"
      defaultOpen
    >
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
        resizable={{
          minWidth: THREAD_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >= mainContentMinWidth(wrapper.clientWidth),
          storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <ThreadSidebar />
        <SidebarRail />
      </Sidebar>
      {children}
      {/* Phone-only bottom nav; iPad+ keeps the left sidebar. */}
      {isMobile ? <BottomTabBar /> : null}
    </SidebarProvider>
  );
}
