import { Fragment, useState } from "react";
import { useGetMlbResults, getGetMlbResultsQueryKey } from "@workspace/api-client-react";
import type { CalcuttaOption, MlbOwnerResult } from "@workspace/api-client-react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

const DASH = "—";
const money = (v: number | null | undefined) => (v == null ? DASH : new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(v));
const pts = (v: number | null | undefined) => (v == null ? DASH : String(v));
const rate = (v: number | null | undefined) =>
  v == null ? DASH : `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(v)}/pt`;
const pct = (v: number) => `${Math.round(v * 10000) / 100}%`;
function et(value: string | null | undefined): string {
  if (!value) return DASH;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return DASH;
  return (
    d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) + " ET"
  );
}
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : null);
const netClass = (v: number | null) => (v == null ? "text-muted-foreground" : v < 0 ? "text-destructive" : "font-bold");

function Metric({ label, value, note, testId }: { label: string; value: string; note?: string; testId?: string }) {
  return (
    <div>
      <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-xl font-bold tabular-nums" data-testid={testId}>{value}</p>
      {note && <p className="mt-0.5 text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

function Owners({ owners, cols, roster = false }: { owners: MlbOwnerResult[]; cols: number; roster?: boolean }) {
  return (
    <tr className="bg-muted/20">
      <td colSpan={cols} className="px-4 py-3">
        <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{roster ? "Consortium members" : "Signed owners"}</p>
        {roster && <p className="mb-2 text-xs text-muted-foreground">Shares are registered consortium membership shares. Use By Team for each member’s current signed team stake.</p>}
        {owners.length === 0 ? (
          <p className="text-xs text-muted-foreground">No signed owners recorded.</p>
        ) : (
          <div className="table-scroll">
            <table className="w-full min-w-[520px] text-xs">
              <thead className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <tr>
                  <th className="py-1 text-left">Owner</th><th className="py-1 text-right">Share</th><th className="py-1 text-right">Points</th>
                  <th className="py-1 text-right">Cost</th><th className="py-1 text-right">Gross</th><th className="py-1 text-right">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {owners.map((o) => (
                  <tr key={o.bidderId}>
                    <td className="py-1.5 font-bold">{o.name}</td>
                    <td className="py-1.5 text-right font-mono">{pct(o.share)}</td>
                    <td className="py-1.5 text-right font-mono">{pts(o.points)}</td>
                    <td className="py-1.5 text-right font-mono">{money(o.cost)}</td>
                    <td className="py-1.5 text-right font-mono">{money(o.gross)}</td>
                    <td className={cn("py-1.5 text-right font-mono", netClass(o.net))}>{money(o.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </td>
    </tr>
  );
}

export function MlbResults({ calcutta }: { calcutta: CalcuttaOption }) {
  const id = calcutta.id;
  const { data, isLoading, error, refetch, isFetching } = useGetMlbResults(id, {
    query: { queryKey: getGetMlbResultsQueryKey(id), refetchInterval: 30_000, enabled: true },
  });
  const [tab, setTab] = useState<"byTeam" | "byConsortium">("byConsortium");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [openSeries, setOpenSeries] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setOpen((p) => ({ ...p, [k]: !p[k] }));

  // Reset expansion when pool changes by keying keys with id
  const k = (s: string) => `${id}:${s}`;

  const header = (
    <header className="flex flex-col gap-1 px-4 pt-4 md:flex-row md:items-end md:justify-between md:px-0 md:pt-0">
      <div>
        <h1 className="mb-1 text-3xl font-extrabold uppercase tracking-tighter md:text-5xl" data-testid="text-report-title">Results</h1>
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">{calcutta.name} · MLB {calcutta.year}</p>
      </div>
      <span className="text-[13px] text-muted-foreground" data-testid="text-last-updated">
        Last Updated: {et(data?.refresh.lastSuccess)}
      </span>
    </header>
  );

  if (isLoading) {
    return (
      <div className="mx-auto max-w-[1400px] space-y-4 pb-6 md:space-y-6 md:p-8" data-testid="mlb-loading" aria-busy="true">
        {header}
        <div className="mx-4 space-y-3 md:mx-0">
          <div className="h-32 animate-pulse bg-muted/60" />
          <div className="h-72 animate-pulse bg-muted/40" />
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="mx-auto max-w-[1400px] space-y-4 pb-6 md:p-8">
        {header}
        <div role="alert" className="mx-4 border border-destructive/40 bg-destructive/5 p-5 text-sm text-destructive md:mx-0" data-testid="mlb-error">
          Could not load MLB results. {error instanceof Error ? error.message : "Please try again."}{" "}
          <button type="button" onClick={() => void refetch()} className="font-bold underline" data-testid="button-retry-mlb">Retry</button>
        </div>
      </div>
    );
  }

  if (!data) return null;
  const r = data.refresh;
  const unavailable = data.status === "unavailable";
  const partial = data.status === "partial";
  const sourceHref = safeUrl(r.sourceUrl);
  const teamsCols = 9;
  const consCols = 7;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 pb-6 md:space-y-6 md:p-8" data-testid="mlb-results">
      {header}

      {error && (
        <div role="alert" className="mx-4 border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive md:mx-0" data-testid="mlb-poll-error">
          The latest poll failed; showing the last response received.{" "}
          <button type="button" onClick={() => void refetch()} className="font-bold underline">Retry</button>
        </div>
      )}

      {r.stale && r.lastSuccess && (
        <div role="status" className="mx-4 border-2 border-destructive/50 bg-destructive/5 p-4 md:mx-0" data-testid="mlb-stale">
          <p className="font-mono text-[11px] font-bold uppercase tracking-widest text-destructive">Stale data retained</p>
          <p className="mt-1 text-sm">
            These actuals were last confirmed {et(r.lastSuccess)} and are not current. A refresh has not succeeded since
            {r.lastFailure ? ` the failure at ${et(r.lastFailure)}` : " then"}.
            {r.nextRetry ? ` Next retry: ${et(r.nextRetry)}.` : ""}
          </p>
        </div>
      )}

      {(unavailable || partial || data.reasons.length > 0) && (
        <div role="status" className="mx-4 border border-border bg-muted/30 p-4 md:mx-0" data-testid="mlb-status-banner">
          <p className="font-mono text-[11px] font-bold uppercase tracking-widest">
            {unavailable ? "Results unavailable" : partial ? "Partial coverage" : "Notes"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {unavailable
              ? "Financial figures are blank until the full required schedule is covered. Nothing below is zero; it is simply not known."
              : partial
                ? "Some figures are blank because coverage is incomplete."
                : ""}
          </p>
          {data.reasons.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">
              {data.reasons.map((x, i) => <li key={i}>{x}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* Summary */}
      <section className="mx-4 border border-border bg-card shadow-sm md:mx-0">
        <div className="grid grid-cols-2 gap-x-8 gap-y-5 p-5 md:grid-cols-4">
          <Metric label="Pool pot" value={money(data.pot)} testId="text-mlb-pot" />
          <Metric label="Earned points" value={pts(data.earnedPoints)} note="Realized from completed games" testId="text-mlb-earned" />
          <Metric label="Provisional points" value={pts(data.provisionalPoints)} note="Whole-tournament inventory" testId="text-mlb-provisional" />
          <Metric label="Dollars per point" value={rate(data.dollarsPerPoint)} testId="text-mlb-rate" />
        </div>
        <div className="space-y-2 border-t border-border p-5 text-sm text-muted-foreground">
          <p>
            <span className="font-bold text-foreground">How the rate is set: </span>
            dollars per point = pool pot ÷ provisional points, where the denominator counts every point available across the
            whole tournament ({pts(data.provisionalPoints)} points), not only points earned so far
            {data.dollarsPerPoint != null && data.pot != null && data.provisionalPoints != null
              ? ` (${money(data.pot)} ÷ ${data.provisionalPoints} = ${rate(data.dollarsPerPoint)})`
              : ""}
            .
          </p>
          <p data-testid="text-mlb-provisional-note">
            {data.tournamentComplete
              ? "The tournament is complete. Gross and net values are terminal results over the whole tournament."
              : "The tournament is in progress. Gross and net values are provisional values based on points earned to date; they are not cash settlements."}
          </p>
          <p data-testid="text-mlb-mtm">
            <span className="font-bold text-foreground">MTM: unavailable. </span>{data.mtmReason}
          </p>
        </div>
      </section>

      {/* Tabs */}
      <div className="no-scrollbar mx-4 flex overflow-x-auto border-b border-border md:mx-0">
        {(["byConsortium", "byTeam"] as const).map((t) => (
          <button
            key={t} type="button" data-testid={`tab-${t === "byConsortium" ? "byOwner" : "byTeam"}`} onClick={() => setTab(t)}
            className={cn("-mb-px whitespace-nowrap border-b-2 px-4 py-3 font-mono text-[11px] font-bold uppercase tracking-widest transition-colors md:px-5 md:text-sm",
              tab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t === "byConsortium" ? "By Consortium" : "By Team"}
          </button>
        ))}
      </div>

      {tab === "byTeam" ? (
        <section className="mx-4 border border-border bg-card shadow-sm md:mx-0">
          <div className="table-scroll">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <thead className="border-b border-border bg-muted/30 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <tr>
                  <th className="w-10 px-3 py-3" />
                  <th className="px-3 py-3 text-left">Team</th>
                  <th className="px-3 py-3 text-right">Game</th><th className="px-3 py-3 text-right">Sweep</th><th className="px-3 py-3 text-right">Bye</th>
                  <th className="px-3 py-3 text-right">Points</th><th className="px-3 py-3 text-right">Cost</th>
                  <th className="px-3 py-3 text-right">Gross</th><th className="px-3 py-3 text-right">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {data.teams.length === 0 && (
                  <tr><td colSpan={teamsCols} className="px-6 py-14 text-center text-sm text-muted-foreground">No teams recorded for this pool.</td></tr>
                )}
                {data.teams.map((t) => {
                  const key = k(`t${t.entryId}`);
                  return (
                    <Fragment key={t.entryId}>
                      <tr data-testid={`row-team-${t.teamId}`}>
                        <td className="px-3 py-3">
                          <button type="button" aria-expanded={!!open[key]} aria-label={`Owners of ${t.name}`} onClick={() => toggle(key)} data-testid={`button-team-owners-${t.teamId}`}>
                            <ChevronDown className={cn("h-4 w-4 transition-transform", open[key] && "rotate-180")} />
                          </button>
                        </td>
                        <td className="px-3 py-3 font-bold">{t.name}</td>
                        <td className="px-3 py-3 text-right font-mono">{pts(t.gamePoints)}</td>
                        <td className="px-3 py-3 text-right font-mono">{pts(t.sweepPoints)}</td>
                        <td className="px-3 py-3 text-right font-mono">{pts(t.byePoints)}</td>
                        <td className="px-3 py-3 text-right font-mono font-bold">{pts(t.points)}</td>
                        <td className="px-3 py-3 text-right font-mono">{money(t.cost)}</td>
                        <td className="px-3 py-3 text-right font-mono">{money(t.gross)}</td>
                        <td className={cn("px-3 py-3 text-right font-mono", netClass(t.net))}>{money(t.net)}</td>
                      </tr>
                      {open[key] && <Owners owners={t.owners} cols={teamsCols} />}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <section className="mx-4 border border-border bg-card shadow-sm md:mx-0">
          <div className="table-scroll">
            <table className="w-full min-w-[680px] border-collapse text-sm">
              <thead className="border-b border-border bg-muted/30 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <tr>
                  <th className="w-10 px-3 py-3" />
                  <th className="px-3 py-3 text-left">Consortium</th>
                  <th className="px-3 py-3 text-right">Points</th><th className="px-3 py-3 text-right">Cost</th>
                  <th className="px-3 py-3 text-right">Gross</th><th className="px-3 py-3 text-right">Net</th>
                  <th className="px-3 py-3 text-right">Members</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {data.consortia.length === 0 && (
                  <tr><td colSpan={consCols} className="px-6 py-14 text-center text-sm text-muted-foreground">No consortia recorded for this pool.</td></tr>
                )}
                {data.consortia.map((c) => {
                  const key = k(`c${c.key}`);
                  return (
                    <Fragment key={c.key}>
                      <tr data-testid={`row-consortium-${c.key}`}>
                        <td className="px-3 py-3">
                          <button type="button" aria-expanded={!!open[key]} aria-label={`Members of ${c.name}`} onClick={() => toggle(key)} data-testid={`button-consortium-members-${c.key}`}>
                            <ChevronDown className={cn("h-4 w-4 transition-transform", open[key] && "rotate-180")} />
                          </button>
                        </td>
                        <td className="px-3 py-3 font-bold">{c.name}</td>
                        <td className="px-3 py-3 text-right font-mono font-bold">{pts(c.points)}</td>
                        <td className="px-3 py-3 text-right font-mono">{money(c.cost)}</td>
                        <td className="px-3 py-3 text-right font-mono">{money(c.gross)}</td>
                        <td className={cn("px-3 py-3 text-right font-mono", netClass(c.net))}>{money(c.net)}</td>
                        <td className="px-3 py-3 text-right font-mono">{c.members.length}</td>
                      </tr>
                      {open[key] && <Owners owners={c.members} cols={consCols} roster />}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <p className="mx-4 font-mono text-[10px] uppercase tracking-widest text-muted-foreground md:mx-0">
        Gross and net are provisional values, not cash settlements. Blank cells mean not yet computable.
      </p>

      {/* Rounds */}
      <section className="mx-4 border border-border bg-card shadow-sm md:mx-0">
        <h2 className="border-b border-border p-4 font-mono text-[10px] font-bold uppercase tracking-widest text-primary">Inventory by round</h2>
        <div className="table-scroll">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/30 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left">Round</th><th className="px-3 py-2 text-right">Best of</th>
                <th className="px-3 py-2 text-right">Series done</th><th className="px-3 py-2 text-right">Game</th>
                <th className="px-3 py-2 text-right">Sweep</th><th className="px-3 py-2 text-right">Bye</th><th className="px-3 py-2 text-right">Inventory</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {data.rounds.map((x) => (
                <tr key={x.key}>
                  <td className="px-4 py-2 font-bold">{x.label}</td>
                  <td className="px-3 py-2 text-right font-mono">{x.bestOf}</td>
                  <td className="px-3 py-2 text-right font-mono">{x.completedSeries}/{x.seriesCount}</td>
                  <td className="px-3 py-2 text-right font-mono">{x.gamePoints}</td>
                  <td className="px-3 py-2 text-right font-mono">{x.sweepPoints}</td>
                  <td className="px-3 py-2 text-right font-mono">{x.byePoints}</td>
                  <td className="px-3 py-2 text-right font-mono font-bold">{x.inventoryPoints}</td>
                </tr>
              ))}
              {data.rounds.length === 0 && (
                <tr><td colSpan={8} className="p-4 text-muted-foreground">Point inventory is unavailable until source, rubric and payout coverage are verified.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Series */}
      <section className="mx-4 border border-border bg-card shadow-sm md:mx-0">
        <h2 className="border-b border-border p-4 font-mono text-[10px] font-bold uppercase tracking-widest text-primary">Series progress</h2>
        {data.series.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">No series have been recorded yet.</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {data.series.map((s) => {
              const key = k(`s${s.key}`);
              return (
                <li key={s.key} data-testid={`series-${s.key}`}>
                  <button type="button" aria-expanded={!!openSeries[key]} onClick={() => setOpenSeries((p) => ({ ...p, [key]: !p[key] }))}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/30">
                    <span>
                      <span className="block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{s.round} · best of {s.bestOf}</span>
                      <span className="block text-sm font-bold">{s.awayTeam} {s.awayWins} – {s.homeWins} {s.homeTeam}</span>
                    </span>
                    <span className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-widest">
                      <span className={s.complete ? "font-bold" : "text-muted-foreground"}>{s.complete ? (s.sweep ? "Final · sweep" : "Final") : "In progress"}</span>
                      <span className="text-muted-foreground">{s.inventoryPoints} pts</span>
                      <ChevronDown className={cn("h-4 w-4 transition-transform", openSeries[key] && "rotate-180")} />
                    </span>
                  </button>
                  {openSeries[key] && (
                    <div className="table-scroll bg-muted/20 px-4 pb-3">
                      {s.games.length === 0 ? (
                        <p className="py-2 text-xs text-muted-foreground">No games recorded.</p>
                      ) : (
                        <table className="w-full min-w-[560px] text-xs">
                          <tbody className="divide-y divide-border/60">
                            {s.games.map((g) => {
                              const href = safeUrl(g.sourceUrl);
                              return (
                                <tr key={g.providerId}>
                                  <td className="py-1.5 font-mono">G{g.gameNumber}</td>
                                  <td className="py-1.5">{g.awayTeam} {g.awayScore ?? DASH} at {g.homeTeam} {g.homeScore ?? DASH}</td>
                                  <td className="py-1.5 text-muted-foreground">{g.status}</td>
                                  <td className="py-1.5 text-muted-foreground">{et(g.scheduledAt)}</td>
                                  <td className="py-1.5 text-right">
                                    {href ? (
                                      <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-bold text-primary underline" data-testid={`link-espn-${g.providerId}`}>
                                        ESPN <ExternalLink className="h-3 w-3" aria-hidden="true" />
                                      </a>
                                    ) : DASH}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="mx-4 grid gap-4 md:mx-0 lg:grid-cols-2">
        {/* Rubric */}
        <section className="border border-border bg-card shadow-sm">
          <h2 className="border-b border-border p-4 font-mono text-[10px] font-bold uppercase tracking-widest text-primary">Stored rubric</h2>
          <ul className="divide-y divide-border/70" data-testid="list-mlb-rules">
            {data.rules.length === 0 && <li className="p-4 text-sm text-muted-foreground">No rubric stored.</li>}
            {data.rules.map((x, i) => (
              <li key={i} className="flex justify-between gap-3 px-4 py-2 text-sm">
                <span>{x.name}</span><span className="font-mono font-bold">{x.points == null ? DASH : x.points}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Refresh evidence */}
        <section className="border border-border bg-card shadow-sm" data-testid="mlb-refresh-evidence">
          <h2 className="border-b border-border p-4 font-mono text-[10px] font-bold uppercase tracking-widest text-primary">Refresh evidence</h2>
          <dl className="divide-y divide-border/70 text-sm">
            {[
              ["Auto-refresh", r.enabled ? "Enabled" : "Disabled"],
              ["Data state", !r.lastSuccess ? "Not yet refreshed" : r.stale ? "Stale (retained actuals)" : "Current"],
              ["Coverage", `${r.coveredDays} of ${r.requiredDays} days`],
              ["Last success", et(r.lastSuccess)],
              ["Last attempt", et(r.lastAttempt)],
              ["Last failure", et(r.lastFailure)],
              ["Next retry", et(r.nextRetry)],
            ].map(([a, b]) => (
              <div key={a} className="flex justify-between gap-3 px-4 py-2"><dt className="text-muted-foreground">{a}</dt><dd className="text-right font-mono text-xs">{b}</dd></div>
            ))}
            {r.error && (
              <div className="px-4 py-2 text-xs text-destructive" data-testid="text-mlb-refresh-error">Error: {r.error}</div>
            )}
            <div className="px-4 py-2">
              {sourceHref ? (
                <a href={sourceHref} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-bold text-primary underline" data-testid="link-mlb-source">
                  ESPN source <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              ) : <span className="text-xs text-muted-foreground">No source link</span>}
              {isFetching && <span className="ml-3 text-[11px] text-muted-foreground">Checking for updates…</span>}
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}

export default MlbResults;
