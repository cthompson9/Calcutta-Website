# Dated consortium memberships are inert, and the client overrides them with today's roster anyway

_Audit finding P1-2._

Paste the block below to Replit as one task. Verify before moving on.

```
Historical consortium attribution is broken in three places. Fix the client side now; the
schema side gates the trade-offer feature.

1. artifacts/nfl-auction/src/pages/Results.tsx:192 builds consortiumByBidderId from
   GET /api/bidders, whose consortium field comes from loadCurrentBidderConsortiums()
   (routes/bidders.ts:94,151,172 - isNull(toDate), i.e. TODAY's roster). The server already
   resolves as-of membership correctly and returns it as row.consortium. Line 1359 uses it;
   14 other sites use the current-roster map instead: Results.tsx 559, 689, 696, 780, 930,
   971, 1166, 1504, 1510, 1764, 1899, 1910, 1958, 1963, plus Trades.tsx 178, 340, 349 and
   MtmTracker.tsx 649, 863, 1098. Switch all of them to the server-provided as-of value,
   and pass membershipView explicitly when the user asks for the current roster.
   Per .agents/memory/dated-consortium-reporting.md, as-of is the default and current is an
   explicit alternate view.

2. The production bridge wrote one open-ended membership per bidder with
   from_date = 1900-01-01, so the as-of join at lib/consortiumMemberships.ts:145-179
   matches that single row for EVERY historical anchor date - verified, ?season=2015 and
   ?season=2015&membershipView=current return identical rows. Since bidders.consortium_id
   has already been dropped, the 2015-2025 affiliations no longer exist in the database.
   Before loading Calcuttas I-XI, reconstruct each pool's as-of roster from an external
   record and write CLOSED from_date/to_date intervals.

3. Add calcutta_id to consortium_memberships (or a separate calcutta_rosters table). The
   current consortium_memberships_one_active_bidder_idx and the gist exclusion constraint
   allow a bidder to be in exactly one consortium at any instant, so a bidder cannot belong
   to different consortiums in two concurrent Calcuttas. Use a guarded migration in
   lib/db/src/migrations, never drizzle push (see .agents/memory/schema-push-safety.md).
   Also decide whether fractional consortium membership needs its own share column.
```
