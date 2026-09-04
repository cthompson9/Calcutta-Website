import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Trophy,
  ArrowLeftRight,
  TrendingUp,
  Sparkles,
  CircleHelp,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ReactNode, useEffect, useState } from "react";
import { SeasonToggle } from "@/components/SeasonToggle";
import { useSeason } from "@/hooks/useSeason";

interface ShellProps {
  children: ReactNode;
}

export function Shell({ children }: ShellProps) {
  const [location] = useLocation();
  const { selectedCalcutta } = useSeason();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("calcutta-sidebar-collapsed") === "true";
  });

  useEffect(() => {
    window.localStorage.setItem(
      "calcutta-sidebar-collapsed",
      String(sidebarCollapsed),
    );
  }, [sidebarCollapsed]);

  const isNflOnlyRoute =
    ["/mtm", "/teams", "/bidders", "/dashboard"].some((route) =>
      location.startsWith(route),
    );
  const unsupportedSport =
    isNflOnlyRoute && selectedCalcutta && selectedCalcutta.sport !== "NFL"
      ? selectedCalcutta.sport
      : null;

  const navItems = [
    { href: "/", label: "Results", mobileLabel: "Results", icon: Trophy },
    { href: "/mtm", label: "MTM Tracker", mobileLabel: "MTM", icon: TrendingUp },
    { href: "/trades", label: "Trades", mobileLabel: "Trades", icon: ArrowLeftRight },
    { href: "/dashboard", label: "Auction Results", mobileLabel: "Auction", icon: LayoutDashboard },
  ];
  const utilityNavItems = [
    { href: "/whats-new", label: "What's New", mobileLabel: "New", icon: Sparkles },
    { href: "/faq", label: "FAQ", mobileLabel: "FAQ", icon: CircleHelp },
  ];
  const mobileNavItems = [...navItems, ...utilityNavItems];

  return (
    <div className="flex min-h-[100dvh] w-full max-w-full flex-col overflow-x-hidden bg-background md:h-[100dvh] md:flex-row md:overflow-hidden md:bg-muted/20">
      {/* Desktop Sidebar */}
      <aside
        className={cn(
          "hidden h-[100dvh] shrink-0 flex-col overflow-hidden border-sidebar-border bg-sidebar transition-[width,border-color] duration-200 ease-out md:flex",
          sidebarCollapsed ? "w-0 border-r-0" : "w-72 border-r",
        )}
        aria-hidden={sidebarCollapsed}
      >
        <div className="flex min-w-72 items-center gap-3 border-b border-sidebar-border p-5">
          <img
            src="/calcutta-lion.png"
            alt="Calcutta lion"
            className="w-11 h-14 shrink-0 object-contain"
          />
          <img
            src="/calcutta-logo.png"
            alt="The Calcutta"
            className="min-w-0 flex-1 object-contain object-left"
          />
        </div>
        <div className="min-w-72 border-b border-sidebar-border px-3 py-4">
          <SeasonToggle testId="select-calcutta-desktop" />
        </div>
        <nav className="flex min-w-72 flex-1 flex-col gap-1 px-3 py-6">
          {navItems.map((item) => {
            const active =
              location === item.href ||
              (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href}>
                <div
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors font-medium text-sm rounded-md",
                    active
                      ? "bg-sidebar-primary text-sidebar-primary-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  )}
                >
                  <item.icon className="w-4 h-4" />
                  {item.label}
                </div>
              </Link>
            );
          })}
          <div className="mt-auto border-t border-sidebar-border pt-4">
            {utilityNavItems.map((item) => {
              const active =
                location === item.href ||
                location.startsWith(item.href);
              return (
                <Link key={item.href} href={item.href}>
                  <div
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors font-medium text-sm rounded-md",
                      active
                        ? "bg-sidebar-primary text-sidebar-primary-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <item.icon className="w-4 h-4" />
                    {item.label}
                  </div>
                </Link>
              );
            })}
          </div>
        </nav>
      </aside>

      <button
        type="button"
        onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
        className={cn(
          "fixed top-20 z-50 hidden h-9 w-9 items-center justify-center rounded-md border border-border bg-background text-muted-foreground shadow-sm transition-[left,color,background-color] duration-200 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:flex",
          sidebarCollapsed ? "left-3" : "left-[calc(18rem-1.125rem)]",
        )}
        aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        aria-expanded={!sidebarCollapsed}
        title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        data-testid="toggle-desktop-sidebar"
      >
        {sidebarCollapsed ? (
          <PanelLeftOpen className="h-4 w-4" />
        ) : (
          <PanelLeftClose className="h-4 w-4" />
        )}
      </button>

      {/* Main Content */}
      <main className="min-h-[100dvh] min-w-0 max-w-full flex-1 overflow-x-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:h-[100dvh] md:min-h-0 md:overflow-y-auto md:pb-0">
        <div className="md:hidden sticky top-0 z-40 flex items-center gap-2 border-b border-border/60 bg-background/95 px-4 py-2.5 backdrop-blur">
          <div className="flex min-w-0 items-center gap-2">
            <img
              src="/calcutta-lion.png"
              alt="The Calcutta"
              className="h-7 w-6 shrink-0 object-contain"
            />
            <div className="hidden min-[360px]:block min-w-0">
              <p className="truncate text-[11px] font-extrabold uppercase tracking-tight">
                The Calcutta
              </p>
              <p className="truncate text-[8px] font-mono uppercase tracking-[0.16em] text-muted-foreground">
                {selectedCalcutta?.name ?? "Loading"} · {selectedCalcutta?.sport ?? "NFL"} {selectedCalcutta?.year ?? ""}
              </p>
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <SeasonToggle testId="select-calcutta-mobile" />
          </div>
          <span
            className="hidden min-[390px]:inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[8px] font-mono font-bold uppercase tracking-wider text-emerald-700"
            data-testid="status-mobile-view"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            View
          </span>
        </div>
        {unsupportedSport ? (
          <UnsupportedSportState
            calcuttaName={selectedCalcutta?.name ?? "Selected Calcutta"}
            sport={unsupportedSport}
            year={selectedCalcutta?.year}
          />
        ) : (
          children
        )}
      </main>

      {/* Mobile Tab Bar — show 5 most important */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 border-t border-border bg-background/95 backdrop-blur flex items-center justify-around z-50 h-[calc(3.5rem+env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)]">
        {mobileNavItems.map((item) => {
          const active =
            location === item.href ||
            (item.href !== "/" && location.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              data-testid={`nav-mobile-${item.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
              className={cn(
                "flex flex-col items-center justify-center w-full h-full gap-1 px-1 transition-colors",
                active
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <item.icon className={cn("w-5 h-5", active && "stroke-[2.5px]")} />
              <span className="text-[9px] font-bold uppercase tracking-wider">
                {item.mobileLabel}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function UnsupportedSportState({
  calcuttaName,
  sport,
  year,
}: {
  calcuttaName: string;
  sport: string;
  year?: number;
}) {
  return (
    <section className="flex min-h-[70dvh] items-center justify-center px-4 py-16">
      <div className="max-w-xl w-full border border-border bg-card p-6 md:p-8 text-center shadow-sm rounded-lg">
        <p className="mb-3 text-[10px] font-mono font-bold uppercase tracking-[0.22em] text-primary">
          {calcuttaName}
          {year ? ` · ${year}` : ""}
        </p>
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight">
          {sport} reports are not available yet
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          This catalog includes Calcuttas from multiple sports, but the current
          reports are still NFL-only. Choose an NFL Calcutta above to view
          Results, MTM Tracker, Trades, or Auction Results.
        </p>
      </div>
    </section>
  );
}
