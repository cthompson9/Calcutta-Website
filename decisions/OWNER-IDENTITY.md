# Owner identity — a manual reconciliation

**Blocks every cross-pool statistic. Not a coding task.**

Eleven workbooks produced **73 owner records** for roughly twenty people. The loader
deliberately does not merge them: it keeps a full name (one containing a space) as a global
identity and scopes a bare first name or initials to its own pool, so nothing is silently
combined.

## Why it can't be automated

Label similarity is exactly the signal that would merge the wrong two:

- **"Zach" and "Zack" are different people.** Both appear in Calcuttas IV and VI with
  separate bidder IDs, separate books and separate settlement rows.
- **"Joey Anthony" and "Anthony C." (Anthony Calcagni) are different people.**
- The same human appears as `Zach` (5 pool-scoped records), `Zach L.` (3 pools) and
  `Zachary Long` (2 pools) — one person, three conventions, ten pools.

The email columns don't rescue it either. They disagree between workbooks, and Calcutta IX's
appear scrambled relative to IV and VI: `samuel.a.rosen@` maps to Greg in IV/VI and Ezra in
IX; `dhatheway37@` to Matt vs Joey; `jcollins602@` to Joey vs Greg. Calcutta II's in-sheet
`Bidder_ID` lookup is broken and prints the same address regardless of bidder.

## What to produce

A mapping file — 73 records to N people — reviewed by someone who was in the room. Then
applying it is a one-line change in the loader.

```
# owner-identity.yaml
- person: Zachary Long
  records: ["Zach L. [ed1..3]", "Zach [ed4]", "Zach [ed5]", "Zach [ed6]",
            "Zach [ed7]", "Zach [ed9]", "ZL [ed10]", "Zachary Long"]
- person: Zack Miller           # NOT the same person as Zachary Long
  records: ["Zack M. [ed2]", "Zack M. [ed3]", "Zack [ed4]", "Zack [ed6]"]
```

## The records, by apparent base name

| Base | Records | Pools |
|---|---|---|
| Zach | 5 pool-scoped + `Zach L.` + `Zachary Long` | 4,5,6,7,9 + 1,2,3 + 11,8 |
| Sam | 4 pool-scoped + `Sam R.` + `Samuel Rosen` | 4,6,7,9 + 1,2,3 + 11,5,8 |
| Ed | 4 pool-scoped + `Ed Z.` + `Ed Zhang` | 4,6,7,9 + 1,2,3 + 11,5,8 |
| Greg | 4 pool-scoped | 4,5,6,9 |
| Craig | 3 pool-scoped + `Craig T.` + `Craig Thompson` | 4,6,9 + 1,2,3 + 11,5,8 |
| Joey | 3 pool-scoped + `Joey Anthony` | 4,6,9 + 11,5,8 |
| Chris | 3 pool-scoped + `Chris H.` | 4,6,9 + 1,2,3 |
| Zack | 2 pool-scoped | 4,6 |
| Matt | 2 pool-scoped | 4,6 |
| Anthony | 2 pool-scoped | 4,5 |
| Ezra | `Ezra Pemstein` | 11,8 |
| initials | `KD`, `SR`, `ZL`, `GK`, `EZ` | 10 |

Calcutta VII and X use initials, Calcuttas IV/VI/IX use bare first names, Calcuttas I–III use
`First L.`, and Calcuttas V/VIII/XI give full names. XI is the most useful anchor — it spells
out Ezra Pemstein, Craig Thompson, Ed Zhang, Zachary Long, Joey Anthony and Samuel Rosen, and
carries the consortium roster (leader plus members) alongside.
