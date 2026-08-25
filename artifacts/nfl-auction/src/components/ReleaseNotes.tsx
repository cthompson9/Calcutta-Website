import { useState } from "react";
import { Sparkles, X } from "lucide-react";

export type ReleaseUpdate = {
  title: string;
  description: string;
};

export type ReleaseNote = {
  date: string;
  updates: ReleaseUpdate[];
};

export const releaseNotes: ReleaseNote[] = [
  {
    date: "August 25, 2026",
    updates: [
      {
        title: "By Consortium team detail",
        description:
          "Open a consortium's detail view to see team positions, realized and MTM values, breakeven points, source links, and trade history together.",
      },
      {
        title: "Realized value math fixes",
        description:
          "Realized values now use corrected calculations so net results and team-level amounts stay consistent.",
      },
      {
        title: "Sorting bug fixes",
        description:
          "Updated sorting keeps standings, teams, and trade summaries in the expected order.",
      },
      {
        title: "Erroneous trades cleaned up",
        description:
          "Erroneous trades were voided and removed from Consortium trade history while their audit records remain preserved.",
      },
      {
        title: "Frozen report headers",
        description:
          "The top row stays visible while scrolling through long reports.",
      },
      {
        title: "Breakeven points",
        description:
          "Breakeven fields now show the points needed to reach the target realized result.",
      },
    ],
  },
  {
    date: "August 23, 2026",
    updates: [
      {
        title: "Results command center",
        description:
          "The desktop Results report now has sortable signed standings, movement, portfolio detail, trends, and direct source links.",
      },
      {
        title: "Trade legs stay together",
        description:
          "Multi-leg transactions now appear as one expandable trade summary, with the aggregate value, teams, counterparties, date, and status up front.",
      },
      {
        title: "Short positions are shown accurately",
        description:
          "Every Results view now preserves signed long and short ownership so exposure and returns reflect the actual position.",
      },
      {
        title: "Returns are easier to read",
        description:
          "Use Ctrl + [ to return to Results after following a source link. Live consortium standings use net Mark-to-Market, while team analysis shows realized and MTM context together.",
      },
    ],
  },
];

export function ReleaseNotes() {
  const latest = releaseNotes[0]!;
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <section
      aria-labelledby="release-notes-title"
      className="flex items-center gap-3 border border-primary/30 bg-primary/5 px-4 py-2.5"
    >
      <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h2 id="release-notes-title" className="sr-only">What&apos;s new</h2>
        <p className="truncate text-sm">
          <span className="mr-2 font-mono text-[10px] font-bold uppercase tracking-widest text-primary">What&apos;s new</span>
          <span className="font-semibold text-foreground">{latest.updates[0]?.title}.</span>{" "}
          <span className="text-muted-foreground">{latest.updates[0]?.description}</span>
        </p>
      </div>
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{latest.date}</span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss what's new notice"
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
      >
        <X className="h-4 w-4" />
      </button>
    </section>
  );
}