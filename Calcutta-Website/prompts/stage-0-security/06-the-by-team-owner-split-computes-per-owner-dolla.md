# The By-Team owner split computes per-owner dollars from the auction price alone, ignoring all trade cash

_Audit finding P0-5._

Paste the block below to Replit as one task. Verify before moving on.

```
In artifacts/nfl-auction/src/pages/Results.tsx, the expandTeams function (~line 1778)
computes each owner's per-team economics as team.cost * share, team.realizedReturn * share,
team.netReturn * share and team.netMtm * share.

That is wrong whenever a position has been traded. The server already computes the correct
per-owner basis in artifacts/api-server/src/routes/results.ts:734-736:
  originalCostBasis = seasonAuctionPrice * originalShare
  ownerCost = originalCostBasis + tradePaid - tradeReceived
  netReturn = realizedReturn - ownerCost

Two problems with the client version: it drops trade consideration entirely, and
net = team.netReturn * s double-counts cost (it computes s*realized - s*teamCost instead
of s*realized - ownerCost). For a short position (s < 0) it also flips the sign of the cost,
which .agents/memory/short-position-semantics.md forbids.

Fix by adding per-owner cost, gross, net and mtm to the per-team ownership rows returned by
GET /api/results (reusing buildOwnerTeamResult's arithmetic on the server), then have
expandTeams read those fields instead of multiplying team-level aggregates. Delete the
client-side multiplication, including the ptsToBreakeven * s scaling.

Verify with this case: team auctioned $500 to A, A sells 50% to B for $400, team returns
$600 gross. The By Team split must show A net +$200 and B net -$100, matching the By Owner
tab exactly.
```
