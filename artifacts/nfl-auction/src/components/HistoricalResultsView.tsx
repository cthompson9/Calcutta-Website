import type {
  HistoricalPool,
  HistoricalPoolEntry,
  HistoricalPoolOwner,
} from "@workspace/api-client-react";
import { useMemo, useState } from "react";
import { History, Search, Trophy } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";

type HistoricalTab = "byOwner" | "byTeam";
type SortDirection = "asc" | "desc";
type ConsortiumSortKey =
  | "name"
  | "members"
  | "lots"
  | "cost"
  | "payout"
  | "net"
  | "return";
type EntrySortKey =
  | "entry"
  | "owner"
  | "price"
  | "points"
  | "payout"
  | "net"
  | "tracking";

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

function compareNullableNumbers(
  left: number | null,
  right: number | null,
  direction: SortDirection,
): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return direction === "asc" ? left - right : right - left;
}

function compareText(
  left: string,
  right: string,
  direction: SortDirection,
): number {
  const comparison = left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  return direction === "asc" ? comparison : -comparison;
}

function SortButton<T extends string>({
  label,
  sortKey,
  activeSortKey,
  direction,
  onSort,
  align = "right",
}: {
  label: string;
  sortKey: T;
  activeSortKey: T;
  direction: SortDirection;
  onSort: (key: T) => void;
  align?: "left" | "right";
}) {
  const active = sortKey === activeSortKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      aria-label={`Sort by ${label}${active ? `, currently ${direction}ending` : ""}`}
      className={cn(
        "inline-flex w-full items-center gap-1 whitespace-nowrap font-mono text-[10px] font-bold uppercase tracking-widest transition-colors hover:text-foreground",
        align === "left" ? "justify-start text-left" : "justify-end text-right",
        active ? "text-primary" : "text-muted-foreground",
      )}
    >
      {label}
      {active && <span aria-hidden="true">{direction === "asc" ? "↑" : "↓"}</span>}
    </button>
  );
}

