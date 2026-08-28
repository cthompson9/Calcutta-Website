# Extraction contract — one JSON file per Calcutta

Write `/tmp/cal/data/calcutta-<NN>.json` (zero-padded edition number, e.g. `calcutta-09.json`).

The point of this exercise is a **tie-out**: a generic scoring engine will recompute every
team's points and payout from `events` + `rules`, and compare against the `expected` values
you transcribe from the workbook. So transcribe BOTH the inputs and the workbook's own
answers, and never "fix" an input to make the answer come out.

```jsonc
{
  "edition": 9,
  "name": "Calcutta IX",
  "sport": "NCAAM",                  // NCAAM | NFL | NBA | SOCCER
  "format_key": "NCAA_MM_64",        // NCAA_MM_64 | NFL_REGULAR_SEASON_18W | NBA_PLAYOFFS_16 | WORLD_CUP_48
  "season_year": 2026,
  "pot_size": 138490,                // from the workbook; must equal sum of entry prices
  "as_of_date": "2026-03-15",        // roughly when the event started (consortium anchor)

  "normalization": { "mode": "direct" },
  //   { "mode": "direct" }                                  March Madness (rules give pot %)
  //   { "mode": "earned_total" }                            NBA, World Cup (points / total points)
  //   { "mode": "fixed_inventory", "denominator": 11420 }    NFL

  "periods": [
    { "key": "R64",   "seq": 1, "label": "Round of 64",  "kind": "knockout", "weight": 1, "is_scored": true },
    { "key": "R32",   "seq": 2, "label": "Round of 32",  "kind": "knockout", "weight": 1, "is_scored": true }
    // ... include every round the workbook scores
  ],

  "rules": [
    // kind: per_unit | direct_share | group_rank_bonus | split_pool
    { "kind": "direct_share", "metric": "advance", "period_key": "R32", "rate": 0.005 },
    { "kind": "split_pool",   "metric": "upset_3plus", "rate": 0.05 },
    { "kind": "split_pool",   "metric": "upset_8plus", "rate": 0.05,
      "fallback": ["upset_8plus","upset_7plus","upset_6plus","upset_5plus","upset_4plus","upset_3plus"] },
    { "kind": "per_unit",     "metric": "win", "period_key": "GROUP", "rate": 3 },
    { "kind": "per_unit",     "metric": "game_win", "period_key": "R2", "rate": 2 },
    { "kind": "group_rank_bonus", "group_attr": "pot", "rate": 48 }
  ],

  "owners": [
    // label = exactly as written in THIS workbook. name = the full human name if the
    // workbook gives one anywhere; otherwise repeat the label and say so in "notes".
    { "label": "Zach", "name": "Zachary Long", "email": null }
  ],

  "entries": [
    {
      "label": "Duke",              // exactly as the workbook writes the lot
      "lot_order": 41,
      "price": 12600,
      "kind": "single",             // single | bundle | placeholder
      "attributes": { "seed": 1, "region": "East" },   // seed/region/group/pot as available
      "teams": [ { "name": "Duke", "seed": 1, "resolved": true } ],
      "owners": [ { "label": "Zach", "share": 1.0 } ],   // MUST sum to exactly 1
      "events": [
        { "period_key": "R32", "metric": "advance", "units": 1 },
        { "period_key": null,  "metric": "upset_3plus", "units": 2 }
      ],
      "expected": { "points": null, "realized_return": 4847.15 }
    }
  ],

  "trades": [
    { "sheet_ref": "4", "date": "2026-03-18", "detail": "Ed buys 20% of Duke",
      "scope": "entry", "entry_label": "Duke", "from": "Zach", "to": "Ed",
      "pct": 0.20, "cash": -1550.57 }
    // scope "book" or "synthetic_book" for cross-book trades (entry_label null)
  ],

  "expected_owners": [
    { "label": "Zach", "cost": 41905, "realized": 39046.49 }
  ],

  "notes": [ "anything ambiguous, inconsistent, or that you had to interpret" ]
}
```

## Rules for transcription

- **Ownership shares must sum to exactly 1.0 per entry.** Workbooks often write
  `"Zach / Ed"` meaning 50/50, `"Sam / Ed / Zach"` meaning thirds, and sometimes explicit
  `"Sam (80%) / Craig (20%)"`. Use 0.333333/0.333333/0.333334 style so the sum is exact.
  If a workbook's own owner-level totals imply different shares, record BOTH: use the
  workbook's implied shares and note the discrepancy.
- **`events` are counts of things that happened, not dollars.** A March Madness team that
  reached the Elite Eight has three `advance` events (R32, S16, E8) — the payouts accumulate
  per round, so one event per round reached.
- **Bundles**: one entry, `kind: "bundle"`, several `teams`. The 14–16 seed packages and any
  "rest of world" lot. Put every member team in `teams`.
- **Placeholders**: a lot auctioned before its team was known (play-in packages,
  `"Orlando/Charlotte"`, `"Suns/Warriors"`). `kind: "placeholder"`, list the candidate teams,
  `resolved: true` only on the one that actually advanced.
- **Do not invent events.** If a workbook has no column for something, it has no event.
- **`expected`**: use the workbook's own cost / realized-return / points figures verbatim,
  including cents. This is the tie-out target. Set a field to null if the workbook doesn't
  show it.
- **Short positions are real** and appear as negative shares. Keep the sign.
- If a workbook contains a tab that is clearly a leftover template from a different sport,
  ignore it and note it.
- Validate before you finish: `sum(entry.price) == pot_size`, every entry's shares sum to 1,
  every `owners[].label` referenced by an entry exists, every `period_key` exists in `periods`.
  Write a short `validation` block reporting each check as pass/fail.
