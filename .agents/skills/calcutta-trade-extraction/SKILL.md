---
name: calcutta-trade-extraction
description: Extracts and reconciles historical Calcutta trade, side-bet, short, and settlement economics from Google Sheets. Use when preparing authoritative trade evidence for data/calcutta-NN.json without replaying ownership or guessing missing history.
---

# Historical Calcutta Trade Extraction

## Objective

Inspect one historical Calcutta Google Sheet and produce a source-cited handoff
that another engineer can safely merge into the normalized historical catalog.

The output must explain every owner-level difference between:

```text
base net = realized payout - entry cost
final net = base net + trade impact
```

Do not edit the application, database, or existing JSON. Extract and reconcile
evidence only.

## Non-negotiable accounting rules

1. Historical primary positions represent the final imported ownership state.
2. Never replay a historical trade into ownership positions.
3. Trade rows are an audit ledger, but their booked economic amount still
   adjusts owner payout/net.
4. The owner receiving a row's economic impact is the workbook's explicit
   booking-owner cell (often `New Owner`), not necessarily the buyer, seller,
   `from`, or `to` named in the description.
5. Call that authoritative booking owner `leg_owner`.
6. Preserve one output row per populated source accounting row. Two rows with
   the same trade number are normally two legs of one conceptual event and must
   not be collapsed.
7. Use the workbook's calculated net-trade/settlement value as `cash`. Do not
   substitute a price mentioned in prose.
8. Never infer an absent trade, owner, team, percentage, amount, or direction.
   Report ambiguity instead.

## Inputs

The requester supplies:

- Calcutta edition number and name
- Google Sheet URL
- Relevant worksheet name if known
- Existing normalized JSON, if available, for comparison only

Use Google Sheets access that returns formulas and displayed/calculated values.
If possible, also export the workbook as XLSX to preserve cached values and
formula references.

## Workbook inspection

### 1. Locate the owner summary

Find the table containing owner names and fields equivalent to:

- entry cost or risk
- realized payout/return before trades
- base net return
- impact of trades
- final net return

Record exact worksheet and cell references for the header row and every owner
row. Do not assume column letters match another Calcutta.

For each owner, extract:

```json
{
  "label": "Sam R.",
  "cost": 5640,
  "realized": 4982.087308,
  "base_net": -657.912692,
  "trade_impact": -1171.048742,
  "net": -1828.961435,
  "source_cells": {
    "cost": "Returns!E43",
    "realized": "Returns!O43",
    "base_net": "Returns!P43",
    "trade_impact": "Returns!S43",
    "net": "Returns!T43"
  }
}
```

Validate:

```text
realized - cost = base_net
base_net + trade_impact = net
```

Use full available precision for validation; compare to one cent only after the
calculation.

### 2. Locate every trade-related section

Search all worksheets, including hidden rows/columns, for:

- Trade / Trades / Trade #
- Impact of Trades
- New Owner
- Net Trade Value
- Buy / Sell / Short
- bet / side bet / book
- cash / settlement / pays

Inspect formulas, merged cells, hidden ranges, notes, comments, and named
ranges. State explicitly which areas were searched.

### 3. Extract one record per accounting leg

For every populated row in every relevant trade section, produce:

```json
{
  "sheet_ref": "6",
  "source_row": 59,
  "source_range": "Returns!B59:J59",
  "date": null,
  "detail": "Zach shorts 50% of Bills for $2,250",
  "scope": "entry",
  "entry_label": "Buffalo",
  "from": "Zach L.",
  "to": "Sam R.",
  "pct": 0.5,
  "cash": -614.2669231,
  "leg_owner": "Sam R.",
  "leg_side": "buy",
  "asset_value": 614.2669231,
  "synthetic": true,
  "note": "Description and booking owner differ; explicit booking-owner cell is authoritative.",
  "evidence": {
    "detail_cell": "Returns!C59",
    "pct_cell": "Returns!G59",
    "asset_value_cell": "Returns!H59",
    "cash_cell": "Returns!I59",
    "leg_owner_cell": "Returns!J59",
    "cash_formula": "<exact formula if present>"
  }
}
```

Allowed `scope` values:

- `entry`: a team/bundle equity leg
- `book`: portfolio-level wager or book trade
- `synthetic_book`: synthetic long/short or strike-value contract
- `sidebet`: side bet not represented as team ownership
- `cash`: cash-only settlement

Use the narrowest accurate scope. Explain unusual classifications in `note`.

### 4. Separate event direction from booking ownership

