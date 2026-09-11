import { useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Radio,
} from "lucide-react";
import crestImage from "../../../../attached_assets/image_1789101599466.png";
import "./format-preview.css";

type View = "standings" | "live" | "trades" | "auction";

const standings = [
  { rank: 1, name: "Craig T. / Damon H. / Yishi Z.", members: "Craig Thompson · Damon Huard · Yishi Zhang", teams: 5, spend: 15375, points: 1128, value: 19120, net: 3745, delta: 318 },
  { rank: 2, name: "Kurt D.", members: "Kurt DeHut", teams: 6, spend: 17625, points: 1084, value: 18374, net: 749, delta: 221 },
  { rank: 3, name: "GDawg Collin / Tony B.", members: "Collin Gosselin · Tony Bakshi", teams: 4, spend: 13850, points: 941, value: 15942, net: 2092, delta: -84 },
  { rank: 4, name: "Ian C.", members: "Ian Culnane", teams: 5, spend: 14775, points: 866, value: 14672, net: -103, delta: 106 },
  { rank: 5, name: "Joey A.", members: "Joey Arnone", teams: 4, spend: 12300, points: 734, value: 12436, net: 136, delta: -148 },
  { rank: 6, name: "Andrew H. / Chris B.", members: "Andrew Hofer · Chris Brown", teams: 4, spend: 13100, points: 622, value: 10538, net: -2562, delta: -207 },
];

const trades = [
  { date: "Sep 10", team: "Los Angeles Rams", share: "15%", from: "Kurt D. / Joey A.", to: "Craig T. / Damon H. / Yishi Z.", price: 900, status: "Pending review" },
  { date: "Sep 3", team: "San Francisco 49ers", share: "33.33%", from: "Ian C.", to: "Craig T. / Damon H. / Yishi Z.", price: 1325, status: "Approved" },
  { date: "Aug 28", team: "Buffalo Bills", share: "25%", from: "Kurt D.", to: "GDawg Collin / Tony B.", price: 1450, status: "Approved" },
];

const auction = [
  ["Los Angeles Rams", "Kurt D. / Joey A.", 6001],
  ["San Francisco 49ers", "Ian C.", 3950],
  ["Buffalo Bills", "Kurt D.", 5725],
  ["New England Patriots", "Ian C.", 3400],
  ["Jacksonville Jaguars", "Kurt D.", 3100],
  ["Washington Commanders", "GDawg Collin", 2000],
] as const;

function money(value: number, signed = false) {
  const absolute = Math.abs(value).toLocaleString("en-US");
  return `${signed ? (value >= 0 ? "+" : "−") : ""}$${absolute}`;
}

