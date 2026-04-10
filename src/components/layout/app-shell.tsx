"use client";

import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "./sidebar";
import { Header } from "./header";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { cn } from "@/lib/utils";

const SIDEBAR_STORAGE_KEY = "pace-pdm:sidebar-open";

/**
 * Read the persisted sidebar-open flag from localStorage. Returns the
 * server-safe default of `true` if localStorage is unavailable (SSR or
 * private mode). Used as the lazy initializer for `desktopOpen` so the
 * value lands on the first client render — no setState-in-effect needed.
 */
function readPersistedSidebarOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  // Lazy initializer reads localStorage on the client's first render. The
  // SSR snapshot uses the default `true` (via the typeof guard), and we
  // suppress the visible mismatch with the `useHasMounted` flag below.
  const [desktopOpen, setDesktopOpen] = useState(readPersistedSidebarOpen);
  const mounted = useHasMounted();
  const isDesktop = useMediaQuery("(min-width: 768px)");

  // Persist on change
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(desktopOpen));
    } catch {
      // ignore
    }
  }, [desktopOpen]);

  // Cmd+\ / Ctrl+\ to toggle the sidebar — Linear-style.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        if (isDesktop) {
          setDesktopOpen((o) => !o);
        } else {
          setMobileOpen((o) => !o);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isDesktop]);

  const handleMenuClick = useCallback(() => {
    if (isDesktop) {
      setDesktopOpen((o) => !o);
    } else {
      setMobileOpen(true);
    }
  }, [isDesktop]);

  return (
    <div className="flex h-screen bg-background">
      {/* Desktop sidebar — always mounted so width can animate.
          Collapsed = icon rail (w-12), expanded = full nav (w-52).
          During SSR / pre-hydration we render the default (open) regardless
          of any persisted state, so the server output matches the client's
          first render. After mount, the lazy-initialized desktopOpen value
          (which already reflects localStorage) takes effect. */}
      <div
        className={cn(
          "hidden md:block shrink-0 transition-[width] duration-200 ease-out",
          mounted && !desktopOpen ? "md:w-12" : "md:w-52",
        )}
      >
        <Sidebar onNavigate={() => {}} collapsed={mounted && !desktopOpen} />
      </div>

      {/* Mobile sidebar sheet */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-52 p-0 border-r-0">
          <Sidebar onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex flex-col flex-1 min-w-0">
        <Header onMenuClick={handleMenuClick} desktopSidebarOpen={desktopOpen} />
        <main className="flex-1 overflow-y-auto">
          <div className="md:m-2 md:ml-0 p-4 md:p-6 md:rounded-xl md:bg-card md:border md:border-border min-h-full">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
