# An entry isn't always one team: you have bundles, and one of them resolves conditionally

_Audit finding F-4._

Paste the block below to Replit as one task. Verify before moving on.

```
Calcutta entries are currently one-to-one with teams: calcutta_entries is unique on
(calcutta_id, team_id) and aggregateOutcomes (lib/competitionScoring.ts:52) returns
Map. Three real auction structures need more than that:

  1. Multi-team bundles - the 14-16 seeds in each March Madness bracket, and a college
     football "rest of world" bundle. One entry collects many teams' outcomes.
  2. A conditional placeholder - the March Madness play-in package. The "#11 seed position"
     is auctioned and owned BEFORE the team is known, then resolves to whichever team wins
     the First Four. The First Four win itself scores no points.
  3. Per-member-team attributes - if a 14-16 package wins a game, the upset margin depends
     on which member team played, so seeds belong to member teams, not to the entry.

Via a guarded migration in lib/db/src/migrations (not drizzle push):
  - make calcutta_entries.team_id nullable and add a label column, so a placeholder or
    bundle entry can exist and be owned before or without a single team
  - add entry_teams (entry_id, team_id, seed, attributes jsonb) for bundle and placeholder
    membership; a plain entry keeps its implicit single mapping
  - add a resolveEntryForTeam(calcuttaId, teamId) lookup and use it everywhere the
    aggregation layer currently treats teamId as the entry key

Critically, ownership must be unaffected: positions reference entry_id, so a placeholder can
be auctioned and then resolved without touching positions, cost basis, or the exact 1.0000
per-entry ownership invariant. Add a test that resolving a placeholder leaves every
position and the ownership total byte-identical.

Then add an explicit `intraBundleGames: "count" | "exclude"` setting to the format
definition and implement both. When two teams inside a bundle play each other the entry
receives both a win and a loss and a cancelling point differential. In a college football
field where the bundle holds ~100 teams, most games are intra-bundle - this is the majority
of the scoring, not an edge case.
```
