import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Trophy,
  ArrowLeftRight,
  TrendingUp,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ReactNode } from "react";
import { SeasonToggle } from "@/components/SeasonToggle";
import { formatCalcuttaLabel, useSeason } from "@/hooks/useSeason";

interface ShellProps {
  children: ReactNode;
}

export function Shell({ children }: ShellProps) {
  const [location] = useLocation();
  const { selectedCalcutta } = useSeason();

  const navItems = [
    { href: "/", label: "Results", icon: Trophy },
    { href: "/mtm", label: "M2M Tracker", icon: TrendingUp },
    { href: "/trades", label: "Trades", icon: ArrowLeftRight },
    { href: "/dashboard", label: "Auction Results", icon: LayoutDashboard },
    { href: "/whats-new", label: "What's New", icon: Sparkles },
  ];

  return (
    <div className="flex min-h-[100dvh] w-full flex-col md:flex-row bg-muted/20">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex flex-col w-64 border-r border-border bg-sidebar h-[100dvh] sticky top-0">
        <div className="p-5 border-b border-sidebar-border flex items-center gap-3">
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
        <div className="px-3 py-4 border-b border-sidebar-border space-y-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-[10px] text-muted-foreground font-mono font-bold uppercase tracking-widest">
              Calcutta
            </span>
            <span className="min-w-0 truncate text-[10px] text-muted-foreground font-mono" title={selectedCalcutta ? formatCalcuttaLabel(selectedCalcutta) : undefined}>
              {selectedCalcutta?.name ?? "—"}
            </span>
          </div>
          <SeasonToggle />
        </div>
        <nav className="flex-1 py-6 px-3 flex flex-col gap-1">
          {navItems.map((item) => {
            const active =
              location === item.href ||
              (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href}>
                <div
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors font-medium text-sm",
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
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 pb-16 md:pb-0 min-h-[100dvh] max-w-[100vw]">
        <div className="md:hidden sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
          <span className="shrink-0 text-[10px] text-muted-foreground font-mono font-bold uppercase tracking-widest">
            Calcutta
          </span>
          <SeasonToggle />
        </div>
        {children}
      </main>

      {/* Mobile Tab Bar — show 5 most important */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 border-t border-border bg-background flex items-center justify-around z-50 h-16 safe-area-bottom">
        {navItems.slice(0, 5).map((item) => {
          const active =
            location === item.href ||
            (item.href !== "/" && location.startsWith(item.href));
          return (
            <Link key={item.href} href={item.href}>
              <div
                className={cn(
                  "flex flex-col items-center justify-center w-full h-full cursor-pointer gap-1 px-3",
                  active
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <item.icon className="w-5 h-5" />
                <span className="text-[10px] font-bold uppercase tracking-wider">
                  {item.label}
                </span>
              </div>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
