# Open decisions

These are calls for the pool, not for the code. Each one changes money that has already
changed hands, so none of them should be quietly "fixed" during implementation. The load
carries the workbooks' booked figures unless noted.

---

## 1. Calcutta IX's crossbook looks settled backwards — $7,591.95

**Status: needs checking against what actually changed hands.**

Its legs imply book values of $7,005.60 for Zach and −$17,661.20 for Sam. Neither is close to
reality under either basis. Sam's Lion King book is **+$4,953.74**; Zach's is **−$747.27**.
The workbook has the signs the other way round.

Under the Lion King rule Zach owed Sam `0.25 × (−747.27 − 4,953.74) = $1,425.25`. The
workbook credits Zach **+$6,166.70** instead.

| | |
|---|---|
| Booked to Zach | +$6,166.70 |
| Rule says | −$1,425.25 |
| **Swing** | **$7,591.95** in Zach's favour |

This is the same workbook whose Michigan ownership contradicts itself across three tabs and
which carries a trade literally labelled "fixing my math above, which is based on 50/50" — so
it reads as a hand-calculation going wrong rather than a different rule.

---

## 2. Calcutta VII and X used the wrong basis

**Status: decide whether to restate.**

Both were computed on plain share-weighted net rather than the Lion King basis the pool
intends. VII's 3× crossbook implies a spread of $4,907.01 (plain) where Lion King gives
$5,342.34.

Calcutta X compounds it: its book trades used the hard-coded $15,000 pot **and** a flat
$5,000 per-owner cost rather than actual spend. With the pot corrected to $13,540 and actual
costs:

| Instrument | As booked | Restated, plain net | Restated, Lion King |
|---|---|---|---|
| 2× crossbook SR/ZL, to SR | 2,964.96 | 5,196.37 | **5,404.82** |
| 1× crossbook SR/ZL, held by Greg | 1,482.48 | 2,598.19 | **2,702.41** |
| 0.10× synthetic on ZL's book | 96.28 | 38.24 | **63.44** |

---

## 3. Calcutta X's $469.49 settlement sign error

**Status: open.**

The workbook's own trade-impact check displays $469.49 rather than zero. One owner's formula
carries two legs with the counterparty's signs instead of the mirror image; the delta is
exactly `2 × (one leg − the other)`. ZL's published net of −$1,867.45 is wrong by that
amount; sign-corrected it is −$2,336.93.

---

## 4. Is the per-bidder budget cap a rule?

**Status: decide before Calcutta XIII.**

Calcutta X is the first pool where every bidder is booked at an identical $5,000 — a budget
cap rather than a free-for-all. It is also the mechanism that produced the $1,460 of unbid
money. With the pot corrected, unspent budget is now correctly nobody's money rather than
everybody's, but the app doesn't know the cap exists.

---

## 5. World Cup normalization — confirm

**Status: assumed, not stated.**

I have loaded Calcutta XI as `earned_total` (points ÷ total points earned), which reproduces
every figure in its workbook exactly. Worth an explicit confirmation, since the inventory
swings 17% (1,476–1,732) and the choice moves every payout by up to that much.

---

## Resolved

- **The 2× marquee applies to point differential only**, not wins or ties. Confirmed by the
  pool owner and proven mechanically by Calcutta VIII's workbook.
- **Calcutta X's pot is $13,540**, the true lot total, not the hard-coded $15,000. Owner
  impact vs. the workbook: SR −$724.67, ZL −$580.38, KD −$154.95, with costs restated to
  actual spend.
- **Portfolios stay public** to pool participants; only intent — pending offers and their
  notes — becomes owner-scoped.
- **Book positions are a first-class instrument.** Owners may hold synthetic exposure without
  winning any lot.
- **Entry-level trades need no new machinery.** Verified across all 456 lots.
- **Cross-pool owner identity is reviewed.** All 109 declared owner records have an explicit
  approved alias or non-merge in `owner-identity.json`; unsupported future labels block the
  historical load.
