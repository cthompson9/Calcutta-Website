# Calcutta V2 Agent Playbook

The V2 read API is available through REST under `/api/v2` and through the
authenticated MCP endpoint at `/api/mcp`. REST and MCP use the same service
functions, name resolution, ownership ledger, calculated-return loader, and
schedule records.

## Choosing a tool

| User question | MCP tool | REST endpoint |
| --- | --- | --- |
| What do I own? | `get_owner_portfolio` | `GET /api/v2/owner/portfolio` |
| What is my portfolio cost or value? | `get_owner_summary` | `GET /api/v2/owner/summary` |
| Which of my teams is performing best? | `get_owner_portfolio_performance` | `GET /api/v2/owner/portfolio/performance` |
| What games are on a week or date? | `get_schedule` | `GET /api/v2/schedule` |
| When does a team play? | `get_team_schedule` | `GET /api/v2/team/schedule` |
| Is a game marquee, and what is known about it? | `get_game` | `GET /api/v2/game` |
| What is the scoring rubric? | `get_points_rubric` | `GET /api/v2/points-rubric` |
| How are consortiums ranked in this pool? | `get_consortium_leaderboard` | `GET /api/v2/leaderboard/consortia` |

Do not enumerate every NFL team to answer an ownership question. Use the owner
portfolio endpoint, which performs the ownership and trade joins internally.

## Required context and resolution

- `season` is required.
- `calcuttaId` is optional and defaults to that season's canonical NFL pool.
- Owner and team names accept exact or unambiguous partial matches.
- Teams also accept standard abbreviations such as `NYJ`.
- Ambiguous names produce an error rather than selecting an arbitrary match.
- Use the source-prefixed `game_id` returned by schedule responses when calling
  `get_game`.

## Financial interpretation

- Approved positions are authoritative. Pending trades do not affect the
  portfolio.
- Ownership and return calculations are signed, so a short position is
  represented with a negative ownership percentage and signed economics.
- `basis=realized` is the default. Use `basis=mtm` only when the question is
  explicitly about current mark-to-market value.
- `value_source` identifies whether a team value came from normalized calculated
  metrics, the legacy compatibility projection, or is unavailable.
- `calculation_status` summarizes the source coverage for the entire portfolio.
- A missing calculated value or an invalid ROI denominator is returned as
  `null`; it is never guessed.

## Schedule, market, and projections

- Pool-facing dates and kickoff timestamps use `America/New_York`.
- `is_marquee` and `point_diff_multiplier` are `null` for an unconfirmed/TBD
  kickoff. Otherwise they are derived deterministically from kickoff time.
- The marquee multiplier applies only to point differential.
- Market and model projection objects are independent. Never describe a
  sportsbook implied probability as a model probability.
- Market, projection, and projected EV fields remain `null` until their
  respective data sources exist. Do not fill placeholders with estimates.

## Consortium leaderboard

The leaderboard is scoped to one Calcutta. Historical membership at that
Calcutta's fixed as-of date is the default. Use `membershipView=current` only
when the user explicitly asks for today's consortium roster.