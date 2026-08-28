# Book positions and the Lion King rule

_New work. The one genuinely missing trade concept._

Entry-level trades need **no change** — verified: all 62 transfers across the eleven
historical pools were applied and every one of the 456 entries still nets to exactly
`1.000000`. Naked shorts and synthetic longs are already just signed positions that cancel.
Book-level positions are the gap.

```
Owners can hold synthetic long/short exposure on another owner's whole book, without having
won any lot at auction. There are 21 such trade legs across 8 of the 11 historical pools, and
two owners in Calcutta X whose entire position is synthetic. Today this cannot even be
stored: lib/db/src/schema/trades.ts:34 declares entryId as .notNull() with an
onDelete:"restrict" FK.

STORAGE — via a guarded migration, not drizzle push:

  alter table trades
    alter column entry_id drop not null,
    add scope              text not null default 'entry'
          check (scope in ('entry','book','synthetic_book')),
    add reference_owner_id integer references bidders(id),
    add factor             numeric(9,4),
    add basis              text check (basis in ('lion_king','net'));

  -- entry-scoped trades keep entry_id and leave the new columns null
  -- book trades leave entry_id null and require scope, factor and basis

VALUATION — two shapes:

  spread        value(holder) = factor x ( book(A) - book(B) )
  single-sided  value(holder) = factor x book(reference_owner)

BASIS — two definitions, and the difference is material, so it must be stored per trade:

  lion_king   auction lots ONLY (trades excluded), each lot counted at 100% of its
              gain regardless of the share actually bought. Two owners who split a
              team 50/50 at auction EACH carry that team's full gain.
  net         share-weighted and trade-adjusted.

Every crossbook in the pool's history was intended as lion_king. Default to it.

ENGINE — this is a THIRD pass, after entry scoring and after cross-entry awards:
  pass 1  score each entry from its own events
  pass 2  cross-entry awards (split_pool, group_rank_bonus)
  pass 3  book positions, valued from PRE-BOOK books or the calculation is circular
Calcutta X stacks three book instruments on the same pair of owners, so define and document
the evaluation order. Book positions are zero-sum between the parties and must not change
any pool total — assert that.

ACCEPTANCE — recompute all seven computable historical book trades and reproduce:
  Calcutta III  0.10x  spread   101.23   -> exact
  Calcutta V    1x     spread 1,342.38   -> exact on lion_king
  Calcutta VI   0.5x   spread 6,158.01   -> exact on lion_king
  Calcutta VIII 1x     spread 7,686.63   -> exact on lion_king
Three will NOT reproduce their booked figures, and that is the correct outcome — they were
computed on the wrong basis or are simply wrong. See decisions/OPEN-DECISIONS.md. Assert the
four above and record the other three as known variances rather than making them pass.
```
