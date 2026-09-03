# Historical owner identity mapping report

**Review scope:** `data/calcutta-01.json` through `data/calcutta-11.json` and
`data/owner-by-owner.csv`  
**Decision file:** [`owner-identity.json`](owner-identity.json)  
**Status:** approved for the Stage 2 read-path review

## Coverage

- 109 owner declarations were reviewed across the eleven exports.
- 80 owner-level financial rows were reviewed in `owner-by-owner.csv`.
- All 456 ownership displays in `team-by-team.csv` resolve through the same explicit
  export label/name records before reconciliation.
- Every declared export record appears exactly once in the decision file.
- The financial CSV is covered after its display-only `[edN]` suffixes are normalized to
  the corresponding export label. Four Calcutta V rows use the declared full `name` rather
  than `label`: Samuel Rosen → `Sam`, Craig Thompson → `Craig`, Ed Zhang → `Ed`, and
  Joey Anthony → `Joey`.
- 33 canonical identities are represented: 21 alias groups and 12 explicit non-merges.
- There are no unresolved or ambiguous records. If a future record has either state, or has
  no decision entry, the historical loader rejects the entire pool before opening its
  write transaction.

## Approved alias mappings

| Canonical identity | Export records |
|---|---|
| Austin P. | ed1 `Austin P.`; ed2 `Austin P.` |
| Ben F. | ed1 `Ben F.`; ed2 `Ben F.`; ed3 `Ben F.` |
| Billy S. | ed1 `Billy S.`; ed2 `Billy S.`; ed3 `Billy S.` |
| Cameron H. | ed1 `Cameron H.`; ed3 `Cameron H.` |
| Chris H. | ed1 `Chris H.`; ed2 `Chris H.`; ed3 `Chris H.`; ed4 `Chris`; ed6 `Chris`; ed9 `Chris` |
| Craig Thompson | ed1 `Craig T.`; ed2 `Craig T.`; ed3 `Craig T.`; ed4 `Craig`; ed5 `Craig`; ed6 `Craig`; ed8 `Craig Thompson`; ed9 `Craig`; ed11 `Craig Thompson` |
| Damon H. | ed1 `Damon H.`; ed2 `Damon H.`; ed3 `Damon H.` |
| Ed Zhang | ed1 `Ed Z.`; ed2 `Ed Z.`; ed3 `Ed Z.`; ed4 `Ed`; ed5 `Ed`; ed6 `Ed`; ed7 `Ed`; ed8 `Ed Zhang`; ed9 `Ed`; ed10 `EZ`; ed11 `Ed Zhang` |
| Henry A. | ed1 `Henry A.`; ed2 `Henry A.`; ed3 `Henry A.` |
| Justin C. | ed2 `Justin C.`; ed3 `Justin C.` |
| Michael W. | ed1 `Michael W.`; ed2 `Michael W.` |
| Nate F. | ed1 `Nate F.`; ed2 `Nate F.` |
| Sam Ford | ed1 `Sam F.`; ed3 `Sam F.` |
| Samuel Rosen | ed1 `Sam R.`; ed2 `Sam R.`; ed3 `Sam R.`; ed4 `Sam`; ed5 `Sam`; ed6 `Sam`; ed7 `Sam`; ed8 `Samuel Rosen`; ed9 `Sam`; ed10 `SR`; ed11 `Samuel Rosen` |
| Zachary Long | ed1 `Zach L.`; ed2 `Zach L.`; ed3 `Zach L.`; ed4 `Zach`; ed5 `Zach`; ed6 `Zach`; ed7 `Zach`; ed8 `Zachary Long`; ed9 `Zach`; ed10 `ZL`; ed11 `Zachary Long` |
| Zack Miller | ed1 `Zach M.`; ed2 `Zack M.`; ed3 `Zack M.`; ed4 `Zack`; ed6 `Zack` |
| Anthony Calcagni | ed3 `Anthony C.`; ed4 `Anthony`; ed5 `Anthony` |
| Greg | ed4 `Greg`; ed5 `Greg`; ed6 `Greg`; ed9 `Greg`; ed10 `GK` |
| Joey Anthony | ed4 `Joey`; ed5 `Joey`; ed6 `Joey`; ed8 `Joey Anthony`; ed9 `Joey`; ed11 `Joey Anthony` |
| Matt M. | ed2 `Matt M.`; ed3 `Matt M.`; ed4 `Matt`; ed6 `Matt` |
| Ezra Pemstein | ed8 `Ezra Pemstein`; ed11 `Ezra Pemstein` |

## Explicit non-merges

These records are intentionally retained as separate canonical identities. The decision is
not a claim that no future evidence could connect them; it is a block against silently merging
them with a similar label now.

| Canonical identity | Record | Kept separate from |
|---|---|---|
| Ryan M | ed2 `Ryan M` | all other identities; single occurrence |
| Todd C. | ed1 `Todd C.` | all other identities; single occurrence |
| Joshua Melnick | ed8 `Joshua Melnick` | Josh [ed9] |
| Ian Culnane | ed8 `Ian Culnane` | Ian [ed5] |
| Shaun McGuire | ed8 `Shaun McGuire` | Shaun [ed6] |
| Ezra [ed9] | ed9 `Ezra` | Ezra Pemstein |
| Josh [ed9] | ed9 `Josh` | Joshua Melnick |
| Colton [ed6] | ed6 `Colton` | all other identities; single occurrence |
| Kurt [ed7] | ed7 `Kurt` | all other identities; single occurrence |
| KD [ed10] | ed10 `KD` | all other identities; single occurrence |
| Ian [ed5] | ed5 `Ian` | Ian Culnane |
| Shaun [ed6] | ed6 `Shaun` | Shaun McGuire |

## Evidence handling

Exact repeated labels, repeated reliable source identifiers, full-name anchors in Calcuttas
V, VIII, and XI, and the explicit Calcutta X initials/trade notes were accepted as evidence.
The known scrambled email columns in Calcuttas IV, VI, and IX were not used to create a
cross-pool merge. Similar first names, initials without an anchor, and a shared email in a
known-broken lookup were not treated as proof.