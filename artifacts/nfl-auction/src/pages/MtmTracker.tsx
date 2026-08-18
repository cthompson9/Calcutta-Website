import { useState } from "react";
import { useGetMtmSnapshots } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { SeasonToggle } from "@/components/SeasonToggle";
import { useSeason } from "@/hooks/useSeason";
import { TrendingUp, TrendingDown } from "lucide-react";

const OWNER_COLORS = [
  "#3b82f6", // blue
  "#10b981", // green
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // purple
  "#06b6d4", // cyan
  "#f97316", // orange
];

export default function MtmTracker() {
  const { year, setYear } = useSeason();
  const { data, isLoading } = useGetMtmSnapshots({ season: year });

  const hasData = data && data.owners.length > 0 && data.owners.some((o) => o.weeklyTotals.some((v) => v !== 0));

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-5xl font-extrabold uppercase tracking-tighter mb-1">M2M Tracker</h1>
          <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">
            Mark-to-market · week by week · {year}
          </p>
        </div>
        <SeasonToggle year={year} onChange={setYear} />
      </header>

      {isLoading ? (
        <div className="space-y-4 animate-pulse">
          <div className="h-64 bg-muted border border-border" />
          <div className="h-48 bg-muted border border-border" />
        </div>
      ) : !hasData ? (
        <EmptyState year={year} />
      ) : (
        <MtmContent data={data} />
      )}
    </div>
  );
}

function EmptyState({ year }: { year: number }) {
  return (
    <div className="border border-dashed border-border flex flex-col items-center justify-center py-24 text-center">
      <TrendingUp className="w-12 h-12 text-muted-foreground/30 mb-4" />
      <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">No M2M data for {year} yet</p>
      <p className="text-xs text-muted-foreground mt-2 max-w-sm">
        Weekly mark-to-market snapshots will appear here once data is loaded via the API endpoints.
      </p>
      <code className="mt-4 text-xs bg-muted px-3 py-2 font-mono text-muted-foreground">
        POST /api/mtm {"{ teamId, seasonYear, weekNum, mtmValue }"}
      </code>
    </div>
  );
}

function MtmContent({ data }: { data: NonNullable<ReturnType<typeof useGetMtmSnapshots>["data"]> }) {
  const [view, setView] = useState<"owner" | "team">("owner");

  const weekNums = data.weeks.map((w) => w.weekNum);
  const weekLabels = weekNums.map((w) => (w === 0 ? "Pre" : `Wk ${w}`));

  // Chart dimensions
  const W = 700;
  const H = 280;
  const PAD = { top: 20, right: 20, bottom: 32, left: 64 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  // Determine y-range
  const allVals = view === "owner"
    ? data.owners.flatMap((o) => o.weeklyTotals)
    : data.teams.flatMap((t) => t.weeklyValues);
  const minVal = Math.min(...allVals, 0);
  const maxVal = Math.max(...allVals, 0);
  const range = maxVal - minVal || 1;

  function xPos(i: number) {
    return PAD.left + (i / Math.max(weekNums.length - 1, 1)) * chartW;
  }
  function yPos(v: number) {
    return PAD.top + chartH - ((v - minVal) / range) * chartH;
  }

  const series = view === "owner"
    ? data.owners.map((o, i) => ({
        name: o.bidderName,
        values: o.weeklyTotals,
        color: OWNER_COLORS[i % OWNER_COLORS.length],
      }))
    : data.teams.map((t, i) => ({
        name: t.teamName,
        values: t.weeklyValues,
        color: OWNER_COLORS[i % OWNER_COLORS.length],
      }));

  function toPath(values: number[]) {
    return values
      .map((v, i) => `${i === 0 ? "M" : "L"}${xPos(i).toFixed(1)},${yPos(v).toFixed(1)}`)
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
              view === v ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {v === "owner" ? "By Owner" : "By Team"}
          </button>
        ))}
      </div>

      {/* SVG Line Chart */}
      <div className="border border-border bg-card p-4 overflow-x-auto">
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMinYMin meet" className="font-mono">
          {/* Zero line */}
          <line x1={PAD.left} y1={zeroY} x2={W - PAD.right} y2={zeroY} stroke="currentColor" strokeOpacity={0.15} strokeWidth={1} strokeDasharray="4,4" />

          {/* Y axis ticks */}
          {[-2, -1, 0, 1, 2].map((mult) => {
            const v = (mult / 2) * range + minVal;
            const y = yPos(v);
            return (
              <g key={mult}>
                <line x1={PAD.left - 4} y1={y} x2={PAD.left} y2={y} stroke="currentColor" strokeOpacity={0.3} />
                <text x={PAD.left - 8} y={y + 4} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.5}>
                  {v >= 0 ? "+" : ""}{(v / 1000).toFixed(1)}k
                </text>
              </g>
            );
          })}

          {/* X axis labels */}
          {weekLabels.map((label, i) => (
            <text key={i} x={xPos(i)} y={H - 6} textAnchor="middle" fontSize={9} fill="currentColor" fillOpacity={0.5}>
              {label}
            </text>
          ))}

          {/* Series lines */}
          {series.map((s) => (
            <path key={s.name} d={toPath(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
          ))}

          {/* Series dots at last week */}
          {series.map((s) => {
            const lastIdx = s.values.length - 1;
            const lastVal = s.values[lastIdx];
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
              <span className="text-xs text-muted-foreground font-mono">{view === "owner" ? s.name.split(" ")[0] : s.name}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Weekly breakdown table */}
      {data.weeks.length > 0 && (
        <div className="border border-border bg-card overflow-x-auto">
          <div className="px-4 pt-4 pb-2">
            <h3 className="font-bold text-sm uppercase tracking-tight">Weekly Breakdown — By Owner</h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/60">
                <th className="px-4 py-2 text-left text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">Owner</th>
                {data.weeks.map((w) => (
                  <th key={w.weekNum} className="px-3 py-2 text-right text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                    {w.weekNum === 0 ? "Pre" : `Wk ${w.weekNum}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.owners.map((owner, oi) => (
                <tr key={owner.bidderName} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3 font-medium text-sm">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: OWNER_COLORS[oi % OWNER_COLORS.length] }} />
                      {owner.bidderName.split(" ")[0]}
                    </div>
                  </td>
                  {owner.weeklyTotals.map((v, wi) => {
                    const prev = wi > 0 ? owner.weeklyTotals[wi - 1] : v;
                    const delta = v - prev;
                    return (
                      <td key={wi} className={cn("px-3 py-3 text-right font-mono text-xs", v >= 0 ? "text-green-600" : "text-red-600")}>
                        {v >= 0 ? "+" : ""}{formatCurrency(v)}
                        {wi > 0 && delta !== 0 && (
                          <span className={cn("ml-1", delta > 0 ? "text-green-400" : "text-red-400")}>
                            {delta > 0 ? <TrendingUp className="inline w-2.5 h-2.5" /> : <TrendingDown className="inline w-2.5 h-2.5" />}
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
