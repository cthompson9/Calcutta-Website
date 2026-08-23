import { Sparkles } from "lucide-react";

const updates = [
  {
    title: "Trace every ownership position",
    description:
      "Select any Primary or trade-derived Type in Results to jump to the original Auction Results row or exact trade record.",
  },
  {
    title: "Return to Results faster",
    description:
      "After following a source link, press Ctrl + [ to return to the Results view you came from.",
  },
];

export function ReleaseNotes() {
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
              Last 12 hours
            </span>
          </div>
          <ul className="mt-3 space-y-2">
            {updates.map((update) => (
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