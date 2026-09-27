# Calcutta Listener

The website owns the auction, randomized nominations, consortium roster, ownership rules and accepted results. The desktop captures speech, prepares a result, flags uncertainty and submits validated results to that website. It never nominates lots or treats a local draft as an official sale.

## Interface

- Start / Stop listening and a compact connection indicator.
- Active lot: blank while stopped, disconnected or no lot is nominated; updates and briefly highlights each new website nomination.
- What we heard: final and partial speech, followed by Results.
- Results: active lot highlighted; uncertain winner, percentage or amount cells marked red with “Needs a look.” Correct the row using the website roster and Submit, or dismiss an unsent review. Beginning an edit holds it for manual submission; later speech cannot silently submit that draft.
- Pending delivery is distinct from Saved on website. Accepted results are read back from the website, including subsequent commissioner corrections. Correct already accepted sales in the website.

The rehearsal dashboard, statistics, spoken nominations, practice form, local lot editing, export/reset and duplicate browser-board controls are removed from the live interface and local HTTP routes. Historical rehearsal files remain untouched. The old store/grammar tests remain as regression fixtures; the store still tracks recording upload lifecycle, not official results.

## Speech

Examples (use consortium names or explicit aliases from the website):

- “Sold to Alpha for five hundred dollars.”
- “Chiefs sold to Alpha and Bravo, fifty-fifty, for $500.”
- “Sold to Alpha 60 percent and Bravo 40 percent for $500.”

Only finalized explicit sale announcements can submit automatically. Ordinary bids and countdowns do not sell lots. Unknown or ambiguous names, missing splits, malformed amounts, corrections and uncertain lot timing require review. A phrase can span consecutive final fragments from the same speaker within eight seconds. Recognition remains a bounded grammar, not unrestricted language-model interpretation. Numeric unequal percentages are supported; unsupported wording stays in review.

The desktop uses recording-relative word timestamps and observed nomination history to retain the original lot. Speech without reliable timing, near a nomination transition, after reconnect, or across a lot change requires review. Server-side nomination IDs independently prevent applying an old result to a new nomination. The desktop clock/timestamp mapping still needs a real Recall capture check before live use.

## API and persistence

- `GET /api/listener/sessions/:id/context`: authenticated auction snapshot, roster, lots and official results; `protocolVersion: 2`.
- `POST /api/listener/sessions/:id/results`: auction-scoped result with UUID `idempotencyKey`, lot ID, nomination UUID, integer `totalCents`, and allocations of `{consortiumId, basisPoints}` totaling 10000.
- Context polls every two seconds. Heartbeats run independently every ten seconds. The existing website auction query refreshes every three seconds.
- Website sales reuse the same finalization transaction as commissioner sales, including consortium-owner expansion, trade/historical ownership protections and positive allocation checks. Existing auction events store the submission fingerprint and receipt; no new migration is introduced by this change.
- Local drafts and transcript deduplication persist in `.local/live-auction.json`. On switching, each auction is saved separately in a hashed `.auction.json` file keyed by website origin and auction ID. Returning restores that auction; a new auction starts blank. Legacy state migrates only when its session matches the authenticated connection. Unknown delivery outcomes retain the same immutable request ID for retry. Only an explicit receipt marks a result saved. Deterministic conflicts return to review; network failures remain pending.
- Do not switch auctions with unresolved results or pending transcripts. Reopening the same auction renews the existing non-revoked, stopped session, including an expired session, preserving its credentials and receipt namespace. Revoked credentials or a server-side recording flag still require recovery; preserve local files and verify official results. Never clear a queue simply to reconnect.
- `POST /api/listener/preview` validates a short-lived launch ticket and returns the destination without consuming it. Switching from another auction shows its name and ID before pairing. Listening remains off.
- `POST /api/listener/pair` accepts an optional prior session credential for same-device, same-auction resumption; it never transfers that credential to another auction. The production implementation is in `artifacts/api-server/src/lib/listenerTickets.ts`; `hosted/tickets.mjs` remains the legacy integration example.

## Running

Node 22+ and the existing Electron/Recall desktop dependencies are required. From this directory, install desktop dependencies with `npm install --prefix desktop`, configure `.local/backend-config.json` privately, then run `npm start`. Use the existing `node launch.mjs --register-protocol` action only if Windows protocol registration needs installation or repair.

Example private configuration: `{"RECALL_REGION":"us-west-2","RECALL_API_KEY":"YOUR_PRIVATE_KEY"}`. Never commit this file or print credentials. Packaged installations use private Electron user data instead of the development `.local` folder.

The deployed website must include the context, results, preview and updated pairing routes, its existing listener/auction/consortium migrations, a valid `LISTENER_PUBLIC_ORIGIN`, and a valid stable `SESSION_SECRET`. Pair from an open website auction. An older website is detected and recording remains disabled. Recording begins only on explicit Start listening and sends microphone/system audio to Recall according to that workspace's retention settings.

## Validation

Install repository dependencies using the root lockfile first (the UI test uses the root jsdom dev dependency).

```
node --test addons/auction-listener/test/*.test.mjs
node addons/auction-listener/test/smoke.mjs
pnpm --filter @workspace/api-server exec tsx --test src/lib/listenerSale.test.mjs
pnpm run typecheck:libs
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/api-server run build
```

The sale tests use injected in-memory PostgreSQL (PGlite); no production database is used. They exercise actual transactions, consortium expansion, duplicate retries and rollback. Schema fixtures cover the tables used by the transaction; these are not production migration tests. On restricted Windows runners, use Node's `--test-isolation=none` and a matching local esbuild executable, since the repository excludes Windows esbuild binaries.

Before live use, separately verify deployed configuration, Windows ticket launch, pairing, nomination updates and one explicitly authorized recording in a test auction. Local simulations do not establish microphone permissions, Recall key validity or production connectivity.
