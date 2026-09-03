import type {
  HistoricalPool,
  HistoricalPoolEntry,
  HistoricalPoolOwner,
} from "@workspace/api-client-react";
import { History, Trophy } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

type HistoricalTab = "byOwner" | "byTeam";

type ConsortiumResult = {
  name: string;
  members: string[];
  lots: number;
  cost: number | null;
  payout: number | null;
};

function sumCovered(
  rows: HistoricalPoolOwner[],
  field: "cost" | "payout",
  availabilityField: "costAvailable" | "payoutAvailable",
): number | null {
  if (rows.some((row) => !row[availabilityField] || row[field] == null)) {
    return null;
  }
  return rows.reduce((sum, row) => sum + (row[field] ?? 0), 0);
}

function consortiumResults(rows: HistoricalPoolOwner[]): ConsortiumResult[] {
  const grouped = new Map<string, HistoricalPoolOwner[]>();
  for (const row of rows) {
    const name = row.consortium ?? row.labels[0] ?? row.ownerName;
    const members = grouped.get(name) ?? [];
    members.push(row);
    grouped.set(name, members);
  }

  return [...grouped.entries()]
    .map(([name, members]) => ({
      name,
      members: [...new Set(members.map((member) => member.ownerName))],
      lots: members.reduce((sum, member) => sum + member.lotCount, 0),
      cost: sumCovered(members, "cost", "costAvailable"),
      payout: sumCovered(members, "payout", "payoutAvailable"),
    }))
    .sort((left, right) => {
      const leftNet = left.cost == null || left.payout == null
        ? Number.NEGATIVE_INFINITY
        : left.payout - left.cost;
      const rightNet = right.cost == null || right.payout == null
        ? Number.NEGATIVE_INFINITY
        : right.payout - right.cost;
      return rightNet - leftNet || left.name.localeCompare(right.name);
    });
}

function money(value: number | null): string {
  return value == null ? "—" : formatCurrency(value);
}