function HistoricalFilter({
  value,
  onChange,
  placeholder,
  label,
  resultCount,
  totalCount,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  resultCount: number;
  totalCount: number;
}) {
  return (
    <div className="flex flex-col gap-2 sm:items-end">
      <label className="relative block sm:w-72">
        <Search
          className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="sr-only">{label}</span>
        <input
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="w-full border border-border/70 bg-background py-2 pl-8 pr-3 font-mono text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary"
        />
      </label>
      {value.trim() && (
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {resultCount} of {totalCount} shown
        </p>
      )}
    </div>
  );
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
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<ConsortiumSortKey>("net");
  const [direction, setDirection] = useState<SortDirection>("desc");

  const visibleRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = query
      ? rows.filter((row) =>
          [row.name, ...row.members].some((value) =>
            value.toLowerCase().includes(query),
          ),
        )
      : rows;

    return [...filtered].sort((left, right) => {
      const leftNet =
        left.cost == null || left.payout == null ? null : left.payout - left.cost;
      const rightNet =
        right.cost == null || right.payout == null ? null : right.payout - right.cost;
      const leftReturn =
        leftNet == null || left.cost == null || left.cost === 0
          ? null
          : leftNet / left.cost;
      const rightReturn =
        rightNet == null || right.cost == null || right.cost === 0
          ? null
          : rightNet / right.cost;

      switch (sortKey) {
        case "name":
          return compareText(left.name, right.name, direction);
        case "members":
          return compareText(left.members.join(", "), right.members.join(", "), direction);
        case "lots":
          return compareNullableNumbers(left.lots, right.lots, direction);
        case "cost":
          return compareNullableNumbers(left.cost, right.cost, direction);
        case "payout":
          return compareNullableNumbers(left.payout, right.payout, direction);
        case "return":
          return compareNullableNumbers(leftReturn, rightReturn, direction);
        case "net":
        default:
          return compareNullableNumbers(leftNet, rightNet, direction);
      }
    });
  }, [direction, rows, search, sortKey]);

  function handleSort(key: ConsortiumSortKey) {
    if (sortKey === key) {
      setDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setDirection(key === "name" || key === "members" ? "asc" : "desc");
  }

  if (rows.length === 0) return <HistoricalEmpty />;

  return (
    <section className="border border-border bg-card shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-primary">
            Consortium results
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Final normalized cost and payout totals, grouped by the roster recorded
            for this Calcutta.
          </p>
        </div>
        <HistoricalFilter
          value={search}
          onChange={setSearch}
          placeholder="Filter consortiums or members…"
          label="Filter historical consortium results"
          resultCount={visibleRows.length}
          totalCount={rows.length}
        />
      </div>
      <div className="table-scroll">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <caption className="sr-only">
            Filterable and sortable historical consortium results
          </caption>
          <thead className="sticky-table-header border-b border-border bg-muted/30">
            <tr>
              <th className="px-4 py-3 text-left"><SortButton label="Consortium" sortKey="name" activeSortKey={sortKey} direction={direction} onSort={handleSort} align="left" /></th>
              <th className="px-3 py-3 text-left"><SortButton label="Members" sortKey="members" activeSortKey={sortKey} direction={direction} onSort={handleSort} align="left" /></th>
              <th className="px-3 py-3 text-right"><SortButton label="Lots" sortKey="lots" activeSortKey={sortKey} direction={direction} onSort={handleSort} /></th>
              <th className="px-3 py-3 text-right"><SortButton label="Cost" sortKey="cost" activeSortKey={sortKey} direction={direction} onSort={handleSort} /></th>
              <th className="px-3 py-3 text-right"><SortButton label="Payout" sortKey="payout" activeSortKey={sortKey} direction={direction} onSort={handleSort} /></th>
              <th className="px-3 py-3 text-right"><SortButton label="Net" sortKey="net" activeSortKey={sortKey} direction={direction} onSort={handleSort} /></th>
              <th className="px-4 py-3 text-right"><SortButton label="Return" sortKey="return" activeSortKey={sortKey} direction={direction} onSort={handleSort} /></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {visibleRows.map((row) => {
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
            {visibleRows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No consortiums match “{search.trim()}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HistoricalEntryTable({ entries }: { entries: HistoricalPoolEntry[] }) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<EntrySortKey>("net");
  const [direction, setDirection] = useState<SortDirection>("desc");

  const visibleEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = query
      ? entries.filter((entry) =>
          [
            entry.label,
            entryTeams(entry),
            entryOwners(entry),
            entry.tracking ?? "",
          ].some((value) => value.toLowerCase().includes(query)),
        )
      : entries;

    return [...filtered].sort((left, right) => {
      const leftPrice = left.priceAvailable ? left.price : null;
      const rightPrice = right.priceAvailable ? right.price : null;
      const leftPayout = left.payoutAvailable ? left.payout : null;
      const rightPayout = right.payoutAvailable ? right.payout : null;
      const leftPoints = left.pointsAvailable ? left.points : null;
      const rightPoints = right.pointsAvailable ? right.points : null;
      const leftNet =
        leftPrice == null || leftPayout == null ? null : leftPayout - leftPrice;
      const rightNet =
        rightPrice == null || rightPayout == null ? null : rightPayout - rightPrice;

      switch (sortKey) {
        case "entry":
          return compareText(entryTeams(left), entryTeams(right), direction);
        case "owner":
          return compareText(entryOwners(left), entryOwners(right), direction);
        case "price":
          return compareNullableNumbers(leftPrice, rightPrice, direction);
        case "points":
          return compareNullableNumbers(leftPoints, rightPoints, direction);
        case "payout":
          return compareNullableNumbers(leftPayout, rightPayout, direction);
        case "tracking":
          return compareText(left.tracking ?? "", right.tracking ?? "", direction);
        case "net":
        default:
          return compareNullableNumbers(leftNet, rightNet, direction);
      }
    });
  }, [direction, entries, search, sortKey]);

  function handleSort(key: EntrySortKey) {
    if (sortKey === key) {
      setDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setDirection(
      key === "entry" || key === "owner" || key === "tracking" ? "asc" : "desc",
    );
  }

  if (entries.length === 0) return <HistoricalEmpty />;

  return (
    <section className="border border-border bg-card shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-primary">
            Entry results
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Original auction lots, normalized ownership, source tracking, and final payout.
          </p>
        </div>
        <HistoricalFilter
          value={search}
          onChange={setSearch}
          placeholder="Filter teams, owners, or tracking…"
          label="Filter historical entry results"
          resultCount={visibleEntries.length}
          totalCount={entries.length}
        />
      </div>
      <div className="table-scroll">
        <table className="w-full min-w-[980px] border-collapse text-sm">
          <caption className="sr-only">
            Filterable and sortable historical entry results
          </caption>
          <thead className="sticky-table-header border-b border-border bg-muted/30">
            <tr>
              <th className="px-4 py-3 text-left"><SortButton label="Entry / team" sortKey="entry" activeSortKey={sortKey} direction={direction} onSort={handleSort} align="left" /></th>
              <th className="px-3 py-3 text-left"><SortButton label="Consortium" sortKey="owner" activeSortKey={sortKey} direction={direction} onSort={handleSort} align="left" /></th>
              <th className="px-3 py-3 text-right"><SortButton label="Price" sortKey="price" activeSortKey={sortKey} direction={direction} onSort={handleSort} /></th>
              <th className="px-3 py-3 text-right"><SortButton label="Points" sortKey="points" activeSortKey={sortKey} direction={direction} onSort={handleSort} /></th>
              <th className="px-3 py-3 text-right"><SortButton label="Payout" sortKey="payout" activeSortKey={sortKey} direction={direction} onSort={handleSort} /></th>
              <th className="px-3 py-3 text-right"><SortButton label="Net" sortKey="net" activeSortKey={sortKey} direction={direction} onSort={handleSort} /></th>
              <th className="px-4 py-3 text-left"><SortButton label="Tracking" sortKey="tracking" activeSortKey={sortKey} direction={direction} onSort={handleSort} align="left" /></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {visibleEntries.map((entry) => {
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
            {visibleEntries.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No entries match “{search.trim()}”.
                </td>
              </tr>
            )}
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