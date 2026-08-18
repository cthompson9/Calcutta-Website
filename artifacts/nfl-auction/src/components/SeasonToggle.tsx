import { useGetSeasons } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

interface SeasonToggleProps {
  year: number;
  onChange: (year: number) => void;
}

export function SeasonToggle({ year, onChange }: SeasonToggleProps) {
  const { data: seasons } = useGetSeasons();

  // Default to 2025/2026 if API not loaded yet
  const items = seasons ?? [
    { id: 1, year: 2025, isActive: false, isComplete: true, label: "2025 Season" },
    { id: 2, year: 2026, isActive: true, isComplete: false, label: "2026 Season" },
  ];

  return (
    <div className="flex items-center border border-border bg-card overflow-hidden h-9">
      {items.map((s) => (
        <button
          key={s.year}
          onClick={() => onChange(s.year)}
          className={cn(
            "px-4 h-full text-sm font-mono font-bold uppercase tracking-widest transition-colors border-r border-border last:border-r-0",
            year === s.year
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          {s.year}
          {s.isActive && <span className="ml-1 text-[10px] opacity-60">LIVE</span>}
          {s.isComplete && <img src="/sleigh-monkey.png" alt="complete" className="inline-block ml-1 w-5 h-5 object-contain align-middle" />}
        </button>
      ))}
    </div>
  );
}
