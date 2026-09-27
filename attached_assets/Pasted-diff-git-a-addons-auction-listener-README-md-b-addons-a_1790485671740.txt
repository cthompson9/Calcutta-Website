diff --git a/addons/auction-listener/README.md b/addons/auction-listener/README.md
index ac71deb..1debb3d 100644
--- a/addons/auction-listener/README.md
+++ b/addons/auction-listener/README.md
@@ -1,134 +1,61 @@
-# Calcutta Listener — v0, first rehearsal checkpoint
-
-This is an executable **local rehearsal**, not the finished production website integration.
-It captures microphone and computer audio through Recall's Desktop SDK, receives live
-transcripts, recognizes a deliberately limited auction grammar, and updates a local web
-board automatically. The commissioner can edit prices and ownership. No live Calcutta
-records are written, and nothing is published.
-
-## Run on Windows
-
-Node 22+ is required (tested with Node 24). From this directory:
-
-1. Install desktop dependencies: `npm install --prefix desktop`.
-2. Allow the official Electron install script and Recall SDK setup script to install
-   their native components if your npm installation blocks lifecycle scripts. The
-   scripts are `desktop/node_modules/electron/install.js` and
-   `desktop/node_modules/@recallai/desktop-sdk/setup.js`; run each from its own directory.
-3. Configure the **separate backend** using `.local/backend-config.json` (gitignored):
-   `{"RECALL_REGION":"us-west-2","RECALL_API_KEY":"YOUR_PRIVATE_KEY"}`.
-   Runtime environment variables with these names override the file. Never include
-   this file in a desktop package, archive, or commit. Don't paste real keys in chat.
-4. Run `npm start`. The launcher starts the backend on `127.0.0.1:43127` and opens
-   the Electron window. Recording only begins after the user clicks Start listening.
-
-The current user's setup has already installed the dependencies and securely configured
-a purpose-specific key for Recall workspace `90a803a2-686d-4b25-a9fb-0f3ea7e00fc0`
-(Aleph), region `us-west-2`. Credentials exist only in private backend storage.
-
-## First spoken check
-
-Click **Start listening** and wait for **Listening**. Say these with a short pause between:
-
-1. “Next up, Chiefs.”
-2. “Sold to Craig for five hundred dollars.”
-3. “Next up, Bills.”
-
-Expect a Chiefs row for $500 owned by Craig and Bills on the block. Then click **Stop**.
-Try a second sale with “Bills sold to Craig and Dave, fifty-fifty, for two hundred
-dollars.” Use Edit to correct a price or a name. Speech cannot overwrite an existing row.
-
-Use **Start a fresh rehearsal** to archive practice results. The default NFL lots are
-sample inventory; enter the real known lots and their aliases before testing another sport.
-To test Zoom/Discord, run a call on this same computer and keep the same default audio
-devices selected. Test headphones and remote speakers explicitly before a real auction.
-
-## Supported behavior and limits
-
-- Exact known lot names or explicit aliases; nomination order is unrestricted.
-- Explicit “sold to [owner(s)] for [price]”, with a nominated or explicitly named lot.
-- Unknown names create rehearsal owners automatically; no account needed.
-- Numeric amounts and standard English whole-dollar amounts. Ambiguous shorthand
-  such as “five fifty” is rejected.
-- “and”, comma-separated buyers, “fifty-fifty”, “equally”, and “equal shares”.
-  Unequal percentages can be entered in the editor. Unspecified shares remain unresolved.
-- Partial transcripts appear on screen but never commit a sale. A sale may span two
-  consecutive finalized fragments from the same speaker within eight seconds.
-- Durable result/correction history, duplicate protection, rejected late transcripts,
-  and a desktop outbox for temporary local delivery failures.
-- Recognition is Recall AI plus a bounded rule-based auction interpreter. There is
-  no general language-model reasoning and no guarantee of recognizing arbitrary speech.
-- Any speaker can use the supported commands in this rehearsal. Auctioneer-only
-  authorization/filtering, robust owner identity reconciliation, and arbitrary verbal
-  corrections are not implemented. Do not use this version as authoritative live results.
-- No sub-second guarantee. Typed rehearsal tests interpretation, not microphone,
-  cloud transcription, speaker attribution, or end-to-end latency.
-
-## Architecture and secrets
-
-`launch.mjs` starts a separate Node backend and the desktop client. Only the backend
-loads the Recall API key. It creates a Desktop SDK upload and returns its limited upload
-token to Electron's main process. The renderer has no Node access or API key.
-The SDK's `desktop_sdk_callback` events enter `/api/transcript` with a random local
-authorization token. Both live events and clearly labeled typed fixtures use
-`AuctionStore.ingest`. JSON state is saved by replacement before broadcasting SSE.
-The backend binds only to loopback, checks Host/Origin, and authenticates all data routes.
-
-Local state, transcripts, outbox and archived rehearsals remain under `.local/` until
-removed by the user. Recall also receives/stores the audio under workspace retention
-settings; this is not an offline or zero-retention recorder. Recording is audio-only.
-
-The packaging entry point is `desktop/package.mjs`; native helpers remain unpacked,
-and macOS microphone/system-audio usage descriptions are included. Windows is the
-only platform selected for this milestone. A signed cross-platform distribution is
-not completed or tested. The desktop package always needs a separately configured backend.
-
-## Upload lifecycle and webhooks
-
-Live transcription uses authenticated callbacks forwarded by Electron. A public
-webhook URL is not needed for this local checkpoint and none has been registered.
-After stopping, the desktop periodically asks the backend to retrieve upload status.
-Both `sdk_upload.complete` and `sdk_upload.failed` are supported in the durable store.
-The optional `/api/recall/webhook` handler verifies the original payload with the
-backend's `RECALL_WEBHOOK_VERIFICATION_SECRET` and rejects expired signatures.
-For hosting, register a stable HTTPS URL, confirm the correct workspace signing secret,
-and prove an actual verified delivery before calling webhook setup complete.
-
-Calendar scheduling is deliberately deferred: this user starts an in-person or
-desktop auction manually. The existing repository's calendar routes describe sports
-schedules, not connected meeting calendars. If meeting calendar scheduling is requested,
-the next step is to inspect Recall Calendar V2 setup status, choose Google or Microsoft,
-complete that provider's authorization, and implement the user's recording opt-in rule.
+# Calcutta Listener
+
+The website owns the auction, randomized nominations, consortium roster, ownership rules and accepted results. The desktop captures speech, prepares a result, flags uncertainty and submits validated results to that website. It never nominates lots or treats a local draft as an official sale.
+
+## Interface
+
+- Start / Stop listening and a compact connection indicator.
+- Active lot: blank while stopped, disconnected or no lot is nominated; updates and briefly highlights each new website nomination.
+- What we heard: final and partial speech, followed by Results.
+- Results: active lot highlighted; uncertain winner, percentage or amount cells marked red with “Needs a look.” Correct the row using the website roster and Submit, or dismiss an unsent review. Beginning an edit holds it for manual submission; later speech cannot silently submit that draft.
+- Pending delivery is distinct from Saved on website. Accepted results are read back from the website, including subsequent commissioner corrections. Correct already accepted sales in the website.
+
+The rehearsal dashboard, statistics, spoken nominations, practice form, local lot editing, export/reset and duplicate browser-board controls are removed from the live interface and local HTTP routes. Historical rehearsal files remain untouched. The old store/grammar tests remain as regression fixtures; the store still tracks recording upload lifecycle, not official results.
+
+## Speech
+
+Examples (use consortium names or explicit aliases from the website):
+
+- “Sold to Alpha for five hundred dollars.”
+- “Chiefs sold to Alpha and Bravo, fifty-fifty, for $500.”
+- “Sold to Alpha 60 percent and Bravo 40 percent for $500.”
+
+Only finalized explicit sale announcements can submit automatically. Ordinary bids and countdowns do not sell lots. Unknown or ambiguous names, missing splits, malformed amounts, corrections and uncertain lot timing require review. A phrase can span consecutive final fragments from the same speaker within eight seconds. Recognition remains a bounded grammar, not unrestricted language-model interpretation. Numeric unequal percentages are supported; unsupported wording stays in review.
+
+The desktop uses recording-relative word timestamps and observed nomination history to retain the original lot. Speech without reliable timing, near a nomination transition, after reconnect, or across a lot change requires review. Server-side nomination IDs independently prevent applying an old result to a new nomination. The desktop clock/timestamp mapping still needs a real Recall capture check before live use.
+
+## API and persistence
+
+- `GET /api/listener/sessions/:id/context`: authenticated auction snapshot, roster, lots and official results; `protocolVersion: 2`.
+- `POST /api/listener/sessions/:id/results`: auction-scoped result with UUID `idempotencyKey`, lot ID, nomination UUID, integer `totalCents`, and allocations of `{consortiumId, basisPoints}` totaling 10000.
+- Context polls every two seconds. Heartbeats run independently every ten seconds. The existing website auction query refreshes every three seconds.
+- Website sales reuse the same finalization transaction as commissioner sales, including consortium-owner expansion, trade/historical ownership protections and positive allocation checks. Existing auction events store the submission fingerprint and receipt; no new migration is introduced by this change.
+- Local drafts and transcript deduplication persist in `.local/live-auction.json`. On switching, each auction is saved separately in a hashed `.auction.json` file keyed by website origin and auction ID. Returning restores that auction; a new auction starts blank. Legacy state migrates only when its session matches the authenticated connection. Unknown delivery outcomes retain the same immutable request ID for retry. Only an explicit receipt marks a result saved. Deterministic conflicts return to review; network failures remain pending.
+- Do not switch auctions with unresolved results or pending transcripts. Reopening the same auction renews the existing non-revoked, stopped session, including an expired session, preserving its credentials and receipt namespace. Revoked credentials or a server-side recording flag still require recovery; preserve local files and verify official results. Never clear a queue simply to reconnect.
+- `POST /api/listener/preview` validates a short-lived launch ticket and returns the destination without consuming it. Switching from another auction shows its name and ID before pairing. Listening remains off.
+- `POST /api/listener/pair` accepts an optional prior session credential for same-device, same-auction resumption; it never transfers that credential to another auction. The production implementation is in `artifacts/api-server/src/lib/listenerTickets.ts`; `hosted/tickets.mjs` remains the legacy integration example.
+
+## Running
+
+Node 22+ and the existing Electron/Recall desktop dependencies are required. From this directory, install desktop dependencies with `npm install --prefix desktop`, configure `.local/backend-config.json` privately, then run `npm start`. Use the existing `node launch.mjs --register-protocol` action only if Windows protocol registration needs installation or repair.
+
+Example private configuration: `{"RECALL_REGION":"us-west-2","RECALL_API_KEY":"YOUR_PRIVATE_KEY"}`. Never commit this file or print credentials. Packaged installations use private Electron user data instead of the development `.local` folder.
+
+The deployed website must include the context, results, preview and updated pairing routes, its existing listener/auction/consortium migrations, a valid `LISTENER_PUBLIC_ORIGIN`, and a valid stable `SESSION_SECRET`. Pair from an open website auction. An older website is detected and recording remains disabled. Recording begins only on explicit Start listening and sends microphone/system audio to Recall according to that workspace's retention settings.
 
 ## Validation
 
