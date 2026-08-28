# Calcutta XIII will be named wrong, sorted last, and never become the default

_Audit finding P1-7._

Paste the block below to Replit as one task. Verify before moving on.

```
Calcutta edition identity is hardcoded in artifacts/api-server/src/routes/calcuttas.ts:8-45
as a legacyEditionNames map ("NFL:2026" -> "Calcutta XII") plus an ordered editionOrder
name array. selectorOrder() returns 0 for any name not in that array.

Replace both with data:
1. Add an edition_number integer column to the calcuttas table via a guarded migration in
   lib/db/src/migrations (not drizzle push), backfilled from the existing map.
2. Use the DB name column for display and ORDER BY edition_number DESC for the selector.
3. Delete legacyEditionNames, editionOrder and selectorOrder.
4. Fix getOrCreateCanonicalCalcutta (lib/calcuttaReturns.ts:1040), which names new pools
   `${year} NFL Calcutta` - a name that matches neither literal today, so a 2027 pool would
   display as "2027 NFL Calcutta" and sort last.
5. In artifacts/nfl-auction/src/hooks/useSeason.ts:68, the default selection is
   calcuttas[0]; confirm that still resolves to the newest edition after the ordering
   change, and remove the hardcoded DEFAULT_YEAR = 2026 at line 18 in favour of the newest
   edition from the API.

Also switch the deep links in artifacts/nfl-auction/src/lib/resultSourceLinks.ts:28-42
from ?season= to a calcuttaId, since four Calcuttas share the year 2026 and a
year-keyed link cannot disambiguate which pool it meant.
```
