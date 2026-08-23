import { cn } from "@/lib/utils";
import { formatCalcuttaLabel, useSeason } from "@/hooks/useSeason";
import { ChevronDown } from "lucide-react";

export function SeasonToggle({ testId }: { testId?: string }) {
  const { selectedCalcutta, setCalcutta, calcuttas, isLoading } = useSeason();

  return (
    <div className="relative min-w-0 max-w-full">
      <select
        data-testid={testId}
        aria-label="Global Calcutta filter"
        value={selectedCalcutta?.id.toString() ?? ""}
        onChange={(event) => setCalcutta(Number(event.target.value))}
        disabled={isLoading && calcuttas.length === 0}
        className={cn(
          "h-8 w-full min-w-0 max-w-full appearance-none bg-muted/50 border border-border/60 rounded-md pl-3 pr-8 text-[10px] md:text-xs font-mono font-bold uppercase tracking-widest text-foreground outline-none transition-colors",
          "focus:border-primary focus:ring-1 focus:ring-primary",
          "disabled:cursor-wait disabled:text-muted-foreground",
          "md:h-9 md:bg-card md:border-border"
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
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-muted-foreground">
        <ChevronDown className="h-4 w-4" />
      </div>
    </div>
  );
}
