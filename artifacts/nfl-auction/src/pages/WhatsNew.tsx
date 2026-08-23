import { CircleHelp, ExternalLink, Sparkles } from "lucide-react";
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

      <section aria-labelledby="faq-title" className="space-y-4">
        <div className="flex items-center gap-2 border-b border-border pb-2">
          <CircleHelp className="h-4 w-4 text-primary" aria-hidden="true" />
          <h2 id="faq-title" className="text-sm font-mono font-bold uppercase tracking-widest">
            FAQ
          </h2>
        </div>

        <details open className="group border border-border bg-background" data-testid="details-mcp-api-faq">
          <summary className="cursor-pointer list-none px-4 py-3 font-mono text-sm font-bold uppercase tracking-wide focus:outline-none focus:ring-2 focus:ring-primary focus:ring-inset">
            <span className="flex items-center justify-between gap-3">
              How do I connect MCP/API?
              <span className="text-lg leading-none text-muted-foreground transition-transform group-open:rotate-45">
                +
              </span>
            </span>
          </summary>
          <div className="space-y-4 border-t border-border px-4 py-4 text-sm leading-relaxed text-muted-foreground">
            <p>
              Connect an MCP-compatible client to this app&apos;s base URL plus{" "}
              <code className="border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                /api/mcp
              </code>
              . The endpoint uses stateless Streamable HTTP and accepts{" "}
              <code className="border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                POST
              </code>{" "}
              requests.
            </p>
            <div className="border border-border bg-muted/40 p-3 font-mono text-xs text-foreground">
              <div>Authorization: Bearer &lt;MCP_API_KEY&gt;</div>
              <div className="mt-1 text-muted-foreground">Endpoint: /api/mcp</div>
            </div>
            <p>
              For direct API access, use this app&apos;s base URL plus the relevant{" "}
              <code className="border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                /api/...
              </code>{" "}
              route and follow the route&apos;s authentication requirements. Commissioner
              approval actions require separate admin authorization.
            </p>
            <p className="border-l-2 border-primary pl-3 font-medium text-foreground">
              Reach out to me for the API key. Never commit keys to source control or share
              them in public messages.
            </p>
            <a
              href="/api/mcp"
              className="inline-flex items-center gap-1.5 font-mono text-xs font-bold uppercase tracking-widest text-primary hover:underline"
              data-testid="link-open-mcp-endpoint"
            >
              Open MCP endpoint
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>
        </details>
      </section>
    </div>
  );
}