function signedMoney(value: number | null): string {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : ""}${formatCurrency(value)}`;
}

function percent(value: number | null): string {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function entryTeams(entry: HistoricalPoolEntry): string {
  if (entry.teams.length === 0) return entry.label;
  return entry.teams.map((team) => team.name).join(" / ");
}

function entryOwners(entry: HistoricalPoolEntry): string {
  const labels = entry.ownership.map(
    (owner) => owner.consortium ?? owner.label ?? owner.ownerName,
  );
  return [...new Set(labels)].join(" / ") || "Unassigned";
}

export function HistoricalResultsView({
  pool,
  entries,
  owners,
  tab,
}: {
  pool: HistoricalPool;
  entries: HistoricalPoolEntry[];
  owners: HistoricalPoolOwner[];
  tab: HistoricalTab;
}) {
  const consortiums = consortiumResults(owners);
  const coveredPayouts = entries.filter(
    (entry) => entry.payoutAvailable && entry.payout != null,
  );
  const totalPayout = coveredPayouts.length === entries.length
    ? coveredPayouts.reduce((sum, entry) => sum + (entry.payout ?? 0), 0)
    : null;

  return (
    <div className="space-y-5 px-4 md:px-0">
      <div
        className="flex items-start gap-3 border border-sky-300 bg-sky-50 px-4 py-3 text-sky-950 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100"
        role="status"
        data-testid="historical-results-notice"
      >
        <History className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-mono text-xs font-bold uppercase tracking-wider">
            Final historical results
          </p>
          <p className="mt-1 text-xs">
            This report uses the normalized backload captured as of{" "}
            {pool.asOfDate ?? "the recorded auction date"}. Values marked unavailable
            were not supplied by the source and are not treated as zero.
          </p>
        </div>
      </div>

      <section className="grid gap-px border border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
        <HistoricalMetric label="Recorded pot" value={money(pool.potSize)} />
        <HistoricalMetric label="Auction entries" value={String(entries.length)} />
        <HistoricalMetric label="Consortiums" value={String(consortiums.length)} />
        <HistoricalMetric label="Covered payout" value={money(totalPayout)} />
      </section>

      {tab === "byOwner" ? (
        <HistoricalConsortiumTable rows={consortiums} />
      ) : (
        <HistoricalEntryTable entries={entries} />
      )}
    </div>
  );
}

function HistoricalMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card px-5 py-4">
      <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 font-mono text-xl font-bold tracking-tight">{value}</p>
    </div>
  );
}

function HistoricalConsortiumTable({ rows }: { rows: ConsortiumResult[] }) {
  if (rows.length === 0) return <HistoricalEmpty />;

  return (
    <section className="border border-border bg-card shadow-sm">
      <div className="border-b border-border p-4">
        <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-primary">
          Consortium results
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Final normalized cost and payout totals, grouped by the roster recorded
          for this Calcutta.
        </p>
      </div>
      <div className="table-scroll">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead className="sticky-table-header border-b border-border bg-muted/30">
            <tr>
              <th className="px-4 py-3 text-left">Consortium</th>
              <th className="px-3 py-3 text-left">Members</th>
              <th className="px-3 py-3 text-right">Lots</th>
              <th className="px-3 py-3 text-right">Cost</th>
              <th className="px-3 py-3 text-right">Payout</th>
              <th className="px-3 py-3 text-right">Net</th>
              <th className="px-4 py-3 text-right">Return</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {rows.map((row) => {
              const net = row.cost == null || row.payout == null
                ? null
                : row.payout - row.cost;
              const returnPct = net == null || row.cost == null || row.cost === 0
                ? null
                : net / row.cost;
              return (
                <tr key={row.name} data-testid="historical-owner-row">
                  <td className="px-4 py-3 font-semibold">{row.name}</td>
                  <td className="px-3 py-3 text-muted-foreground">
                    {row.members.join(", ")}
                  </td>
                  <td className="px-3 py-3 text-right font-mono">
                    {row.lots.toFixed(2)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono">{money(row.cost)}</td>
                  <td className="px-3 py-3 text-right font-mono">{money(row.payout)}</td>
                  <td className="px-3 py-3 text-right font-mono font-bold">
                    {signedMoney(net)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-bold">
                    {percent(returnPct)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HistoricalEntryTable({ entries }: { entries: HistoricalPoolEntry[] }) {
  if (entries.length === 0) return <HistoricalEmpty />;

  return (
    <section className="border border-border bg-card shadow-sm">
      <div className="border-b border-border p-4">
        <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-primary">
          Entry results
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Original auction lots, normalized ownership, source tracking, and final payout.
        </p>
      </div>
      <div className="table-scroll">
        <table className="w-full min-w-[980px] border-collapse text-sm">
          <thead className="sticky-table-header border-b border-border bg-muted/30">
            <tr>
              <th className="px-4 py-3 text-left">Entry / team</th>
              <th className="px-3 py-3 text-left">Consortium</th>
              <th className="px-3 py-3 text-right">Price</th>
              <th className="px-3 py-3 text-right">Points</th>
              <th className="px-3 py-3 text-right">Payout</th>
              <th className="px-3 py-3 text-right">Net</th>
              <th className="px-4 py-3 text-left">Tracking</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {entries.map((entry) => {
              const price = entry.priceAvailable ? entry.price : null;
              const payout = entry.payoutAvailable ? entry.payout : null;
              const net = price == null || payout == null ? null : payout - price;
              return (
                <tr key={entry.id} data-testid="historical-team-row">
                  <td className="px-4 py-3">
                    <p className="font-semibold">{entryTeams(entry)}</p>
                    {entry.label !== entryTeams(entry) && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{entry.label}</p>
                    )}
                  </td>
                  <td className="px-3 py-3">{entryOwners(entry)}</td>
                  <td className="px-3 py-3 text-right font-mono">{money(price)}</td>
                  <td className="px-3 py-3 text-right font-mono">
                    {entry.pointsAvailable && entry.points != null
                      ? entry.points.toLocaleString()
                      : "—"}
                  </td>
                  <td className="px-3 py-3 text-right font-mono">{money(payout)}</td>
                  <td className="px-3 py-3 text-right font-mono font-bold">
                    {signedMoney(net)}
                  </td>
                  <td className="max-w-[28rem] px-4 py-3 text-xs text-muted-foreground">
                    {entry.tracking ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HistoricalEmpty() {
  return (
    <div className="flex flex-col items-center justify-center border border-dashed border-border bg-card/50 p-12 text-center text-muted-foreground">
      <Trophy className="mb-4 h-8 w-8 opacity-40" />
      <p className="font-mono text-sm font-bold uppercase tracking-widest text-foreground">
        Historical results unavailable
      </p>
      <p className="mt-1 text-sm">
        This backload does not contain reportable entries for the selected Calcutta.
      </p>
    </div>
  );
}