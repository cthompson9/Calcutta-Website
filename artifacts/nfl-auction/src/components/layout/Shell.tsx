import { Link, useLocation } from "wouter";
import { Users, LayoutDashboard, Shield, Plus, TrendingUp, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { ReactNode } from "react";

interface ShellProps {
  children: ReactNode;
}

export function Shell({ children }: ShellProps) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/teams", label: "Teams Browser", icon: Shield },
    { href: "/bidders", label: "Bidder Manager", icon: Users },
  ];

  return (
    <div className="flex min-h-[100dvh] w-full flex-col md:flex-row bg-muted/20">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex flex-col w-64 border-r border-border bg-sidebar h-[100dvh] sticky top-0">
        <div className="p-6 border-b border-sidebar-border flex items-center gap-3">
          <Trophy className="w-6 h-6 text-primary" />
          <div>
            <h1 className="font-bold text-lg leading-tight uppercase tracking-tight">Auction</h1>
            <p className="text-xs text-muted-foreground font-mono font-bold uppercase tracking-widest">Manager</p>
          </div>
        </div>
        <nav className="flex-1 py-6 px-3 flex flex-col gap-1">
          {navItems.map((item) => {
            const active = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href}>
                <div
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors font-medium text-sm",
                    active
                      ? "bg-sidebar-primary text-sidebar-primary-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
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
        {children}
      </main>

      {/* Mobile Tab Bar */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 border-t border-border bg-background flex items-center justify-around z-50 h-16 safe-area-bottom">
        {navItems.map((item) => {
          const active = location === item.href || (item.href !== "/" && location.startsWith(item.href));
          return (
            <Link key={item.href} href={item.href}>
              <div
                className={cn(
                  "flex flex-col items-center justify-center w-full h-full cursor-pointer gap-1 px-4",
                  active ? "text-primary" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <item.icon className="w-5 h-5" />
                <span className="text-[10px] font-bold uppercase tracking-wider">{item.label}</span>
              </div>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