Derive `from` and `to` from explicit cells or unambiguous prose. These fields
describe the conceptual asset transfer.

Derive `leg_owner` only from the cell/formula that controls which owner's
trade-impact total receives that row.

If no explicit booking owner exists:

- set `leg_owner` to `null`;
- mark the row unresolved;
- explain what evidence is missing;
- do not infer it from `to`.

### 5. Preserve formula evidence

For every numeric leg field, capture:

- calculated value
- formula, if present
- all directly referenced source cells needed to understand the result

When prose says “for $2,250” but the net booked effect is `$614.2669231`, keep:

- prose unchanged in `detail`;
- `$614.2669231` as `cash`;
- `$2,250` only in the note or strike/transaction-price evidence.

## Required reconciliation

### Per event

Group rows by `sheet_ref`.

Report:

- conceptual event description
- number of accounting legs
- sum of booked cash
- whether the event is zero-sum
- any intentional non-zero settlement
- any sign, label, or direction mismatch

Do not require every individual event to be zero-sum if the workbook clearly
books an external settlement, fee, or one-sided payment.

### Per owner

Calculate:

```text
derived_trade_impact(owner)
  = sum(cash for rows where leg_owner = owner)
```

Require:

```text
derived_trade_impact(owner) = owner summary trade_impact
```

to within $0.01 for every owner.

Then require:

```text
realized - cost + derived_trade_impact = final net
```

to within $0.01 for every owner.

### Whole Calcutta

Report:

```text
sum(owner summary trade impacts)
sum(extracted leg cash)
difference
```

The difference must be within $0.01 unless the workbook documents an external
cash source/sink. If not, the extraction is incomplete.

Also report:

- owner summary row count
- conceptual event count
- accounting leg count
- unmatched owner labels
- unmatched team/entry labels
- duplicate source rows
- unresolved formulas
- unresolved ambiguities

## Compare with existing normalized JSON

If an existing `data/calcutta-NN.json` is supplied:

1. Match rows by source range first.
2. Otherwise match by:

```text
sheet_ref + detail + entry_label + leg_owner + cash
```

3. Classify each row:
   - `unchanged`
   - `missing_from_json`
   - `json_mismatch`
   - `source_only_ambiguous`
4. Never recommend deleting or replacing a row solely because wording differs.
5. Explicitly distinguish missing audit evidence from ownership corrections.

## Final output

Return one JSON object in a fenced `json` block, followed by a short human
summary.

```json
{
  "calcutta": {
    "edition_number": 3,
    "name": "Calcutta III",
    "sheet_url": "https://docs.google.com/...",
    "worksheets_inspected": ["Returns", "Calcutta Live Draft"],
    "trade_section_ranges": ["Returns!B49:J62"]
  },
  "owner_reconciliation": [],
  "trades": [],
  "event_reconciliation": [],
  "totals": {
    "owner_trade_impact": 0,
    "trade_leg_cash": 0,
    "difference": 0
  },
  "comparison_to_existing_json": {
    "unchanged": 0,
    "missing_from_json": 0,
    "json_mismatch": 0,
    "source_only_ambiguous": 0,
    "details": []
  },
  "validation": {
    "all_owner_trade_impacts_tie": true,
    "all_owner_final_nets_tie": true,
    "whole_calcutta_ties": true,
    "safe_for_engineering_handoff": true
  },
  "unresolved": []
}
```

Set `safe_for_engineering_handoff` to `true` only when:

- every extracted amount has a source cell;
- every non-null `leg_owner` has explicit workbook evidence;
- every owner trade-impact and final-net equation ties within one cent;
- all unmatched labels and ambiguities are listed;
- no ownership changes were inferred.

## Human summary template

```markdown
## Calcutta [edition] extraction

- Owner rows: [count]
- Conceptual trade events: [count]
- Accounting legs: [count]
- Trade section: [worksheet/range]
- Owner trade impacts tie: [yes/no]
- Final owner nets tie: [yes/no]
- Existing JSON: [unchanged/missing/mismatch counts]
- Safe for engineering handoff: [yes/no]

### Important exceptions
- [Any sign mismatch, synthetic contract, external settlement, or ambiguity]
```

## Stop conditions

Stop and request clarification rather than guessing when:

- the workbook requires permission;
- formulas are unavailable and displayed values do not reconcile;
- the owner summary has no explicit trade-impact field;
- a booking owner cannot be identified;
- duplicate-looking rows have different source ranges;
- a team/owner label could map to multiple normalized identities;
- total trade legs do not reproduce owner trade impacts.
