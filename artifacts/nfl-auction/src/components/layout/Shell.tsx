import { Link, useLocation } from "wouter";
import {
  useGetAuctionSummary,
  getGetAuctionSummaryQueryKey,
} from "@workspace/api-client-react";
import {
  LayoutDashboard,
  Trophy,
  ArrowLeftRight,
  TrendingUp,
  Sparkles,
  CircleHelp,
  PanelLeftClose,
  PanelLeftOpen,
  ArrowLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ReactNode, useEffect, useState } from "react";
import { SeasonToggle } from "@/components/SeasonToggle";
import { useSeason } from "@/hooks/useSeason";
import { trackEvent } from "@/lib/analytics";

interface ShellProps {
  children: ReactNode;
  isPreview?: boolean;
}

export function Shell({ children, isPreview }: ShellProps) {
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
    ["/analysis", "/teams", "/bidders", "/dashboard"].some((route) =>
      location.startsWith(route),
    );
  const unsupportedSport =
    isNflOnlyRoute && selectedCalcutta && selectedCalcutta.sport !== "NFL"
      ? selectedCalcutta.sport
      : null;

  const { data: summary } = useGetAuctionSummary(
    { season: selectedCalcutta?.year ?? 0, calcuttaId: selectedCalcutta?.id },
    {
      query: {
        enabled: isPreview && selectedCalcutta?.sport === "NFL",
        queryKey: getGetAuctionSummaryQueryKey({
          season: selectedCalcutta?.year ?? 0,
          calcuttaId: selectedCalcutta?.id,
        }),
      },
    },
  );

  const navItems = [
    { href: "/results", label: "Results", mobileLabel: "Results", icon: Trophy },
    { href: "/analysis", label: "Analysis", mobileLabel: "Analysis", icon: TrendingUp },
    { href: "/trades", label: "Trades", mobileLabel: "Trades", icon: ArrowLeftRight },
    { href: "/dashboard", label: "Auction Results", mobileLabel: "Auction", icon: LayoutDashboard },
  ];
  const utilityNavItems = [
    { href: "/whats-new", label: "What's New", mobileLabel: "New", icon: Sparkles },
    { href: "/faq", label: "FAQ", mobileLabel: "FAQ", icon: CircleHelp },
  ];
  const mobileNavItems = [...navItems, ...utilityNavItems];

  return (
    <div className="flex min-h-[100svh] w-full max-w-full flex-col overflow-x-hidden bg-background md:h-[100dvh] md:min-h-0 md:flex-row md:overflow-hidden md:bg-muted/20">
      {/* Desktop Sidebar */}
      <aside
        className={cn(
          "hidden h-[100dvh] shrink-0 flex-col overflow-hidden border-sidebar-border bg-sidebar transition-[width,border-color] duration-200 ease-out md:flex",
          sidebarCollapsed ? "w-0 border-r-0" : "w-72 border-r",
        )}
        aria-hidden={sidebarCollapsed}
      >
        <div className={cn("flex min-w-72 items-center border-b border-sidebar-border", isPreview ? "p-6" : "gap-3 p-5")}>
          {isPreview ? (
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center">
                <img src="/crest-transparent.png" alt="" aria-hidden="true" className="h-full w-full object-contain mix-blend-multiply" />
              </div>
              <div className="flex flex-col">
                <strong className="font-serif text-2xl font-medium tracking-tight text-foreground leading-none mb-1">
                  The Calcutta
                </strong>
                <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  NFL Szn · Est. 2022
                </span>
              </div>
            </div>
          ) : (
            <>
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
            </>
          )}
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
              <Link
                key={item.href}
                href={item.href}
                onClick={() => trackEvent("navigation_selected", {
                  destination: item.label,
                  surface: "desktop_sidebar",
                })}
              >
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
          <div className="mt-auto flex flex-col">
            {isPreview && summary && (
              <div className="flex flex-col gap-1 px-6 pb-6 pt-2">
                <div className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Pool Size
                </div>
                <div className="text-xl font-bold font-mono tracking-tight text-foreground">
                  {new Intl.NumberFormat("en-US", {
                    style: "currency",
                    currency: "USD",
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 0,
                  }).format(summary.potSize)}
                </div>
                <div className="mt-2 font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  $ Per Point
                </div>
                <div className="text-xl font-bold font-mono tracking-tight text-foreground">
                  {new Intl.NumberFormat("en-US", {
                    style: "currency",
                    currency: "USD",
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  }).format(summary.dollarsPerPoint)}
                </div>
              </div>
            )}
            <div className="border-t border-sidebar-border pt-4">
            {utilityNavItems.map((item) => {
              const active =
                location === item.href ||
                location.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => trackEvent("navigation_selected", {
                    destination: item.label,
                    surface: "desktop_sidebar",
                  })}
                >
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
          </div>
        </nav>
      </aside>

      <button
        type="button"
        onClick={() => setSidebarCollapsed((collapsed) => {
          const next = !collapsed;
          trackEvent("sidebar_toggled", { state: next ? "collapsed" : "expanded" });
          return next;
        })}
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
      <main className="min-h-0 min-w-0 max-w-full flex-1 overflow-x-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:h-[100dvh] md:overflow-y-auto md:pb-0">
        <div className="md:hidden sticky top-0 z-40 flex items-center gap-2 border-b border-border/60 bg-background/95 px-4 py-2.5 backdrop-blur">
          {isPreview ? (
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center">
                <img src="/crest-transparent.png" alt="" aria-hidden="true" className="h-full w-full object-contain mix-blend-multiply" />
              </div>
              <div className="hidden min-[360px]:block min-w-0">
                <p className="truncate text-sm font-serif font-medium tracking-tight leading-none">
                  The Calcutta
                </p>
                <p className="truncate text-[8px] font-mono uppercase tracking-[0.16em] text-muted-foreground mt-0.5">
                  NFL Szn · Est. 2022
                </p>
              </div>
            </div>
          ) : (
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
          )}
          <div className="min-w-0 flex-1">
            <SeasonToggle testId="select-calcutta-mobile" />
          </div>
          {!isPreview && (
            <span
              className="hidden min-[390px]:inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[8px] font-mono font-bold uppercase tracking-wider text-emerald-700"
              data-testid="status-mobile-view"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              View
            </span>
          )}
        </div>
        {isPreview && location !== "/dashboard" && (
          <div className="unified-preview-page-crest" aria-hidden="true">
            <img src="/crest-transparent.png" alt="" />
          </div>
        )}
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
              onClick={() => trackEvent("navigation_selected", {
                destination: item.label,
                surface: "mobile_tab_bar",
              })}
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
          Results, Analysis, Trades, or Auction Results.
        </p>
      </div>
    </section>
  );
}
