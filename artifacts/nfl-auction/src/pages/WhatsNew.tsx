import { CircleHelp, ExternalLink, Sparkles } from "lucide-react";
import { releaseNotes } from "@/components/ReleaseNotes";

const claudeSetupSteps = [
  {
    title: "Open Claude Settings",
    description: "Open your Claude account menu in the lower-left corner and select Settings.",
    image: "screen-1-settings.png",
    alt: "Claude account menu with Settings selected",
  },
  {
    title: "Open Connectors",
    description: "Select Connectors in the sidebar, open the Add menu, and choose Add custom connector.",
    image: "screen-2-connectors.png",
    alt: "Claude Settings Connectors page with Add custom connector selected",
  },
  {
    title: "Enter the connector details",
    description: "Name the connector Calcutta MCP and enter the MCP URL shown below, then select Continue.",
    image: "screen-3-custom-connector.png",
    alt: "Claude Add custom connector form with the Calcutta MCP name and URL",
  },
  {
    title: "Keep automatic OAuth registration",
    description:
      "Leave Always required selected. Under OAuth client, choose No client ID — register one automatically, then select Add. Do not choose Use your own OAuth client.",
    image: "screen-4-oauth.png",
    alt: "Claude custom connector authentication settings with automatic OAuth client registration selected",
  },
  {
    title: "Start the connection",
    description: "When the connector appears as unfinished in your list, select Connect.",
    image: "screen-5-connect.png",
    alt: "Claude connector list showing the Calcutta MCP Connect button",
  },
  {
    title: "Authorize Calcutta MCP",
    description:
      "Enter the MCP API key on the Calcutta authorization page and select Connect. Reach out to Craig for the API key.",
    image: "screen-6-api-key.png",
    alt: "Calcutta authorization page asking for the MCP API key",
  },
] as const;

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
            <div className="space-y-2 border border-border bg-muted/40 p-3">
              <p className="font-mono text-xs font-bold uppercase tracking-wide text-foreground">
                Claude custom connector
              </p>
              <p className="text-xs">
                Follow the six screens below in order. Claude is the OAuth client, so
                you do not need to create or enter an OAuth client ID or secret.
              </p>
              <div className="mt-4 space-y-4">
                {claudeSetupSteps.map((step, index) => (
                  <figure
                    key={step.image}
                    className="overflow-hidden border border-border bg-background"
                    data-testid={`claude-setup-step-${index + 1}`}
                  >
                    <div className="grid gap-3 p-3 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] md:items-start">
                      <figcaption className="text-xs leading-relaxed">
                        <p className="font-mono font-bold uppercase tracking-wide text-foreground">
                          Step {index + 1}: {step.title}
                        </p>
                        <p className="mt-1">{step.description}</p>
                        {index === 2 && (
                          <p className="mt-2 border-l-2 border-primary pl-2 text-foreground">
                            Connector URL:{" "}
                            <code className="break-all font-mono">
                              https://nfl-calcutta.replit.app/api/mcp
                            </code>
                          </p>
                        )}
                      </figcaption>
                      <img
                        src={`${import.meta.env.BASE_URL}claude-setup/${step.image}`}
                        alt={step.alt}
                        loading="lazy"
                        className="h-auto w-full border border-border object-contain"
                      />
                    </div>
                  </figure>
                ))}
              </div>
            </div>
            <p>
              For direct API access, use this app&apos;s base URL plus the relevant{" "}
              <code className="border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                /api/...
              </code>{" "}
              route and follow that route&apos;s authentication requirements.
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

        <details className="group border border-border bg-background" data-testid="details-mcp-prompts-faq">
          <summary className="cursor-pointer list-none px-4 py-3 font-mono text-sm font-bold uppercase tracking-wide focus:outline-none focus:ring-2 focus:ring-primary focus:ring-inset">
            <span className="flex items-center justify-between gap-3">
              What can I ask Claude?
              <span className="text-lg leading-none text-muted-foreground transition-transform group-open:rotate-45">
                +
              </span>
            </span>
          </summary>
          <div className="space-y-4 border-t border-border px-4 py-4 text-sm leading-relaxed text-muted-foreground">
            <p>
              These are good starting prompts. Include a season when you want a
              historical answer instead of the active season:
            </p>
            <ul className="list-disc space-y-2 pl-5 text-xs">
              <li>
                <code className="font-mono text-foreground">
                  Show the current owners, auction cost, wins, and realized return for the Seattle Seahawks in 2026.
                </code>
              </li>
              <li>
                <code className="font-mono text-foreground">
                  Compare signed realized returns by consortium for the 2025 and 2026 Calcuttas.
                </code>
              </li>
              <li>
                <code className="font-mono text-foreground">
                  Show the mark-to-market value and return for the 49ers in the current season.
                </code>
              </li>
              <li>
                <code className="font-mono text-foreground">
                  Check trade 123 and summarize its status and audit history.
                </code>
              </li>
              <li>
                <code className="font-mono text-foreground">
                  Prepare a 25% trade of the Seahawks from Alex to Jordan for $100, but do not approve it.
                </code>
              </li>
            </ul>
            <p className="border-l-2 border-primary pl-3 text-xs font-medium text-foreground">
              Creating a trade leaves it pending for review. Other changes may be
              restricted depending on the action.
            </p>
          </div>
        </details>
      </section>
    </div>
  );
}