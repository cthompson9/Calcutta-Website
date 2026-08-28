# The sequence

Five stages. Each prompt in `prompts/` is one Replit task, one PR, one verification. Do them
in the order the filenames give.

**The governing constraint: Calcutta XII is live and holds real money.** Nothing here
migrates or rewrites the data that pool depends on until its season is over. The new model is
built *alongside* the existing tables, proven on eleven completed pools, and only converged
with XII in the offseason.

---

## Stage 0 — Stop the bleeding · 8 prompts · this week

`prompts/stage-0-security/`

No schema change, blocks on nothing, so it runs in parallel with everything else. Prompts 00
through 03 are the ones that are dangerous to leave running against a live pool.

| | |
|---|---|
| `00` | Gate the six ungated write endpoints; one timing-safe `requireAdmin` replacing seven copies; CORS allowlist; helmet |
| `01` | Delete the dead duplicate MCP router that serves owner financials to anonymous callers |
| `02` | One unit for `netPctReturn`; validate every `res.json`; add an error handler; set `NODE_ENV=production` |
| `03` | Rate limiting on three credential oracles; rotate all three secrets |
| `04` | The Week-0 MTM latch — an incomplete Kalshi capture wipes the marks and refills with a flat $107.18 |
| `05` | The marquee multiplier: wins and ties from raw counts, 2× on point differential only |
| `06` | By-Team owner dollars from the server instead of scaling team aggregates |
| `07` | One shared ownership validator so REST and MCP agree on what's approvable |

**Acceptance** — existing suite green, plus a new test asserting that a complete season's
league points equal the denominator exactly. Curl each formerly-ungated endpoint without a
credential and get 401.

---

## Stage 1 — The model, proven on the back data · 15 prompts · additive

`prompts/stage-1-model/`

The schema and the historical data are one stage, because **the data is the schema's
acceptance test**. Additive only — creates new tables, changes nothing Calcutta XII reads.

Start with `00` (new tables) and finish with `14` (backload + tie-out). The middle prompts
`02`–`12` are the engine capabilities the eleven pools require: three normalization modes,
two-pass cross-entry scoring, a format-driven metric vocabulary, per-format period ladders,
series storage, bundles and placeholders, non-NFL teams and seeds, elimination coverage, and
shape-validated rubrics. `13` is book positions and the Lion King rule.

**Acceptance — this is the whole point:**

```
456 / 456   lot payouts tie to the cent
112 / 112   point totals tie
 82 /  82   owner roll-ups tie
 11 /  11   pools where engine payout total == pot exactly
```

Not "looks right." Either it reproduces those four lines or Stage 1 isn't done. The reference
implementation in `reference/load_and_verify.py` reaches them, so the data supports it.

---

## Stage 1.5 — Owner identity · yours, not Replit's · during Stage 1

`decisions/OWNER-IDENTITY.md`

73 owner records for roughly twenty people. Hand-write the mapping; it cannot be automated,
because label similarity is the exact signal that would merge Zach with Zack. Blocks every
cross-pool statistic, so do it while Stage 1 is in flight.

---

## Stage 2 — Read paths and the historical UI · 5 prompts · after 1 and 1.5

`prompts/stage-2-read-paths/`

| | |
|---|---|
| `00` | V2 read endpoints over the new model — entries with tracking, owner roll-ups, trades |
| `01` | Required coverage flags; never render 0 where the answer is "no data" |
| `02` | As-of consortium membership everywhere, instead of today's roster |
| `03` | `edition_number` replacing the hardcoded name map; deep links on `calcuttaId` |
| `04` | MCP season defaults and unambiguous name resolution |

**Acceptance** — the UI's figures for Calcuttas I–XI match `team-by-team.csv` and
`owner-by-owner.csv` exactly.

Note that Stage 2 also retires the finding that a historical pool reports every owner a 100%
loss: that bug lives in the *old* read path, and Stage 2 routes history around it entirely.
Which is the second reason to build alongside rather than migrate.

---

## Stage 3 — Converge Calcutta XII · 7 prompts · offseason only

`prompts/stage-3-converge/`

Dual-write, then cut reads over one endpoint at a time with a week of old-vs-new comparison
before each cut. Then retire `team_period_snapshots` (one reader; the wide NFL-shaped table
that cannot represent a non-NFL metric), `nfl_games` (superseded by the generic `events`
table) and `team_bidders` (a view nothing reads). Prompt `00` collapses the migration chain
into a baseline so a clean database can be built at all — today the documented dev flow
crashes three times in a row.

---

## Stage 4 — Auth and trade offers

Per the phased plan in the audit report. Phase 1 (login and the read gate) changes no
reported number and is safe mid-season. Phase 2 (owner-scoped trade offers) needs a
`calcutta_id` column on `consortium_memberships` first, and should keep the commissioner as
final approver for all of Calcutta XII.

---

## What not to let Replit decide

`decisions/RULES.md` is the canonical rubric reference — six rubrics across four sports, the
three normalization modes, the Lion King basis, and the two invariants worth asserting in
code. `decisions/OPEN-DECISIONS.md` holds the five questions that move money and are the
pool's call, not the implementation's. If a prompt and a workbook disagree, the workbook is
evidence, not authority — record the variance rather than making the test pass.