function Crest() {
  return (
    <div className="fp-crest" aria-label="The Calcutta">
      <img src={crestImage} alt="" aria-hidden="true" />
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="fp-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function StandingsView() {
  const [sort, setSort] = useState<"rank" | "net">("rank");
  const rows = useMemo(
    () => [...standings].sort((a, b) => sort === "rank" ? a.rank - b.rank : b.net - a.net),
    [sort],
  );
  const leader = rows[0]!;
  return (
    <>
      <header className="fp-page-header">
        <div><p>2026 season · Week 1</p><h1>Consortium standings</h1><span>Ownership-weighted returns across the Calcutta pool.</span></div>
        <div className="fp-asof"><Radio /> Live standings<br/><small>Updated 2:45 PM ET</small></div>
      </header>
      <section className="fp-leader">
        <div><p>Current leader</p><h2>{leader.name}</h2><span>{leader.members}</span></div>
        <div className="fp-leader-number"><span>Net return</span><strong>{money(leader.net, true)}</strong><small><ArrowUpRight /> {money(leader.delta, true)} this week</small></div>
      </section>
      <div className="fp-viewbar">
        <span>{rows.length} consortiums</span>
        <div><button className={sort === "rank" ? "active" : ""} onClick={() => setSort("rank")}>Rank</button><button className={sort === "net" ? "active" : ""} onClick={() => setSort("net")}>Net return</button></div>
      </div>
      <div className="fp-table-wrap">
        <table className="fp-table">
          <thead><tr><th>Rank</th><th>Consortium</th><th>Teams</th><th>Spend</th><th>Points</th><th>Value</th><th>Net</th><th>Week</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.name}>
            <td className="fp-rank">{row.rank}</td><td><strong>{row.name}</strong><small>{row.members}</small></td><td>{row.teams}</td><td>{money(row.spend)}</td><td>{row.points.toLocaleString()}</td><td>{money(row.value)}</td><td className={row.net >= 0 ? "gain" : "loss"}>{money(row.net, true)}</td><td className={row.delta >= 0 ? "gain" : "loss"}>{row.delta >= 0 ? <ArrowUpRight /> : <ArrowDownRight />}{money(row.delta, true)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </>
  );
}

function LiveView() {
  return (
    <>
      <header className="fp-page-header"><div><p>Week 1 · In progress</p><h1>Live tracker</h1><span>Games affecting Calcutta positions right now.</span></div><div className="fp-asof"><Clock3 /> Sunday slate<br/><small>3 games live</small></div></header>
      <div className="fp-metrics"><Metric label="Pool value in play" value="$42,850" /><Metric label="Largest live move" value="+$318" note="Craig T. consortium" /><Metric label="Completed today" value="4 of 13" /></div>
      <section className="fp-games">
        {[["Buffalo Bills","17","Baltimore Ravens","14","3rd · 08:42"],["San Francisco 49ers","21","Seattle Seahawks","10","Halftime"],["Los Angeles Rams","13","Houston Texans","16","4th · 12:05"]].map((game) => <article key={game[0]}>
          <p><Radio /> {game[4]}</p><div><strong>{game[0]}</strong><b>{game[1]}</b></div><div><strong>{game[2]}</strong><b>{game[3]}</b></div><footer>Calcutta move <span>+$124</span><ChevronRight /></footer>
        </article>)}
      </section>
    </>
  );
}

function TradesView() {
  return (
    <>
      <header className="fp-page-header"><div><p>Transaction ledger</p><h1>Trades</h1><span>Every transfer, settlement, and commissioner decision.</span></div><div className="fp-asof">Trade window<br/><small>Closes Week 10</small></div></header>
      <div className="fp-trade-list">{trades.map((trade) => <article key={`${trade.date}-${trade.team}`}>
        <time>{trade.date}</time><div><h3>{trade.team} <span>{trade.share}</span></h3><p>{trade.from} <ChevronRight /> {trade.to}</p></div><strong>{money(trade.price)}</strong><em className={trade.status === "Approved" ? "approved" : ""}>{trade.status}</em>
      </article>)}</div>
      <p className="fp-footnote">Trades lock at the Week 10 kickoff. After that, you are married to your mistakes.</p>
    </>
  );
}

function AuctionView() {
  return (
    <div className="fp-auction">
      <Crest /><p>Calcutta XII · Auction night</p><h1>The 2026 ledger</h1>
      <div className="fp-metrics"><Metric label="Total pot" value="$97,625" /><Metric label="Average lot" value="$3,051" /><Metric label="Dollar per point" value="$8.55" /></div>
      <table className="fp-table"><thead><tr><th>Lot</th><th>Club</th><th>Buyer</th><th>Hammer</th></tr></thead><tbody>{auction.map((row, index) => <tr key={row[0]}><td className="fp-rank">{String(index + 1).padStart(2, "0")}</td><td><strong>{row[0]}</strong></td><td>{row[1]}</td><td><strong>{money(row[2])}</strong></td></tr>)}</tbody></table>
    </div>
  );
}

export default function FormatPreview() {
  const [view, setView] = useState<View>("standings");
  const labels: Array<[View, string]> = [["standings","Standings"],["live","Live tracker"],["trades","Trades"],["auction","Auction night"]];
  return (
    <div className="format-preview">
      <aside className="fp-sidebar">
        <div className="fp-brand"><Crest /><div><strong>The Calcutta</strong><span>Football club · Est. 2015</span></div></div>
        <nav>{labels.map(([id,label]) => <button key={id} onClick={() => setView(id)} className={view === id ? "active" : ""}>{label}<ChevronRight /></button>)}</nav>
        <div className="fp-sidebar-note"><CircleDollarSign /><span>Calcutta XII</span><strong>$97,625 pool</strong></div>
        <a href="./"><ArrowLeft /> Return to live app</a>
      </aside>
      <div className="fp-mobilebar"><div className="fp-brand"><Crest /><strong>The Calcutta</strong></div><a href="./"><ArrowLeft /> Live app</a></div>
      <nav className="fp-mobile-nav">{labels.map(([id,label]) => <button key={id} onClick={() => setView(id)} className={view === id ? "active" : ""}>{label}</button>)}</nav>
      <main className="fp-main">
        {view === "standings" && <StandingsView />}
        {view === "live" && <LiveView />}
        {view === "trades" && <TradesView />}
        {view === "auction" && <AuctionView />}
      </main>
    </div>
  );
}