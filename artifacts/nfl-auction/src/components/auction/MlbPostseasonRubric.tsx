import { useGetMlbResults, getGetMlbResultsQueryKey } from "@workspace/api-client-react";
import { useSeason } from "@/hooks/useSeason";

const rounds = [
  { name: "Wild Card round", win: "WC Round Win", sweep: "WC Sweep" },
  { name: "Division Series", win: "LDS Win", sweep: "LDS Sweep" },
  { name: "League Championship Series", win: "LCS Win", sweep: "LCS Sweep" },
  { name: "World Series", win: "World Series Win", sweep: "World Series Sweep" },
] as const;

export function MlbPostseasonRubric() {
  const { selectedCalcutta } = useSeason();
  const { data, isLoading, error } = useGetMlbResults(selectedCalcutta?.id ?? 0, {
    query: { queryKey: getGetMlbResultsQueryKey(selectedCalcutta?.id ?? 0), enabled: selectedCalcutta?.sport === "MLB", refetchInterval: 30_000 },
  });
  const points = (name: string) => data?.rules.find((rule) => rule.name === name)?.points ?? null;
  const display = (name: string) => points(name) == null ? "Unavailable" : `${points(name)} points`;
  return (
    <section className="rounded-md border border-border bg-card p-5" aria-labelledby="mlb-points-rubric">
      <h2 id="mlb-points-rubric" className="font-mono text-sm font-bold uppercase tracking-widest">
        Points Rubric
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Saved rules for {selectedCalcutta?.name}. Each win earns points for its round; a completed sweep earns its bonus.
      </p>
      {isLoading && <p className="mt-2 text-sm text-muted-foreground">Loading saved rubric…</p>}
      {error && <p className="mt-2 text-sm text-destructive" role="alert">The saved rubric could not be loaded.</p>}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="pb-2 pr-4 font-semibold">Round</th>
              <th scope="col" className="pb-2 pr-4 font-semibold">Per win</th>
              <th scope="col" className="pb-2 font-semibold">Sweep bonus</th>
            </tr>
          </thead>
          <tbody>
            {rounds.map((round) => (
              <tr key={round.name} className="border-b border-border/60 last:border-0">
                <th scope="row" className="py-2 pr-4 font-medium">{round.name}</th>
                <td className="py-2 pr-4">{display(round.win)}</td>
                <td className="py-2">{display(round.sweep)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">Wild Card bye:</span> {display("WC Bye")} for each evidenced bye entrant, included once in earned points and the provisional inventory.
      </p>
    </section>
  );
}