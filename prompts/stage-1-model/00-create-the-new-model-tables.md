# Create the new model tables

_New work, not an audit finding. Do this first in Stage 1._

Additive only. Creates new tables; changes nothing Calcutta XII reads.

```
Add the format-agnostic Calcutta model as NEW tables alongside the existing ones. Nothing in
this task may alter or drop an existing table — Calcutta XII is live on them.

Use /reference/schema.sql in this handoff as the specification. Translate it into Drizzle
schema files under lib/db/src/schema/ following this repo's existing conventions, and add a
single guarded migration in lib/db/src/migrations/ (next free number) that creates them.
Follow .agents/memory/schema-push-safety.md: never `drizzle-kit push` against populated data.

Tables:
  competition_formats     key, sport, structure, definition jsonb
  format_periods          format_key, key, seq, label, kind, weight, is_scored
  entries                 calcutta_id, label, lot_order, price, kind, attributes jsonb
  entry_teams             entry_id, team_id, seed, resolved
  scoring_rules           calcutta_id, kind, metric, period_key, rate, group_attr, fallback
  scoring_events          entry_id, period_key, metric, units
  expected_entry_results  entry_id, points, realized_return
  expected_owner_results  calcutta_id, owner_id, cost, realized

CRITICAL — declare every index and partial-unique constraint IN THE DRIZZLE SCHEMA, not only
in the migration SQL. The existing positions_primary_entry_bidder_idx exists only in
migration 0013's raw SQL and is therefore silently dropped by a routine `drizzle-kit push`.
Do not repeat that. Specifically:
  - scoring_events unique on (entry_id, period_key, metric)
  - entries unique on (calcutta_id, label)
  - format_periods unique on (format_key, seq) and primary key (format_key, key)

Also port the deferred ownership constraint from reference/schema.sql onto the new entries
model: each entry's signed positions must net to exactly 1.000000, checked as a DEFERRABLE
INITIALLY DEFERRED constraint trigger so both legs of a trade commit together. Triggers are
invisible to drizzle-kit, so this one lives in the migration — note that in a comment.

Acceptance: the migration applies cleanly to a fresh database AND to a copy of production;
`drizzle-kit push` immediately afterwards produces an EMPTY diff. If push wants to drop
anything you just created, the Drizzle schema is incomplete — fix it rather than accepting
the diff.
```
