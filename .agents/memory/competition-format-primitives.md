---
name: Competition format primitives
description: Shared NFL/MLB architecture distinction between fixed regular-season fixtures and contingent postseason brackets.
---

Use one pool-scoped event, scoring, payout, ownership, snapshot, and publication lifecycle across sports, but distinguish **regular season** from **postseason knockout** as a first-class competition-format capability. A regular season has a known fixture set (subject to revisions); a postseason has contingent matchups, game counts, and advancement. Knockout stages may be best-of-1, 3, 5, or 7, with round-specific win values, eligible sweep bonuses, and explicit bye awards. Whether best-of-1 can earn a sweep bonus must be specified by the rubric rather than inferred from winning its only game.

**Why:** The user confirmed the shared-primitives approach and clarified that schedule certainty, elimination, and series length are format properties, not MLB-only exceptions. Treating playoff games like a fixed NFL regular-season schedule would misstate future games and pool points; a fixed normalization denominator is also unsafe when series lengths and sweeps vary.

**How to apply:** Keep common identity, evidence, ownership, payout-conservation, audit, and promotion contracts. Put legal fixture generation, series completion, advancement, per-round scoring, sweep eligibility, and market interpretation behind format/sport adapters. Use a per-outcome payable-point total for variable-point pool normalization, while preserving NFL's established behavior. Do not mark contingent postseason games as missing regular-season coverage.

For MLB's provisional realized rate, the user describes seven games as “a compromise between no sweeps and no 5/6 game series.” Completed rounds contribute their actual earned points, not a placeholder.

**Why:** The user wants a transparent maximum-game-count allowance for unfinished series, not a probabilistic game-count forecast or a reserve for every possible future sweep bonus.

**How to apply:** Replace each completed series' game-count allowance with actual game-win points and earned sweep points. Do not add already played games on top of the unfinished series allowance.