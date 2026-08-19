import { cn } from "@/lib/utils";
import { useSeason } from "@/hooks/useSeason";

export function SeasonToggle() {
  const { year, setYear, seasons, isLoading } = useSeason();

  return (
    <div
      className="flex max-w-full items-center overflow-x-auto border border-border bg-card h-9"
      aria-label="Global season filter"
    >
      {isLoading && seasons.length === 0 ? (
        <span className="px-4 text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
          Loading…
        </span>
      ) : seasons.length === 0 ? (
        <span className="px-4 text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
          No seasons
        </span>
      ) : seasons.map((s) => (
        <button
          key={s.year}
          type="button"
          onClick={() => setYear(s.year)}
          aria-pressed={year === s.year}
          className={cn(
            "shrink-0 px-4 h-full text-sm font-mono font-bold uppercase tracking-widest transition-colors border-r border-border last:border-r-0",
            year === s.year
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          {s.year}
          {s.isActive && <span className="ml-1 text-[10px] opacity-60">LIVE</span>}
          {s.isComplete && <span className="ml-1 text-[10px] opacity-60">✓</span>}
        </button>
      ))}
    </div>
  );
}
