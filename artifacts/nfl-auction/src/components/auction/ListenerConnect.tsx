import { useEffect, useRef, useState } from "react";

type ListenerState = {
  connected?: boolean;
  recording?: boolean;
  pending?: number;
  lastSeenAt?: string | null;
};

export type ListenerTranscript = {
  id: string | number;
  text: string;
  partial?: boolean;
  receivedAt?: string;
};

type ViewerState = ListenerState & {
  transcripts?: ListenerTranscript[];
};

function listenerStatus(state: ListenerState | null, unavailable: boolean) {
  if (unavailable) return "Listener status unavailable";
  if (!state?.connected) return "Listener not connected";
  return state.recording ? "Recording" : "Listener connected";
}

/** Admin-only listener pairing controls. The admin key never enters a URL. */
export function ListenerConnect({ auctionId, adminKey }: { auctionId: string | number; adminKey: string }) {
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [state, setState] = useState<ListenerState | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const version = ++generation.current;
    setLink(null);
    setState(null);
    setError("");
    setBusy(false);
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/listener/status?auctionId=${encodeURIComponent(String(auctionId))}`, {
          headers: { Authorization: `Bearer ${adminKey}` },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Listener status unavailable");
        const next = (await response.json()) as ListenerState;
        if (generation.current === version) {
          setState(next);
          setUnavailable(false);
        }
      } catch {
        if (generation.current === version) setUnavailable(true);
      }
      if (!controller.signal.aborted) timeout = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      generation.current++;
      controller.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, [auctionId, adminKey]);

  async function openListener() {
    const version = generation.current;
    setBusy(true);
    setError("");
    setLink(null);
    try {
      const response = await fetch("/api/listener/tickets", {
        method: "POST",
        headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ auctionId }),
        cache: "no-store",
      });
      if (!response.ok) throw new Error(response.status === 503
        ? "Listener connections are not configured on this website yet."
        : response.status === 401 || response.status === 403
        ? "Sign in as commissioner again to connect the listener."
        : "Could not connect. Confirm this auction is open and try again.");
      const result = (await response.json()) as { launchUrl?: string };
      if (!result.launchUrl) throw new Error("Listener did not return a launch link.");
      const parsed = new URL(result.launchUrl);
      if (parsed.protocol !== "calcutta-listener:" || parsed.hostname !== "connect" || parsed.search || !parsed.hash) {
        throw new Error("Invalid listener link.");
      }
       if (generation.current === version) {
         setLink(result.launchUrl);
         // A browser may block protocol navigation after an asynchronous request.
         // Keep the explicit anchor below for that case, but try the one-click path.
         window.location.assign(result.launchUrl);
       }
    } catch (cause) {
      if (generation.current === version) setError(cause instanceof Error ? cause.message : "Could not open listener.");
    } finally {
      if (generation.current === version) setBusy(false);
    }
  }

  return (
    <section className="rounded-md border border-border bg-card p-4 space-y-2" aria-label="Auction listener">
      <h3 className="font-semibold">Calcutta Listener</h3>
      <p className="text-sm text-muted-foreground">Connect to auction #{auctionId}. Saved listener history stays with this auction when you return.</p>
      <p role="status">{listenerStatus(state, unavailable)}</p>
      {state && <p className="text-xs text-muted-foreground">Pending deliveries: {state.pending ?? 0}</p>}
      <button type="button" onClick={() => void openListener()} disabled={busy} className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">
         {busy ? "Connecting…" : "Open Calcutta Listener"}
      </button>
      {link && (
        <p className="text-sm text-muted-foreground">
          If nothing opened,{" "}
          <a href={link} rel="noreferrer" className="underline">
            click here to open the listener
          </a>
          . Allow your browser to open Calcutta Listener. Links expire after 90 seconds.
        </p>
      )}
      <p className="text-sm text-muted-foreground">Recording starts only when you click Start listening in the listener window.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </section>
  );
}

/** Read-only public transcript fallback; bounded to the latest 100 entries. */
export function ListenerTranscript({ auctionId }: { auctionId: string | number }) {
  const [view, setView] = useState<ViewerState | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/listener/auction-view?auctionId=${encodeURIComponent(String(auctionId))}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Transcript unavailable");
        setView((await response.json()) as ViewerState);
        setUnavailable(false);
      } catch {
        if (!controller.signal.aborted) setUnavailable(true);
      }
      if (!controller.signal.aborted) timeout = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      controller.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, [auctionId]);

  const entries = (view?.transcripts ?? []).slice(-100);
  return (
    <div className="p-4 bg-black/5 dark:bg-white/5 font-mono text-xs text-muted-foreground space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{listenerStatus(view, unavailable)}</span>
        <span className="opacity-70">polling ~3s</span>
      </div>
       {view?.lastSeenAt && <p className="opacity-70">Last seen: {new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(view.lastSeenAt))} ET</p>}
      <div className="max-h-40 overflow-y-auto space-y-1" aria-live="polite">
        {entries.length ? entries.map((entry) => (
          <p key={String(entry.id)} className={entry.partial ? "opacity-70 italic" : ""}>
            {entry.text}
            {entry.partial ? " (interim)" : ""}
          </p>
        )) : <p>{view?.connected ? "Waiting for transcript…" : "No listener transcript available."}</p>}
      </div>
    </div>
  );
}
