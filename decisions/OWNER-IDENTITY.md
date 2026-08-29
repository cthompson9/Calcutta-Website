# Owner identity — reviewed cross-pool reconciliation

**Stage 1.5 is complete for the supplied 11 historical exports.**

The review covers all **109 declared owner records** in the eleven JSON exports and all
**80 owner rows** in `data/owner-by-owner.csv`. It resolves them to **33 canonical
identities**. The exact record-level decisions live in
[`owner-identity.json`](owner-identity.json), and the human-readable audit is in
[`OWNER-IDENTITY-REPORT.md`](OWNER-IDENTITY-REPORT.md).

The loader now requires an approved decision for every owner label before a historical
transaction can begin. `approved_alias` records share a canonical identity;
`approved_non_merge` records intentionally remain distinct. `unresolved` and `ambiguous`
are valid decision states in the file but are rejected by the loader.

## Non-negotiable non-merges

- **Zachary Long and Zack Miller** are different people.
- **Joey Anthony and Anthony Calcagni** are different people.
- **Samuel Rosen and Sam Ford** are different people.
- `Ezra [ed9]` is not merged with Ezra Pemstein because the Calcutta IX email is
  known to be scrambled.
- `Josh [ed9]` is not merged with Joshua Melnick, and `Ian [ed5]` is not merged with
  Ian Culnane, on first-name similarity alone.
- `Shaun [ed6]` is not merged with Shaun McGuire on first-name similarity alone.

The source email columns were used only where they agree with repeated labels or an explicit
full-name anchor. The review does not use the scrambled cross-sheet emails in Calcuttas IV,
VI, or IX, and does not infer an identity from label similarity alone.

## Review result

| Check | Result |
|---|---:|
| JSON owner declarations reviewed | 109 |
| CSV owner rows reviewed | 80 |
| Canonical identities | 33 |
| Approved alias groups | 21 |
| Explicit non-merge groups | 12 |
| Unresolved or ambiguous records | 0 |

Any future export must add an explicit record to `owner-identity.json`; an omitted, unresolved,
or ambiguous record blocks the historical backload rather than silently creating a pool-scoped
identity.