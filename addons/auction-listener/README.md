# Calcutta Listener — v0, first rehearsal checkpoint

This is an executable **local rehearsal**, not the finished production website integration.
It captures microphone and computer audio through Recall's Desktop SDK, receives live
transcripts, recognizes a deliberately limited auction grammar, and updates a local web
board automatically. The commissioner can edit prices and ownership. No live Calcutta
records are written, and nothing is published.

## Run on Windows

Node 22+ is required (tested with Node 24). From this directory:

1. Install desktop dependencies: `npm install --prefix desktop`.
2. Allow the official Electron install script and Recall SDK setup script to install
   their native components if your npm installation blocks lifecycle scripts. The
   scripts are `desktop/node_modules/electron/install.js` and
   `desktop/node_modules/@recallai/desktop-sdk/setup.js`; run each from its own directory.
3. Configure the **separate backend** using `.local/backend-config.json` (gitignored):
   `{"RECALL_REGION":"us-west-2","RECALL_API_KEY":"YOUR_PRIVATE_KEY"}`.
   Runtime environment variables with these names override the file. Never include
   this file in a desktop package, archive, or commit. Don't paste real keys in chat.
4. Run `npm start`. The launcher starts the backend on `127.0.0.1:43127` and opens
   the Electron window. Recording only begins after the user clicks Start listening.

The current user's setup has already installed the dependencies and securely configured
a purpose-specific key for Recall workspace `90a803a2-686d-4b25-a9fb-0f3ea7e00fc0`
(Aleph), region `us-west-2`. Credentials exist only in private backend storage.

## First spoken check

Click **Start listening** and wait for **Listening**. Say these with a short pause between:

1. “Next up, Chiefs.”
2. “Sold to Craig for five hundred dollars.”
3. “Next up, Bills.”

Expect a Chiefs row for $500 owned by Craig and Bills on the block. Then click **Stop**.
Try a second sale with “Bills sold to Craig and Dave, fifty-fifty, for two hundred
dollars.” Use Edit to correct a price or a name. Speech cannot overwrite an existing row.

Use **Start a fresh rehearsal** to archive practice results. The default NFL lots are
sample inventory; enter the real known lots and their aliases before testing another sport.
To test Zoom/Discord, run a call on this same computer and keep the same default audio
devices selected. Test headphones and remote speakers explicitly before a real auction.

## Supported behavior and limits

- Exact known lot names or explicit aliases; nomination order is unrestricted.
- Explicit “sold to [owner(s)] for [price]”, with a nominated or explicitly named lot.
- Unknown names create rehearsal owners automatically; no account needed.
- Numeric amounts and standard English whole-dollar amounts. Ambiguous shorthand
  such as “five fifty” is rejected.
- “and”, comma-separated buyers, “fifty-fifty”, “equally”, and “equal shares”.
  Unequal percentages can be entered in the editor. Unspecified shares remain unresolved.
- Partial transcripts appear on screen but never commit a sale. A sale may span two
  consecutive finalized fragments from the same speaker within eight seconds.
- Durable result/correction history, duplicate protection, rejected late transcripts,
  and a desktop outbox for temporary local delivery failures.
- Recognition is Recall AI plus a bounded rule-based auction interpreter. There is
  no general language-model reasoning and no guarantee of recognizing arbitrary speech.
- Any speaker can use the supported commands in this rehearsal. Auctioneer-only
  authorization/filtering, robust owner identity reconciliation, and arbitrary verbal
  corrections are not implemented. Do not use this version as authoritative live results.
- No sub-second guarantee. Typed rehearsal tests interpretation, not microphone,
  cloud transcription, speaker attribution, or end-to-end latency.

## Architecture and secrets

`launch.mjs` starts a separate Node backend and the desktop client. Only the backend
loads the Recall API key. It creates a Desktop SDK upload and returns its limited upload
token to Electron's main process. The renderer has no Node access or API key.
The SDK's `desktop_sdk_callback` events enter `/api/transcript` with a random local
authorization token. Both live events and clearly labeled typed fixtures use
`AuctionStore.ingest`. JSON state is saved by replacement before broadcasting SSE.
The backend binds only to loopback, checks Host/Origin, and authenticates all data routes.

Local state, transcripts, outbox and archived rehearsals remain under `.local/` until
removed by the user. Recall also receives/stores the audio under workspace retention
settings; this is not an offline or zero-retention recorder. Recording is audio-only.

The packaging entry point is `desktop/package.mjs`; native helpers remain unpacked,
and macOS microphone/system-audio usage descriptions are included. Windows is the
only platform selected for this milestone. A signed cross-platform distribution is
not completed or tested. The desktop package always needs a separately configured backend.

## Upload lifecycle and webhooks

Live transcription uses authenticated callbacks forwarded by Electron. A public
webhook URL is not needed for this local checkpoint and none has been registered.
After stopping, the desktop periodically asks the backend to retrieve upload status.
Both `sdk_upload.complete` and `sdk_upload.failed` are supported in the durable store.
The optional `/api/recall/webhook` handler verifies the original payload with the
backend's `RECALL_WEBHOOK_VERIFICATION_SECRET` and rejects expired signatures.
For hosting, register a stable HTTPS URL, confirm the correct workspace signing secret,
and prove an actual verified delivery before calling webhook setup complete.

Calendar scheduling is deliberately deferred: this user starts an in-person or
desktop auction manually. The existing repository's calendar routes describe sports
schedules, not connected meeting calendars. If meeting calendar scheduling is requested,
the next step is to inspect Recall Calendar V2 setup status, choose Google or Microsoft,
complete that provider's authorization, and implement the user's recording opt-in rule.

## Validation

- `node --test --test-isolation=none test/listener.test.mjs`
- `node test/smoke.mjs`

The second command starts the actual backend on a temporary loopback port and tests the
page and auction transitions through HTTP. Tests use synthetic credentials and payloads;
they do not record the user or call Recall. On this machine, the user also started
two live recordings: both reached complete and six finalized transcript events arrived
at the application. Those phrases named MLB teams while the starter inventory was NFL;
no sale was created. A successful spoken nomination/sale with matching lots and measured
end-to-end latency remains to be verified.

## Next checkpoint: thecalcutta.app integration

After the spoken check, add a dedicated, authenticated session/event endpoint to the
existing Express app, tied to an explicitly selected Calcutta and its existing lot IDs.
Do not send incremental results through the existing 32-team bulk import endpoint.
Use the shared season transaction advisory lock, exact persisted share totals,
idempotent event IDs, optimistic correction versions, and immutable approved trades.
Resolve/create bidder identities within that transaction. Push updates to all connected
viewers and preserve actual sale order. Test against an isolated development database.

Verify Replit's current Git revision and supported handoff before transferring the
reviewed branch. The source currently lives on local branch `feature/auction-listener-v0`.
No Replit Agent implementation requests, pushes, merges, deployments or production
database writes have been performed. Publishing remains a separate approval step.

Recall references: [Desktop SDK](https://docs.recall.ai/docs/desktop-sdk),
[in-person capture](https://docs.recall.ai/docs/adhoc-meetings-in-person-meetings),
[real-time transcription](https://docs.recall.ai/docs/dsdk-realtime-transcription),
[upload lifecycle](https://docs.recall.ai/docs/desktop-recording-sdk-webhooks).
