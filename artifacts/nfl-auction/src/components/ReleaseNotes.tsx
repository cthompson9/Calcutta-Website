import { Sparkles } from "lucide-react";

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
    date: "August 23, 2026",
    updates: [
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
        title: "Switch return views more easily",
        description:
          "Use Ctrl + [ to return to Results after following a source link, while a streamlined returns engine makes it easier to toggle between live Mark-to-Market and realized results.",
      },
    ],
  },
];

export function ReleaseNotes() {
  const latest = releaseNotes[0]!;

  return (
    <section
      aria-labelledby="release-notes-title"
      className="border border-primary/30 bg-primary/5 p-4 md:p-5"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center border border-primary/30 bg-background text-primary">
          <Sparkles className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2
              id="release-notes-title"
              className="font-mono text-sm font-bold uppercase tracking-widest text-foreground"
            >
              What&apos;s new
            </h2>
            <span className="border border-primary/30 bg-background px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest text-primary">
              {latest.date}
            </span>
          </div>
          <ul className="mt-3 space-y-2">
            {latest.updates.map((update) => (
              <li key={update.title} className="text-sm leading-relaxed">
                <span className="font-bold text-foreground">{update.title}.</span>{" "}
                <span className="text-muted-foreground">{update.description}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}