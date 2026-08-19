import { useState } from "react";
import { useGetMtmSnapshots, useGetTeams } from "@workspace/api-client-react";
import type { MtmData } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { useSeason } from "@/hooks/useSeason";
import { TrendingUp, TrendingDown, Lock, Unlock, Plus, X, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";

const OWNER_COLORS = [
  "#3b82f6", // blue
  "#10b981", // green
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // purple
  "#06b6d4", // cyan
  "#f97316", // orange
];

// ── Auth-gated MTM upsert (requires ADMIN_API_KEY as Bearer token) ─────────────

async function upsertMtmSnapshot(
  payload: { teamId: number; seasonYear: number; weekNum?: number; mtmValue: number; snapshotDate?: string },
  adminKey: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/mtm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminKey}`,
      },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) return { ok: false, error: "Invalid admin key" };
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MtmTracker() {
  const { year } = useSeason();
  const { data, isLoading, refetch } = useGetMtmSnapshots({ season: year });
  const [adminKey, setAdminKey] = useState<string | null>(
    () => sessionStorage.getItem("nfl_admin_key"),
  );
  const [showEntry, setShowEntry] = useState(false);

  function saveAdminKey(key: string) {
    sessionStorage.setItem("nfl_admin_key", key);
    setAdminKey(key);
  }

  function clearAdminKey() {
    sessionStorage.removeItem("nfl_admin_key");
    setAdminKey(null);
  }

  const hasData =
    data &&
    data.owners.length > 0 &&
    data.owners.some((o) => o.weeklyTotals.some((v) => v !== 0));

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-5xl font-extrabold uppercase tracking-tighter mb-1">M2M Tracker</h1>
          <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">
            Mark-to-market · week by week · {year}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <AdminPanel adminKey={adminKey} onSetKey={saveAdminKey} onClearKey={clearAdminKey} />
        </div>
      </header>

      {/* Admin data-entry panel */}
      {adminKey && (
        <div className="border border-primary/30 bg-primary/5">
          <button
            onClick={() => setShowEntry((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-xs font-mono font-bold uppercase tracking-widest text-primary hover:bg-primary/10 transition-colors"
          >
            <span className="flex items-center gap-2">
              <Plus className="w-3.5 h-3.5" />
              Enter MTM Data
            </span>
            {showEntry ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          {showEntry && (
            <div className="border-t border-primary/20 p-4">
              <MtmEntryForm
                year={year}
                adminKey={adminKey}
                onSuccess={() => {
                  void refetch();
                  setShowEntry(false);
                }}
              />
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-4 animate-pulse">
          <div className="h-64 bg-muted border border-border" />
          <div className="h-48 bg-muted border border-border" />
        </div>
      ) : !hasData ? (
        <EmptyState year={year} isAdmin={!!adminKey} onEnterData={() => setShowEntry(true)} />
      ) : (
        <MtmContent data={data} />
      )}
    </div>
  );
}

// ── Admin auth panel ──────────────────────────────────────────────────────────

function AdminPanel({
  adminKey,
  onSetKey,
  onClearKey,
}: {
  adminKey: string | null;
  onSetKey: (k: string) => void;
  onClearKey: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState("");

  function handleUnlock() {
    if (!input.trim()) return;
    onSetKey(input.trim());
    setInput("");
    setExpanded(false);
  }

  if (adminKey) {
    return (
      <button
        onClick={onClearKey}
        className="flex items-center gap-1.5 px-3 py-1.5 border border-green-600 text-green-700 text-xs font-mono font-bold uppercase tracking-widest hover:bg-green-50 transition-colors"
        title="Admin mode active — click to lock"
      >
        <Unlock className="w-3 h-3" /> Admin Active
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 px-3 py-1.5 border border-border text-muted-foreground text-xs font-mono font-bold uppercase tracking-widest hover:bg-muted transition-colors"
        title="Enter admin key to record MTM values"
      >
        <Lock className="w-3 h-3" /> Admin
      </button>
      {expanded && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border p-3 w-64 space-y-2 shadow-lg">
          <p className="text-xs font-mono text-muted-foreground">
            Enter your admin key to record weekly MTM values.
          </p>
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleUnlock();
            }}
            placeholder="Admin key…"
            className="w-full border border-border bg-background px-2 py-1.5 text-sm font-mono"
            autoFocus
          />
          <button
            onClick={handleUnlock}
            disabled={!input.trim()}
            className="w-full bg-primary text-primary-foreground text-xs font-mono font-bold uppercase tracking-widest py-1.5 hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            Unlock
          </button>
        </div>
      )}
    </div>
  );
}

// ── MTM data-entry form ───────────────────────────────────────────────────────

type EntryRow = { teamId: string; mtmValue: string; snapshotDate: string };

function MtmEntryForm({
  year,
  adminKey,
  onSuccess,
}: {
  year: number;
  adminKey: string;
  onSuccess: () => void;
}) {
  const { data: teams } = useGetTeams({ season: year });

  const [entries, setEntries] = useState<EntryRow[]>([
    { teamId: "", mtmValue: "", snapshotDate: "" },
  ]);
  const [pending, setPending] = useState(false);

  const [bulkMode, setBulkMode] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [csvError, setCsvError] = useState("");

  function addRow() {
    setEntries((prev) => [...prev, { teamId: "", mtmValue: "", snapshotDate: "" }]);
  }

  function removeRow(i: number) {
    setEntries((prev) => prev.filter((_, j) => j !== i));
  }

  function updateRow(i: number, key: keyof EntryRow, value: string) {
    setEntries((prev) => prev.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  }

  async function handleSingleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const valid = entries.filter((r) => r.teamId && r.mtmValue !== "");
    if (!valid.length) return;

    setPending(true);
    let done = 0;
    let failed = 0;
    let authFailed = false;

    for (const r of valid) {
      const result = await upsertMtmSnapshot(
        {
          teamId: parseInt(r.teamId),
          seasonYear: year,
          mtmValue: parseFloat(r.mtmValue),
          snapshotDate: r.snapshotDate || undefined,
        },
        adminKey,
      );
      if (result.ok) {
        done++;
      } else {
        failed++;
        if (result.error === "Invalid admin key") authFailed = true;
      }
    }

    setPending(false);
    if (authFailed) {
      toast.error("Invalid admin key — check your credentials");
    } else if (done > 0) {
      toast.success(`Saved ${done} MTM snapshot${done !== 1 ? "s" : ""}`);
      if (!failed) onSuccess();
    }
    if (failed && !authFailed) {
      toast.error(`${failed} snapshot${failed !== 1 ? "s" : ""} failed to save`);
    }
  }

  async function handleCsvImport() {
    setCsvError("");
    const lines = csvText
      .trim()
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"));

    const parsed: Array<{
      teamId: number;
      mtmValue: number;
      snapshotDate?: string;
    }> = [];

    for (const line of lines) {
      const parts = line.split(",").map((p) => p.trim());
      if (parts.length < 2) {
        setCsvError(`Bad line: "${line}" — expected: teamId, mtmValue[, YYYY-MM-DD]`);
        return;
      }
      const teamId = parseInt(parts[0] ?? "");
      const mtmValue = parseFloat(parts[1] ?? "");
      if (isNaN(teamId) || isNaN(mtmValue)) {
        setCsvError(`Bad values in: "${line}"`);
        return;
      }
      parsed.push({ teamId, mtmValue, snapshotDate: parts[2] || undefined });
    }

    if (!parsed.length) {
      setCsvError("No valid rows found");
      return;
    }

    setPending(true);
    let done = 0;
    let failed = 0;
    let authFailed = false;

    for (const r of parsed) {
      const result = await upsertMtmSnapshot({ ...r, seasonYear: year }, adminKey);
      if (result.ok) {
        done++;
      } else {
        failed++;
        if (result.error === "Invalid admin key") authFailed = true;
      }
    }

    setPending(false);
    if (authFailed) {
      toast.error("Invalid admin key — check your credentials");
    } else if (done > 0) {
      toast.success(`Imported ${done} MTM snapshot${done !== 1 ? "s" : ""}`);
      if (!failed) { setCsvText(""); onSuccess(); }
    }
    if (failed && !authFailed) {
      toast.error(`${failed} row${failed !== 1 ? "s" : ""} failed`);
    }
  }

  const validRowCount = entries.filter(
    (r) => r.teamId && r.mtmValue !== "",
  ).length;

  return (
    <div className="space-y-4">
      {/* Mode tabs */}
      <div className="flex gap-0 border-b border-border">
        {(["rows", "csv"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setBulkMode(m === "csv")}
            className={cn(
              "px-4 py-2 text-xs font-mono font-bold uppercase tracking-widest border-b-2 -mb-px transition-colors",
              (m === "csv") === bulkMode
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {m === "rows" ? "Row Entry" : "CSV Import"}
          </button>
        ))}
      </div>

      {!bulkMode ? (
        /* ── Row entry mode ── */
        <form onSubmit={(e) => void handleSingleSubmit(e)} className="space-y-3">
          {/* Column headers */}
          <div className="grid grid-cols-[1fr_130px_120px_32px] gap-2 items-center">
            <span className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">Team</span>
            <span className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">Date</span>
            <span className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">MTM Value ($)</span>
            <span />
          </div>

          {entries.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_130px_120px_32px] gap-2 items-center">
              {/* Team */}
              <select
                value={row.teamId}
                onChange={(e) => updateRow(i, "teamId", e.target.value)}
                className="border border-border bg-background px-2 py-1.5 text-sm font-mono w-full"
                required
              >
                <option value="">— Team —</option>
                {(teams ?? [])
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>

              {/* Date (defaults to today on submit if blank) */}
              <input
                type="date"
                value={row.snapshotDate}
                onChange={(e) => updateRow(i, "snapshotDate", e.target.value)}
                className="border border-border bg-background px-2 py-1.5 text-sm font-mono w-full"
              />

              {/* MTM value */}
              <input
                type="number"
                step="0.01"
                value={row.mtmValue}
                onChange={(e) => updateRow(i, "mtmValue", e.target.value)}
                placeholder="e.g. 250.00"
                className="border border-border bg-background px-2 py-1.5 text-sm font-mono w-full"
                required
              />

              {/* Remove */}
              {entries.length > 1 ? (
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  className="text-muted-foreground hover:text-destructive transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              ) : (
                <span />
              )}
            </div>
          ))}

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={addRow}
              className="text-xs font-mono text-primary hover:underline flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add row
            </button>
            <button
              type="submit"
              disabled={pending || validRowCount === 0}
              className="ml-auto bg-primary text-primary-foreground text-xs font-mono font-bold uppercase tracking-widest px-5 py-2 hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {pending
                ? "Saving…"
                : `Save ${validRowCount || ""} Snapshot${validRowCount !== 1 ? "s" : ""}`}
            </button>
          </div>
        </form>
      ) : (
        /* ── CSV import mode ── */
        <div className="space-y-3">
          <p className="text-xs font-mono text-muted-foreground">
            One row per line:{" "}
            <code className="bg-muted px-1">teamId, mtmValue[, YYYY-MM-DD]</code>
            <br />
            Date defaults to today if omitted. Same date = overwrite. Lines starting with{" "}
            <code className="bg-muted px-1">#</code> are ignored. Team IDs shown on the Teams page.
          </p>
          <textarea
            value={csvText}
            onChange={(e) => {
              setCsvText(e.target.value);
              setCsvError("");
            }}
            rows={8}
            placeholder={
              "# teamId, mtmValue, date (date optional — defaults to today)\n1, 320.00, 2026-09-15\n2, -45.50\n3, 110.00, 2026-09-15"
            }
            className="w-full border border-border bg-background px-3 py-2 text-sm font-mono resize-y"
          />
          {csvError && <p className="text-xs text-destructive font-mono">{csvError}</p>}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleCsvImport()}
              disabled={pending || !csvText.trim()}
              className="bg-primary text-primary-foreground text-xs font-mono font-bold uppercase tracking-widest px-5 py-2 hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {pending ? "Importing…" : "Import CSV"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({
  year,
  isAdmin,
  onEnterData,
}: {
  year: number;
  isAdmin: boolean;
  onEnterData: () => void;
}) {
  return (
    <div className="border border-dashed border-border flex flex-col items-center justify-center py-24 text-center">
      <TrendingUp className="w-12 h-12 text-muted-foreground/30 mb-4" />
      <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">
        No M2M data for {year} yet
      </p>
      <p className="text-xs text-muted-foreground mt-2 max-w-sm">
        Weekly mark-to-market snapshots will appear here once data is entered.
      </p>
      {isAdmin ? (
        <button
          onClick={onEnterData}
          className="mt-6 flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-xs font-mono font-bold uppercase tracking-widest hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> Enter First Snapshot
        </button>
      ) : (
        <code className="mt-4 text-xs bg-muted px-3 py-2 font-mono text-muted-foreground">
          POST /api/mtm {"{ teamId, seasonYear, mtmValue[, snapshotDate] }"}
        </code>
      )}
    </div>
  );
}

// ── Main chart + table ────────────────────────────────────────────────────────

function MtmContent({ data }: { data: MtmData }) {
  const [view, setView] = useState<"owner" | "team">("owner");

  // Use snapshotDate as the x-axis — format as "Sep 15" style labels
  const dates = data.weeks.map((w) => w.snapshotDate);
  const weekLabels = dates.map((d) => {
    const dt = new Date(d + "T12:00:00"); // noon to avoid TZ edge cases
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  });

  // Chart dimensions
  const W = 700;
  const H = 280;
  const PAD = { top: 20, right: 20, bottom: 32, left: 64 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  // Determine y-range
  const allVals =
    view === "owner"
      ? data.owners.flatMap((o) => o.weeklyTotals)
      : data.teams.flatMap((t) => t.weeklyValues);
  const minVal = Math.min(...allVals, 0);
  const maxVal = Math.max(...allVals, 0);
  const range = maxVal - minVal || 1;

  function xPos(i: number) {
    return PAD.left + (i / Math.max(dates.length - 1, 1)) * chartW;
  }
  function yPos(v: number) {
    return PAD.top + chartH - ((v - minVal) / range) * chartH;
  }

  const series =
    view === "owner"
      ? data.owners.map((o, i) => ({
          name: o.bidderName,
          values: o.weeklyTotals,
          color: OWNER_COLORS[i % OWNER_COLORS.length] as string,
        }))
      : data.teams.map((t, i) => ({
          name: t.teamName,
          values: t.weeklyValues,
          color: OWNER_COLORS[i % OWNER_COLORS.length] as string,
        }));

  function toPath(values: number[]) {
    return values
      .map(
        (v, i) => `${i === 0 ? "M" : "L"}${xPos(i).toFixed(1)},${yPos(v).toFixed(1)}`,
      )
      .join(" ");
  }

  const zeroY = yPos(0);

  return (
    <div className="space-y-6">
      {/* View toggle */}
      <div className="flex border-b border-border">
        {(["owner", "team"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={cn(
              "px-5 py-2.5 text-sm font-mono font-bold uppercase tracking-widest transition-colors border-b-2 -mb-px",
              view === v
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {v === "owner" ? "By Owner" : "By Team"}
          </button>
        ))}
      </div>

      {/* SVG Line Chart */}
      <div className="border border-border bg-card p-4 overflow-x-auto">
        <svg
          width="100%"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMinYMin meet"
          className="font-mono"
        >
          {/* Zero line */}
          <line
            x1={PAD.left}
            y1={zeroY}
            x2={W - PAD.right}
            y2={zeroY}
            stroke="currentColor"
            strokeOpacity={0.15}
            strokeWidth={1}
            strokeDasharray="4,4"
          />

          {/* Y axis ticks */}
          {[-2, -1, 0, 1, 2].map((mult) => {
            const v = (mult / 2) * range + minVal;
            const y = yPos(v);
            return (
              <g key={mult}>
                <line
                  x1={PAD.left - 4}
                  y1={y}
                  x2={PAD.left}
                  y2={y}
                  stroke="currentColor"
                  strokeOpacity={0.3}
                />
                <text
                  x={PAD.left - 8}
                  y={y + 4}
                  textAnchor="end"
                  fontSize={9}
                  fill="currentColor"
                  fillOpacity={0.5}
                >
                  {v >= 0 ? "+" : ""}
                  {(v / 1000).toFixed(1)}k
                </text>
              </g>
            );
          })}

          {/* X axis labels */}
          {weekLabels.map((label, i) => (
            <text
              key={i}
              x={xPos(i)}
              y={H - 6}
              textAnchor="middle"
              fontSize={9}
              fill="currentColor"
              fillOpacity={0.5}
            >
              {label}
            </text>
          ))}

          {/* Series lines */}
          {series.map((s) => (
            <path
              key={s.name}
              d={toPath(s.values)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
            />
          ))}

          {/* Series dots at last week */}
          {series.map((s) => {
            const lastIdx = s.values.length - 1;
            const lastVal = s.values[lastIdx] ?? 0;
            return (
              <circle
                key={s.name}
                cx={xPos(lastIdx)}
                cy={yPos(lastVal)}
                r={4}
                fill={s.color}
              />
            );
          })}
        </svg>

        {/* Legend */}
        <div className="flex flex-wrap gap-4 mt-4 px-2">
          {series.map((s) => (
            <div key={s.name} className="flex items-center gap-1.5">
              <div className="w-3 h-0.5" style={{ backgroundColor: s.color }} />
              <span className="text-xs text-muted-foreground font-mono">
                {view === "owner" ? s.name.split(" ")[0] : s.name}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Weekly breakdown table */}
      {data.weeks.length > 0 && (
        <div className="border border-border bg-card overflow-x-auto">
          <div className="px-4 pt-4 pb-2">
            <h3 className="font-bold text-sm uppercase tracking-tight">
              Weekly Breakdown — By Owner
            </h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/60">
                <th className="px-4 py-2 text-left text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                  Owner
                </th>
                {data.weeks.map((w) => (
                  <th
                    key={w.snapshotDate}
                    className="px-3 py-2 text-right text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground"
                  >
                    {new Date(w.snapshotDate + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.owners.map((owner, oi) => (
                <tr
                  key={owner.bidderName}
                  className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors"
                >
                  <td className="px-4 py-3 font-medium text-sm">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: OWNER_COLORS[oi % OWNER_COLORS.length] }}
                      />
                      {owner.bidderName.split(" ")[0]}
                    </div>
                  </td>
                  {owner.weeklyTotals.map((v, wi) => {
                    const prev = wi > 0 ? (owner.weeklyTotals[wi - 1] ?? v) : v;
                    const delta = v - prev;
                    return (
                      <td
                        key={wi}
                        className={cn(
                          "px-3 py-3 text-right font-mono text-xs",
                          v >= 0 ? "text-green-600" : "text-red-600",
                        )}
                      >
                        {v >= 0 ? "+" : ""}
                        {formatCurrency(v)}
                        {wi > 0 && delta !== 0 && (
                          <span
                            className={cn(
                              "ml-1",
                              delta > 0 ? "text-green-400" : "text-red-400",
                            )}
                          >
                            {delta > 0 ? (
                              <TrendingUp className="inline w-2.5 h-2.5" />
                            ) : (
                              <TrendingDown className="inline w-2.5 h-2.5" />
                            )}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
