# The events table physically cannot store a best-of-seven series

_Audit finding F-3._

Paste the block below to Replit as one task. Verify before moving on.

```
lib/db/src/schema/events.ts has a unique index events_season_scope_week_matchup_idx on
(season_id, sport, competition, week, away_team_id, home_team_id). This makes it impossible
to store a best-of-seven series: home and away alternate, so games 1, 2, 5 and 7 share the
same (week, away_team_id, home_team_id) tuple and the second insert fails with a duplicate
key error. Verified against the dev database.

Add a nullable series_game integer column to events and include it in that unique index
(NULL for one-off matchups, 1..7 for series games), via a guarded migration in
lib/db/src/migrations - not drizzle push, per .agents/memory/schema-push-safety.md. Keep the
existing events_season_scope_source_event_idx unique index as-is.

Game-level rows are required for the NBA Calcutta because its rubric pays per game win with
a round multiplier (R1 x1, R2 x2, R3 x4, Finals x8) and awards +15 for a sweep - scoring on
series advancement alone is not an option. March Madness and World Cup group play are
unaffected since no pair of teams meets twice in a round.
```
