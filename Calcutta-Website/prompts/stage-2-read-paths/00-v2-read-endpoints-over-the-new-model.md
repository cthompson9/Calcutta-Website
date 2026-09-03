# V2 read endpoints over the new model

_New work. Do this first in Stage 2._

```
Add read endpoints that serve the eleven historical Calcuttas from the new model, so no
historical pool ever touches the legacy read path. Calcutta XII continues to use the existing
endpoints unchanged.

Endpoints, all under /api/v2, all validating their response against the generated Zod schema
before returning (see the audit's finding on the 47 unvalidated res.json calls):

  GET /api/v2/pools
      every Calcutta, ordered by edition_number descending. Include sport, format_key,
      season_year, pot_size, status.

  GET /api/v2/pool/:id/entries
      one row per auction lot: label, kind (single|bundle|placeholder), attributes
      (seed / region / group / pot), price, the teams it holds, ownership (owner + signed
      share), the tracking narrative, points, payout.

  GET /api/v2/pool/:id/owners
      per owner: fractional lot count, cost, payout. Do NOT compute IRR or MOIC — the pool
      owner does not want derived investment metrics, just the tracking and the totals.

  GET /api/v2/pool/:id/trades
      entry-scoped and book-scoped trades, with scope, factor and basis surfaced.

Two rules that apply to all of them:

1. Every money field is nullable and carries an explicit coverage flag. Never render or
   return 0 where the honest answer is "no data" — that is exactly the bug that makes the
   legacy path report historical owners a 100% loss.

2. The tracking narrative is generated from scoring_events by a view, with the phrasing as
   the only sport-specific part (see reference/views.sql). Do not hand-write per-sport
   response builders.

Acceptance: the endpoints' figures for Calcuttas I-XI match team-by-team.csv and
owner-by-owner.csv in this handoff, to the cent.
```
