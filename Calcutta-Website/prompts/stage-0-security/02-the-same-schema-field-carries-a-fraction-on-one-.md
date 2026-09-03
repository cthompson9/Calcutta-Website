# The same schema field carries a fraction on one endpoint and a percent on another, 100× apart

_Audit finding P0-7._

Paste the block below to Replit as one task. Verify before moving on.

```
artifacts/api-server/src/routes/results.ts returns netPctReturn in two different units from
the same OpenAPI schema: line 214 returns netReturn / cost (a fraction, e.g. 15.2771) and
line 400 returns Math.round(pct * 10000) / 100 (a percent, e.g. 1527.71). Verified live on
the same Bills row via GET /api/results and GET /api/results/by-owner.

1. Pick ONE unit - I recommend the fraction, since it matches realizedMultiple - use it in
   both call sites, and document it explicitly in lib/api-spec/openapi.yaml at the
   netPctReturn definitions (lines ~2015, ~2406, ~2480) with a description naming the unit.
   Then regenerate the client with
   `pnpm --filter @workspace/api-spec run codegen` and fix any client display code that
   assumed the other unit.

2. Make buildTeamResult (results.ts:227-300) round money fields to cents the way
   buildOwnerTeamResult (results.ts:305-405) already does. GET /api/results currently
   returns values like "netMtm": 7.180000000000007.

3. Only 7 of 54 legacy res.json() calls validate against the generated response schema.
   Wrap every res.json in the corresponding schema from @workspace/api-zod (the schemas
   already exist) so a unit or nullability drift like this fails loudly in development.

4. Add an Express error handler at the end of app.ts that logs the error server-side and
   returns {error: "Internal error", requestId} - and set NODE_ENV=production on the
   deployment. Right now there is no error handler, NODE_ENV is unset outside `dev`, and
   Express's default handler returns the full SQL statement, bound parameter values and
   absolute file paths in the response body. Verified: PATCH /api/bidders/99999999999
   returns a 500 containing the query text and params.
```
