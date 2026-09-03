import { Sparkles } from "lucide-react";
import { releaseNotes } from "@/components/ReleaseNotes";

export default function WhatsNew() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 md:space-y-8 p-4 md:p-8">
      <header>
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-primary/30 bg-primary/5 text-primary md:h-10 md:w-10">
            <Sparkles className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold uppercase tracking-tighter md:text-5xl">
              What&apos;s New
            </h1>
            <p className="mt-1 text-xs font-mono uppercase tracking-wider text-muted-foreground md:text-sm md:tracking-widest">
              Release notes &amp; frequently asked questions
            </p>
          </div>
        </div>
      </header>

      <section aria-labelledby="release-history-title" className="space-y-4">
        <div className="flex items-end justify-between gap-3 border-b border-border pb-2">
          <div>
            <h2
              id="release-history-title"
              className="text-sm font-mono font-bold uppercase tracking-widest"
            >
              Release history
            </h2>
            <p className="mt-1 text-xs font-mono text-muted-foreground">
              Most recent updates appear first.
            </p>
          </div>
          <span className="hidden text-xs font-mono uppercase tracking-widest text-muted-foreground sm:block">
            {releaseNotes.length} release{releaseNotes.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="space-y-3 md:space-y-4">
          {releaseNotes.map((release) => (
            <article
              key={release.date}
              className="border border-primary/30 bg-primary/5 p-3 md:p-5"
              data-testid={`release-note-${release.date}`}
            >
              <div className="flex items-center gap-2">
                <time className="font-mono text-sm font-bold uppercase tracking-widest text-primary">
                  {release.date}
                </time>
              </div>
              <ul className="mt-3 space-y-2 md:mt-4 md:space-y-3">
                {release.updates.map((update) => (
                  <li key={update.title} className="text-sm leading-relaxed">
                    <span className="font-bold text-foreground">{update.title}.</span>{" "}
                    <span className="text-muted-foreground">{update.description}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

    </div>
  );
}