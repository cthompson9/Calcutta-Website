import { useGetAuctionSummary } from "@workspace/api-client-react";
import { formatCurrency, formatPercentage } from "@/lib/utils";
import { Trophy, TrendingUp, DollarSign, Activity } from "lucide-react";
import { useSeason } from "@/hooks/useSeason";

export default function Dashboard() {
  const { year } = useSeason();
  const { data: summary, isLoading: loadingSummary } = useGetAuctionSummary({ season: year });

  if (loadingSummary) {
    return (
      <div className="p-4 md:p-8 space-y-8 animate-pulse">
        <div className="h-8 w-64 bg-muted mb-8" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-32 bg-muted border border-border" />)}
        </div>
        <div className="h-[400px] bg-muted border border-border" />
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="p-4 md:p-8 space-y-8 max-w-7xl mx-auto">
      <header>
        <h1 className="text-3xl md:text-5xl font-extrabold uppercase tracking-tighter mb-2">Auction Board</h1>
        <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">
          {year} auction standings & stats
        </p>
      </header>

      {/* Headline Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-0 border border-border bg-card">
        <StatCard title="Total Pot" value={formatCurrency(summary.potSize)} icon={Trophy} className="border-b md:border-b-0 md:border-r" />
        <StatCard title="Avg Bid / Team" value={formatCurrency(summary.avgBidPerTeam)} icon={DollarSign} className="border-b md:border-b-0 md:border-r border-l" />
        <StatCard title="Teams Auctioned" value={`${summary.teamsAuctioned}/32`} icon={Activity} className="border-r md:border-r border-t md:border-t-0" />
        <StatCard title="Nominations Left" value={summary.nominationsLeft.toString()} icon={TrendingUp} className="border-t md:border-t-0" />
      </div>

      <div className="grid md:grid-cols-3 gap-8 items-start">
        {/* Leaderboard */}
        <div className="md:col-span-2 space-y-4">
          <h2 className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
            <div className="w-3 h-3 bg-primary" /> Standings
          </h2>
          <div className="border border-border bg-card overflow-hidden">
            <div className="grid grid-cols-12 bg-muted text-muted-foreground text-xs font-mono font-bold uppercase tracking-widest px-4 py-3 border-b border-border">
              <div className="col-span-1 text-center">Rk</div>
              <div className="col-span-4">Bidder</div>
              <div className="col-span-3 text-right">Total Paid</div>
              <div className="col-span-2 text-center">Teams</div>
              <div className="col-span-2 text-right">% Pot</div>
            </div>
            {summary.standings.map((standing, index) => {
              const isLeader = index === 0 && standing.totalPaid > 0;
              return (
                <div 
                  key={standing.bidderId} 
                  className={`grid grid-cols-12 items-center px-4 py-4 border-b border-border last:border-0 hover:bg-muted/50 transition-colors ${
                    isLeader ? "bg-gold/10" : ""
                  }`}
                >
                  <div className="col-span-1 text-center font-mono font-bold">
                    {index + 1}
                  </div>
                  <div className="col-span-4 font-bold truncate pr-2 flex items-center gap-2">
                    {isLeader && <Trophy className="w-4 h-4 text-gold shrink-0" />}
                    {standing.bidderName}
                  </div>
                  <div className="col-span-3 text-right font-mono font-bold text-lg">
                    {formatCurrency(standing.totalPaid)}
                  </div>
                  <div className="col-span-2 text-center font-mono text-muted-foreground">
                    {standing.teamCount}
                  </div>
                  <div className="col-span-2 text-right font-mono text-sm">
                    {formatPercentage(standing.percentOfPot)}
                  </div>
                </div>
              );
            })}
            {summary.standings.length === 0 && (
              <div className="p-8 text-center text-muted-foreground">
                No active bidders yet.
              </div>
            )}
          </div>
        </div>

        {/* Conference Breakdown */}
        <div className="space-y-4">
          <h2 className="text-xl font-bold uppercase tracking-tight flex items-center gap-2">
            <div className="w-3 h-3 bg-primary" /> Conference Splits
          </h2>
          <div className="flex flex-col gap-4">
            {summary.conferenceBreakdown.map((conf) => {
              const isAFC = conf.conference === "AFC";
              return (
                <div 
                  key={conf.conference} 
                  className={`border border-border p-5 relative overflow-hidden bg-card ${
                    isAFC ? "border-t-4 border-t-afc" : "border-t-4 border-t-nfc"
                  }`}
                >
                  <div className="flex justify-between items-end mb-6">
                    <h3 className={`text-4xl font-black ${isAFC ? "text-afc" : "text-nfc"}`}>
                      {conf.conference}
                    </h3>
                    <div className="text-right">
                      <div className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Spent</div>
                      <div className="text-xl font-mono font-bold">{formatCurrency(conf.totalSpent)}</div>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4 border-t border-border pt-4 mt-2">
                    <div>
                      <div className="text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-widest">Teams</div>
                      <div className="font-mono text-lg">{conf.teamCount}/16</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-widest">Avg Bid</div>
                      <div className="font-mono text-lg">{formatCurrency(conf.avgBid)}</div>
                    </div>
                  </div>
                </div>
              );
            })}
            {summary.conferenceBreakdown.length === 0 && (
              <div className="border border-dashed border-border px-5 py-12 text-center">
                <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                  No conference auction data for {year}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ title, value, icon: Icon, className }: { title: string, value: string, icon: any, className?: string }) {
  return (
    <div className={`p-6 flex flex-col gap-2 ${className}`}>
      <div className="flex items-center justify-between text-muted-foreground">
        <span className="text-xs font-mono font-bold uppercase tracking-widest">{title}</span>
        <Icon className="w-4 h-4 opacity-50" />
      </div>
      <div className="text-3xl md:text-4xl font-mono font-black tracking-tight">{value}</div>
    </div>
  );
}
