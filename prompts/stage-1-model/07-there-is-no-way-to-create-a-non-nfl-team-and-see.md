# There is no way to create a non-NFL team, and seeds are season-scoped and capped at 7

_Audit finding F-6._

Paste the block below to Replit as one task. Verify before moving on.

```
The teams table cannot represent a non-NFL team, and seeds are modelled only for the NFL.

Via a guarded migration in lib/db/src/migrations (not drizzle push):
1. Add a sport text column to teams, backfilled to 'NFL'.
2. Replace the global unique index on teams.name with a unique index on (sport, name).
   College names collide with NFL ones - Panthers, Jaguars, Cardinals - and
   lib/nflStandingsImport.ts:371-381 matches on (name, conference, division) requiring
   exactly one match, so a colliding row would break the LIVE NFL standings refresh.
3. Make conference and division nullable - a bracket field has neither. Then filter on
   sport = 'NFL' when resolving team identity in nflStandingsImport.ts.
4. Move seed off team_results (currently keyed (team_id, season_id), so season-scoped rather
   than per-Calcutta) onto calcutta_entries or entry_teams, and raise the cap: NBA needs
   1-8, March Madness 1-16. mcpServer.ts:1529 currently caps it at 7 for NFL playoff seeds.

In lib/api-spec/openapi.yaml, replace the conference and division enums with optional
free-text grouping fields validated per sport (keeping AFC/NFC and the four divisions as the
rule when sport is NFL), add sport to the team create/update payloads, and regenerate the
client. Use `number` not `integer` for new numeric fields per
.agents/memory/openapi-numeric-fields.md.

Finally, give the outcome aggregator access to both teams' seeds for a game, since March
Madness upset detection is a function of the seed gap between winner and loser, and the NBA
underdog bonus needs the seeds of both sides of a series.
```