-- `node --test --test-isolation=none test/listener.test.mjs`
-- `node test/smoke.mjs`
-
-The second command starts the actual backend on a temporary loopback port and tests the
-page and auction transitions through HTTP. Tests use synthetic credentials and payloads;
-they do not record the user or call Recall. On this machine, the user also started
-two live recordings: both reached complete and six finalized transcript events arrived
-at the application. Those phrases named MLB teams while the starter inventory was NFL;
-no sale was created. A successful spoken nomination/sale with matching lots and measured
-end-to-end latency remains to be verified.
-
-## Next checkpoint: thecalcutta.app integration
-
-After the spoken check, add a dedicated, authenticated session/event endpoint to the
-existing Express app, tied to an explicitly selected Calcutta and its existing lot IDs.
-Do not send incremental results through the existing 32-team bulk import endpoint.
-Use the shared season transaction advisory lock, exact persisted share totals,
-idempotent event IDs, optimistic correction versions, and immutable approved trades.
-Resolve/create bidder identities within that transaction. Push updates to all connected
-viewers and preserve actual sale order. Test against an isolated development database.
-
-Verify Replit's current Git revision and supported handoff before transferring the
-reviewed branch. The source currently lives on local branch `feature/auction-listener-v0`.
-No Replit Agent implementation requests, pushes, merges, deployments or production
-database writes have been performed. Publishing remains a separate approval step.
-
-Recall references: [Desktop SDK](https://docs.recall.ai/docs/desktop-sdk),
-[in-person capture](https://docs.recall.ai/docs/adhoc-meetings-in-person-meetings),
-[real-time transcription](https://docs.recall.ai/docs/dsdk-realtime-transcription),
-[upload lifecycle](https://docs.recall.ai/docs/desktop-recording-sdk-webhooks).
+Install repository dependencies using the root lockfile first (the UI test uses the root jsdom dev dependency).
+
+```
+node --test addons/auction-listener/test/*.test.mjs
+node addons/auction-listener/test/smoke.mjs
+pnpm --filter @workspace/api-server exec tsx --test src/lib/listenerSale.test.mjs
+pnpm run typecheck:libs
+pnpm --filter @workspace/api-server run typecheck
+pnpm --filter @workspace/api-server run build
+```
+
+The sale tests use injected in-memory PostgreSQL (PGlite); no production database is used. They exercise actual transactions, consortium expansion, duplicate retries and rollback. Schema fixtures cover the tables used by the transaction; these are not production migration tests. On restricted Windows runners, use Node's `--test-isolation=none` and a matching local esbuild executable, since the repository excludes Windows esbuild binaries.
+
+Before live use, separately verify deployed configuration, Windows ticket launch, pairing, nomination updates and one explicitly authorized recording in a test auction. Local simulations do not establish microphone permissions, Recall key validity or production connectivity.
diff --git a/addons/auction-listener/desktop/controller.cjs b/addons/auction-listener/desktop/controller.cjs
index cd6d454..15affd6 100644
--- a/addons/auction-listener/desktop/controller.cjs
+++ b/addons/auction-listener/desktop/controller.cjs
@@ -15,7 +15,7 @@ class CaptureController {
   constructor({sdk,api,apiUrl,platform=process.platform,openSettings,onState=()=>{},readQueue=()=>[],writeQueue=()=>{}}) {
     Object.assign(this,{sdk,api,apiUrl,platform,openSettings,onState,writeQueue});
     this.queue=readQueue();this.windows=new Map();this.permissions={};this.active=null;this.busy=false;this.initialized=false;this.sending=false;
-    this.state={status:'idle',message:'Ready for a rehearsal.'};
+    this.state={status:'idle',message:'Open an auction on the website to connect.'};
   }
   update(status,message,extra={}) {this.state={status,message,recording:!!this.active,...extra};this.onState(this.state);}
   async init() {
@@ -25,7 +25,7 @@ class CaptureController {
       const recording=this.windows.get(e.window?.id); if(!recording) return;
       try {
         const event=transcriptPayload(e);if(!event) return;
-        this.queue.push({id:randomUUID(),sessionId:recording.sessionId,uploadId:recording.id,websiteSessionId:recording.websiteSessionId,event});
+        this.queue.push({id:randomUUID(),sessionId:recording.sessionId,uploadId:recording.id,websiteSessionId:recording.websiteSessionId,captureStartedAt:recording.captureStartedAt,event});
         this.writeQueue(this.queue);void this.flush();
       } catch {this.update('error','A transcript could not be read or saved. Stop and check the listener.');}
     });
@@ -65,7 +65,7 @@ class CaptureController {
       }
       const windowId=await this.sdk.prepareDesktopAudioRecording();
       upload=await this.api('/api/uploads',{});
-      const recording={id:upload.id,sessionId:upload.sessionId,websiteSessionId:upload.websiteSessionId,windowId};
+      const recording={id:upload.id,sessionId:upload.sessionId,websiteSessionId:upload.websiteSessionId,windowId,captureStartedAt:Date.now()};
       this.windows.set(windowId,recording);
       await this.sdk.startRecording({windowId,uploadToken:upload.uploadToken});
       this.active=recording;
diff --git a/addons/auction-listener/desktop/main.cjs b/addons/auction-listener/desktop/main.cjs
index ebf829d..dc05f8f 100644
--- a/addons/auction-listener/desktop/main.cjs
+++ b/addons/auction-listener/desktop/main.cjs
@@ -9,7 +9,8 @@ trace('desktop-module-loaded');
 const sdk=require('@recallai/desktop-sdk');
 const {CaptureController}=require('./controller.cjs');
 if(!app.requestSingleInstanceLock()) app.exit(0);
-let window,controller,closing=false,timer,backend,api,pairing=false;
+let window,controller,closing=false,timer,heartbeatTimer,backend,api,pairing=false;
+let syncing=false,heartbeating=false;
 let pendingLink=findLaunchLink(process.argv);
 async function connectWebsite(raw) {
   if(!raw)return;
@@ -17,10 +18,19 @@ async function connectWebsite(raw) {
   if(pairing)return;
   pairing=true;
   try {
-    if(controller.active || controller.busy || controller.queue.length)throw new Error('Stop recording and deliver pending transcripts before switching auctions.');
+    if(controller.active || controller.busy)throw new Error('Stop recording before connecting to an auction.');
+    const target=await api('/api/website/preview',{url:raw});
+    if(controller.queue.length && !target.sameAuction)throw new Error('Deliver pending transcripts before switching auctions. Reopen the current auction to reconnect.');
+    if(target.current && !target.sameAuction) {
+      const choice=await dialog.showMessageBox(window,{type:'question',title:'Switch auction',
+        message:`Open ${target.auction.name} — Auction #${target.auction.id}?`,
+        detail:`Currently connected to ${target.current.name} — Auction #${target.current.id}. Saved history stays with each auction. Listening will remain off.`,
+        buttons:['Cancel','Switch auction'],defaultId:1,cancelId:0});
+      if(choice.response!==1)return;
+    }
     const state=await api('/api/website/pair',{url:raw});
     window.webContents.send('website:state',state);
-    window.setTitle(`Calcutta Listener — ${state.auction.name}`);
+    window.setTitle(`Calcutta Listener — ${state.auction.name} — Auction #${state.auction.id}`);
   } catch(error) {dialog.showErrorBox('Connect to auction',error.message);}
   finally {pairing=false;}
 }
@@ -53,32 +63,40 @@ app.whenReady().then(async()=>{
     readQueue:()=>existsSync(queuePath)?JSON.parse(readFileSync(queuePath,'utf8')):[],
     writeQueue:queue=>{writeFileSync(`${queuePath}.tmp`,JSON.stringify(queue),{mode:0o600});renameSync(`${queuePath}.tmp`,queuePath);},
   });
-  window=new BrowserWindow({width:1180,height:860,minWidth:760,minHeight:600,title:'Calcutta Listener — Rehearsal',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
+  window=new BrowserWindow({width:1180,height:860,minWidth:760,minHeight:600,title:'Calcutta Listener',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
   trace('window-created');
   window.webContents.on('did-fail-load',(_e,code)=>trace(`page-load-failed-${code}`));
   window.setMenuBarVisibility(false);
   window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
   window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==connection.url)event.preventDefault();});
   const allowed=event=>{if(event.sender!==window.webContents || new URL(event.senderFrame.url).origin!==connection.url)throw new Error('Unauthorized window.');};
-  ipcMain.handle('capture:start',async event=>{allowed(event);await controller.start();return controller.state;});
+  ipcMain.handle('capture:start',async event=>{allowed(event);if(pairing)throw new Error('Finish connecting to the auction first.');const live=await api('/api/live/sync',{});if(!live.ready)throw new Error('Connect to the website before recording.');await controller.start();return controller.state;});
   ipcMain.handle('capture:stop',async event=>{allowed(event);await controller.stop();return controller.state;});
   ipcMain.handle('capture:status',event=>{allowed(event);return controller.state;});
   ipcMain.handle('capture:permissions',async(event,p)=>{allowed(event);await controller.fixPermission(p);});
-  ipcMain.handle('capture:board',async event=>{allowed(event);await shell.openExternal(`${connection.url}/#${connection.token}`);});
   ipcMain.handle('website:status',async event=>{allowed(event);return api('/api/website');});
   await window.loadURL(`${connection.url}/#${connection.token}`);
   trace('page-loaded');
   window.show();
   if(pendingLink){const link=pendingLink;pendingLink=null;await connectWebsite(link);}
   else window.webContents.send('website:state',await api('/api/website'));
+  // Snapshot polling and heartbeats must not wait behind transcript/result delivery.
   timer=setInterval(async()=>{
-    await controller.flush();
+    if(syncing)return; syncing=true;
+    try {await api('/api/live/sync',{});void controller.flush();}
+    catch { /* The local UI reports a failed backend connection. */ }
+    finally {syncing=false;}
+  },2000);
+  heartbeatTimer=setInterval(async()=>{
+    if(heartbeating)return; heartbeating=true;
+    try {
     const website=await api('/api/website/tick',{recording:!!controller.active}).catch(()=>null);
     if(website && window && !window.isDestroyed())window.webContents.send('website:state',website);
     const state=await api('/api/state').catch(()=>null);
     for(const upload of state?.uploads??[]) {
       if(upload.id && ['recording_ended','uploading'].includes(upload.status)) await api('/api/reconcile',{id:upload.id}).catch(()=>{});
     }
+    } finally {heartbeating=false;}
   },10000);
   window.on('close',event=>{
     if(closing)return;
@@ -90,6 +108,7 @@ app.whenReady().then(async()=>{
         await controller.stop();if(controller.active)return;
       }
       clearInterval(timer);
+      clearInterval(heartbeatTimer);
       if(controller.initialized)await sdk.shutdown().catch(()=>{});
       closing=true;window.close();
     })();
diff --git a/addons/auction-listener/desktop/preload.cjs b/addons/auction-listener/desktop/preload.cjs
index 5cb5dd0..bba432b 100644
--- a/addons/auction-listener/desktop/preload.cjs
+++ b/addons/auction-listener/desktop/preload.cjs
@@ -4,7 +4,6 @@ contextBridge.exposeInMainWorld('capture',{
   stop:()=>ipcRenderer.invoke('capture:stop'),
   status:()=>ipcRenderer.invoke('capture:status'),
   permissions:p=>ipcRenderer.invoke('capture:permissions',p),
-  openBoard:()=>ipcRenderer.invoke('capture:board'),
   onStatus:callback=>{ipcRenderer.on('capture:state',(_event,state)=>callback(state));},
   websiteStatus:()=>ipcRenderer.invoke('website:status'),
   onWebsite:callback=>{ipcRenderer.on('website:state',(_event,state)=>callback(state));},
diff --git a/addons/auction-listener/server/bridge.mjs b/addons/auction-listener/server/bridge.mjs
index 08bff30..467fa11 100644
--- a/addons/auction-listener/server/bridge.mjs
+++ b/addons/auction-listener/server/bridge.mjs
@@ -8,7 +8,7 @@ export class WebsiteBridge {
   constructor({file, allowedOrigins=DEFAULT_ORIGINS, fetcher=fetch, now=Date.now}) {
     Object.assign(this, {file, allowedOrigins, fetcher, now});
     this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {pairing:null, queue:[]};
-    this.message = ''; this.sending = false;
+    this.message = ''; this.sending = false; this.lastAck = 0;
   }
   save() {
     writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data), {mode:0o600});
@@ -16,26 +16,53 @@ export class WebsiteBridge {
   }
   status() {
     const p = this.data.pairing;
-    return {connected:!!p && Date.parse(p.expiresAt)>this.now(), auction:p?.auction??null,
+    return {connected:!!p && Date.parse(p.expiresAt)>this.now() && this.lastAck > 0 && this.now()-this.lastAck < 30000, auction:p?.auction??null,
       origin:p?.origin??null, pending:this.data.queue.length, message:this.message};
   }
-  async request(origin, route, body, token) {
+  async request(origin, route, body, token, method='POST') {
     if (!this.allowedOrigins.includes(origin)) throw new Error('Website is not allowed.');
-    const response = await this.fetcher(`${origin}${route}`, {method:'POST',redirect:'error',
+    const response = await this.fetcher(`${origin}${route}`, {method,redirect:'error',
       headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
-      body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
-    if (!response.ok) throw new Error(response.status===401 || response.status===410
-      ? 'Connection expired. Open the listener again from the Auction tab.' : 'Website unavailable. Saved events will retry.');
-    return response.json();
+      ...(method==='GET'?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(12000)});
+    if (!response.ok) {
+      const error=new Error(response.status===401 || response.status===410
+        ? 'Connection expired. Open the listener again from the Auction tab.'
+        : [409,422].includes(response.status) ? 'Website rejected this result. Check the current lot, winners and shares before submitting again.'
+        : response.status===404 ? 'Website needs the listener result update.' : 'Website unavailable. Saved deliveries will retry.');
+      error.status=response.status; throw error;
+    }
+    const result=await response.json(); this.lastAck=this.now(); return result;
+  }
+  async context() {
+    const p=this.data.pairing;
+    if(!p) throw new Error('Open the listener from the website first.');
+    return this.request(p.origin,`/api/listener/sessions/${p.id}/context`,undefined,p.token,'GET');
+  }
+  async submitResult(result) {
+    const p=this.data.pairing;
+    if(!p) throw new Error('Open the listener from the website first.');
+    return this.request(p.origin,`/api/listener/sessions/${p.id}/results`,result,p.token);
+  }
+  async preview(raw) {
+    const {origin,ticket}=parseLaunchLink(raw,this.allowedOrigins);
+    const result=await this.request(origin,'/api/listener/preview',{origin,ticket});
+    if(!Number.isSafeInteger(result.auction?.id) || result.auction.id<=0 || typeof result.auction.name!=='string')
+      throw new Error('Website returned an invalid auction.');
+    const p=this.data.pairing;
+    return {origin,auction:result.auction,sameAuction:!!p && p.origin===origin && String(p.auction.id)===String(result.auction.id)};
   }
-  async pair(raw) {
-    if (this.data.queue.length) throw new Error('Deliver pending transcripts before changing the connected auction.');
+  async pair(raw, {resume=false}={}) {
+    if (this.data.queue.length && !resume) throw new Error('Deliver pending transcripts before changing the connected auction.');
     const {origin,ticket} = parseLaunchLink(raw,this.allowedOrigins);
     // Persist one redemption identity so a lost HTTP response can safely be retried.
     if(this.data.pending?.ticket !== ticket) {
       this.data.pending={origin,ticket,redemptionId:randomUUID()}; this.save();
     }
-    const result=await this.request(origin,'/api/listener/pair',this.data.pending);
+    const previous=this.data.pairing;
+    const result=await this.request(origin,'/api/listener/pair',{...this.data.pending,
+      ...(resume && previous?.origin===origin?{resume:{id:previous.id,token:previous.token}}:{})});
+    if(resume && (result.id!==previous?.id || result.token!==previous?.token))
+      throw new Error('Website did not preserve the existing listener connection. Saved work is unchanged.');
     if(!/^[A-Za-z0-9_-]{43}$/.test(result.token??'') || !/^[A-Za-z0-9_-]{1,80}$/.test(result.id??'') ||
       !result.auction || typeof result.auction.name!=='string' || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt)<=this.now()) {
       throw new Error('Website returned an invalid listener session.');
@@ -67,11 +94,11 @@ export class WebsiteBridge {
     } catch(error) {this.message=error.message;}
     finally {this.sending=false;}
   }
-  async heartbeat(recording=false) {
+  async heartbeat(recording=false, pendingResults=0) {
     if(!this.data.pairing) return;
     const p=this.data.pairing;
     try {
-      await this.request(p.origin,`/api/listener/sessions/${p.id}/heartbeat`,{recording,pending:this.data.queue.length},p.token);
+      await this.request(p.origin,`/api/listener/sessions/${p.id}/heartbeat`,{recording,pending:Math.min(10000,this.data.queue.length+pendingResults)},p.token);
     } catch(error) {this.message=error.message;}
   }
 }
diff --git a/addons/auction-listener/server/http.mjs b/addons/auction-listener/server/http.mjs
index d344519..d278e7f 100644
--- a/addons/auction-listener/server/http.mjs
+++ b/addons/auction-listener/server/http.mjs
@@ -17,8 +17,8 @@ export function verifiedWebhook(raw, headers, secret, now=Date.now()) {
   const sig=createHmac('sha256',key).update(`${id}.${stamp}.${raw}`).digest('base64');
   return String(headers['webhook-signature']??'').split(' ').some(v=>v.startsWith('v1,') && equal(v.slice(3),sig));
 }
-export function createAuctionServer({store,recall,token,bridge}) {
-  let creating=false;
+export function createAuctionServer({store,recall,token,bridge,live}) {
+  let creating=false, pairing=false;
   const server=createServer(async(req,res)=>{
     const origin=`http://${req.headers.host}`;
     res.setHeader('Cache-Control','no-store');
@@ -49,46 +49,51 @@ export function createAuctionServer({store,recall,token,bridge}) {
       if (!equal(bearer,token) && !equal(cookie,token)){json(401,{error:'Open the board from the Calcutta launcher.'});return;}
       if (req.method==='GET' && path==='/api/state') {json(200,{...store.snapshot(),recallConfigured:!!recall.config.apiKey,apiUrl:recall.config.apiUrl});return;}
       if (req.method==='GET' && path==='/api/website') {json(200,bridge?.status()??{connected:false});return;}
-      if (req.method==='GET' && path==='/api/events') {
-        res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive'});
-        const send=s=>res.write(`data: ${JSON.stringify(s)}\n\n`);
-        send(store.snapshot());store.listeners.add(send);
-        const heartbeat=setInterval(()=>res.write(': keepalive\n\n'),15000);
-        req.on('close',()=>{clearInterval(heartbeat);store.listeners.delete(send);});return;
-      }
-      if (req.method==='GET' && path==='/api/export') {
-        res.setHeader('Content-Disposition','attachment; filename="calcutta-rehearsal.json"');
-        json(200,store.snapshot());return;
-      }
+      if (req.method==='GET' && path==='/api/live') {json(200,live?.snapshot()??{});return;}
       if (req.method==='POST') {
         const input=JSON.parse((await body(req))||'{}');
+        if (path==='/api/live/sync') {await live?.sync();json(200,live?.snapshot()??{});return;}
+        if (path==='/api/live/flush') {await live?.flush();json(200,live?.snapshot()??{});return;}
+        if (path==='/api/live/result') {if(!live)throw new Error('Live results unavailable.');live.correct(input);void live.flush();json(200,live.snapshot());return;}
+        if (path==='/api/live/review') {if(!live)throw new Error('Live results unavailable.');json(200,live.beginReview(input));return;}
+        if (path==='/api/live/dismiss') {if(!live)throw new Error('Live results unavailable.');live.dismiss(input.id);json(200,live.snapshot());return;}
+        if(path==='/api/website/preview') {
+          if(!bridge) throw new Error('Website connection is unavailable.');
+          const target=await bridge.preview(input.url);
+          json(200,{...target,current:bridge.status().auction});return;
+        }
         if(path==='/api/website/pair') {
           if(!bridge) throw new Error('Website connection is unavailable.');
+          if(pairing || live?.syncing || live?.sending || bridge.sending) throw new Error('A connection or delivery is in progress. Try again shortly.');
           if(creating || store.state.uploads.some(u=>['ready','recording_started'].includes(u.status))) throw new Error('Stop recording before connecting to an auction.');
-          json(200,await bridge.pair(input.url));return;
+          pairing=true;if(live)live.switching=true;
+          try {
+            const target=await bridge.preview(input.url);
+            if(!target.sameAuction && (live?.hasUnresolved() || bridge.data.queue.length))
+              throw new Error('Resolve or dismiss unsent reviews before switching auctions. Pending deliveries must be acknowledged first.');
+            await bridge.pair(input.url,{resume:target.sameAuction});
+          } finally {pairing=false;if(live)live.switching=false;}
+          await live?.sync(); await bridge.heartbeat(false,live?.data.drafts.filter(d=>!['submitted','dismissed'].includes(d.status)).length??0);json(200,bridge.status());return;
         }
         if(path==='/api/website/tick') {
-          await bridge?.flush();await bridge?.heartbeat(!!input.recording);
+          if(pairing) {json(200,bridge?.status()??{connected:false});return;}
+          await bridge?.heartbeat(!!input.recording,live?.data.drafts.filter(d=>!['submitted','dismissed'].includes(d.status)).length??0);
+          void bridge?.flush(); void live?.flush();
           json(200,bridge?.status()??{connected:false});return;
         }
-        if(path==='/api/session') {
-          if(creating || store.state.uploads.some(u=>['ready','recording_started'].includes(u.status))) throw new Error('Stop recording before starting a new rehearsal.');
-          store.newSession(input.lots);json(200,store.snapshot());return;
-        }
-        if(path==='/api/result') {store.edit(input);json(200,store.snapshot());return;}
         if(path==='/api/transcript') {
+          if(pairing) throw new Error('Wait for the auction connection to finish.');
           if(input.websiteSessionId) {
             if(input.websiteSessionId!==bridge?.data.pairing?.id) throw new Error('Transcript belongs to a different website session.');
+            if(live) {live.ingest(input);void live.flush();}
             bridge.enqueue({...input,receivedAt:new Date().toISOString()});void bridge.flush();
-          } else store.ingest({...input,source:'recall'});
+          } else if(live) throw new Error('Connect this recording to a website auction.');
+          else store.ingest({...input,source:'recall'});
           json(200,{ok:true});return;
         }
-        if(path==='/api/rehearse') {
-          if(typeof input.text!=='string' || input.text.length>20000) throw new Error('Enter a short auction announcement.');
-          store.ingest({sessionId:store.state.id,uploadId:'typed-rehearsal',source:'typed rehearsal',event:{event:'transcript.data',data:{data:{participant:{id:0,name:'Typed rehearsal'},words:[{text:input.text,start_timestamp:{relative:Date.now()/1000}}]}}}});
-          json(200,store.snapshot());return;
-        }
         if(path==='/api/uploads') {
+          if(pairing) throw new Error('Wait for the auction connection to finish.');
+          if(live) {await live.sync();if(!live.ready())throw new Error('Connect to an updated website auction before recording.');}
           if(bridge?.data.pairing && !bridge.status().connected) throw new Error('Open the listener from the Auction tab to reconnect before recording.');
           if(creating || store.state.uploads.some(u=>['ready','recording_started'].includes(u.status))) throw new Error('A recording is already starting or active.');
           if(!recall.config.apiKey) throw new Error('Recall API key has not been configured.');
diff --git a/addons/auction-listener/server/live-auction.mjs b/addons/auction-listener/server/live-auction.mjs
new file mode 100644
index 0000000..098d907
--- /dev/null
+++ b/addons/auction-listener/server/live-auction.mjs
@@ -0,0 +1,510 @@
+import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
+import { randomUUID, createHash } from "node:crypto";
+import { normalize, priceCents } from "./interpreter.mjs";
+
+const match = (text, rows) => {
+  const matches = rows.filter((r) =>
+    [r.displayName, ...(r.aliases ?? [])].some(
+      (n) => normalize(n) === normalize(text),
+    ),
+  );
+  return matches.length === 1 ? matches[0] : null;
+};
+
+export function validateDraft(draft, context) {
+  const issues = {};
+  const lot = context?.lots.find((l) => l.id === draft.lotId);
+  if (
+    !lot ||
+    lot.status !== "bidding" ||
+    lot.nominationId !== draft.nominationId ||
+    context.currentLotId !== lot.id
+  )
+    issues.lot =
+      "The active nomination changed. Review the lot before submitting.";
+  if (
+    !Number.isSafeInteger(draft.totalCents) ||
+    draft.totalCents <= 0 ||
+    draft.totalCents > 100000000
+  )
+    issues.amount = "Enter a final amount between $0.01 and $1,000,000.";
+  const owners = Array.isArray(draft.allocations) ? draft.allocations : [];
+  if (
+    !owners.length ||
+    owners.length > 8 ||
+    owners.some(
+      (a) =>
+        !context?.consortia.some(
+          (c) => c.id === a.consortiumId && c.active === 1,
+        ),
+    ) ||
+    new Set(owners.map((a) => a.consortiumId)).size !== owners.length
+  )
+    issues.owners = "Choose distinct, active consortia from the website.";
+  if (
+    !owners.length ||
+    owners.some(
+      (a) => !Number.isInteger(a.basisPoints) || a.basisPoints <= 0,
+    ) ||
+    owners.reduce((n, a) => n + (a.basisPoints ?? 0), 0) !== 10000
+  )
+    issues.shares = "Ownership percentages must total exactly 100%.";
+  return issues;
+}
+
+export function parseResult(text, context, binding) {
+  const raw = text.trim().replace(/[.!?]+$/, "");
+  if (!/\bsold\b/i.test(raw)) return null;
+  const issues = {};
+  if (
+    /\b(?:not sold|unsold|don't|do not|correction|actually|cancel|wait|hold on|maybe|if|example|would|could)\b/i.test(
+      raw,
+    )
+  )
+    issues.announcement =
+      "Possible correction or conditional announcement. Review before submitting.";
+  const sale = /^(?:(.+?)\s+)?sold\s+to\s+(.+?)(?:\s+for\s+(.+))?$/i.exec(
+    raw
+      .replace(
+        /^(?:going\s+)?once[, .]*\s*(?:(?:going\s+)?twice[, .]*\s*)?/i,
+        "",
+      )
+      .replace(/^twice[, .]*\s*/i, ""),
+  );
+  const lot = context?.lots.find((l) => l.id === binding?.lotId);
+  if (!binding?.safe)
+    issues.lot =
+      "Speech timing does not identify one current nomination. Select and confirm the lot.";
+  if (sale?.[1] && match(sale[1], context?.lots ?? [])?.id !== lot?.id)
+    issues.lot = "The spoken lot differs from the nominated lot. Review it.";
+  const roster = context?.consortia.filter((c) => c.active === 1) ?? [];
+  let owners = sale?.[2]?.replace(/[,;]+$/, "").trim() ?? "";
+  const equal =
+    /(?:,?\s+)(fifty[ -]fifty|50[ /-]50|equally|equal shares)$/i.exec(owners);
+  if (equal) owners = owners.slice(0, equal.index).trim();
+  const whole = match(owners, roster);
+  const pieces = whole
+    ? [owners]
+    : owners.split(/\s+(?:and|&)\s+|\s*,\s*/).filter(Boolean);
+  const allocations = pieces.map((part) => {
+    const percent = /\s+(\d+(?:\.\d{1,2})?)\s*(?:%|percent)$/i.exec(part);
+    const name = percent ? part.slice(0, percent.index).trim() : part;
+    const consortium = match(name, roster);
+    return {
+      consortiumId: consortium?.id ?? null,
+      heardName: name,
+      basisPoints: percent ? Math.round(Number(percent[1]) * 100) : null,
+    };
+  });
+  if (
+    equal &&
+    allocations.length &&
+    !allocations.some((a) => a.basisPoints !== null)
+  ) {
+    if (/fifty|50/i.test(equal[1]) && allocations.length !== 2)
+      issues.shares = "Fifty-fifty requires two winners.";
+    else
+      allocations.forEach((a, i) => {
+        a.basisPoints =
+          Math.floor(10000 / allocations.length) +
+          (i < 10000 % allocations.length ? 1 : 0);
+      });
+  } else if (allocations.length === 1 && allocations[0].basisPoints === null)
+    allocations[0].basisPoints = 10000;
+  const draft = {
+    lotId: lot?.id ?? null,
+    nominationId: binding?.nominationId ?? null,
+    totalCents: sale?.[3] ? priceCents(sale[3]) : null,
+    allocations,
+  };
+  if (!sale)
+    issues.announcement =
+      "Waiting for a complete “sold to [winner] for [amount]” announcement.";
+  return { ...draft, issues: { ...validateDraft(draft, context), ...issues } };
+}
+
+export class LiveAuction {
+  constructor({ file, bridge, now = Date.now }) {
+    Object.assign(this, { file, bridge, now });
+    this.data = existsSync(file)
+      ? JSON.parse(readFileSync(file, "utf8"))
+      : { sessionId: null, drafts: [], transcript: [], seen: [] };
+    this.context = null;
+    this.history = [];
+    this.lastSync = 0;
+    this.syncing = false;
+    this.sending = false;
+    this.error = "";
+    this.pending = null;
+    this.switching = false;
+  }
+  save() {
+    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data), {
+      mode: 0o600,
+    });
+    renameSync(`${this.file}.tmp`, this.file);
+  }
+  hasUnresolved() {
+    return this.data.drafts.some(
+      (d) => d.status !== "submitted" && d.status !== "dismissed",
+    );
+  }
+  ready() {
+    return (
+      !this.switching &&
+      !!this.context &&
+      this.lastSync > 0 &&
+      this.now() - this.lastSync < 6000 &&
+      this.bridge.status().connected
+    );
+  }
+  snapshot() {
+    return {
+      context: this.context,
+      drafts: this.data.drafts,
+      transcript: this.data.transcript,
+      ready: this.ready(),
+      error: this.error,
+      pending: this.data.drafts.filter((d) => d.status === "pending").length,
+      auctionKey: this.data.auctionKey ?? null,
+    };
+  }
+  async sync() {
+    if (this.switching || this.syncing || !this.bridge.data.pairing) return;
+    this.syncing = true;
+    try {
+      const sessionId = this.bridge.data.pairing.id;
+      const context = await this.bridge.context();
+      if (
+        context.protocolVersion !== 2 ||
+        !Array.isArray(context.lots) ||
+        !Array.isArray(context.consortia) ||
+        !Array.isArray(context.sales)
+      )
+        throw new Error(
+          "Website needs the listener result update before recording.",
+        );
+      const pairing = this.bridge.data.pairing;
+      if (!Number.isSafeInteger(context.id) || context.id <= 0 ||
+          String(context.id) !== String(pairing.auction?.id) || !pairing.origin)
+        throw new Error("Website returned a different auction. Reconnect from its Auction tab.");
+      // Origin isolates separate installations even when their database IDs overlap.
+      const auctionKey = createHash("sha256").update(JSON.stringify([pairing.origin, context.id])).digest("hex");
+      const changed = this.data.auctionKey !== auctionKey;
+      const legacySameSession = !this.data.auctionKey && this.data.sessionId === sessionId;
+      if (changed || this.data.sessionId !== sessionId) {
+        if (this.hasUnresolved() && !legacySameSession)
+          throw new Error("Resolve the previous auction results before switching auctions.");
+        if (changed && !legacySameSession) {
+          if (this.data.auctionKey) this.archive();
+          else if (this.data.sessionId) {
+            // Never guess which auction owns a legacy session file.
+            const legacyKey = createHash("sha256").update(this.data.sessionId).digest("hex");
+            writeFileSync(`${this.file}.${legacyKey}.archive.json`, JSON.stringify(this.data), {mode: 0o600});
+          }
+          const saved = `${this.file}.${auctionKey}.auction.json`;
+          this.data = existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) :
+            { drafts: [], transcript: [], seen: [] };
+          if (this.data.auctionKey && this.data.auctionKey !== auctionKey)
+            throw new Error("Saved auction identity does not match.");
+        }
+        Object.assign(this.data, {sessionId, auctionKey});
+        this.history = [];
+        this.context = null;
+        this.pending = null;
+        this.lastSync = 0;
+        this.save();
+      }
+      const lot = context.lots.find(
+        (l) => l.id === context.currentLotId && l.status === "bidding",
+      );
+      const nominationId = lot?.nominationId ?? null;
+      if (
+        !this.history.length ||
+        this.history.at(-1).nominationId !== nominationId ||
+        this.now() - this.lastSync >= 6000
+      ) {
+        this.history.push({
+          at: this.now(),
+          lotId: lot?.id ?? null,
+          nominationId,
+        });
+        this.history = this.history.slice(-500);
+      }
+      this.context = context;
+      this.lastSync = this.now();
+      this.error = "";
+    } catch (error) {
+      this.lastSync = 0;
+      this.error = error.message;
+    } finally {
+      this.syncing = false;
+    }
+  }
+  archive() {
+    const target = `${this.file}.${this.data.auctionKey}.auction.json`;
+    writeFileSync(`${target}.tmp`, JSON.stringify(this.data), {mode: 0o600});
+    renameSync(`${target}.tmp`, target);
+  }
+  ingest(input) {
+    if (this.switching) throw new Error("Wait for the auction connection to finish.");
+    if (input.websiteSessionId !== this.data.sessionId)
+      throw new Error("Transcript belongs to another auction.");
+    const event = input.event;
+    if (!["transcript.data", "transcript.partial_data"].includes(event?.event))
+      throw new Error("Invalid transcript type.");
+    const words = event.data?.data?.words;
+    if (!Array.isArray(words) || words.length > 5000)
+      throw new Error("Invalid transcript.");
+    const text = words
+      .map((w) => (typeof w === "string" ? w : (w.text ?? "")))
+      .join(" ")
+      .trim();
+    if (!text || text.length > 20000) return;
+    const speaker = String(
+      event.data.data.participant?.id ??
+        event.data.data.participant ??
+        "unknown",
+    );
+    const start = words[0]?.start_timestamp?.relative;
+    const end = words.at(-1)?.end_timestamp?.relative ?? start;
+    const key = createHash("sha256")
+      .update(
+        JSON.stringify([
+          input.uploadId,
+          speaker,
+          event.event,
+          start,
+          end,
+          text,
+        ]),
+      )
+      .digest("hex");
+    if (this.data.seen.includes(key)) return;
+    this.data.seen.push(key);
+    const final = event.event === "transcript.data";
+    this.data.transcript = [
+      { id: key, text, final },
+      ...this.data.transcript.filter((t) => t.final),
+    ].slice(0, 100);
+    if (final) {
+      const spokenAt =
+        Number.isFinite(start) && Number.isFinite(input.captureStartedAt)
+          ? input.captureStartedAt + start * 1000
+          : null;
+      const observed =
+        spokenAt === null
+          ? null
+          : this.history.findLast((h) => h.at <= spokenAt);
+      const current = this.history.at(-1);
+      const binding = {
+        ...observed,
+        safe:
+          this.ready() &&
+          !!observed?.nominationId &&
+          observed === current &&
+          spokenAt >= observed.at + 2000 &&
+          spokenAt <= this.now() &&
+          start >= 0 &&
+          end >= start,
+      };
+      const stream = `${input.uploadId}:${speaker}`;
+      const previous =
+        this.pending &&
+        this.pending.stream === stream &&
+        this.now() - this.pending.at < 8000 &&
+        !/\bsold\b/i.test(text)
+          ? this.pending
+          : null;
+      const combined = previous ? `${previous.text} ${text}` : text;
+      const parsed = parseResult(
+        combined,
+        this.context,
+        previous?.binding ?? binding,
+      );
+      if (parsed) {
+        let draft =
+          previous &&
+          this.data.drafts.find(
+            (d) => d.id === previous.id && d.status === "review" && !d.manual,
+          );
+        if (!draft) {
+          draft = { id: randomUUID(), status: "review", revision: 0 };
+          this.data.drafts.push(draft);
+        }
+        Object.assign(draft, parsed, {
+          text: combined,
+          revision: draft.revision + 1,
+        });
+        if (
+          this.data.drafts.some(
+            (d) =>
+              d.id !== draft.id &&
+              d.nominationId &&
+              d.nominationId === draft.nominationId &&
+              d.status !== "dismissed",
+          )
+        )
+          draft.issues.announcement =
+            "Another result exists for this nomination. Review in the website before submitting.";
+        if (!Object.keys(draft.issues).length) draft.status = "pending";
+        this.pending =
+          draft.status === "review"
+            ? {
+                id: draft.id,
+                text: combined,
+                stream,
+                binding: previous?.binding ?? binding,
+                at: this.now(),
+              }
+            : null;
+      }
+    }
+    this.save();
+  }
+  correct({ id, expectedRevision, lotId, totalCents, allocations }) {
+    if (!this.ready())
+      throw new Error("Reconnect and refresh the auction before submitting.");
+    const draft = this.data.drafts.find((d) => d.id === id);
+    if (id && !draft)
+      throw new Error("This review no longer exists. Refresh the results.");
+    if (
+      draft &&
+      (draft.status !== "review" || draft.revision !== expectedRevision)
+    )
+      throw new Error(
+        "This result changed or is already awaiting acknowledgment. Refresh it first.",
+      );
+    const lot = this.context.lots.find((l) => l.id === lotId);
+    const clean = {
+      lotId,
+      nominationId: lot?.nominationId,
+      totalCents,
+      allocations,
+    };
+    const issues = validateDraft(clean, this.context);
+    if (Object.keys(issues).length)
+      throw new Error(Object.values(issues).join(" "));
+    const next = draft ?? {
+      id: randomUUID(),
+      revision: 0,
+      text: "Manual result",
+    };
+    // A changed submission is a new operation; an uncertain pending operation cannot be edited.
+    Object.assign(next, clean, {
+      status: "pending",
+      issues: {},
+      manual: true,
+      revision: next.revision + 1,
+      requestId: randomUUID(),
+    });
+    if (!draft) this.data.drafts.push(next);
+    this.pending = null;
+    this.save();
+    return next;
+  }
+  beginReview({ id, expectedRevision, lotId }) {
+    let draft = this.data.drafts.find((d) => d.id === id);
+    if (
+      id &&
+      (!draft ||
+        draft.status !== "review" ||
+        draft.revision !== expectedRevision)
+    )
+      throw new Error("This result changed. Refresh before editing.");
+    if (!draft) {
+      if (
+        this.data.drafts.some(
+          (d) =>
+            d.lotId === lotId && !["dismissed", "submitted"].includes(d.status),
+        )
+      )
+        throw new Error(
+          "A result already exists for this lot. Edit that review.",
+        );
+      const lot = this.context?.lots.find(
+        (l) => l.id === lotId && l.status === "bidding",
+      );
+      if (!this.ready() || !lot)
+        throw new Error("Refresh the nominated lot before editing.");
+      draft = {
+        id: randomUUID(),
+        lotId,
+        nominationId: lot.nominationId,
+        allocations: [],
+        totalCents: null,
+        text: "Manual review",
+        status: "review",
+        revision: 0,
+        issues: { announcement: "Commissioner is reviewing this result." },
+      };
+      this.data.drafts.push(draft);
+    }
+    draft.manual = true;
+    draft.revision++;
+    this.pending = null;
+    this.save();
+    return structuredClone(draft);
+  }
+  dismiss(id) {
+    const draft = this.data.drafts.find((d) => d.id === id);
+    if (!draft || draft.status !== "review")
+      throw new Error("Only an unsent review can be dismissed.");
+    draft.status = "dismissed";
+    draft.revision++;
+    this.save();
+  }
+  async flush() {
+    if (
+      this.sending ||
+      this.switching ||
+      !this.bridge.data.pairing ||
+      this.data.sessionId !== this.bridge.data.pairing.id
+    )
+      return;
+    this.sending = true;
+    try {
+      for (const draft of this.data.drafts.filter(
+        (d) => d.status === "pending",
+      )) {
+        draft.requestId ??= randomUUID();
+        this.save();
+        try {
+          const ack = await this.bridge.submitResult({
+            idempotencyKey: draft.requestId,
+            lotId: draft.lotId,
+            nominationId: draft.nominationId,
+            totalCents: draft.totalCents,
+            allocations: draft.allocations.map(
+              ({ consortiumId, basisPoints }) => ({
+                consortiumId,
+                basisPoints,
+              }),
+            ),
+          });
+          if (
+            ack.idempotencyKey !== draft.requestId ||
+            !Number.isInteger(ack.saleId)
+          )
+            throw new Error("Website has not acknowledged saving this result.");
+          draft.status = "submitted";
+          draft.saleId = ack.saleId;
+          draft.message = "Saved on website";
+          draft.revision++;
+          this.save();
+        } catch (error) {
+          draft.message = error.message;
+          if ([409, 422].includes(error.status)) {
+            draft.status = "review";
+            draft.issues = { submission: error.message };
+            draft.revision++;
+          }
+          this.save();
+          break;
+        }
+      }
+    } finally {
+      this.sending = false;
+    }
+  }
+}
diff --git a/addons/auction-listener/server/main.mjs b/addons/auction-listener/server/main.mjs
index 9872226..ffc41c2 100644
--- a/addons/auction-listener/server/main.mjs
+++ b/addons/auction-listener/server/main.mjs
@@ -6,6 +6,7 @@ import { AuctionStore } from './store.mjs';
 import { RecallClient, readRecallConfig } from './recall.mjs';
 import { createAuctionServer } from './http.mjs';
 import { WebsiteBridge } from './bridge.mjs';
+import { LiveAuction } from './live-auction.mjs';
 
 export async function startBackend({ dataDir=fileURLToPath(new URL('../.local/',import.meta.url)), port=43127, env=process.env, fetcher=fetch }={}) {
   mkdirSync(dataDir,{recursive:true});
@@ -17,7 +18,8 @@ export async function startBackend({ dataDir=fileURLToPath(new URL('../.local/',
   const recall=new RecallClient(config,fetcher);
   const bridge=new WebsiteBridge({file:resolve(dataDir,'website-bridge.json'),fetcher,
     ...(Array.isArray(privateConfig.CALCUTTA_WEBSITE_ORIGINS)?{allowedOrigins:privateConfig.CALCUTTA_WEBSITE_ORIGINS}:{})});
-  const server=createAuctionServer({store,recall,token,bridge});
+  const live=new LiveAuction({file:resolve(dataDir,'live-auction.json'),bridge});
+  const server=createAuctionServer({store,recall,token,bridge,live});
   await new Promise((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',accept);});
   if(store.state.uploads.some(u=>['ready','recording_started'].includes(u.status))) {
     store.change(s=>{for(const u of s.uploads)if(['ready','recording_started'].includes(u.status))u.status='interrupted';});
@@ -25,7 +27,7 @@ export async function startBackend({ dataDir=fileURLToPath(new URL('../.local/',
   const connection={url:`http://127.0.0.1:${server.address().port}`,token,apiUrl:config.apiUrl};
   const connectionPath=resolve(dataDir,'connection.json');
   writeFileSync(connectionPath,JSON.stringify(connection),{mode:0o600});
-  return {server,store,connection,connectionPath};
+  return {server,store,live,connection,connectionPath};
 }
 if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
   startBackend().then(({connection})=>console.log(`Calcutta rehearsal backend ready at ${connection.url}. Use the launcher to open it.`)).catch(()=>{console.error('Could not start the local backend. Another listener may already be running.');process.exitCode=1;});
diff --git a/addons/auction-listener/test/listener.test.mjs b/addons/auction-listener/test/listener.test.mjs
index 3b3fc7d..6be311f 100644
--- a/addons/auction-listener/test/listener.test.mjs
+++ b/addons/auction-listener/test/listener.test.mjs
@@ -92,9 +92,8 @@ test('HTTP boundaries reject unauthorized/cross-origin writes and never expose t
   const call=(path,data,auth=true,extra={})=>fetch(app.connection.url+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${app.connection.token}`} :{}),...extra},...(data?{body:JSON.stringify(data)}:{})});
   assert.equal((await call('/api/rehearse',{text:'Chiefs sold to Craig for $500'},false)).status,401);
   assert.equal((await call('/api/rehearse',{text:'Chiefs sold to Craig for $500'},true,{Origin:'https://example.com'})).status,403);
-  const upload=await (await call('/api/uploads',{})).json();assert.equal(upload.uploadToken,'upload-token');assert.ok(!JSON.stringify(upload).includes('never-return'));
-  assert.equal((await call('/api/transcript',{sessionId:upload.sessionId,uploadId:upload.id,event:payload('Chiefs sold to Craig for $500')})).status,200);
-  const state=await (await call('/api/state')).json();assert.equal(state.sales.length,1);assert.ok(!JSON.stringify(state).includes('never-return'));assert.ok(!JSON.stringify(state).includes('upload-token'));
+  assert.equal((await call('/api/uploads',{})).status,400,'unpaired listener must not create a recording');
+  const state=await (await call('/api/state')).json();assert.equal(state.sales.length,0);assert.ok(!JSON.stringify(state).includes('never-return'));assert.ok(!JSON.stringify(state).includes('upload-token'));
 });
 function fakeCapture({platform='win32',denied=false}={}) {
   const events={},calls=[],sdk={addEventListener:(n,fn)=>events[n]=fn,init:async()=>{},requestPermission:async p=>events['permission-status']({permission:p,status:denied?'denied':'granted'}),prepareDesktopAudioRecording:async()=> 'window-1',startRecording:async args=>calls.push(args),stopRecording:async()=>{}};
diff --git a/addons/auction-listener/test/live-auction.test.mjs b/addons/auction-listener/test/live-auction.test.mjs
new file mode 100644
index 0000000..d745604
--- /dev/null
+++ b/addons/auction-listener/test/live-auction.test.mjs
@@ -0,0 +1,111 @@
+import test from 'node:test';
+import assert from 'node:assert/strict';
+import {mkdtempSync} from 'node:fs';
+import {tmpdir} from 'node:os';
+import {join} from 'node:path';
+import {LiveAuction,parseResult,validateDraft} from '../server/live-auction.mjs';
+
+const context=()=>({protocolVersion:2,id:1,currentLotId:10,lots:[{id:10,displayName:'Chiefs',status:'bidding',nominationId:'nom-1'},{id:11,displayName:'Bills',status:'available',nominationId:null}],consortia:[{id:1,displayName:'Alpha',aliases:['A team'],active:1},{id:2,displayName:'Bravo',aliases:[],active:1}],sales:[]});
+const binding={lotId:10,nominationId:'nom-1',safe:true};
+function fixture() {
+  let now=100000, ctx=context(), send=async r=>({idempotencyKey:r.idempotencyKey,saleId:50});
+  const bridge={data:{pairing:{id:'session-1',origin:'https://thecalcutta.app',auction:{id:1}}},status:()=>({connected:true}),context:async()=>structuredClone(ctx),submitResult:r=>send(r)};
+  const file=join(mkdtempSync(join(tmpdir(),'listener-live-')),'live.json');
+  const live=new LiveAuction({file,bridge,now:()=>now});
+  return {live,file,bridge,setTime:n=>now=n,getTime:()=>now,setContext:c=>ctx=c,setSend:fn=>send=fn};
+}
+function speech(text,{start=4,final=true,uploadId='upload-1',...rest}={}) {
+  return {websiteSessionId:'session-1',uploadId,captureStartedAt:100000,event:{event:final?'transcript.data':'transcript.partial_data',data:{data:{participant:{id:'speaker-1'},words:[{text,start_timestamp:{relative:start},end_timestamp:{relative:start+1}}]}}},...rest};
+}
+test('exact roster aliases, explicit splits and final amounts become a ready result',()=>{
+  for(const text of ['Sold to Alpha for $500','Chiefs sold to A team for five hundred dollars','Sold to Alpha and Bravo fifty-fifty for $500','Sold to Alpha 60 percent and Bravo 40 percent for $500']) {
+    const d=parseResult(text,context(),binding);assert.deepEqual(d.issues,{});assert.equal(d.totalCents,50000);
+  }
+});
+test('unknown/ambiguous winners, absent shares, invalid amount and wrong lot flag specific fields',()=>{
+  assert.ok(parseResult('Sold to Nobody for $500',context(),binding).issues.owners);
+  assert.ok(parseResult('Sold to Alpha and Bravo for $500',context(),binding).issues.shares);
+  assert.ok(parseResult('Sold to Alpha for five-ish',context(),binding).issues.amount);
+  assert.ok(parseResult('Bills sold to Alpha for $500',context(),binding).issues.lot);
+  const c=context();c.consortia[1].aliases=['Alpha'];assert.ok(parseResult('Sold to Alpha for $500',c,binding).issues.owners);
+  assert.ok(parseResult('Not sold to Alpha for $500',context(),binding).issues.announcement);
+  assert.equal(parseResult('Going once, twice, $500',context(),binding),null);
+});
+test('partials cannot sell; repeated final callbacks cannot create duplicate drafts',async()=>{
+  const f=fixture();await f.live.sync();f.setTime(105000);f.live.ingest(speech('Sold to Alpha for $500',{final:false}));assert.equal(f.live.data.drafts.length,0);
+  const event=speech('Sold to Alpha for $500');f.live.ingest(event);f.live.ingest({...event,id:'another-callback-id'});
+  assert.equal(f.live.data.drafts.length,1);assert.equal(f.live.data.drafts[0].status,'pending');
+});
+test('final fragments combine for the same speaker without losing original nomination binding',async()=>{
+  const f=fixture();await f.live.sync();f.setTime(105000);f.live.ingest(speech('Sold to Alpha'));assert.equal(f.live.data.drafts[0].status,'review');
+  f.live.ingest(speech('for $500',{start:5}));assert.equal(f.live.data.drafts.length,1);assert.equal(f.live.data.drafts[0].status,'pending');
+});
+test('late speech retains old lot and requires review after a nomination change',async()=>{
+  const f=fixture();await f.live.sync();f.setTime(105000);const c=context();c.lots[0].status='sold';c.lots[1].status='bidding';c.lots[1].nominationId='nom-2';c.currentLotId=11;f.setContext(c);await f.live.sync();
+  f.live.ingest(speech('Sold to Alpha for $500'));const d=f.live.data.drafts[0];assert.equal(d.lotId,10);assert.equal(d.status,'review');assert.ok(d.issues.lot);
+});
+test('no nomination, missing timestamps, stale context and boundary speech never auto-submit',async()=>{
+  const f=fixture();await f.live.sync();f.setTime(101000);f.live.ingest(speech('Sold to Alpha for $500',{start:1}));assert.equal(f.live.data.drafts[0].status,'review');
+  const g=fixture();await g.live.sync();g.setTime(110000);g.live.ingest(speech('Sold to Alpha for $500'));assert.equal(g.live.data.drafts[0].status,'review');
+  const h=fixture();await h.live.sync();h.setTime(105000);h.live.ingest(speech('Sold to Alpha for $500',{captureStartedAt:undefined}));assert.equal(h.live.data.drafts[0].status,'review');
+  const c=context();c.currentLotId=null;assert.ok(validateDraft({lotId:10,nominationId:'nom-1',totalCents:50000,allocations:[{consortiumId:1,basisPoints:10000}]},c).lot);
+});
+test('lost acknowledgment survives restart with identical immutable request ID',async()=>{
+  const f=fixture();await f.live.sync();f.setTime(105000);f.live.ingest(speech('Sold to Alpha for $500'));
+  const sent=[];f.setSend(async r=>{sent.push(r);throw new Error('lost response');});await f.live.flush();assert.equal(f.live.data.drafts[0].status,'pending');
+  assert.throws(()=>f.live.correct({id:f.live.data.drafts[0].id}),/already awaiting/);
+  const restarted=new LiveAuction({file:f.file,bridge:f.bridge,now:f.getTime});f.setSend(async r=>{sent.push(r);return{idempotencyKey:r.idempotencyKey,saleId:50};});await restarted.flush();
+  assert.deepEqual(sent[0],sent[1]);assert.equal(restarted.data.drafts[0].status,'submitted');
+});
+test('deterministic rejection becomes editable review; invalid percentages cannot submit',async()=>{
+  const f=fixture();await f.live.sync();f.setTime(105000);f.live.ingest(speech('Sold to Alpha for $500'));
+  f.setSend(async()=>{throw Object.assign(new Error('Conflict'),{status:409});});await f.live.flush();const d=f.live.data.drafts[0];assert.equal(d.status,'review');
+  const edit={id:d.id,expectedRevision:d.revision,lotId:10,totalCents:55000,allocations:[{consortiumId:1,basisPoints:9999}]};assert.throws(()=>f.live.correct(edit),/100%/);
+  f.live.correct({...edit,allocations:[{consortiumId:1,basisPoints:10000}]});assert.equal(d.status,'pending');assert.equal(d.totalCents,55000);
+});
+test('unresolved results cannot move to another auction; no acknowledgment means no saved status',async()=>{
+  const f=fixture();await f.live.sync();f.setTime(105000);f.live.ingest(speech('Sold to Alpha for $500'));
+  f.setSend(async()=>({}));await f.live.flush();assert.equal(f.live.data.drafts[0].status,'pending');
+  f.bridge.data.pairing.id='session-2';await f.live.sync();assert.equal(f.live.data.sessionId,'session-1');assert.match(f.live.error,/previous auction/);
+});
+test('beginning manual review prevents subsequent fragments or announcements from auto-submitting',async()=>{
+  const f=fixture();await f.live.sync();f.setTime(105000);f.live.ingest(speech('Sold to Alpha'));
+  const d=f.live.data.drafts[0];f.live.beginReview({id:d.id,expectedRevision:d.revision,lotId:10});
+  f.live.ingest(speech('for $500',{start:5}));assert.equal(d.status,'review');assert.equal(d.totalCents,null);
+  f.live.ingest(speech('Sold to Alpha for $500',{start:5}));assert.ok(f.live.data.drafts.every(d=>d.status==='review'));
+});
+
+test('auction history survives A to B to A and restart without mixing origins',async()=>{
+  const f=fixture();await f.live.sync();f.setTime(105000);
+  f.live.ingest(speech('Sold to Alpha for $500'));await f.live.flush();
+  const keyA=f.live.data.auctionKey;
+  f.bridge.data.pairing={id:'session-B',origin:'https://thecalcutta.app',auction:{id:2}};
+  f.setContext({...context(),id:2});await f.live.sync();
+  assert.equal(f.live.data.drafts.length,0);assert.equal(f.live.data.transcript.length,0);
+  assert.notEqual(f.live.data.auctionKey,keyA);
+  f.bridge.data.pairing={id:'session-A2',origin:'https://thecalcutta.app',auction:{id:1}};
+  f.setContext(context());await f.live.sync();
+  assert.equal(f.live.data.auctionKey,keyA);assert.equal(f.live.data.drafts[0].status,'submitted');
+  assert.equal(f.live.data.transcript.length,1);assert.equal(f.live.data.sessionId,'session-A2');
+  const restarted=new LiveAuction({file:f.file,bridge:f.bridge,now:f.getTime});await restarted.sync();
+  assert.equal(restarted.data.drafts.length,1);
+  f.bridge.data.pairing={id:'session-other-site',origin:'https://www.thecalcutta.app',auction:{id:1}};
+  await restarted.sync();assert.equal(restarted.data.drafts.length,0);
+});
+
+test('restart preserves unsent review and reconnect observation cannot reuse old speech timing',async()=>{
+  const f=fixture();await f.live.sync();f.setTime(105000);
+  f.live.ingest(speech('Sold to unknown for $500'));
+  const restarted=new LiveAuction({file:f.file,bridge:f.bridge,now:f.getTime});await restarted.sync();
+  assert.equal(restarted.data.drafts[0].status,'review');
+  restarted.ingest(speech('Sold to Alpha for $500',{uploadId:'late-upload'}));
+  assert.equal(restarted.data.drafts[1].status,'review');
+  assert.ok(restarted.data.drafts[1].issues.lot);
+});
+
+test('context from a different auction cannot change saved state or enable recording',async()=>{
+  const f=fixture();await f.live.sync();const key=f.live.data.auctionKey;
+  f.setContext({...context(),id:999});await f.live.sync();
+  assert.equal(f.live.ready(),false);assert.equal(f.live.data.auctionKey,key);
+  assert.match(f.live.error,/different auction/);
+});
diff --git a/addons/auction-listener/test/live-http.test.mjs b/addons/auction-listener/test/live-http.test.mjs
new file mode 100644
index 0000000..7a53b04
--- /dev/null
+++ b/addons/auction-listener/test/live-http.test.mjs
@@ -0,0 +1,42 @@
+import test from 'node:test';
+import assert from 'node:assert/strict';
+import {mkdtempSync} from 'node:fs';
+import {tmpdir} from 'node:os';
+import {join} from 'node:path';
+import {startBackend} from '../server/main.mjs';
+
+test('paired local API pulls context, captures a review and submits the corrected result',async t=>{
+  const id='11111111-1111-4111-8111-111111111111', nominationId='22222222-2222-4222-8222-222222222222';
+  const context={protocolVersion:2,id:1,currentLotId:10,lots:[{id:10,displayName:'Chiefs',status:'bidding',nominationId}],consortia:[{id:1,displayName:'Alpha',active:1}],sales:[]};
+  const sent=[];let targetAuction=1;
+  const app=await startBackend({dataDir:mkdtempSync(join(tmpdir(),'listener-http-live-')),port:0,env:{RECALL_API_KEY:'fake-test-key'},fetcher:async(url,options)=>{
+    const body=options.body?JSON.parse(options.body):null;
+    const value=url.endsWith('/preview')?{auction:{id:targetAuction,name:'Test auction'}}:url.endsWith('/pair')?{id,token:'x'.repeat(43),expiresAt:'2099-01-01',auction:{id:1,name:'Test auction'}}
+      :url.endsWith('/context')?context
+      :url.endsWith('/results')?(sent.push(body),{saleId:1,idempotencyKey:body.idempotencyKey})
+      :url.endsWith('/events')?{acceptedIds:body.events.map(e=>e.id)}:{ok:true};
+    return new Response(JSON.stringify(value),{status:200});
+  }});
+  t.after(()=>{app.server.closeAllConnections();app.server.close();});
+  const call=(path,body,auth=true)=>fetch(app.connection.url+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${app.connection.token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
+  assert.equal((await call('/api/live',undefined,false)).status,401);
+  assert.equal((await call('/api/website/pair',{url:`calcutta-listener://connect#origin=${encodeURIComponent('https://thecalcutta.app')}&ticket=${'t'.repeat(43)}`})).status,200);
+  assert.equal((await (await call('/api/live')).json()).ready,true);
+  const event={id:'event-1',websiteSessionId:id,sessionId:'local-1',uploadId:'upload-1',event:{event:'transcript.data',data:{data:{words:[{text:'Sold to unknown for $500'}]}}}};
+  assert.equal((await call('/api/transcript',event)).status,200);
+  const draft=(await (await call('/api/live')).json()).drafts[0];assert.equal(draft.status,'review');assert.ok(draft.issues.owners);
+  const launch={url:`calcutta-listener://connect#origin=${encodeURIComponent('https://thecalcutta.app')}&ticket=${'t'.repeat(43)}`};
+  assert.equal((await call('/api/website/pair',launch)).status,200);
+  assert.equal((await (await call('/api/live')).json()).drafts[0].id,draft.id);
+  targetAuction=2;
+  const blocked=await call('/api/website/pair',launch);
+  assert.notEqual(blocked.status,200);assert.match((await blocked.json()).error,/before switching/);
+  assert.equal((await (await call('/api/live')).json()).drafts[0].id,draft.id);
+  targetAuction=1;
+  assert.equal((await call('/api/live/result',{id:draft.id,expectedRevision:draft.revision,lotId:10,totalCents:50000,allocations:[{consortiumId:1,basisPoints:10000}]})).status,200);
+  // Wait on the actual single-flight operation, without making another sale request.
+  while(app.live.sending)await new Promise(r=>setTimeout(r,5));
+  assert.equal(sent.length,1);assert.equal(app.live.data.drafts[0].status,'submitted');
+  assert.equal(sent[0].lotId,10);assert.equal(sent[0].nominationId,nominationId);
+  const state=JSON.stringify(await (await call('/api/live')).json());assert.ok(!state.includes('fake-test-key'));assert.ok(!state.includes('x'.repeat(43)));
+});
diff --git a/addons/auction-listener/test/live-ui.test.mjs b/addons/auction-listener/test/live-ui.test.mjs
new file mode 100644
index 0000000..a0fbeef
--- /dev/null
+++ b/addons/auction-listener/test/live-ui.test.mjs
@@ -0,0 +1,25 @@
+import test from 'node:test';
+import assert from 'node:assert/strict';
+import {readFileSync} from 'node:fs';
+import {JSDOM} from 'jsdom';
+const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
+const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
+
+test('minimal UI highlights current lot and lets commissioner correct a red review inline',async t=>{
+  const dom=new JSDOM(html,{url:'http://127.0.0.1:43127',runScripts:'outside-only'});t.after(()=>dom.window.close());
+  const w=dom.window, d=w.document, requests=[];let statusHandler;
+  const state={ready:true,pending:0,error:'',context:{currentLotId:10,lots:[{id:10,displayName:'Chiefs',status:'bidding',nominationId:'n-1'}],consortia:[{id:1,displayName:'Alpha',active:1}],sales:[]},transcript:[{text:'Sold to maybe Alpha for $500',final:true}],drafts:[{id:'draft-1',revision:1,lotId:10,totalCents:50000,allocations:[{consortiumId:null,heardName:'Maybe Alpha',basisPoints:10000}],status:'review',issues:{owners:'Unknown winner'}}]};
+  w.capture={status:async()=>({recording:true,status:'recording'}),onStatus:fn=>statusHandler=fn,onWebsite:()=>{},start:async()=>({recording:true}),stop:async()=>({recording:false}),permissions:()=>{}};
+  w.fetch=async(url,options)=>{if(options.body)requests.push({url,body:JSON.parse(options.body)});return{ok:true,json:async()=>url==='/api/website'?{auction:{name:'Test auction'}}:url==='/api/live/review'?{...structuredClone(state.drafts[0]),revision:2}:structuredClone(state)};};
+  w.eval(source);await new Promise(r=>setTimeout(r,10));
+  assert.equal(d.getElementById('current').textContent,'Chiefs');assert.equal(d.querySelectorAll('.active-lot').length,1);
+  assert.match(d.querySelector('.needs-review').textContent,/Needs a look/);
+  assert.ok(d.getElementById('transcript').compareDocumentPosition(d.getElementById('results')) & w.Node.DOCUMENT_POSITION_FOLLOWING);
+  assert.ok(!d.body.textContent.includes('Auction so far'));assert.equal(d.getElementById('practice'),null);
+  [...d.querySelectorAll('button')].find(b=>b.textContent==='Correct & submit').click();
+  await new Promise(r=>setTimeout(r,10));
+  d.querySelector('select[aria-label="Winning consortium"]').value='1';
+  [...d.querySelectorAll('button')].find(b=>b.textContent==='Submit').click();await new Promise(r=>setTimeout(r,10));
+  assert.deepEqual(requests.find(r=>r.url==='/api/live/result').body,{id:'draft-1',expectedRevision:2,lotId:10,totalCents:50000,allocations:[{consortiumId:1,basisPoints:10000}]});
+  statusHandler({recording:false,status:'stopped'});assert.equal(d.getElementById('current').textContent,'');
+});
diff --git a/addons/auction-listener/test/smoke.mjs b/addons/auction-listener/test/smoke.mjs
index a5309d0..9e9818c 100644
--- a/addons/auction-listener/test/smoke.mjs
+++ b/addons/auction-listener/test/smoke.mjs
@@ -7,9 +7,8 @@ const app=await startBackend({dataDir:mkdtempSync(join(tmpdir(),'calcutta-smoke-
 try {
   const html=await fetch(app.connection.url).then(r=>r.text());assert.ok(html.includes('Start listening'));
   const headers={Authorization:`Bearer ${app.connection.token}`,'Content-Type':'application/json'};
-  for(const text of ['Next up Chiefs','Sold to Craig and Dave, fifty-fifty, for five hundred dollars','Next up Bills']){
-    const r=await fetch(`${app.connection.url}/api/rehearse`,{method:'POST',headers,body:JSON.stringify({text})});assert.equal(r.status,200);
-  }
-  const state=await fetch(`${app.connection.url}/api/state`,{headers}).then(r=>r.json());assert.equal(state.sales.length,1);assert.equal(state.sales[0].owners.length,2);assert.equal(state.currentLotId,'4');
-  console.log('PASS: real local HTTP server, page, nomination, shared sale, and next nomination. No Recall recording or production write performed.');
+  assert.ok(!html.includes('AUCTION SO FAR'));
+  const state=await fetch(`${app.connection.url}/api/live`,{headers}).then(r=>r.json());assert.equal(state.ready,false);assert.equal(state.context,null);
+  const start=await fetch(`${app.connection.url}/api/uploads`,{method:'POST',headers,body:'{}'});assert.equal(start.status,400);
+  console.log('PASS: local page and disconnected recording guard. No recording or production write performed.');
 }finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));}
diff --git a/addons/auction-listener/web/app.js b/addons/auction-listener/web/app.js
index 89c2756..4960870 100644
--- a/addons/auction-listener/web/app.js
+++ b/addons/auction-listener/web/app.js
@@ -1,72 +1,410 @@
-const $=id=>document.getElementById(id);
-let state,editing=null,captureState={status:'idle'},lotsFilled=false;
-function renderWebsite(s) {
-  const paired=!!s.auction;
-  document.querySelector('.badge').textContent=paired?'WEBSITE CONNECTED':'LOCAL REHEARSAL';
-  document.querySelector('.notice').textContent=paired
-    ? `${s.auction.name} · ${s.message||'Connected'}${s.pending?` · ${s.pending} events waiting`:''}. Run bidding and corrections in the website.`
-    : 'Practice results stay on this computer. Open this listener from your website’s Auction tab to connect.';
-  // The local rehearsal interpreter must never masquerade as the hosted auction.
-  for(const el of document.querySelectorAll('.columns, section.card, details.card')) el.hidden=paired;
-  if(paired){$('status-detail').textContent=s.connected?'Ready to send speech to this auction.':'Connection expired. Reopen from the Auction tab.';}
+const $ = (id) => document.getElementById(id);
+const node = (tag, text, className) => {
+  const el = document.createElement(tag);
+  if (text != null) el.textContent = text;
+  if (className) el.className = className;
+  return el;
+};
+const money = (cents) =>
+  Number.isInteger(cents)
+    ? new Intl.NumberFormat("en-US", {
+        style: "currency",
+        currency: "USD",
+      }).format(cents / 100)
+    : "—";
+let live = { drafts: [], transcript: [] },
+  capture = { recording: false },
+  website = {},
+  editing = null,
+  nomination = null,
+  lastRows = "",
+  lastTranscript = "";
+async function api(path, body) {
+  const r = await fetch(path, {
+    method: body === undefined ? "GET" : "POST",
+    headers: { "Content-Type": "application/json" },
+    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
+  });
+  const value = await r.json();
+  if (!r.ok) throw new Error(value.error || "Could not reach the listener.");
+  return value;
 }
-const money=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:cents%100?2:0}).format(cents/100);
-async function api(path,data) {
-  const r=await fetch(path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
-  const body=await r.json();if(!r.ok)throw new Error(body.error||'Could not reach the local backend.');return body;
+function error(text) {
+  $("error").textContent = text || "";
+  $("error").hidden = !text;
 }
-function error(message){$('error').textContent=message;$('error').hidden=!message;}
-function node(tag,text,className){const el=document.createElement(tag);if(text!=null)el.textContent=text;if(className)el.className=className;return el;}
-function render(next) {
-  state=next;
-  $('current').textContent=state.lots.find(l=>l.id===state.currentLotId)?.name??'Name the next lot';
-  $('remaining').textContent=`${state.lots.length-state.sales.length} of ${state.lots.length} lots available`;
-  $('count').textContent=state.sales.length;$('total').textContent=money(state.sales.reduce((n,s)=>n+s.priceCents,0));
-  $('empty').hidden=!!state.sales.length;
-  $('results').replaceChildren(...state.sales.map((sale,i)=>{
-    const tr=node('tr');tr.append(node('td',String(i+1)),node('td',state.lots.find(l=>l.id===sale.lotId)?.name));
-    const owners=node('td',sale.owners.map(o=>`${o.name}${o.basisPoints===null?'':` (${o.basisPoints/100}%)`}`).join(' / '));
-    if(sale.needsShares)owners.append(node('br'),node('span','Set ownership shares','warn'));
-    tr.append(owners,node('td',money(sale.priceCents)));
-    const cell=node('td'),button=node('button','Edit','secondary');button.setAttribute('aria-label',`Edit ${state.lots.find(l=>l.id===sale.lotId)?.name}`);button.onclick=()=>openEditor(sale);cell.append(button);tr.append(cell);return tr;
-  }));
-  $('transcript').replaceChildren(...(state.transcript.length?state.transcript.map(t=>{const a=node('article',t.text,t.final?'':'partial');a.append(node('p',`${t.source} · ${new Date(t.receivedAt).toLocaleTimeString()}`));return a;}):[node('p','Waiting for speech.','muted')]));
-  const reviews=state.pendingAnnouncement?[{text:state.pendingAnnouncement,reason:'Incomplete announcement. Waiting for the remaining words, or use Add a result.'},...state.reviews]:state.reviews;
-  $('reviews').replaceChildren(...(reviews.length?reviews.map(r=>{const a=node('article',r.text);a.append(node('p',r.reason));return a;}):[node('p','No unresolved announcements.','muted')]));
-  const last=state.uploads.at(-1);$('recording-status').textContent=last?`Recall recording: ${last.status.replaceAll('_',' ')}`:'No recording started.';
-  if(!lotsFilled){$('lots').value=state.lots.map(l=>[l.name,...l.aliases].join(' | ')).join('\n');lotsFilled=true;}
+function controls() {
+  $("start").disabled =
+    !window.capture ||
+    !live.ready ||
+    capture.recording ||
+    capture.status === "starting";
+  $("stop").disabled = !capture.recording;
+  $("indicator").classList.toggle("active", !!capture.recording);
+  $("status").textContent = capture.recording
+    ? "Listening"
+    : {
+        starting: "Starting…",
+        stopped: "Stopped",
+        permission: "Audio permission needed",
+        error: "Recorder needs attention",
+        warning: "Check connection",
+      }[capture.status] || "Ready";
+  $("status-detail").textContent =
+    capture.message || "Connect to an auction to begin.";
+  $("permission").hidden = capture.status !== "permission";
+  $("connection").textContent = live.ready ? "Connected" : "Not connected";
+  $("auction").textContent =
+    (website.auction ? `${website.auction.name} — Auction #${website.auction.id}` : null) ||
+    "Open the listener from your website’s Auction tab.";
+  const lot =
+    capture.recording && live.ready
+      ? live.context?.lots.find(
+          (l) => l.id === live.context.currentLotId && l.status === "bidding",
+        )
+      : null;
+  $("current").textContent = lot?.displayName || "";
+  if (nomination !== lot?.nominationId) {
+    nomination = lot?.nominationId;
+    $("current").classList.remove("new-lot");
+    if (lot) {
+      void $("current").offsetWidth;
+      $("current").classList.add("new-lot");
+    }
+  }
+  $("pending").textContent = live.pending
+    ? `${live.pending} awaiting website confirmation`
+    : "";
+}
+function render() {
+  controls();
+  const transcriptKey = JSON.stringify(live.transcript);
+  if (transcriptKey !== lastTranscript) {
+    lastTranscript = transcriptKey;
+    $("transcript").replaceChildren(
+      ...(live.transcript.length
+        ? live.transcript.map((t) =>
+            node("article", t.text, t.final ? "" : "partial"),
+          )
+        : [node("p", "Waiting for speech.", "muted")]),
+    );
+  }
+  if (editing) return;
+  const key = JSON.stringify([
+    live.context,
+    live.drafts,
+    capture.recording,
+    live.ready,
+  ]);
+  if (key === lastRows) return;
+  lastRows = key;
+  const context = live.context,
+    rows = [];
+  const active =
+    capture.recording && live.ready
+      ? context?.lots.find(
+          (l) => l.id === context.currentLotId && l.status === "bidding",
+        )
+      : null;
+  const saleIds = new Set(context?.sales.map((s) => s.id));
+  const drafts = live.drafts.filter(
+    (d) =>
+      d.status !== "dismissed" &&
+      !(d.status === "submitted" && saleIds.has(d.saleId)),
+  );
+  if (active && !drafts.some((d) => d.lotId === active.id))
+    rows.push(
+      resultRow(
+        { lotId: active.id, allocations: [], status: "waiting" },
+        active,
+      ),
+    );
+  for (const draft of [...drafts].reverse())
+    rows.push(resultRow(draft, active));
+  for (const sale of [...(context?.sales ?? [])].reverse()) {
+    const shares = new Map();
+    for (const a of sale.allocations) {
+      const key = a.consortiumId ?? `bidder-${a.bidderId}`;
+      const existing = shares.get(key) ?? {
+        consortiumId: a.consortiumId,
+        heardName: a.consortiumName || a.bidderName,
+        basisPoints: 0,
+      };
+      existing.basisPoints += Math.round(Number(a.share) * 10000);
+      shares.set(key, existing);
+    }
+    rows.push(
+      resultRow({
+        ...sale,
+        allocations: [...shares.values()],
+        status: "submitted",
+      }),
+    );
+  }
+  rows.sort(
+    (a, b) =>
+      Number(b.classList.contains("active-lot")) -
+      Number(a.classList.contains("active-lot")),
+  );
+  $("results").replaceChildren(...rows);
+  $("empty").hidden = !!rows.length;
+}
+function flagged(cell, message) {
+  if (!message) return;
+  cell.classList.add("needs-review");
+  cell.append(node("small", `Needs a look: ${message}`));
+}
+function resultRow(draft, active) {
+  const tr = node("tr", null, draft.lotId === active?.id ? "active-lot" : "");
+  const lot = node(
+    "td",
+    live.context?.lots.find((l) => l.id === draft.lotId)?.displayName ||
+      "Select lot",
+  );
+  flagged(lot, draft.issues?.lot);
+  const buyers = node("td"),
+    shares = node("td");
+  for (const a of draft.allocations) {
+    buyers.append(
+      node(
+        "div",
+        live.context?.consortia.find((c) => c.id === a.consortiumId)
+          ?.displayName ||
+          a.heardName ||
+          "Unknown winner",
+      ),
+    );
+    shares.append(
+      node("div", a.basisPoints == null ? "—" : `${a.basisPoints / 100}%`),
+    );
+  }
+  flagged(buyers, draft.issues?.owners);
+  flagged(shares, draft.issues?.shares);
+  const amount = node("td", money(draft.totalCents));
+  flagged(amount, draft.issues?.amount);
+  const action = node("td");
+  action.append(
+    node(
+      "span",
+      {
+        submitted: "Saved on website",
+        pending: "Pending delivery",
+        review: "Needs a look",
+        waiting: "Waiting for sale",
+      }[draft.status],
+    ),
+  );
+  flagged(action, draft.issues?.announcement || draft.issues?.submission);
+  if (draft.message && draft.status !== "submitted")
+    action.append(node("small", draft.message));
+  if (["review", "waiting"].includes(draft.status)) {
+    const edit = node(
+      "button",
+      draft.status === "waiting" ? "Enter result" : "Correct & submit",
+      "secondary",
+    );
+    edit.onclick = () => editRow(tr, draft);
+    action.append(edit);
+    if (draft.status === "review") {
+      const dismiss = node("button", "Dismiss", "secondary");
+      dismiss.onclick = async () => {
+        try {
+          live = await api("/api/live/dismiss", { id: draft.id });
+          lastRows = "";
+          render();
+        } catch (e) {
+          error(e.message);
+        }
+      };
+      action.append(dismiss);
+    }
+  }
+  tr.append(lot, buyers, shares, amount, action);
+  return tr;
 }
-function renderCapture(s) {
-  captureState=s;
-  $('status').textContent=({idle:'Ready to rehearse',starting:'Starting…',recording:'Listening',stopped:'Recording stopped',permission:'Audio permission needed',warning:'Check the listener',error:'Recorder needs attention'})[s.status]??s.status;
-  $('status-detail').textContent=s.message??'';
-  $('indicator').classList.toggle('active',s.status==='recording');
-  $('start').disabled=s.recording || s.status==='starting';
-  $('stop').disabled=!s.recording;
-  $('permission').hidden=s.status!=='permission';
+async function editRow(tr, draft) {
+  if (editing) return;
+  editing = {};
+  try {
+    draft = await api("/api/live/review", {
+      id: draft.id,
+      expectedRevision: draft.revision,
+      lotId: draft.lotId,
+    });
+  } catch (e) {
+    editing = null;
+    error(e.message);
+    return;
+  }
+  editing = { ...draft };
+  const lot = node("select");
+  lot.setAttribute("aria-label", "Confirm lot");
+  for (const l of live.context.lots.filter((l) => l.status === "bidding")) {
+    const o = node("option", l.displayName);
+    o.value = l.id;
+    lot.append(o);
+  }
+  lot.value = String(draft.lotId ?? "");
+  const lotCell = node("td");
+  lotCell.append(lot, node("small", "Confirm this is the lot you heard."));
+  const buyers = node("td"),
+    shares = node("td"),
+    inputs = [];
+  function allocation(value = {}) {
+    const select = node("select");
+    select.setAttribute("aria-label", "Winning consortium");
+    const blank = node("option", "Choose consortium");
+    blank.value = "";
+    select.append(blank);
+    for (const c of live.context.consortia.filter((c) => c.active === 1)) {
+      const o = node("option", c.displayName);
+      o.value = c.id;
+      select.append(o);
+    }
+    select.value = String(value.consortiumId ?? "");
+    const percent = node("input");
+    percent.type = "number";
+    percent.min = "0.01";
+    percent.max = "100";
+    percent.step = "0.01";
+    percent.value =
+      value.basisPoints == null ? "" : String(value.basisPoints / 100);
+    percent.setAttribute("aria-label", "Ownership percentage");
+    const holder = node("div"),
+      remove = node("button", "Remove", "secondary");
+    holder.append(select, remove);
+    buyers.append(holder);
+    shares.append(percent);
+    const pair = { select, percent };
+    inputs.push(pair);
+    remove.onclick = () => {
+      inputs.splice(inputs.indexOf(pair), 1);
+      holder.remove();
+      percent.remove();
+    };
+  }
+  for (const value of draft.allocations.length
+    ? draft.allocations
+    : [{ basisPoints: 10000 }])
+    allocation(value);
+  const add = node("button", "Add winner", "secondary");
+  add.onclick = () => {
+    if (inputs.length < 8) allocation();
+  };
+  buyers.append(add);
+  const price = node("input");
+  price.type = "number";
+  price.min = "0.01";
+  price.max = "1000000";
+  price.step = "0.01";
+  price.value = draft.totalCents == null ? "" : String(draft.totalCents / 100);
+  price.setAttribute("aria-label", "Final amount in dollars");
+  const amount = node("td");
+  amount.append(price);
+  const action = node("td"),
+    submit = node("button", "Submit"),
+    cancel = node("button", "Cancel", "secondary"),
+    message = node("small");
+  message.setAttribute("role", "alert");
+  action.append(submit, cancel, message);
+  cancel.onclick = () => {
+    editing = null;
+    lastRows = "";
+    render();
+  };
+  submit.onclick = async () => {
+    try {
+      if (
+        !lot.value ||
+        !price.value ||
+        !price.checkValidity() ||
+        inputs.some(
+          (p) =>
+            !p.select.value || !p.percent.value || !p.percent.checkValidity(),
+        )
+      )
+        throw new Error(
+          "Choose a lot and winners, then enter valid percentages and amount.",
+        );
+      submit.disabled = true;
+      live = await api("/api/live/result", {
+        id: draft.id,
+        expectedRevision: draft.revision,
+        lotId: Number(lot.value),
+        totalCents: Math.round(Number(price.value) * 100),
+        allocations: inputs.map((p) => ({
+          consortiumId: Number(p.select.value),
+          basisPoints: Math.round(Number(p.percent.value) * 100),
+        })),
+      });
+      editing = null;
+      lastRows = "";
+      render();
+    } catch (e) {
+      message.textContent = e.message;
+      submit.disabled = false;
+    }
+  };
+  tr.replaceChildren(lotCell, buyers, shares, amount, action);
 }
-function openEditor(sale=null){editing=sale;$('edit-title').textContent=sale?'Edit result':'Add a result';$('edit-error').textContent='';$('edit-lot').replaceChildren(...state.lots.map(l=>{const o=node('option',l.name);o.value=l.id;return o;}));$('edit-lot').value=sale?.lotId??state.currentLotId??state.lots[0].id;$('edit-price').value=sale?sale.priceCents/100:'';$('edit-owners').value=sale?sale.owners.map(o=>`${o.name}, ${o.basisPoints===null?'':o.basisPoints/100}`).join('\n'):'';$('editor').showModal();}
-$('add').onclick=()=>openEditor();$('cancel-edit').onclick=()=>$('editor').close();
-$('edit-form').onsubmit=async e=>{e.preventDefault();try{
-  const owners=$('edit-owners').value.trim().split('\n').map(line=>{const at=line.lastIndexOf(',');if(at<0)throw new Error('Use “Name, percentage” on each line.');const percent=line.slice(at+1).trim();if(!/^\d+(?:\.\d{1,2})?$/.test(percent))throw new Error('Use percentages with up to two decimal places.');return{name:line.slice(0,at).trim(),basisPoints:Math.round(Number(percent)*100)};});
-  await api('/api/result',{saleId:editing?.id,expectedRevision:editing?.revision,lotId:$('edit-lot').value,priceCents:Math.round(Number($('edit-price').value)*100),owners});$('editor').close();
-}catch(e){$('edit-error').textContent=e.message;}};
-$('practice').onsubmit=async e=>{e.preventDefault();try{await api('/api/rehearse',{text:$('announcement').value});$('announcement').value='';error('');}catch(e){error(e.message);}};
-$('new').onclick=async()=>{if(!confirm('Archive these practice results and start a fresh rehearsal?'))return;try{const lots=$('lots').value.split('\n').filter(s=>s.trim()).map(line=>{const [name,...aliases]=line.split('|').map(s=>s.trim());return{name,aliases};});await api('/api/session',{lots});error('');}catch(e){error(e.message);}};
-async function init(){
-  const token=location.hash.slice(1);if(token){history.replaceState(null,'','/');await api('/api/auth',{token});}
-  const initial=await api('/api/state');render(initial);
-  const events=new EventSource('/api/events');events.onmessage=e=>render(JSON.parse(e.data));events.onerror=()=>error('Board connection interrupted. It will reconnect automatically.');events.onopen=()=>error('');
-  if(window.capture){
-    window.capture.onWebsite(renderWebsite);renderWebsite(await window.capture.websiteStatus());
-    window.capture.onStatus(renderCapture);renderCapture(await window.capture.status());
-    $('start').onclick=async()=>{try{renderCapture(await window.capture.start());}catch{error('Could not reach the desktop recorder.');}};
-    $('stop').onclick=async()=>{try{renderCapture(await window.capture.stop());}catch{error('Could not stop the recorder.');}};
-    $('permission').onclick=()=>window.capture.permissions(captureState.permission);
-    $('open-board').hidden=false;$('open-board').onclick=()=>window.capture.openBoard();
-  }else{
-    $('start').disabled=true;$('status').textContent='Live local board';$('status-detail').textContent='Use the Calcutta desktop window to start and stop audio. Typed practice works here.';
+async function poll() {
+  try {
+    const previousAuction = live.auctionKey;
+    [live, website] = await Promise.all([
+      api("/api/live"),
+      api("/api/website"),
+    ]);
+    if(previousAuction !== live.auctionKey) {
+      editing = null;
+      lastRows = "";
+      lastTranscript = "";
+      nomination = null;
+    }
+    error(live.error);
+    render();
+  } catch (e) {
+    live.ready = false;
+    controls();
+    error(e.message);
+  } finally {
+    setTimeout(poll, 1000);
+  }
+}
+async function init() {
+  const token = location.hash.slice(1);
+  if (token) {
+    history.replaceState(null, "", "/");
+    await api("/api/auth", { token });
+  }
+  if (window.capture) {
+    capture = await window.capture.status();
+    window.capture.onStatus((s) => {
+      capture = s;
+      render();
+    });
+    window.capture.onWebsite((s) => {
+      website = s;
+      controls();
+    });
+    $("start").onclick = async () => {
+      try {
+        capture = await window.capture.start();
+        render();
+      } catch (e) {
+        error(e.message);
+      }
+    };
+    $("stop").onclick = async () => {
+      try {
+        capture = await window.capture.stop();
+        render();
+      } catch (e) {
+        error(e.message);
+      }
+    };
+    $("permission").onclick = () =>
+      window.capture.permissions(capture.permission);
   }
-  if(!initial.recallConfigured)error('Recall is not configured yet. Typed rehearsal still works.');
+  await poll();
 }
-init().catch(e=>error(e.message));
+init().catch((e) => error(e.message));
diff --git a/addons/auction-listener/web/index.html b/addons/auction-listener/web/index.html
index 7d3318a..d90f84b 100644
--- a/addons/auction-listener/web/index.html
+++ b/addons/auction-listener/web/index.html
@@ -1,16 +1,74 @@
 <!doctype html>
-<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Calcutta Listener</title><link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script></head>
-<body><main>
-  <header><div><span class="eyebrow">THE CALCUTTA · AUCTION LISTENER</span><h1>Let the auction speak.</h1><p>Call the lot. Announce the sale. Watch the board update.</p></div><span class="badge">LOCAL REHEARSAL</span></header>
-  <div class="notice">Practice results stay on this computer. The live Calcutta website is not connected yet. Starter lots are NFL teams; change them in Rehearsal setup below.</div>
-  <section class="control"><div><span id="indicator" class="dot"></span><strong id="status">Connecting…</strong><p id="status-detail">Opening the local auction board.</p></div><div class="buttons"><button id="start">Start listening</button><button id="stop" class="secondary" disabled>Stop</button><button id="permission" class="secondary" hidden>Open audio settings</button></div></section>
-  <p class="small">Start listening records your microphone and computer audio through Recall in US West. Let participants know recording is on. Keep the same audio devices selected during the rehearsal.</p>
-  <div id="error" role="alert" hidden></div>
-  <div class="columns"><section class="card"><span class="eyebrow">ON THE BLOCK</span><h2 id="current">Name the next lot</h2><p id="remaining"></p><div class="phrase">“Next up, Chiefs.”<br>“Sold to Craig for five hundred dollars.”<br>“Next up, Bills.”</div><p class="small">For a shared purchase: “Chiefs sold to Craig and Dave, fifty-fifty, for five hundred dollars.” Unknown shares are flagged for editing.</p></section><section class="card stats"><span class="eyebrow">AUCTION SO FAR</span><div><strong id="total">$0</strong><span>Total sold</span></div><div><strong id="count">0</strong><span>Lots sold</span></div><p id="recording-status" class="small">No recording started.</p></section></div>
-  <section class="card"><div class="section-heading"><h2>Results</h2><button id="add" class="secondary">Add a result</button></div><div class="table-wrap"><table><thead><tr><th>Order</th><th>Lot</th><th>Owner / share</th><th>Price</th><th></th></tr></thead><tbody id="results"></tbody></table></div><p id="empty" class="muted">Your first completed sale will appear here automatically.</p></section>
-  <div class="columns bottom"><section class="card"><h2>What we heard</h2><p class="small">Final speech can create results. Partial speech is shown in italics while Recall finishes recognizing it.</p><div id="transcript" class="feed"><p class="muted">Waiting for speech.</p></div></section><section class="card"><h2>Needs a look</h2><p class="small">Uncertain announcements are held here. Use “Add a result” or edit an existing row.</p><div id="reviews" class="feed"><p class="muted">No unresolved announcements.</p></div></section></div>
-  <details class="card"><summary>Practice without recording</summary><p>Typed rehearsal uses the same auction interpreter as live speech. It does not test audio or transcription speed.</p><form id="practice"><label for="announcement">Auction announcement</label><input id="announcement" placeholder="Next up, Chiefs." required maxlength="2000"><button>Send practice phrase</button></form></details>
-  <details class="card"><summary>Rehearsal setup &amp; saved results</summary><p>The starter list contains 32 NFL teams. Change it for your auction, one lot per line. Add nicknames after a pipe: <code>Kansas City Chiefs | Chiefs | KC</code>.</p><label for="lots">Known lots</label><textarea id="lots" rows="7"></textarea><div class="buttons"><button id="new" class="secondary">Start a fresh rehearsal</button><a href="/api/export" download="calcutta-rehearsal.json">Save results &amp; correction history</a><button id="open-board" class="secondary" hidden>Open board in browser</button></div><p class="small">A fresh rehearsal archives the current results locally. No data is sent to the production website.</p></details>
-  <footer>Calcutta Listener · v0 · Local rehearsal · Recall audio + a limited auction phrase interpreter</footer>
-  <dialog id="editor"><form id="edit-form"><h2 id="edit-title">Edit result</h2><label for="edit-lot">Lot</label><select id="edit-lot"></select><label for="edit-price">Total sale price ($)</label><input id="edit-price" type="number" min="0.01" max="1000000" step="0.01" required><label for="edit-owners">Owners and percentages — one per line</label><textarea id="edit-owners" rows="4" placeholder="Craig, 50&#10;Dave, 50" required></textarea><p class="small">Percentages must total 100. Correct spellings here; edits are saved in history.</p><p id="edit-error" role="alert"></p><div class="buttons"><button>Save result</button><button id="cancel-edit" type="button" class="secondary">Cancel</button></div></form></dialog>
-</main></body></html>
+<html lang="en">
+  <head>
+    <meta charset="utf-8" />
+    <meta name="viewport" content="width=device-width,initial-scale=1" />
+    <title>Calcutta Listener</title>
+    <link rel="stylesheet" href="/style.css" />
+    <script src="/app.js" defer></script>
+  </head>
+  <body>
+    <main>
+      <header>
+        <div>
+          <span class="eyebrow">THE CALCUTTA</span>
+          <h1>Auction Listener</h1>
+        </div>
+        <span id="connection" class="badge">Not connected</span>
+      </header>
+      <p id="auction">Open the listener from your website’s Auction tab.</p>
+      <section class="control">
+        <div>
+          <span id="indicator" class="dot"></span
+          ><strong id="status">Ready</strong>
+          <p id="status-detail">Connect to an auction to begin.</p>
+        </div>
+        <div class="buttons">
+          <button id="start" disabled>Start listening</button
+          ><button id="stop" class="secondary" disabled>Stop</button
+          ><button id="permission" class="secondary" hidden>
+            Open audio settings
+          </button>
+        </div>
+      </section>
+      <p class="small">
+        Start listening captures microphone and computer audio. Results are
+        final only after the website confirms they are saved.
+      </p>
+      <div id="error" role="alert" hidden></div>
+      <section class="card nomination">
+        <span class="eyebrow">ACTIVE LOT</span>
+        <h2 id="current" aria-live="polite" aria-atomic="true"></h2>
+      </section>
+      <section class="card">
+        <h2>What we heard</h2>
+        <div id="transcript" class="feed" aria-live="polite">
+          <p class="muted">Waiting for speech.</p>
+        </div>
+      </section>
+      <section class="card">
+        <div class="section-heading">
+          <h2>Results</h2>
+          <span id="pending" role="status"></span>
+        </div>
+        <div class="table-wrap">
+          <table>
+            <thead>
+              <tr>
+                <th>Lot</th>
+                <th>Winning consortia</th>
+                <th>Ownership</th>
+                <th>Final amount</th>
+                <th>Status / action</th>
+              </tr>
+            </thead>
+            <tbody id="results"></tbody>
+          </table>
+        </div>
+        <p id="empty" class="muted">
+          Results from this auction will appear here.
+        </p>
+      </section>
+    </main>
+  </body>
+</html>
diff --git a/addons/auction-listener/web/style.css b/addons/auction-listener/web/style.css
index b04f397..c6a6b2b 100644
--- a/addons/auction-listener/web/style.css
+++ b/addons/auction-listener/web/style.css
@@ -1,2 +1,258 @@
-:root{font-family:Inter,Segoe UI,Arial,sans-serif;color:#153733;background:#f4f5ee;font-size:15px}*{box-sizing:border-box}body{margin:0}main{max-width:1160px;margin:auto;padding:36px 32px}header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:24px}h1{font-size:40px;font-weight:650;letter-spacing:-1.8px;margin:12px 0}h2{font-size:22px;margin:0 0 14px;letter-spacing:-.4px}p{line-height:1.55;color:#577069;margin:8px 0}.eyebrow{font-size:11px;letter-spacing:1.8px;font-weight:750}.badge{font-size:11px;font-weight:750;padding:9px 12px;border-radius:30px;background:#e3ebd2;white-space:nowrap}.notice{background:#e8eddd;border-left:3px solid #94a766;padding:12px 16px;font-size:13px}.control{background:#183f39;color:white;display:flex;justify-content:space-between;align-items:center;gap:20px;padding:22px 24px;border-radius:12px;margin-top:22px}.control p{color:#bed0c9;font-size:13px;margin:6px 0 0 20px}.dot{display:inline-block;width:9px;height:9px;background:#a6b6af;border-radius:50%;margin-right:10px}.dot.active{background:#c4ed7d;box-shadow:0 0 0 5px #c4ed7d22}button{font:inherit;font-size:13px;font-weight:650;border:0;border-radius:6px;background:#cce79c;color:#193e32;padding:11px 17px;cursor:pointer;white-space:nowrap}button:hover{filter:brightness(.95)}button:disabled{opacity:.45;cursor:default}.secondary{background:#e9ede4;color:#32574a}.control .secondary{background:#31544a;color:white}.buttons{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.small{font-size:12px}.columns{display:grid;grid-template-columns:1.4fr 1fr;gap:20px;margin:22px 0}.card{background:#fff;border:1px solid #dce3d6;border-radius:10px;padding:23px}.card h2{font-weight:600}.card>.eyebrow{color:#698269}#current{font-size:32px;margin:14px 0 6px}.phrase{margin:18px 0 12px;padding:13px 16px;background:#f4f6ef;border-radius:6px;line-height:1.9;font-size:14px}.stats>div{display:inline-flex;flex-direction:column;margin:24px 30px 16px 0}.stats strong{font-size:35px;letter-spacing:-1px}.stats span:not(.eyebrow){font-size:12px;color:#698269;margin-top:6px}.section-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.section-heading h2{margin:0}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;text-align:left}th{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:#708277;padding:10px 8px;border-bottom:1px solid #dce3d6}td{padding:16px 8px;font-size:14px;border-bottom:1px solid #edf0e8}td:first-child{color:#849180;width:50px}td:nth-child(4){font-weight:650}.muted{color:#859282;font-size:13px;padding:12px 0}.bottom{grid-template-columns:1fr 1fr}.feed{max-height:235px;overflow:auto}.feed article{padding:12px 0;border-bottom:1px solid #edf0e8;font-size:13px;line-height:1.5}.feed article p{font-size:12px}.partial{font-style:italic;opacity:.6}.warn{color:#94661c;background:#fff4dc;border-radius:5px;padding:3px 6px;font-size:11px;display:inline-block;margin-top:5px}details{margin:20px 0}summary{font-weight:650;cursor:pointer}details p{font-size:13px;margin:16px 0}label{display:block;font-size:12px;font-weight:650;margin:16px 0 7px}input,textarea,select{width:100%;border:1px solid #bdccbe;border-radius:5px;font:inherit;padding:11px;color:#183f39;background:#fcfdf9;margin-bottom:12px}textarea{resize:vertical}a{color:#315f4c;font-size:13px}footer{font-size:11px;color:#81927d;text-align:center;padding:14px}#error{background:#fff0e8;color:#8e3d27;padding:14px;border-radius:6px;margin-top:12px}dialog{border:1px solid #bdccbe;border-radius:12px;padding:28px;max-width:500px;width:90%;color:#183f39}dialog::backdrop{background:#12372f88}#edit-error{color:#a33e20;font-size:13px}[hidden]{display:none!important}button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #78a66c;outline-offset:3px}@media(max-width:780px){main{padding:22px 16px}.columns{grid-template-columns:1fr}h1{font-size:30px}.control{flex-direction:column;align-items:stretch}header{flex-wrap:wrap}.card{padding:18px}}
-.stats>.eyebrow{display:block}
+:root {
+  font-family:
+    Inter,
+    Segoe UI,
+    Arial,
+    sans-serif;
+  color: #153733;
+  background: #f4f5ee;
+  font-size: 15px;
+}
+* {
+  box-sizing: border-box;
+}
+body {
+  margin: 0;
+}
+main {
+  max-width: 1160px;
+  margin: auto;
+  padding: 28px 32px;
+}
+header,
+.section-heading {
+  display: flex;
+  justify-content: space-between;
+  align-items: center;
+  gap: 20px;
+}
+h1 {
+  font-size: 32px;
+  letter-spacing: -1px;
+  margin: 8px 0;
+}
+h2 {
+  font-size: 22px;
+  margin: 0 0 14px;
+}
+p {
+  line-height: 1.5;
+  color: #577069;
+}
+.eyebrow {
+  font-size: 11px;
+  letter-spacing: 1.8px;
+  font-weight: 750;
+}
+.badge {
+  font-size: 12px;
+  padding: 9px 12px;
+  border-radius: 30px;
+  background: #e3ebd2;
+}
+.control {
+  background: #183f39;
+  color: white;
+  display: flex;
+  justify-content: space-between;
+  align-items: center;
+  gap: 20px;
+  padding: 22px 24px;
+  border-radius: 12px;
+  margin-top: 20px;
+}
+.control p {
+  color: #bed0c9;
+  font-size: 13px;
+  margin: 6px 0 0 20px;
+}
+.dot {
+  display: inline-block;
+  width: 9px;
+  height: 9px;
+  background: #a6b6af;
+  border-radius: 50%;
+  margin-right: 10px;
+}
+.dot.active {
+  background: #c4ed7d;
+  box-shadow: 0 0 0 5px #c4ed7d22;
+}
+button {
+  font: inherit;
+  font-size: 13px;
+  font-weight: 650;
+  border: 0;
+  border-radius: 6px;
+  background: #cce79c;
+  color: #193e32;
+  padding: 10px 14px;
+  cursor: pointer;
+}
+button:hover {
+  filter: brightness(0.95);
+}
+button:disabled {
+  opacity: 0.45;
+  cursor: default;
+}
+.secondary {
+  background: #e9ede4;
+  color: #32574a;
+}
+.control .secondary {
+  background: #31544a;
+  color: white;
+}
+.buttons {
+  display: flex;
+  align-items: center;
+  gap: 10px;
+  flex-wrap: wrap;
+}
+.small,
+small {
+  font-size: 12px;
+}
+small {
+  display: block;
+  max-width: 260px;
+  margin-top: 6px;
+}
+.card {
+  background: #fff;
+  border: 1px solid #dce3d6;
+  border-radius: 10px;
+  padding: 22px;
+  margin: 18px 0;
+}
+.nomination {
+  min-height: 110px;
+}
+#current {
+  font-size: 30px;
+  margin: 12px 0 0;
+  min-height: 36px;
+}
+.new-lot {
+  animation: acknowledge 1.6s ease-out;
+}
+@keyframes acknowledge {
+  from {
+    background: #d6efaa;
+  }
+  to {
+    background: transparent;
+  }
+}
+.table-wrap {
+  overflow: auto;
+}
+table {
+  border-collapse: collapse;
+  width: 100%;
+  text-align: left;
+}
+th {
+  font-size: 11px;
+  text-transform: uppercase;
+  letter-spacing: 0.8px;
+  color: #708277;
+  padding: 10px 8px;
+  border-bottom: 1px solid #dce3d6;
+}
+td {
+  padding: 14px 8px;
+  font-size: 14px;
+  border-bottom: 1px solid #edf0e8;
+  vertical-align: top;
+}
+td button {
+  display: block;
+  margin-top: 8px;
+}
+td div {
+  min-height: 24px;
+}
+.active-lot {
+  background: #f0f6e3;
+  box-shadow: inset 4px 0 #719e3b;
+}
+.needs-review {
+  background: #fff0ed;
+  color: #a02c25;
+}
+.needs-review small {
+  font-weight: 600;
+}
+.muted {
+  color: #65766b;
+  font-size: 13px;
+}
+.feed {
+  max-height: 180px;
+  overflow: auto;
+}
+.feed article {
+  padding: 10px 0;
+  border-bottom: 1px solid #edf0e8;
+  font-size: 14px;
+  line-height: 1.5;
+}
+.partial {
+  font-style: italic;
+  color: #697b71;
+}
+input,
+select {
+  width: 100%;
+  min-width: 110px;
+  border: 1px solid #bdccbe;
+  border-radius: 5px;
+  font: inherit;
+  padding: 9px;
+  color: #183f39;
+  background: #fcfdf9;
+  margin-bottom: 10px;
+}
+#error {
+  background: #fff0ed;
+  color: #a02c25;
+  padding: 14px;
+  border-radius: 6px;
+  margin-top: 12px;
+}
+#pending {
+  font-size: 12px;
+  color: #6f5b24;
+}
+[hidden] {
+  display: none !important;
+}
+:focus-visible {
+  outline: 3px solid #78a66c;
+  outline-offset: 3px;
+}
+@media (prefers-reduced-motion: reduce) {
+  .new-lot {
+    animation: none;
+  }
+}
+@media (max-width: 780px) {
+  main {
+    padding: 20px 16px;
+  }
+  .control {
+    flex-direction: column;
+    align-items: stretch;
+  }
+  header {
+    flex-wrap: wrap;
+  }
+  .card {
+    padding: 16px;
+  }
+  table {
+    min-width: 650px;
+  }
+}
diff --git a/artifacts/api-server/package.json b/artifacts/api-server/package.json
index 9cbf627..f5bef11 100644
--- a/artifacts/api-server/package.json
+++ b/artifacts/api-server/package.json
@@ -28,6 +28,7 @@
     "zod": "catalog:"
   },
   "devDependencies": {
+    "@electric-sql/pglite": "^0.5.8",
     "@types/cookie-parser": "^1.4.10",
     "@types/cors": "^2.8.19",
     "@types/express": "^5.0.6",
diff --git a/artifacts/api-server/src/lib/auctionAllocations.ts b/artifacts/api-server/src/lib/auctionAllocations.ts
new file mode 100644
index 0000000..9512172
--- /dev/null
+++ b/artifacts/api-server/src/lib/auctionAllocations.ts
@@ -0,0 +1,188 @@
+import { eq } from "drizzle-orm";
+import {
+  auctionConsortiaTable,
+  auctionConsortiumOwnersTable,
+} from "@workspace/db";
+export type AllocationInput = {
+  bidderId?: number;
+  consortiumId?: number;
+  share: number;
+};
+type ExpandedAllocation = {
+  bidderId: number;
+  consortiumId: number;
+  basisPoints: number;
+  cents: number;
+};
+export function shareBasisPoints(share: number): number {
+  if (
+    !Number.isFinite(share) ||
+    share <= 0 ||
+    share > 1 ||
+    Math.abs(share * 10000 - Math.round(share * 10000)) > 1e-7
+  ) {
+    throw new Error(
+      "Allocation shares must be positive, use at most four decimals, and total exactly 100%.",
+    );
+  }
+  return Math.round(share * 10000);
+}
+function distributeIntegerTotal<T extends { bidderId: number; weight: number }>(
+  rows: T[],
+  total: number,
+): Array<T & { amount: number }> {
+  const weightTotal = rows.reduce((sum, row) => sum + row.weight, 0);
+  if (!rows.length || weightTotal <= 0)
+    throw new Error("At least one positive owner allocation is required.");
+  const staged = rows.map((row) => {
+    const exact = (total * row.weight) / weightTotal;
+    const amount = Math.floor(exact);
+    return { ...row, amount, remainder: exact - amount };
+  });
+  let remaining = total - staged.reduce((sum, row) => sum + row.amount, 0);
+  const order = [...staged].sort(
+    (a, b) => b.remainder - a.remainder || a.bidderId - b.bidderId,
+  );
+  for (let i = 0; i < remaining; i++) order[i % order.length].amount++;
+  return staged.map((row) => {
+    const { remainder: _remainder, ...result } = row;
+    return result as T & { amount: number };
+  });
+}
+export function validateAllocationInput(shares: AllocationInput[]): void {
+  const seen = new Set<string>();
+  let total = 0;
+  for (const allocation of shares) {
+    if ((allocation.bidderId == null) === (allocation.consortiumId == null))
+      throw new Error(
+        "Each allocation must name exactly one bidder or consortium.",
+      );
+    const key =
+      allocation.consortiumId != null
+        ? `c${allocation.consortiumId}`
+        : `b${allocation.bidderId}`;
+    if (seen.has(key)) throw new Error("Allocation buyers must be unique.");
+    seen.add(key);
+    total += shareBasisPoints(allocation.share);
+  }
+  if (total !== 10000)
+    throw new Error(
+      "Allocation shares must be unique, use at most four decimals, and total exactly 100%.",
+    );
+}
+export async function expandSaleAllocations(
+  tx: any,
+  auctionId: number,
+  inputs: AllocationInput[],
+  totalCents: number,
+): Promise<ExpandedAllocation[]> {
+  validateAllocationInput(inputs);
+  const consortia = await tx
+    .select({
+      id: auctionConsortiaTable.id,
+      active: auctionConsortiaTable.active,
+    })
+    .from(auctionConsortiaTable)
+    .where(eq(auctionConsortiaTable.auctionId, auctionId));
+  const ownerRows = await tx
+    .select({
+      consortiumId: auctionConsortiumOwnersTable.consortiumId,
+      bidderId: auctionConsortiumOwnersTable.bidderId,
+      ownerShare: auctionConsortiumOwnersTable.share,
+    })
+    .from(auctionConsortiumOwnersTable)
+    .where(eq(auctionConsortiumOwnersTable.auctionId, auctionId));
+  const selected: Array<{
+    bidderId: number;
+    consortiumId: number;
+    weight: number;
+  }> = [];
+  for (const input of inputs) {
+    const consortium =
+      input.consortiumId != null
+        ? consortia.find(
+            (item: { id: number; active: number }) =>
+              item.id === input.consortiumId,
+          )
+        : undefined;
+    const directOwner =
+      input.bidderId == null
+        ? undefined
+        : ownerRows.find(
+            (owner: { bidderId: number }) => owner.bidderId === input.bidderId,
+          );
+    const resolvedConsortium =
+      consortium ??
+      (directOwner
+        ? consortia.find(
+            (item: { id: number; active: number }) =>
+              item.id === directOwner.consortiumId,
+          )
+        : undefined);
+    if (!resolvedConsortium || resolvedConsortium.active !== 1)
+      throw new Error(
+        "Every buyer must belong to an active consortium in this auction.",
+      );
+    const inputBps = shareBasisPoints(input.share);
+    if (input.bidderId != null) {
+      if (!directOwner || directOwner.consortiumId !== resolvedConsortium.id)
+        throw new Error(
+          "Every bidder-level buyer must be an active roster owner.",
+        );
+      selected.push({
+        bidderId: input.bidderId,
+        consortiumId: resolvedConsortium.id,
+        weight: inputBps,
+      });
+    } else {
+      const owners = ownerRows.filter(
+        (owner: { consortiumId: number }) =>
+          owner.consortiumId === resolvedConsortium.id,
+      );
+      const ownerTotal = owners.reduce(
+        (sum: number, owner: { ownerShare: string }) =>
+          sum + Math.round(Number(owner.ownerShare) * 10000),
+        0,
+      );
+      if (!owners.length || ownerTotal !== 10000)
+        throw new Error(
+          "The selected consortium does not have a complete owner roster.",
+        );
+      for (const owner of owners) {
+        selected.push({
+          bidderId: owner.bidderId,
+          consortiumId: resolvedConsortium.id,
+          weight: inputBps * Math.round(Number(owner.ownerShare) * 10000),
+        });
+      }
+    }
+  }
+  if (
+    new Set(selected.map((owner) => owner.bidderId)).size !== selected.length
+  ) {
+    throw new Error(
+      "Expanded allocations cannot assign one bidder more than once.",
+    );
+  }
+  const shares = distributeIntegerTotal(selected, 10000).map((row) => ({
+    bidderId: row.bidderId,
+    consortiumId: row.consortiumId,
+    basisPoints: row.amount,
+  }));
+  if (shares.some((share) => share.basisPoints <= 0))
+    throw new Error(
+      "Every expanded owner must receive at least one basis point.",
+    );
+  const withCents = distributeIntegerTotal(
+    shares.map((share) => ({ ...share, weight: share.basisPoints })),
+    totalCents,
+  ).map((row) => ({
+    bidderId: row.bidderId,
+    consortiumId: row.consortiumId,
+    basisPoints: row.basisPoints,
+    cents: row.amount,
+  }));
+  if (withCents.some((allocation) => allocation.cents <= 0))
+    throw new Error("Every owner must receive at least one cent.");
+  return withCents;
+}
diff --git a/artifacts/api-server/src/lib/auctionState.ts b/artifacts/api-server/src/lib/auctionState.ts
new file mode 100644
index 0000000..f89109f
--- /dev/null
+++ b/artifacts/api-server/src/lib/auctionState.ts
@@ -0,0 +1,132 @@
+import { and, asc, eq, sql } from "drizzle-orm";
+import {
+  db,
+  auctionSessionsTable,
+  auctionLotsTable,
+  auctionConsortiaTable,
+  auctionConsortiumOwnersTable,
+  auctionSalesTable,
+  auctionSaleAllocationsTable,
+  auctionEventsTable,
+  biddersTable,
+} from "@workspace/db";
+export async function snapshot(
+  auctionId: number,
+  executor: Pick<typeof db, "select"> = db,
+) {
+  const [session] = await executor
+    .select()
+    .from(auctionSessionsTable)
+    .where(eq(auctionSessionsTable.id, auctionId));
+  if (!session) return null;
+  const lots = await executor
+    .select()
+    .from(auctionLotsTable)
+    .where(eq(auctionLotsTable.auctionId, auctionId))
+    .orderBy(
+      asc(auctionLotsTable.nominationSequence),
+      asc(auctionLotsTable.id),
+    );
+  const consortia = await executor
+    .select()
+    .from(auctionConsortiaTable)
+    .where(eq(auctionConsortiaTable.auctionId, auctionId));
+  const sales = await executor
+    .select()
+    .from(auctionSalesTable)
+    .where(eq(auctionSalesTable.auctionId, auctionId));
+  const allocations = await executor
+    .select({
+      saleId: auctionSaleAllocationsTable.saleId,
+      bidderId: auctionSaleAllocationsTable.bidderId,
+      share: auctionSaleAllocationsTable.share,
+      cents: auctionSaleAllocationsTable.cents,
+      bidderName: biddersTable.name,
+      consortiumName: auctionConsortiaTable.displayName,
+      consortiumId: auctionSaleAllocationsTable.consortiumId,
+    })
+    .from(auctionSaleAllocationsTable)
+    .innerJoin(
+      biddersTable,
+      eq(biddersTable.id, auctionSaleAllocationsTable.bidderId),
+    )
+    .leftJoin(
+      auctionConsortiaTable,
+      eq(auctionConsortiaTable.id, auctionSaleAllocationsTable.consortiumId),
+    )
+    .innerJoin(
+      auctionSalesTable,
+      eq(auctionSalesTable.id, auctionSaleAllocationsTable.saleId),
+    )
+    .where(eq(auctionSalesTable.auctionId, auctionId));
+  const ownerRows = await executor
+    .select({
+      consortiumId: auctionConsortiumOwnersTable.consortiumId,
+      bidderId: auctionConsortiumOwnersTable.bidderId,
+      bidderName: biddersTable.name,
+      share: auctionConsortiumOwnersTable.share,
+    })
+    .from(auctionConsortiumOwnersTable)
+    .innerJoin(
+      biddersTable,
+      eq(biddersTable.id, auctionConsortiumOwnersTable.bidderId),
+    )
+    .where(eq(auctionConsortiumOwnersTable.auctionId, auctionId))
+    .orderBy(asc(auctionConsortiumOwnersTable.id));
+  const consortiaWithOwners = consortia.map((consortium) => ({
+    ...consortium,
+    owners: ownerRows
+      .filter((owner) => owner.consortiumId === consortium.id)
+      .map(({ consortiumId: _id, ...owner }) => ({
+        ...owner,
+        share: Number(owner.share),
+      })),
+  }));
+  const finalized = sales.reduce((sum, sale) => sum + sale.totalCents, 0);
+  const live =
+    lots.find((lot) => lot.status === "bidding")?.currentBidCents ?? 0;
+  return {
+    ...session,
+    lots,
+    consortia: consortiaWithOwners,
+    sales: sales.map((sale) => ({
+      ...sale,
+      allocations: allocations.filter(
+        (allocation) => allocation.saleId === sale.id,
+      ),
+    })),
+    metrics: {
+      poolSizeCents: finalized + live,
+      lotsSold: sales.length,
+      totalLots: lots.length,
+      averageSaleCents: sales.length
+        ? Math.round(finalized / sales.length)
+        : null,
+    },
+  };
+}
+export async function event(
+  tx: any,
+  auctionId: number,
+  type: string,
+  payload: Record<string, unknown>,
+  key?: string,
+  nominationId?: string,
+) {
+  const [{ max }] = await tx
+    .select({
+      max: sql<number>`coalesce(max(${auctionEventsTable.sequence}),0)`,
+    })
+    .from(auctionEventsTable)
+    .where(eq(auctionEventsTable.auctionId, auctionId));
+  await tx
+    .insert(auctionEventsTable)
+    .values({
+      auctionId,
+      sequence: Number(max) + 1,
+      eventType: type,
+      payload,
+      idempotencyKey: key,
+      nominationId,
+    });
+}
diff --git a/artifacts/api-server/src/lib/finalizeAuctionSale.ts b/artifacts/api-server/src/lib/finalizeAuctionSale.ts
new file mode 100644
index 0000000..d98c91c
--- /dev/null
+++ b/artifacts/api-server/src/lib/finalizeAuctionSale.ts
@@ -0,0 +1,233 @@
+import { and, eq, inArray, sql } from "drizzle-orm";
+import {
+  db,
+  calcuttasTable,
+  auctionSessionsTable,
+  auctionLotsTable,
+  auctionConsortiaTable,
+  auctionSalesTable,
+  auctionSaleAllocationsTable,
+  auctionEventsTable,
+  positionsTable,
+  tradesTable,
+  listenerSessionsTable,
+} from "@workspace/db";
+import { OWNERSHIP_SEASON_LOCK_NAMESPACE } from "./ownershipShares";
+import { event } from "./auctionState";
+
+import {
+  expandSaleAllocations,
+  validateAllocationInput,
+  type AllocationInput,
+} from "./auctionAllocations";
+
+type SaleInput = {
+  totalCents: number;
+  allocations: AllocationInput[];
+  expectedRevision?: number;
+  reason?: string;
+};
+type ListenerSubmission = {
+  id: string;
+  key: string;
+  requestId: string;
+  fingerprint: string;
+  nominationId: string;
+};
+
+// Both commissioner and listener sales use the same ownership transaction.
+export async function finalizeAuctionSale(
+  calcuttaId: number,
+  auctionId: number,
+  lotId: number,
+  input: SaleInput,
+  listener?: ListenerSubmission,
+  database: Pick<typeof db, "transaction"> = db,
+) {
+  const total = input.totalCents,
+    shares = input.allocations;
+  if (!Number.isSafeInteger(total) || total <= 0 || total > 2147483647)
+    throw new Error("Invalid sale price.");
+  validateAllocationInput(shares);
+  return database.transaction(async (tx) => {
+    const [calcutta] = await tx
+      .select({ seasonId: calcuttasTable.seasonId })
+      .from(calcuttasTable)
+      .where(eq(calcuttasTable.id, calcuttaId));
+    if (!calcutta) throw new Error("Calcutta not found.");
+    await tx.execute(
+      sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${calcutta.seasonId})`,
+    );
+    const [session] = await tx
+      .select()
+      .from(auctionSessionsTable)
+      .where(eq(auctionSessionsTable.id, auctionId))
+      .for("update");
+    if (!session || session.calcuttaId !== calcuttaId)
+      throw new Error("Auction does not belong to this Calcutta.");
+    if (listener) {
+      const [credential] = await tx
+        .select()
+        .from(listenerSessionsTable)
+        .where(eq(listenerSessionsTable.id, listener.id))
+        .for("update");
+      if (
+        !credential ||
+        credential.auctionId !== auctionId ||
+        credential.revokedAt ||
+        credential.expiresAt <= new Date()
+      )
+        throw new Error(
+          "Listener session expired. Reconnect from the website.",
+        );
+      const [replay] = await tx
+        .select()
+        .from(auctionEventsTable)
+        .where(
+          and(
+            eq(auctionEventsTable.auctionId, auctionId),
+            eq(auctionEventsTable.idempotencyKey, listener.key),
+          ),
+        );
+      if (replay) {
+        if (
+          replay.eventType !== "sale_finalized" ||
+          replay.payload.fingerprint !== listener.fingerprint
+        )
+          throw new Error(
+            "Submission ID was already used for a different result.",
+          );
+        return {
+          saleId: Number(replay.payload.saleId),
+          idempotencyKey: listener.requestId,
+        };
+      }
+    }
+    const [lot] = await tx
+      .select()
+      .from(auctionLotsTable)
+      .where(
+        and(
+          eq(auctionLotsTable.id, lotId),
+          eq(auctionLotsTable.auctionId, auctionId),
+        ),
+      )
+      .for("update");
+    if (
+      !session ||
+      session.status === "complete" ||
+      !lot ||
+      lot.status !== "bidding"
+    )
+      throw new Error("Auction is complete or lot is not currently bidding.");
+    if (
+      input.expectedRevision != null &&
+      session.revision !== input.expectedRevision
+    )
+      throw new Error("Stale auction revision.");
+    if (
+      listener &&
+      (session.status !== "live" ||
+        session.currentLotId !== lotId ||
+        lot.nominationId !== listener.nominationId)
+    )
+      throw new Error(
+        "The nominated lot changed. Review this result in the website.",
+      );
+    const [trade] = await tx
+      .select({ id: tradesTable.id })
+      .from(tradesTable)
+      .where(
+        and(
+          eq(tradesTable.entryId, lot.entryId),
+          eq(tradesTable.status, "approved"),
+        ),
+      )
+      .limit(1);
+    if (trade)
+      throw new Error(
+        "Approved trades protect this ownership; use the established correcting trade workflow.",
+      );
+    const existingPrimary = await tx
+      .select({ id: positionsTable.id })
+      .from(positionsTable)
+      .where(
+        and(
+          eq(positionsTable.entryId, lot.entryId),
+          eq(positionsTable.source, "primary"),
+        ),
+      )
+      .limit(1);
+    if (existingPrimary[0])
+      throw new Error(
+        "This entry already has primary ownership. Historical ownership is immutable; use the established correction workflow.",
+      );
+    const allocations = await expandSaleAllocations(
+      tx,
+      auctionId,
+      shares,
+      total,
+    );
+    const [sale] = await tx
+      .insert(auctionSalesTable)
+      .values({
+        auctionId,
+        lotId,
+        totalCents: total,
+        reason: input.reason,
+        source: listener ? "listener" : "manual",
+      })
+      .returning();
+    const allocs = allocations.map((a) => ({
+      saleId: sale.id,
+      bidderId: a.bidderId,
+      consortiumId: a.consortiumId,
+      share: (a.basisPoints / 10000).toFixed(6),
+      cents: a.cents,
+    }));
+    if (allocs.some((a) => a.cents <= 0))
+      throw new Error("Every buyer must receive at least one cent.");
+    await tx.insert(auctionSaleAllocationsTable).values(allocs);
+    await tx
+      .delete(positionsTable)
+      .where(
+        and(
+          eq(positionsTable.entryId, lot.entryId),
+          eq(positionsTable.source, "primary"),
+        ),
+      );
+    await tx
+      .insert(positionsTable)
+      .values(
+        allocations.map((a) => ({
+          entryId: lot.entryId,
+          bidderId: a.bidderId,
+          ownershipShare: (a.basisPoints / 10000).toFixed(6),
+          source: "primary",
+          costBasis: (a.cents / 100).toFixed(2),
+        })),
+      );
+    await tx
+      .update(auctionLotsTable)
+      .set({ status: "sold", currentBidCents: total })
+      .where(eq(auctionLotsTable.id, lotId));
+    await tx
+      .update(auctionSessionsTable)
+      .set({ currentLotId: null, revision: session.revision + 1 })
+      .where(eq(auctionSessionsTable.id, auctionId));
+    await event(
+      tx,
+      auctionId,
+      "sale_finalized",
+      {
+        lotId,
+        saleId: sale.id,
+        totalCents: total,
+        ...(listener ? { fingerprint: listener.fingerprint } : {}),
+      },
+      listener?.key,
+      listener?.nominationId,
+    );
+    return { saleId: sale.id, idempotencyKey: listener?.requestId };
+  });
+}
diff --git a/artifacts/api-server/src/lib/listenerResult.ts b/artifacts/api-server/src/lib/listenerResult.ts
new file mode 100644
index 0000000..40360ab
--- /dev/null
+++ b/artifacts/api-server/src/lib/listenerResult.ts
@@ -0,0 +1,47 @@
+import { createHash } from "node:crypto";
+import { z } from "zod/v4";
+
+export const listenerResultSchema = z
+  .object({
+    idempotencyKey: z.string().uuid(),
+    lotId: z.number().int().positive(),
+    nominationId: z.string().uuid(),
+    totalCents: z.number().int().positive().max(100_000_000),
+    allocations: z
+      .array(
+        z.object({
+          consortiumId: z.number().int().positive(),
+          basisPoints: z.number().int().positive().max(10000),
+        }),
+      )
+      .min(1)
+      .max(8),
+  })
+  .strict()
+  .superRefine((value, ctx) => {
+    if (
+      new Set(value.allocations.map((a) => a.consortiumId)).size !==
+        value.allocations.length ||
+      value.allocations.reduce((n, a) => n + a.basisPoints, 0) !== 10000
+    ) {
+      ctx.addIssue({
+        code: "custom",
+        message: "Choose distinct buyers with shares totaling exactly 100%.",
+      });
+    }
+  });
+
+export function resultFingerprint(value: z.infer<typeof listenerResultSchema>) {
+  return createHash("sha256")
+    .update(
+      JSON.stringify({
+        lotId: value.lotId,
+        nominationId: value.nominationId,
+        totalCents: value.totalCents,
+        allocations: [...value.allocations].sort(
+          (a, b) => a.consortiumId - b.consortiumId,
+        ),
+      }),
+    )
+    .digest("hex");
+}
diff --git a/artifacts/api-server/src/lib/listenerSale.test.mjs b/artifacts/api-server/src/lib/listenerSale.test.mjs
new file mode 100644
index 0000000..4e233fc
--- /dev/null
+++ b/artifacts/api-server/src/lib/listenerSale.test.mjs
@@ -0,0 +1,84 @@
+import test from 'node:test';
+import assert from 'node:assert/strict';
+import { PGlite } from '@electric-sql/pglite';
+import { drizzle } from 'drizzle-orm/pglite';
+import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
+import { SQL, is } from 'drizzle-orm';
+import { listenerResultSchema, resultFingerprint } from './listenerResult.ts';
+
+// The service uses only this injected in-memory PostgreSQL instance. Never a hosted DB.
+process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
+const schema = await import('@workspace/db');
+const { finalizeAuctionSale } = await import('./finalizeAuctionSale.ts');
+const tables=['calcuttasTable','auctionSessionsTable','auctionLotsTable','auctionConsortiaTable','auctionConsortiumOwnersTable','auctionSalesTable','auctionSaleAllocationsTable','auctionEventsTable','positionsTable','tradesTable','listenerSessionsTable'];
+const nominationId='11111111-1111-4111-8111-111111111111';
+const sessionId='22222222-2222-4222-8222-222222222222';
+const requestId='33333333-3333-4333-8333-333333333333';
+const valid={idempotencyKey:requestId,lotId:10,nominationId,totalCents:50000,allocations:[{consortiumId:1,basisPoints:6000},{consortiumId:2,basisPoints:4000}]};
+
+async function fixture(t) {
+  const pg=new PGlite(); await pg.waitReady; t.after(()=>pg.close());
+  const db=drizzle(pg), dialect=new PgDialect();
+  for(const name of tables) {
+    const table=getTableConfig(schema[name]);
+    const columns=table.columns.map(c=>{
+      let def='';
+      if(is(c.default,SQL))def=` DEFAULT ${dialect.sqlToQuery(c.default).sql}`;
+      else if(c.default!==undefined)def=` DEFAULT '${(typeof c.default==='object'?JSON.stringify(c.default):String(c.default)).replaceAll("'","''")}'`;
+      return `"${c.name}" ${c.getSQLType()}${c.primary?' PRIMARY KEY':''}${def}`;
+    });
+    await pg.exec(`CREATE TABLE "${table.name}" (${columns.join(',')});`);
+  }
+  await pg.exec(`
+    CREATE UNIQUE INDEX sales_lot ON auction_sales(lot_id);
+    CREATE UNIQUE INDEX events_key ON auction_events(auction_id,idempotency_key);
+    CREATE UNIQUE INDEX events_sequence ON auction_events(auction_id,sequence);
+    CREATE UNIQUE INDEX allocation_buyer ON auction_sale_allocations(sale_id,bidder_id);
+    INSERT INTO calcuttas(id,season_id) VALUES(1,1);
+    INSERT INTO auction_sessions(id,calcutta_id,status,current_lot_id,revision) VALUES(1,1,'live',10,0);
+    INSERT INTO auction_lots(id,auction_id,entry_id,display_name,status,nomination_id) VALUES(10,1,100,'Chiefs','bidding','${nominationId}');
+    INSERT INTO auction_consortia(id,auction_id,display_name,active) VALUES(1,1,'Alpha',1),(2,1,'Bravo',1);
+    INSERT INTO auction_consortium_owners(auction_id,consortium_id,bidder_id,share) VALUES(1,1,101,.5),(1,1,102,.5),(1,2,103,1);
+    INSERT INTO listener_sessions(id,auction_id,token_hash,expires_at) VALUES('${sessionId}',1,'unused','2099-01-01');
+  `);
+  const submit=(value=valid,overrides={})=>finalizeAuctionSale(1,1,value.lotId,{totalCents:value.totalCents,allocations:value.allocations.map(a=>({consortiumId:a.consortiumId,share:a.basisPoints/10000}))},{id:sessionId,key:`listener:${sessionId}:${value.idempotencyKey}`,requestId:value.idempotencyKey,fingerprint:resultFingerprint(value),nominationId:value.nominationId,...overrides},db);
+  return {db,pg,submit};
+}
+test('result schema rejects fractional/duplicate/incomplete shares and fingerprints canonical order',()=>{
+  assert.equal(listenerResultSchema.safeParse(valid).success,true);
+  for(const allocations of [[{consortiumId:1,basisPoints:9999}],[{consortiumId:1,basisPoints:5000},{consortiumId:1,basisPoints:5000}],[{consortiumId:1,basisPoints:10000.1}]]) assert.equal(listenerResultSchema.safeParse({...valid,allocations}).success,false);
+  assert.equal(resultFingerprint(valid),resultFingerprint({...valid,allocations:[...valid.allocations].reverse()}));
+});
+test('sale, expanded ownership and receipt commit once; identical retries are harmless',async t=>{
+  const f=await fixture(t);const first=await f.submit();const second=await f.submit();assert.deepEqual(second,first);
+  const sales=await f.db.select().from(schema.auctionSalesTable);assert.equal(sales.length,1);assert.equal(sales[0].source,'listener');
+  const positions=await f.db.select().from(schema.positionsTable);assert.equal(positions.length,3);assert.deepEqual(positions.map(p=>Number(p.ownershipShare)),[.3,.3,.4]);
+  assert.equal(positions.reduce((n,p)=>n+Math.round(Number(p.costBasis)*100),0),50000);
+  const [auction]=await f.db.select().from(schema.auctionSessionsTable);assert.equal(auction.currentLotId,null);assert.equal(auction.revision,1);
+  await assert.rejects(f.submit({...valid,totalCents:60000}),/different result/);
+  assert.equal((await f.db.select().from(schema.auctionSalesTable))[0].totalCents,50000);
+});
+test('stale nomination, revoked credential and inactive consortium cannot write ownership',async t=>{
+  const f=await fixture(t);
+  await assert.rejects(f.submit({...valid,nominationId:'44444444-4444-4444-8444-444444444444'}),/nominated lot changed/);
+  await f.pg.exec('UPDATE auction_consortia SET active=0 WHERE id=1');await assert.rejects(f.submit(),/active consortium/);
+  await f.pg.exec(`UPDATE auction_consortia SET active=1; UPDATE listener_sessions SET revoked_at=now()`);await assert.rejects(f.submit(),/expired/);
+  assert.equal((await f.db.select().from(schema.positionsTable)).length,0);assert.equal((await f.db.select().from(schema.auctionSalesTable)).length,0);
+});
+test('database failure rolls back the sale and leaves it safe to retry',async t=>{
+  const f=await fixture(t);
+  await f.pg.exec(`ALTER TABLE positions ADD CONSTRAINT deliberate_failure CHECK(cost_basis < 0)`);
+  await assert.rejects(f.submit());assert.equal((await f.db.select().from(schema.auctionSalesTable)).length,0);
+  assert.equal((await f.db.select().from(schema.auctionEventsTable)).length,0);
+  await f.pg.exec('ALTER TABLE positions DROP CONSTRAINT deliberate_failure');await f.submit();assert.equal((await f.db.select().from(schema.auctionSalesTable)).length,1);
+});
+test('manual finalization uses the same consortium expansion and protects existing sales',async t=>{
+  const f=await fixture(t);await finalizeAuctionSale(1,1,10,{totalCents:50000,expectedRevision:0,allocations:[{consortiumId:1,share:1}]},undefined,f.db);
+  assert.equal((await f.db.select().from(schema.positionsTable)).length,2);
+  await assert.rejects(f.submit(),/not currently bidding/);
+});
+test('simultaneous retries acknowledge one sale; a different operation cannot sell the lot twice',async t=>{
+  const f=await fixture(t);const receipts=await Promise.all([f.submit(),f.submit()]);assert.deepEqual(receipts[0],receipts[1]);
+  await assert.rejects(f.submit({...valid,idempotencyKey:'55555555-5555-4555-8555-555555555555'}),/not currently bidding/);
+  assert.equal((await f.db.select().from(schema.auctionSalesTable)).length,1);
+});
diff --git a/artifacts/api-server/src/lib/listenerTickets.test.mjs b/artifacts/api-server/src/lib/listenerTickets.test.mjs
new file mode 100644
index 0000000..5d434b6
--- /dev/null
+++ b/artifacts/api-server/src/lib/listenerTickets.test.mjs
@@ -0,0 +1,53 @@
+import test from 'node:test';
+import assert from 'node:assert/strict';
+import {randomUUID} from 'node:crypto';
+import {ListenerTickets} from './listenerTickets.ts';
+
+function fixture() {
+  let now=1000000;
+  const rows=new Map(), sessions=new Map();
+  const repository={
+    createTicket:async row=>rows.set(row.hash,row),
+    getSession:async id=>sessions.get(id),
+    withTicket:async(hash,fn)=>fn({
+      getTicket:async()=>rows.get(hash),
+      getOpenAuction:async id=>({id,calcuttaId:id+10,name:`Calcutta ${id}`}),
+      getSession:async id=>sessions.get(id),
+      activateSession:async row=>sessions.set(row.id,row),
+      markRedeemed:async data=>Object.assign(rows.get(hash),data),
+      resumeSession:async(id,expiresAt)=>Object.assign(sessions.get(id),{expiresAt}),
+    }),
+  };
+  const service=new ListenerTickets({repository,secret:'s'.repeat(32),now:()=>now});
+  const issue=async(id=1)=>{
+    const issued=await service.issue(id,'https://thecalcutta.app');
+    return {...Object.fromEntries(new URLSearchParams(new URL(issued.launchUrl).hash.slice(1))),redemptionId:randomUUID()};
+  };
+  return {service,issue,sessions,advance:()=>{now+=50000000;}};
+}
+test('preview identifies destination without consuming ticket or creating credentials',async()=>{
+  const f=fixture(), ticket=await f.issue();
+  assert.equal((await f.service.preview(ticket)).auction.id,1);
+  assert.equal(f.sessions.size,0);
+  await f.service.redeem(ticket);assert.equal(f.sessions.size,1);
+});
+test('expired same-device session resumes with pending deliveries and identical receipt identity',async()=>{
+  const f=fixture(), first=await f.service.redeem(await f.issue());
+  f.sessions.get(first.id).pending=3;f.advance();
+  const request={...await f.issue(),resume:{id:first.id,token:first.token}};
+  const resumed=await f.service.redeem(request);
+  assert.equal(resumed.id,first.id);assert.equal(resumed.token,first.token);
+  assert.equal(f.sessions.size,1);assert.equal(f.sessions.get(first.id).pending,3);
+  assert.equal((await f.service.authenticate(first.id,first.token)).id,first.id);
+  assert.deepEqual(await f.service.redeem(request),resumed);
+});
+test('resume cannot transfer credentials to another auction or revive revoked/recording sessions',async()=>{
+  const f=fixture(), first=await f.service.redeem(await f.issue());
+  const resume={id:first.id,token:first.token};
+  await assert.rejects(f.service.redeem({...await f.issue(2),resume}),/could not be resumed/);
+  await assert.rejects(f.service.redeem({...await f.issue(),resume:{...resume,token:'x'.repeat(43)}}),/could not be resumed/);
+  f.sessions.get(first.id).recording=true;
+  await assert.rejects(f.service.redeem({...await f.issue(),resume}),/could not be resumed/);
+  f.sessions.get(first.id).recording=false;f.sessions.get(first.id).revokedAt=new Date();
+  await assert.rejects(f.service.redeem({...await f.issue(),resume}),/could not be resumed/);
+});
diff --git a/artifacts/api-server/src/lib/listenerTickets.ts b/artifacts/api-server/src/lib/listenerTickets.ts
new file mode 100644
index 0000000..40e9081
--- /dev/null
+++ b/artifacts/api-server/src/lib/listenerTickets.ts
@@ -0,0 +1,56 @@
+import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
+
+const digest = (value: string) => createHash("sha256").update(value).digest("hex");
+const ticketShape = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
+export class ListenerTickets {
+  repository: any; secret!: string; now: () => number = Date.now;
+  constructor(options: any) { if (typeof options.secret !== "string" || options.secret.length < 32) throw new Error("Listener signing secret must contain at least 32 characters."); Object.assign(this, options); }
+  async issue(auctionId: number, origin: string) {
+    if (new URL(origin).origin !== origin || !origin.startsWith("https://")) throw new Error("HTTPS origin required.");
+    const ticket = randomBytes(32).toString("base64url"); const expiresAt = new Date(this.now() + 90_000).toISOString();
+    await this.repository.createTicket({ hash: digest(ticket), auctionId, origin, expiresAt });
+    return { launchUrl: `calcutta-listener://connect#${new URLSearchParams({ origin, ticket })}`, expiresAt };
+  }
+  async preview({ticket, origin}: any) {
+    if (!ticketShape(ticket)) throw new Error("Invalid connection ticket.");
+    return this.repository.withTicket(digest(ticket), async (tx: any) => {
+      const row = await tx.getTicket();
+      if (!row || row.origin !== origin || Date.parse(row.expiresAt) <= this.now()) throw new Error("Connection link expired.");
+      const auction = await tx.getOpenAuction(row.auctionId);
+      if (!auction) throw new Error("Auction is unavailable or complete.");
+      return {auction};
+    });
+  }
+  async redeem({ ticket, redemptionId, origin, resume }: any) {
+    if (!ticketShape(ticket) || !/^[0-9a-f-]{36}$/.test(redemptionId ?? "")) throw new Error("Invalid connection ticket.");
+    return this.repository.withTicket(digest(ticket), async (tx: any) => {
+      const row = await tx.getTicket();
+      if (!row || row.origin !== origin || Date.parse(row.expiresAt) <= this.now()) throw new Error("Connection link expired.");
+      const auction = await tx.getOpenAuction(row.auctionId); if (!auction) throw new Error("Auction is unavailable or complete.");
+      if (row.redemptionId && row.redemptionId !== redemptionId) throw new Error("Connection ticket already used.");
+      // Keep the same receipt namespace and pending deliveries when this device reconnects.
+      if (resume) {
+        if (row.sessionId && row.sessionId !== resume.id) throw new Error("Connection ticket already used.");
+        const existing = await tx.getSession(resume.id);
+        if (existing && existing.auctionId === row.auctionId && !existing.revokedAt && !existing.recording &&
+            ticketShape(resume.token) && existing.tokenHash.length === 64 && timingSafeEqual(Buffer.from(existing.tokenHash), Buffer.from(digest(resume.token)))) {
+          const expiresAt = new Date(this.now() + 43_200_000).toISOString();
+          await tx.resumeSession(existing.id, expiresAt);
+          await tx.markRedeemed({redemptionId, sessionId: existing.id});
+          return {id: existing.id, token: resume.token, expiresAt, auction};
+        }
+        throw new Error("Existing listener could not be resumed. Resolve its connection before replacing it.");
+      }
+      const token = createHmac("sha256", this.secret).update(`calcutta-listener-v1:${row.hash}:${redemptionId}`).digest("base64url");
+      if (row.sessionId) { const existing = await tx.getSession(row.sessionId); if (!existing || existing.revokedAt || Date.parse(existing.expiresAt) <= this.now()) throw new Error("Listener session is no longer active."); return { id: existing.id, token, expiresAt: existing.expiresAt, auction }; }
+      const session = { id: randomUUID(), auctionId: row.auctionId, tokenHash: digest(token), expiresAt: new Date(this.now() + 43_200_000).toISOString() };
+      await tx.activateSession(session); await tx.markRedeemed({ redemptionId, sessionId: session.id }); return { id: session.id, token, expiresAt: session.expiresAt, auction };
+    });
+  }
+  async authenticate(id: string, token: string) {
+    if (!ticketShape(token) || !/^[0-9a-f-]{36}$/.test(id ?? "")) throw new Error("Unauthorized listener.");
+    const row = await this.repository.getSession(id); const hash = digest(token);
+    if (!row || row.revokedAt || Date.parse(row.expiresAt) <= this.now() || hash.length !== row.tokenHash.length || !timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(hash))) throw new Error("Unauthorized listener.");
+    return row;
+  }
+}
diff --git a/artifacts/api-server/src/routes/auctions.ts b/artifacts/api-server/src/routes/auctions.ts
index 57477bd..b54fcca 100644
--- a/artifacts/api-server/src/routes/auctions.ts
+++ b/artifacts/api-server/src/routes/auctions.ts
@@ -12,6 +12,10 @@ import { OWNERSHIP_SEASON_LOCK_NAMESPACE } from "../lib/ownershipShares";
 import { requireAdmin } from "../middlewares/requireAdmin";
 import { ErrorResponse, sendParsedJson } from "../lib/sendParsedJson";
 
+import { snapshot, event } from "../lib/auctionState";
+import { expandSaleAllocations, validateAllocationInput, shareBasisPoints } from "../lib/auctionAllocations";
+import { finalizeAuctionSale } from "../lib/finalizeAuctionSale";
+
 const router: IRouter = Router();
 const id = z.coerce.number().int().positive();
 const lotInput = z.object({
@@ -30,131 +34,6 @@ function cents(value: number): number {
   if (result <= 0) throw new Error("Sale price must be at least one cent.");
   return result;
 }
-type AllocationInput = { bidderId?: number; consortiumId?: number; share: number };
-type ExpandedAllocation = { bidderId: number; consortiumId: number; basisPoints: number; cents: number };
-function shareBasisPoints(share: number): number {
-  if (!Number.isFinite(share) || share <= 0 || share > 1 || Math.abs(share * 10000 - Math.round(share * 10000)) > 1e-7) {
-    throw new Error("Allocation shares must be positive, use at most four decimals, and total exactly 100%.");
-  }
-  return Math.round(share * 10000);
-}
-function distributeIntegerTotal<T extends { bidderId: number; weight: number }>(rows: T[], total: number): Array<T & { amount: number }> {
-  const weightTotal = rows.reduce((sum, row) => sum + row.weight, 0);
-  if (!rows.length || weightTotal <= 0) throw new Error("At least one positive owner allocation is required.");
-  const staged = rows.map((row) => {
-    const exact = total * row.weight / weightTotal;
-    const amount = Math.floor(exact);
-    return { ...row, amount, remainder: exact - amount };
-  });
-  let remaining = total - staged.reduce((sum, row) => sum + row.amount, 0);
-  const order = [...staged].sort((a, b) => b.remainder - a.remainder || a.bidderId - b.bidderId);
-  for (let i = 0; i < remaining; i++) order[i % order.length].amount++;
-  return staged.map((row) => {
-    const { remainder: _remainder, ...result } = row;
-    return result as T & { amount: number };
-  });
-}
-function validateAllocationInput(shares: AllocationInput[]): void {
-  const seen = new Set<string>();
-  let total = 0;
-  for (const allocation of shares) {
-    if ((allocation.bidderId == null) === (allocation.consortiumId == null)) throw new Error("Each allocation must name exactly one bidder or consortium.");
-    const key = allocation.consortiumId != null ? `c${allocation.consortiumId}` : `b${allocation.bidderId}`;
-    if (seen.has(key)) throw new Error("Allocation buyers must be unique.");
-    seen.add(key);
-    total += shareBasisPoints(allocation.share);
-  }
-  if (total !== 10000) throw new Error("Allocation shares must be unique, use at most four decimals, and total exactly 100%.");
-}
-async function expandSaleAllocations(tx: any, auctionId: number, inputs: AllocationInput[], totalCents: number): Promise<ExpandedAllocation[]> {
-  validateAllocationInput(inputs);
-  const consortia = await tx.select({
-    id: auctionConsortiaTable.id,
-    active: auctionConsortiaTable.active,
-  }).from(auctionConsortiaTable).where(eq(auctionConsortiaTable.auctionId, auctionId));
-  const ownerRows = await tx.select({
-    consortiumId: auctionConsortiumOwnersTable.consortiumId,
-    bidderId: auctionConsortiumOwnersTable.bidderId,
-    ownerShare: auctionConsortiumOwnersTable.share,
-  }).from(auctionConsortiumOwnersTable).where(eq(auctionConsortiumOwnersTable.auctionId, auctionId));
-  const selected: Array<{ bidderId: number; consortiumId: number; weight: number }> = [];
-  for (const input of inputs) {
-    const consortium = input.consortiumId != null
-      ? consortia.find((item: { id: number; active: number }) => item.id === input.consortiumId)
-      : undefined;
-    const directOwner = input.bidderId == null ? undefined : ownerRows.find((owner: { bidderId: number }) => owner.bidderId === input.bidderId);
-    const resolvedConsortium = consortium ?? (directOwner ? consortia.find((item: { id: number; active: number }) => item.id === directOwner.consortiumId) : undefined);
-    if (!resolvedConsortium || resolvedConsortium.active !== 1) throw new Error("Every buyer must belong to an active consortium in this auction.");
-    const inputBps = shareBasisPoints(input.share);
-    if (input.bidderId != null) {
-      if (!directOwner || directOwner.consortiumId !== resolvedConsortium.id) throw new Error("Every bidder-level buyer must be an active roster owner.");
-      selected.push({ bidderId: input.bidderId, consortiumId: resolvedConsortium.id, weight: inputBps });
-    } else {
-      const owners = ownerRows.filter((owner: { consortiumId: number }) => owner.consortiumId === resolvedConsortium.id);
-      const ownerTotal = owners.reduce((sum: number, owner: { ownerShare: string }) => sum + Math.round(Number(owner.ownerShare) * 10000), 0);
-      if (!owners.length || ownerTotal !== 10000) throw new Error("The selected consortium does not have a complete owner roster.");
-      for (const owner of owners) {
-        selected.push({
-          bidderId: owner.bidderId,
-          consortiumId: resolvedConsortium.id,
-          weight: inputBps * Math.round(Number(owner.ownerShare) * 10000),
-        });
-      }
-    }
-  }
-  if (new Set(selected.map((owner) => owner.bidderId)).size !== selected.length) {
-    throw new Error("Expanded allocations cannot assign one bidder more than once.");
-  }
-  const shares = distributeIntegerTotal(selected, 10000).map((row) => ({
-    bidderId: row.bidderId, consortiumId: row.consortiumId, basisPoints: row.amount,
-  }));
-  if (shares.some((share) => share.basisPoints <= 0)) throw new Error("Every expanded owner must receive at least one basis point.");
-  const withCents = distributeIntegerTotal(shares.map((share) => ({ ...share, weight: share.basisPoints })), totalCents)
-    .map((row) => ({ bidderId: row.bidderId, consortiumId: row.consortiumId, basisPoints: row.basisPoints, cents: row.amount }));
-  if (withCents.some((allocation) => allocation.cents <= 0)) throw new Error("Every owner must receive at least one cent.");
-  return withCents;
-}
-async function snapshot(auctionId: number) {
-  const [session] = await db.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, auctionId));
-  if (!session) return null;
-  const lots = await db.select().from(auctionLotsTable).where(eq(auctionLotsTable.auctionId, auctionId)).orderBy(asc(auctionLotsTable.nominationSequence), asc(auctionLotsTable.id));
-  const consortia = await db.select().from(auctionConsortiaTable).where(eq(auctionConsortiaTable.auctionId, auctionId));
-  const sales = await db.select().from(auctionSalesTable).where(eq(auctionSalesTable.auctionId, auctionId));
-  const allocations = await db.select({
-    saleId: auctionSaleAllocationsTable.saleId,
-    bidderId: auctionSaleAllocationsTable.bidderId,
-    share: auctionSaleAllocationsTable.share,
-    cents: auctionSaleAllocationsTable.cents,
-    bidderName: biddersTable.name,
-    consortiumName: auctionConsortiaTable.displayName,
-    consortiumId: auctionSaleAllocationsTable.consortiumId,
-  }).from(auctionSaleAllocationsTable)
-    .innerJoin(biddersTable, eq(biddersTable.id, auctionSaleAllocationsTable.bidderId))
-    .leftJoin(auctionConsortiaTable, eq(auctionConsortiaTable.id, auctionSaleAllocationsTable.consortiumId))
-    .innerJoin(auctionSalesTable, eq(auctionSalesTable.id, auctionSaleAllocationsTable.saleId))
-    .where(eq(auctionSalesTable.auctionId, auctionId));
-  const ownerRows = await db.select({
-    consortiumId: auctionConsortiumOwnersTable.consortiumId,
-    bidderId: auctionConsortiumOwnersTable.bidderId,
-    bidderName: biddersTable.name,
-    share: auctionConsortiumOwnersTable.share,
-  }).from(auctionConsortiumOwnersTable).innerJoin(biddersTable, eq(biddersTable.id, auctionConsortiumOwnersTable.bidderId))
-    .where(eq(auctionConsortiumOwnersTable.auctionId, auctionId))
-    .orderBy(asc(auctionConsortiumOwnersTable.id));
-  const consortiaWithOwners = consortia.map((consortium) => ({
-    ...consortium,
-    owners: ownerRows.filter((owner) => owner.consortiumId === consortium.id).map(({ consortiumId: _id, ...owner }) => ({
-      ...owner, share: Number(owner.share),
-    })),
-  }));
-  const finalized = sales.reduce((sum, sale) => sum + sale.totalCents, 0);
-  const live = lots.find((lot) => lot.status === "bidding")?.currentBidCents ?? 0;
-  return { ...session, lots, consortia: consortiaWithOwners, sales: sales.map((sale) => ({ ...sale, allocations: allocations.filter((allocation) => allocation.saleId === sale.id) })), metrics: { poolSizeCents: finalized + live, lotsSold: sales.length, totalLots: lots.length, averageSaleCents: sales.length ? Math.round(finalized / sales.length) : null } };
-}
-async function event(tx: any, auctionId: number, type: string, payload: Record<string, unknown>, key?: string, nominationId?: string) {
-  const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${auctionEventsTable.sequence}),0)` }).from(auctionEventsTable).where(eq(auctionEventsTable.auctionId, auctionId));
-  await tx.insert(auctionEventsTable).values({ auctionId, sequence: Number(max) + 1, eventType: type, payload, idempotencyKey: key, nominationId });
-}
 function routeIds(req: any): { calcuttaId: number; auctionId: number } {
   return { calcuttaId: Number(req.params.calcuttaId), auctionId: Number(req.params.auctionId) };
 }
@@ -557,30 +436,7 @@ router.post("/calcuttas/:calcuttaId/auctions/:auctionId/lots/:lotId/sale", requi
   try { total = body.data.totalCents ?? cents(body.data.price!); validateAllocationInput(body.data.allocations); }
   catch (e) { return sendParsedJson(res, ErrorResponse, { error: e instanceof Error ? e.message : "Invalid sale allocation." }, 422); }
   try {
-    await db.transaction(async (tx) => {
-      const [calcutta] = await tx.select({ seasonId: calcuttasTable.seasonId }).from(calcuttasTable).where(eq(calcuttasTable.id, calcuttaId));
-      if (!calcutta) throw new Error("Calcutta not found.");
-      await tx.execute(sql`select pg_advisory_xact_lock(${OWNERSHIP_SEASON_LOCK_NAMESPACE}, ${calcutta.seasonId})`);
-      const [session] = await tx.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, auctionId)).for("update");
-      const [lot] = await tx.select().from(auctionLotsTable).where(and(eq(auctionLotsTable.id, lotId), eq(auctionLotsTable.auctionId, auctionId))).for("update");
-      if (!session || session.status === "complete" || !lot || lot.status !== "bidding") throw new Error("Auction is complete or lot is not currently bidding.");
-      if (body.data.expectedRevision != null && session.revision !== body.data.expectedRevision) throw new Error("Stale auction revision.");
-      const [trade] = await tx.select({ id: tradesTable.id }).from(tradesTable).where(and(eq(tradesTable.entryId, lot.entryId), eq(tradesTable.status, "approved"))).limit(1);
-      if (trade) throw new Error("Approved trades protect this ownership; use the established correcting trade workflow.");
-      const existingPrimary = await tx.select({ id: positionsTable.id }).from(positionsTable).where(and(eq(positionsTable.entryId, lot.entryId), eq(positionsTable.source, "primary"))).limit(1);
-      if (existingPrimary[0]) throw new Error("This entry already has primary ownership. Historical ownership is immutable; use the established correction workflow.");
-      const allocations = await expandSaleAllocations(tx, auctionId, body.data.allocations, total);
-      const [sale] = await tx.insert(auctionSalesTable).values({ auctionId, lotId, totalCents: total, reason: body.data.reason }).returning();
-      const allocs = allocations.map((a) => ({
-        saleId: sale.id, bidderId: a.bidderId, consortiumId: a.consortiumId,
-        share: (a.basisPoints / 10000).toFixed(6), cents: a.cents,
-      }));
-      await tx.insert(auctionSaleAllocationsTable).values(allocs);
-      await tx.delete(positionsTable).where(and(eq(positionsTable.entryId, lot.entryId), eq(positionsTable.source, "primary")));
-      await tx.insert(positionsTable).values(allocations.map((a) => ({ entryId: lot.entryId, bidderId: a.bidderId, ownershipShare: (a.basisPoints / 10000).toFixed(6), source: "primary", costBasis: (a.cents / 100).toFixed(2) })));
-      await tx.update(auctionLotsTable).set({ status: "sold", currentBidCents: total }).where(eq(auctionLotsTable.id, lotId));
-      await tx.update(auctionSessionsTable).set({ revision: session.revision + 1 }).where(eq(auctionSessionsTable.id, auctionId)); await event(tx, auctionId, "sale_finalized", { lotId, saleId: sale.id, totalCents: total });
-    }); res.json(await snapshot(auctionId));
+    await finalizeAuctionSale(calcuttaId, auctionId, lotId, { ...body.data, totalCents: total }); res.json(await snapshot(auctionId));
   } catch (e) { sendParsedJson(res, ErrorResponse, { error: e instanceof Error ? e.message : "Sale failed." }, 409); }
 });
 
@@ -643,4 +499,4 @@ router.get("/calcuttas/:calcuttaId/auctions/:auctionId/events", async (req, res)
   const after = Number(req.query.after ?? 0); res.json(await db.select().from(auctionEventsTable).where(and(eq(auctionEventsTable.auctionId, auctionId), sql`${auctionEventsTable.sequence} > ${after}`)).orderBy(asc(auctionEventsTable.sequence)).limit(500));
 });
 
-export default router;
\ No newline at end of file
+export default router;
diff --git a/artifacts/api-server/src/routes/listener.ts b/artifacts/api-server/src/routes/listener.ts
index 39340e2..5fe9c87 100644
--- a/artifacts/api-server/src/routes/listener.ts
+++ b/artifacts/api-server/src/routes/listener.ts
@@ -1,44 +1,14 @@
 import { Router } from "express";
 import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
-import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
 import { z } from "zod/v4";
 import { db, auctionSessionsTable, calcuttasTable, listenerTicketsTable, listenerSessionsTable, listenerTranscriptEventsTable } from "@workspace/db";
 import { requireAdmin } from "../middlewares/requireAdmin";
 import { rateLimit } from "express-rate-limit";
+import { snapshot } from "../lib/auctionState";
+import { finalizeAuctionSale } from "../lib/finalizeAuctionSale";
+import { listenerResultSchema, resultFingerprint } from "../lib/listenerResult";
 
-// Faithful TS port of hosted/tickets.mjs. Keeping this in the server bundle
-// avoids a runtime-relative .mjs dependency after esbuild output.
-const digest = (value: string) => createHash("sha256").update(value).digest("hex");
-const ticketShape = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
-class ListenerTickets {
-  repository: any; secret!: string; now!: () => number;
-  constructor(options: any) { if (typeof options.secret !== "string" || options.secret.length < 32) throw new Error("Listener signing secret must contain at least 32 characters."); Object.assign(this, options); }
-  async issue(auctionId: number, origin: string) {
-    if (new URL(origin).origin !== origin || !origin.startsWith("https://")) throw new Error("HTTPS origin required.");
-    const ticket = randomBytes(32).toString("base64url"); const expiresAt = new Date(this.now() + 90_000).toISOString();
-    await this.repository.createTicket({ hash: digest(ticket), auctionId, origin, expiresAt });
-    return { launchUrl: `calcutta-listener://connect#${new URLSearchParams({ origin, ticket })}`, expiresAt };
-  }
-  async redeem({ ticket, redemptionId, origin }: any) {
-    if (!ticketShape(ticket) || !/^[0-9a-f-]{36}$/.test(redemptionId ?? "")) throw new Error("Invalid connection ticket.");
-    return this.repository.withTicket(digest(ticket), async (tx: any) => {
-      const row = await tx.getTicket();
-      if (!row || row.origin !== origin || Date.parse(row.expiresAt) <= this.now()) throw new Error("Connection link expired.");
-      const auction = await tx.getOpenAuction(row.auctionId); if (!auction) throw new Error("Auction is unavailable or complete.");
-      if (row.redemptionId && row.redemptionId !== redemptionId) throw new Error("Connection ticket already used.");
-      const token = createHmac("sha256", this.secret).update(`calcutta-listener-v1:${row.hash}:${redemptionId}`).digest("base64url");
-      if (row.sessionId) { const existing = await tx.getSession(row.sessionId); if (!existing || existing.revokedAt || Date.parse(existing.expiresAt) <= this.now()) throw new Error("Listener session is no longer active."); return { id: existing.id, token, expiresAt: existing.expiresAt, auction }; }
-      const session = { id: randomUUID(), auctionId: row.auctionId, tokenHash: digest(token), expiresAt: new Date(this.now() + 43_200_000).toISOString() };
-      await tx.activateSession(session); await tx.markRedeemed({ redemptionId, sessionId: session.id }); return { id: session.id, token, expiresAt: session.expiresAt, auction };
-    });
-  }
-  async authenticate(id: string, token: string) {
-    if (!ticketShape(token) || !/^[0-9a-f-]{36}$/.test(id ?? "")) throw new Error("Unauthorized listener.");
-    const row = await this.repository.getSession(id); const hash = digest(token);
-    if (!row || row.revokedAt || Date.parse(row.expiresAt) <= this.now() || hash.length !== row.tokenHash.length || !timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(hash))) throw new Error("Unauthorized listener.");
-    return row;
-  }
-}
+import { ListenerTickets } from "../lib/listenerTickets";
 
 const router = Router();
 const uuid = z.string().uuid();
@@ -72,10 +42,13 @@ const repository = {
   async withTicket(hash: string, callback: (tx: any) => Promise<any>) {
     return db.transaction(async (tx) => callback({
       getTicket: async () => (await tx.select().from(listenerTicketsTable).where(eq(listenerTicketsTable.hash, hash)).for("update").limit(1))[0],
-      getOpenAuction: async (id: number) => (await tx.select({ id: auctionSessionsTable.id, name: calcuttasTable.name, status: auctionSessionsTable.status })
+      getOpenAuction: async (id: number) => (await tx.select({ id: auctionSessionsTable.id, calcuttaId: calcuttasTable.id, name: calcuttasTable.name, status: auctionSessionsTable.status })
         .from(auctionSessionsTable).innerJoin(calcuttasTable, eq(calcuttasTable.id, auctionSessionsTable.calcuttaId))
         .where(and(eq(auctionSessionsTable.id, id), sql`${auctionSessionsTable.status} <> 'complete'`)).for("update").limit(1))[0],
       getSession: async (id: string) => (await tx.select().from(listenerSessionsTable).where(eq(listenerSessionsTable.id, id)).for("update").limit(1))[0],
+      resumeSession: async (id: string, expiresAt: string) => {
+        await tx.update(listenerSessionsTable).set({expiresAt: new Date(expiresAt)}).where(eq(listenerSessionsTable.id, id));
+      },
       activateSession: async (session: any) => {
         const old = await tx.select().from(listenerSessionsTable).where(and(eq(listenerSessionsTable.auctionId, session.auctionId), isNull(listenerSessionsTable.revokedAt))).for("update");
         if (old.some((x: any) => x.recording || x.pending > 0)) throw new Error("An active listener is recording or has pending deliveries.");
@@ -106,8 +79,16 @@ router.post("/listener/tickets", requireAdmin, async (req, res) => {
 });
 
 const pairLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });
+router.post("/listener/preview", pairLimiter, async (req, res) => {
+  noStore(res); const service = tickets();
+  const body = z.object({origin: z.string(), ticket: z.string()}).safeParse(req.body);
+  if (!service) return closed(res);
+  if (!body.success || body.data.origin !== publicOrigin()) return res.status(401).json({error: "Invalid connection ticket."});
+  try { return res.json(await service.preview(body.data)); }
+  catch { return res.status(410).json({error: "Invalid or expired connection ticket."}); }
+});
 router.post("/listener/pair", pairLimiter, async (req, res) => {
-  noStore(res); const service = tickets(); const body = z.object({ origin: z.string(), ticket: z.string(), redemptionId: uuid }).safeParse(req.body);
+  noStore(res); const service = tickets(); const body = z.object({ origin: z.string(), ticket: z.string(), redemptionId: uuid, resume: z.object({id: uuid, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).optional() }).safeParse(req.body);
   if (!service || !publicOrigin()) return closed(res);
   if (!body.success || body.data.origin !== publicOrigin()) return res.status(401).json({ error: "Invalid connection ticket." });
   try { return res.json(await service.redeem(body.data)); }
@@ -157,6 +138,48 @@ router.post("/listener/sessions/:id/events", async (req, res) => {
   } catch { return res.status(401).json({ error: "Unauthorized listener." }); }
 });
 
+// An authenticated, auction-scoped snapshot. No admin/Recall credential is sent to the desktop.
+router.get("/listener/sessions/:id/context", async (req, res) => {
+  noStore(res);
+  try {
+    const s = await session(req);
+    // Serialize against nomination, roster edits, and sale transactions.
+    const context = await db.transaction(async (tx) => {
+      const [auction] = await tx.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, s.auctionId)).for("update");
+      const [credential] = await tx.select().from(listenerSessionsTable).where(eq(listenerSessionsTable.id, s.id)).for("update");
+      if (!auction || auction.status === "complete" || !credential || credential.revokedAt || credential.expiresAt <= new Date()) throw new Error("Unauthorized listener.");
+      const value = await snapshot(s.auctionId, tx);
+      if (!value) throw new Error("Auction unavailable.");
+      return { ...value, protocolVersion: 2, serverTime: new Date().toISOString(), currentLotId: value.lots.find(l => l.id === value.currentLotId && l.status === "bidding")?.id ?? null };
+    });
+    return res.json(context);
+  } catch { return res.status(401).json({ error: "Reconnect the listener from an open auction." }); }
+});
+
+router.post("/listener/sessions/:id/results", async (req, res) => {
+  noStore(res);
+  let s;
+  try { s = await session(req); }
+  catch { return res.status(401).json({ error: "Reconnect the listener from the website." }); }
+  const parsed = listenerResultSchema.safeParse(req.body);
+  if (!parsed.success) return res.status(422).json({ error: "Check the lot, winners, amount and ownership percentages." });
+  try {
+    const [auction] = await db.select().from(auctionSessionsTable).where(eq(auctionSessionsTable.id, s.auctionId));
+    if (!auction) return res.status(404).json({ error: "Auction unavailable." });
+    const input = parsed.data;
+    const result = await finalizeAuctionSale(auction.calcuttaId, s.auctionId, input.lotId, {
+      totalCents: input.totalCents,
+      allocations: input.allocations.map(a => ({ consortiumId: a.consortiumId, share: a.basisPoints / 10000 })),
+    }, { id: s.id, nominationId: input.nominationId, key: `listener:${s.id}:${input.idempotencyKey}`, requestId: input.idempotencyKey, fingerprint: resultFingerprint(input) });
+    return res.json(result);
+  } catch (error) {
+    // Constraint/database internals must not be reflected to the desktop.
+    const message = error instanceof Error ? error.message : "";
+    const known = /^(Listener session expired|Submission ID was already used|The nominated lot changed|Auction is complete|Approved trades protect|This entry already has|Every buyer must|Every owner must|Every expanded owner|The selected consortium|Expanded allocations|Invalid sale price)/.test(message);
+    return res.status(known ? 409 : 503).json({ error: known ? message : "Result could not be saved. Retry when the website is available." });
+  }
+});
+
 router.post("/listener/sessions/:id/heartbeat", async (req, res) => {
   try {
     const s = await session(req); const body = z.object({ recording: z.boolean(), pending: z.number().int().nonnegative().max(10000).optional() }).safeParse(req.body);
@@ -217,4 +240,4 @@ router.post("/listener/revoke", requireAdmin, async (req, res) => {
   });
   return res.json({ ok: true });
 });
-export default router;
\ No newline at end of file
+export default router;
diff --git a/artifacts/nfl-auction/src/components/auction/ListenerConnect.tsx b/artifacts/nfl-auction/src/components/auction/ListenerConnect.tsx
index a912a5d..637885a 100644
--- a/artifacts/nfl-auction/src/components/auction/ListenerConnect.tsx
+++ b/artifacts/nfl-auction/src/components/auction/ListenerConnect.tsx
@@ -35,6 +35,10 @@ export function ListenerConnect({ auctionId, adminKey }: { auctionId: string | n
 
   useEffect(() => {
     const version = ++generation.current;
+    setLink(null);
+    setState(null);
+    setError("");
+    setBusy(false);
     const controller = new AbortController();
     let timeout: ReturnType<typeof setTimeout> | undefined;
     const poll = async () => {
@@ -75,7 +79,11 @@ export function ListenerConnect({ auctionId, adminKey }: { auctionId: string | n
         body: JSON.stringify({ auctionId }),
         cache: "no-store",
       });
-      if (!response.ok) throw new Error("Could not connect. Confirm this auction is open and try again.");
+      if (!response.ok) throw new Error(response.status === 503
+        ? "Listener connections are not configured on this website yet."
+        : response.status === 401 || response.status === 403
+        ? "Sign in as commissioner again to connect the listener."
+        : "Could not connect. Confirm this auction is open and try again.");
       const result = (await response.json()) as { launchUrl?: string };
       if (!result.launchUrl) throw new Error("Listener did not return a launch link.");
       const parsed = new URL(result.launchUrl);
@@ -98,6 +106,7 @@ export function ListenerConnect({ auctionId, adminKey }: { auctionId: string | n
   return (
     <section className="rounded-md border border-border bg-card p-4 space-y-2" aria-label="Auction listener">
       <h3 className="font-semibold">Calcutta Listener</h3>
+      <p className="text-sm text-muted-foreground">Connect to auction #{auctionId}. Saved listener history stays with this auction when you return.</p>
       <p role="status">{listenerStatus(state, unavailable)}</p>
       {state && <p className="text-xs text-muted-foreground">Pending deliveries: {state.pending ?? 0}</p>}
       <button type="button" onClick={() => void openListener()} disabled={busy} className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">
@@ -165,4 +174,4 @@ export function ListenerTranscript({ auctionId }: { auctionId: string | number }
       </div>
     </div>
   );
-}
\ No newline at end of file
+}
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index bc8e8d6..d1fcb10 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -205,7 +205,7 @@ importers:
         version: 2.8.6
       drizzle-orm:
         specifier: 'catalog:'
-        version: 0.45.2(@types/pg@8.20.0)(pg@8.22.0)
+        version: 0.45.2(@electric-sql/pglite@0.5.8)(@types/pg@8.20.0)(pg@8.22.0)
       express:
         specifier: ^5.2.1
         version: 5.2.1
@@ -225,6 +225,9 @@ importers:
         specifier: 'catalog:'
         version: 3.25.76
     devDependencies:
+      '@electric-sql/pglite':
+        specifier: ^0.5.8
+        version: 0.5.8
       '@types/cookie-parser':
         specifier: ^1.4.10
         version: 1.4.10(@types/express@5.0.6)
@@ -467,10 +470,10 @@ importers:
     dependencies:
       drizzle-orm:
         specifier: 'catalog:'
-        version: 0.45.2(@types/pg@8.20.0)(pg@8.22.0)
+        version: 0.45.2(@electric-sql/pglite@0.5.8)(@types/pg@8.20.0)(pg@8.22.0)
       drizzle-zod:
         specifier: ^0.8.3
-        version: 0.8.3(drizzle-orm@0.45.2(@types/pg@8.20.0)(pg@8.22.0))(zod@3.25.76)
+        version: 0.8.3(drizzle-orm@0.45.2(@electric-sql/pglite@0.5.8)(@types/pg@8.20.0)(pg@8.22.0))(zod@3.25.76)
       pg:
         specifier: ^8.22.0
         version: 8.22.0
@@ -648,6 +651,9 @@ packages:
   '@drizzle-team/brocli@0.10.2':
     resolution: {integrity: sha512-z33Il7l5dKjUgGULTqBsQBQwckHh5AbIuxhdsIxDDiZAzBOrZO6q9ogcWC65kU382AfynTfgNumVcNIjuIua6w==}
 
+  '@electric-sql/pglite@0.5.8':
+    resolution: {integrity: sha512-n9tsbUOhwx2epK1V0ZG9Ar4SHWUju04dhmzZXiSBXwBoleOvIfals33NAaWgagQVAL4Rbvx/Ptsu3P+pA09f6Q==}
+
   '@esbuild/linux-x64@0.27.3':
     resolution: {integrity: sha512-Czi8yzXUWIQYAtL/2y6vogER8pvcsOsk5cpwL4Gk5nJqH5UZiVByIY8Eorm5R13gq+DQKYg0+JyQoytLQas4dA==}
     engines: {node: '>=18'}
@@ -3470,6 +3476,8 @@ snapshots:
 
   '@drizzle-team/brocli@0.10.2': {}
 
+  '@electric-sql/pglite@0.5.8': {}
+
   '@esbuild/linux-x64@0.27.3':
     optional: true
 
@@ -4916,14 +4924,15 @@ snapshots:
       esbuild: 0.27.3
       tsx: 4.23.1
 
-  drizzle-orm@0.45.2(@types/pg@8.20.0)(pg@8.22.0):
+  drizzle-orm@0.45.2(@electric-sql/pglite@0.5.8)(@types/pg@8.20.0)(pg@8.22.0):
     optionalDependencies:
+      '@electric-sql/pglite': 0.5.8
       '@types/pg': 8.20.0
       pg: 8.22.0
 
-  drizzle-zod@0.8.3(drizzle-orm@0.45.2(@types/pg@8.20.0)(pg@8.22.0))(zod@3.25.76):
+  drizzle-zod@0.8.3(drizzle-orm@0.45.2(@electric-sql/pglite@0.5.8)(@types/pg@8.20.0)(pg@8.22.0))(zod@3.25.76):
     dependencies:
-      drizzle-orm: 0.45.2(@types/pg@8.20.0)(pg@8.22.0)
+      drizzle-orm: 0.45.2(@electric-sql/pglite@0.5.8)(@types/pg@8.20.0)(pg@8.22.0)
       zod: 3.25.76
 
   dunder-proto@1.0.1:
