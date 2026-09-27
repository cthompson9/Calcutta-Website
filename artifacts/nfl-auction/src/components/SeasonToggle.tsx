import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatCalcuttaLabel, useSeason } from "@/hooks/useSeason";
import { useAdminAccess } from "@/hooks/useAdminAccess";
import { Check, ChevronDown } from "lucide-react";
import { trackEvent } from "@/lib/analytics";
import { CreateCalcuttaDialog } from "@/components/CreateCalcuttaDialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

export function SeasonToggle({ testId }: { testId?: string }) {
  const { selectedCalcutta, setCalcutta, calcuttas, isLoading } = useSeason();
  const { adminKey } = useAdminAccess();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          aria-label="Global Calcutta filter"
          aria-expanded={open}
          disabled={isLoading && calcuttas.length === 0}
          className={cn(
            "h-10 w-full min-w-0 max-w-full bg-muted/50 border border-border/60 rounded-md pl-3 pr-3 text-left text-[10px] md:text-xs font-mono font-bold uppercase tracking-[0.08em] text-foreground outline-none transition-colors flex items-center justify-between gap-2",
            "focus:border-primary focus:ring-1 focus:ring-primary",
            "disabled:cursor-wait disabled:text-muted-foreground",
            "md:h-10 md:bg-card md:border-border"
          )}
        >
          <span className="block truncate">{selectedCalcutta ? formatCalcuttaLabel(selectedCalcutta) : isLoading ? "Loading…" : "No Calcuttas"}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="z-[80] w-[var(--radix-popover-trigger-width)] overflow-hidden p-0">
        <Command>
          <CommandInput aria-label="Search Calcuttas" placeholder="Search Calcuttas…" />
          <CommandList>
            <CommandEmpty>
              {calcuttas.length === 0 ? (isLoading ? "Loading…" : "No Calcuttas") : "No Calcuttas match your search."}
            </CommandEmpty>
            {calcuttas.map((calcutta) => {
              const label = formatCalcuttaLabel(calcutta);
              return (
                <CommandItem
                  key={calcutta.id}
                  value={`${label} ${calcutta.sport} ${calcutta.year}`}
                  onSelect={() => {
                    trackEvent("calcutta_selected", {
                      sport: calcutta.sport,
                      year: calcutta.year,
                      surface: testId?.includes("mobile") ? "mobile_header" : "desktop_sidebar",
                    });
                    setCalcutta(calcutta.id);
                    setOpen(false);
                  }}
                  className="text-[10px] font-mono font-bold uppercase tracking-wider"
                >
                  <Check className={cn("h-4 w-4", selectedCalcutta?.id === calcutta.id ? "opacity-100" : "opacity-0")} aria-hidden="true" />
                  <span className="truncate">{label}</span>
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
        {adminKey && (
          <div className="border-t border-border p-1">
            <button
              type="button"
              onClick={() => { setOpen(false); setCreateOpen(true); }}
              className="w-full rounded px-3 py-2 text-left text-xs font-semibold text-primary hover:bg-accent focus:bg-accent focus:outline-none"
            >+ Create New Calcutta</button>
          </div>
        )}
      </PopoverContent>
    </Popover>
    {createOpen && <CreateCalcuttaDialog open={createOpen} onOpenChange={setCreateOpen} />}
    </>
  );
}
