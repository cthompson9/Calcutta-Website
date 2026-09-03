# Two channels disagree about whether the same trade is approvable

_Audit finding P0-6._

Paste the block below to Replit as one task. Verify before moving on.

```
Trade approval integrity is implemented twice in artifacts/api-server with different rules:

- REST PATCH /api/trades/:id/status -> validateTradeOwnership (routes/trades.ts:79-84)
  uses Math.abs(total - 1) > 0.0000005
- MCP set_trade_status -> validateMcpTradeApproval (mcpServer.ts:210-220) ->
  validatePrimaryOwnership (lib/ownershipShares.ts:18-62) requires the sum of rounded
  basis points to equal exactly 10000 and each share to have at most 4 decimal places

A split of 0.33333 / 0.33333 / 0.33334 is approved by REST and rejected by MCP.
.agents/memory/ownership-write-integrity.md says four-decimal exactness is the rule, so
validatePrimaryOwnership is correct. Delete the inline epsilon block in
routes/trades.ts:79-84 and have validateTradeOwnership call validatePrimaryOwnership.

Second, unify trade creation. POST /api/trades (routes/trades.ts:266) and the MCP
create_trade tool (mcpServer.ts:948-1063) are separate implementations, and the MCP one:
  - calls getOrCreateCanonicalCalcutta (mcpServer.ts:990), so recording a trade can CREATE
    a new Calcutta row - it must call resolveCalcuttaId and 400 like REST does
  - resolves teams with a fuzzy ilike %name% limit 1 instead of an id
  - auto-creates bidder rows
  - hardcodes percentage bounds 1..100 instead of using MIN/MAX_TRADE_PERCENTAGE

Extract one createTrade service function and have both channels call it. Creating a trade
must never create a Calcutta or a bidder.

Add tests asserting both channels accept and reject the same ownership splits.
```
