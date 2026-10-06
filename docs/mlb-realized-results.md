# MLB realized results

## Scope and activation

The MLB postseason results implementation is complete but **not activated**.
No production migration, runtime activation, or publishing is authorized by this work.
NFL results, ownership, MTM, the 11,420 denominator and the NFL poller retain their existing behavior.

Two independent gates protect ingestion:

1. The separately authorized event-identity migration in
   `lib/db/src/migrations/0066MlbEventIdentity.ts` must be applied in a transaction.
   It allows multiple MLB games between the same teams in a round while retaining
   the existing matchup uniqueness rule for every other sport. It is deliberately
   absent from the automatic startup migration registry. Do not run a schema push.
2. The API runtime must be explicitly enabled with `MLB_RESULTS_ENABLED=true`,
   only after separate authorization. This work does not set that variable.

Before activation, validate the selected MLB pool's 12 team identities, completed
auction/primary-ledger coverage, fixed consortium roster and all nine active
points rules. A commissioner-authorized retry is available at
`POST /api/calcuttas/:calcuttaId/mlb-results/refresh`; it does not bypass either
activation gate. No result read activates ingestion.

## Scoring and valuation policy

The selected pool's `calcutta_rules` are the sole MLB rubric authority, including
the auction/dashboard display. Missing, duplicate, inactive, unsupported or
invalid rules make values unavailable; no display-only or NFL default substitutes.

The user explicitly approved retaining Wild Card byes. The supplied reference
therefore contains **38 WC points: 9 game points + 9 sweep points + 20 bye points**.
Adding 40 provisional DS points, 56 LCS points and 56 WS points yields **190**,
not 170. This is a fixture, not a hardcoded provider total or live pot.

Each unfinished series contributes its full legal 3/5/7-game allowance at the
round's win rate, including games already played. Completed series replace that
allowance with actual scored games and earned sweep bonuses. There is no reserve
for hypothetical future sweeps. A bye is an award, never a fabricated game.
Awards are rebuilt cumulatively from canonical final evidence; repeats do not add
awards, and corrected outcomes remove superseded wins/bonuses.

Bye proof currently requires four completed WC series with eight participants
and four DS matchups with eight participants. The four DS entrants absent from
the WC universe are the byes. If that evidence is incomplete, bye identity is not
guessed and financial values stay unavailable. Subsequent-round participants
must have verified prior-round advancement.

The rate is the selected pool's verified sold pot divided by its whole-tournament
provisional point inventory. Teams earn only actual points, not the unfinished
inventory. Changing the denominator revalues all cumulative points coherently:
it records neither a new award nor a cash payment. At tournament completion,
actual payable points become the denominator and gross values conserve the
whole pot to the cent using deterministic largest-remainder allocation.

Signed owners come from the existing entry/position/trade ledger. Longs, shorts
and trade cash remain signed. Team and owner cents reconcile; consortium rows
consolidate the auction's fixed member allocations rather than counting each
member as a separate consortium. No ownership, stored result economics, payout
ledger, snapshot history or MTM mark is written by this feature.

## Discovery, persistence and corrections

ESPN structured daily scoreboards are validated for event season and postseason
type. Each event keeps its provider identity, scores, status, round, series,
game number and original source evidence. Home-field switches and reschedules
do not create a new series. Repeated same-matchup games have separate IDs.

Canonical events and the existing pool calendar are updated in one transaction.
The calendar contains ordered rounds, 11 stable series slots, legal contingent
games, actual participants and verified advancement links. Games after a clinch
are unneeded and earn nothing. Suspended/postponed games are not finals.

The API's independent MLB poller checks every five minutes in the September
15–November 15 discovery season. Each execution fetches at most eight daily
pages, at most four concurrently, with ten-second request timeouts. Historical
coverage backfills progressively; recent game-window/post-game checks and
advancement-triggered next-day discovery share that bound. Previously discovered
days are rechecked in bounded daily batches for corrections.

The existing refresh-state store retains coverage, failure/backoff, next retry,
last attempt/success and a renewable three-minute coalescing lease. No database
connection is held during ESPN requests. A superseded worker cannot commit.
Failed batches roll back event/calendar changes and keep previous valid actuals;
omitted daily events never cause destructive snapshot replacement.

## Public contract

- `GET /api/calcuttas/:calcuttaId/mlb-results`
- Existing MCP service: `get_mlb_results`, with mandatory `calcuttaId`
- Existing `/results` screen for selected MLB pools: By Team and By Consortium

REST and MCP use the same read-only, repeatable-read projection. Reads expose
stored rules, evidence, inventory, dollars per point, signed owners, consortium
economics and refresh/coverage status. Missing values are null, not fabricated
zeroes. Valid retained actuals may remain visible after a refresh failure, but
are explicitly partial/stale. Source links and visible times use New York time.

MLB projected MTM is explicitly unavailable. The series-format actuals adapter
cannot enter the existing fixed-denominator or forecast publication paths.

## Verification

Isolated PGlite/PostgreSQL-compatible tests cover the approved 190-point
reference, 3/5/7-game progression, sweeps/byes, post-clinch suppression, corrected
finals, replay, signed money rounding, terminal pot conservation, stable calendar
slots, multiple same-matchup games, rollback, leases/retries/restarts, incomplete
source/rubric coverage, explicit pool isolation and REST response/auth boundaries.
Fixtures never use the shared development or production database.
