# Six write endpoints have no credential check at all, and one of them cascade-deletes live ownership

_Audit finding P0-2._

Paste the block below to Replit as one task. Verify before moving on.

```
Several write endpoints in artifacts/api-server have no authentication at all. Fix them:

1. Add the existing admin-key check (the isAdminRequest pattern used in routes/teams.ts:40)
   to: POST /api/bidders, PATCH /api/bidders/:id, DELETE /api/bidders/:id
   (routes/bidders.ts:193/208/235), POST /api/seasons (routes/seasons.ts:13),
   POST /api/trades (routes/trades.ts:266), and PATCH /api/trades/:id
   (routes/trades.ts:354 - today only the `percentage` field is gated, the rest is open).

2. Extract that duplicated admin check into ONE shared middleware in
   artifacts/api-server/src/middlewares/requireAdmin.ts and use it everywhere. There are
   currently 7 copies (routes/trades.ts:91, teams.ts:40, results.ts:42, periods.ts:175,
   mtm.ts:39, auctionImport.ts:40, nflStandingsImport.ts:14). Use crypto.timingSafeEqual
   with a length pre-check, matching the pattern already in routes/jobs.ts:56-69, and
   compare only the extracted token rather than the whole Authorization header.

3. Replace the wildcard cors() at app.ts:30 with an explicit origin allowlist (the deployed
   Replit origin plus http://localhost:5173 for dev) and credentials: true.

4. Add helmet() and app.disable("x-powered-by").

Do not change any behaviour for requests that already send a valid admin key.
```
