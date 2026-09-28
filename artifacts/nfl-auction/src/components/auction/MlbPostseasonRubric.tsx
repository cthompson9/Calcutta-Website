const rounds = [
  { name: "Wild Card round", win: 1, sweep: 3 },
  { name: "Division Series", win: 2, sweep: 5 },
  { name: "League Championship Series", win: 5, sweep: 10 },
  { name: "World Series", win: 10, sweep: 10 },
] as const;

export function MlbPostseasonRubric() {
  return (
    <section className="rounded-md border border-border bg-card p-5" aria-labelledby="mlb-points-rubric">
      <h2 id="mlb-points-rubric" className="font-mono text-sm font-bold uppercase tracking-widest">
        Points Rubric
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Each win earns points for its round. A series sweep earns an additional bonus.
      </p>
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
                <td className="py-2 pr-4">{round.win} {round.win === 1 ? "point" : "points"}</td>
                <td className="py-2">+{round.sweep} points</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">Wild Card bye:</span> +5 points for each team that earns a bye in the Wild Card round.
      </p>
    </section>
  );
}