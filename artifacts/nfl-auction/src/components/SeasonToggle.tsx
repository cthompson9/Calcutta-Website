import { cn } from "@/lib/utils";
import { formatCalcuttaLabel, useSeason } from "@/hooks/useSeason";

export function SeasonToggle() {
  const { selectedCalcutta, setCalcutta, calcuttas, isLoading } = useSeason();

  return (
    <div className="min-w-0 max-w-full">
      <select
        aria-label="Global Calcutta filter"
        value={selectedCalcutta?.id.toString() ?? ""}
        onChange={(event) => setCalcutta(Number(event.target.value))}
        disabled={isLoading && calcuttas.length === 0}
        className={cn(
          "h-9 w-full min-w-0 max-w-full border border-border bg-card px-2 text-[10px] font-mono font-bold uppercase tracking-widest text-foreground outline-none transition-colors",
          "focus:border-primary focus:ring-1 focus:ring-primary",
          "disabled:cursor-wait disabled:text-muted-foreground",
        )}
      >
        {calcuttas.length === 0 ? (
          <option value="">
            {isLoading ? "Loading…" : "No Calcuttas"}
          </option>
        ) : (
          calcuttas.map((calcutta) => (
            <option key={calcutta.id} value={calcutta.id}>
              {formatCalcuttaLabel(calcutta)}
            </option>
          ))
        )}
      </select>
    </div>
  );
}
