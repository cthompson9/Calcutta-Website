-- ============================================================================
-- Calcutta platform: format-agnostic core
-- Designed from the 11 historical Calcutta workbooks (March Madness, NFL,
-- NBA playoffs, World Cup).
--
-- Design rules:
--   1. The LEDGER (entries, ownership, trades, cash) is relational and exact.
--   2. The FORMAT (periods, metrics, rubric) is data, in a validated document.
--   3. Scoring is ONE generic fact table. Every column of every results tab in
--      every workbook becomes a row in scoring_events.
--   4. An entry is an auction LOT, not a team. Lots may hold 0, 1, or many
--      teams (bundles), and may resolve later (play-in placeholders).
-- ============================================================================

drop schema if exists cal cascade;
create schema cal;
set search_path to cal;

-- ---------------------------------------------------------------- formats ---
create table competition_formats (
  key         text primary key,          -- 'NCAA_MM_64', 'WORLD_CUP_48', 'NBA_PLAYOFFS_16'
  sport       text not null,
  structure   text not null
    check (structure in ('league','single_elim','series_bracket','group_knockout')),
  definition  jsonb not null,            -- periods, metrics, attributes
  created_at  timestamptz not null default now()
);

create table format_periods (
  format_key  text not null references competition_formats(key) on delete cascade,
  key         text not null,             -- 'GROUP','R32','R16','QF','SF','FINAL','WK1'..
  seq         integer not null,
  label       text not null,
  kind        text not null default 'regular'
    check (kind in ('baseline','regular','group','knockout')),
  weight      numeric(10,4) not null default 1,   -- NBA round multiplier lives here
  is_scored   boolean not null default true,      -- March Madness First Four = false
  primary key (format_key, key),
  unique (format_key, seq)
);

-- ---------------------------------------------------------------- pools -----
create table calcuttas (
  id             serial primary key,
  edition_number integer not null unique,        -- I..XII as an integer, not a name map
  name           text not null unique,
  sport          text not null,
  format_key     text not null references competition_formats(key),
  season_year    integer not null,
  pot_size       numeric(14,2),
  as_of_date     date,                           -- consortium anchor, per pool
  normalization  jsonb not null,                 -- {mode:'fixed_inventory',denominator:11420}
                                                 -- {mode:'earned_total'} | {mode:'direct'}
  status         text not null default 'complete'
);

-- ---------------------------------------------------------------- rubric ----
-- Four rule kinds cover all four formats. Verified against every workbook.
create table scoring_rules (
  id           serial primary key,
  calcutta_id  integer not null references calcuttas(id) on delete cascade,
  kind         text not null check (kind in (
                 'per_unit',        -- units x rate. rate may vary by period.
                 'direct_share',    -- units x (rate = fraction of pot)
                 'group_rank_bonus',-- top scorer in a subgroup gets `rate`, ties split
                 'split_pool')),    -- `rate` = pot fraction, divided by total units
  metric       text,                -- null for group_rank_bonus
  period_key   text,                -- null = applies in every period
  rate         numeric(14,8) not null,
  group_attr   text,                -- group_rank_bonus: 'pot' / 'region'
  fallback     text[],              -- split_pool: ordered metric chain, first non-empty wins
  note         text
);
create index scoring_rules_calcutta_idx on scoring_rules (calcutta_id);

-- ---------------------------------------------------------------- teams -----
create table teams (
  id     serial primary key,
  sport  text not null,
  name   text not null,
  unique (sport, name)               -- NOT globally unique: Pitt vs Carolina Panthers
);

-- ---------------------------------------------------------------- owners ----
create table owners (
  id           serial primary key,
  display_name text not null unique,
  email        text
);

-- The same human appears as 'Zach' in one workbook and 'ZL' in another.
create table calcutta_owners (
  calcutta_id integer not null references calcuttas(id) on delete cascade,
  owner_id    integer not null references owners(id),
  label       text not null,          -- as written in THAT pool
  primary key (calcutta_id, owner_id),
  unique (calcutta_id, label)
);

-- ---------------------------------------------------------------- entries ---
-- An auction lot. team_id is NOT here: a lot may hold many teams, or none yet.
create table entries (
  id          serial primary key,
  calcutta_id integer not null references calcuttas(id) on delete cascade,
  label       text not null,          -- 'Duke' | 'Penn / Idaho / Prairie View A&M' | 'Suns/Warriors'
  lot_order   integer,                -- nomination order
  price       numeric(14,2) not null, -- winning bid
  kind        text not null default 'single'
    check (kind in ('single','bundle','placeholder')),
  attributes  jsonb,                  -- {seed, region, group, pot}
  unique (calcutta_id, label)
);

create table entry_teams (
  entry_id integer not null references entries(id) on delete cascade,
  team_id  integer not null references teams(id),
  seed     integer,
  resolved boolean not null default true,   -- placeholder: false until the play-in decides
  primary key (entry_id, team_id)
);

-- ------------------------------------------------------------- ownership ----
create table positions (
  id          serial primary key,
  entry_id    integer not null references entries(id) on delete cascade,
  owner_id    integer not null references owners(id),
  share       numeric(9,6) not null,        -- signed: shorts are negative
  source      text not null default 'primary' check (source in ('primary','trade')),
  trade_id    integer
);
create index positions_entry_idx on positions (entry_id);

-- Each entry's signed ownership must net to exactly 1. Deferred so both legs of
-- a trade commit together. This is the invariant the whole app exists to protect.
create or replace function cal.enforce_entry_ownership_total() returns trigger
language plpgsql as $$
declare t numeric;
begin
  select coalesce(sum(share),0) into t from cal.positions
   where entry_id = coalesce(new.entry_id, old.entry_id);
  if t <> 1.000000 then
    raise exception 'entry % ownership must net exactly 1.000000, got %',
      coalesce(new.entry_id, old.entry_id), t using errcode='23514';
  end if;
  return null;
end $$;

create constraint trigger positions_net_one
  after insert or update or delete on positions
  deferrable initially deferred
  for each row execute function cal.enforce_entry_ownership_total();

-- ---------------------------------------------------------------- trades ----
create table trades (
  id            serial primary key,
  calcutta_id   integer not null references calcuttas(id) on delete cascade,
  sheet_ref     text,                  -- the workbook's own Trade ID
  trade_date    date,
  detail        text,
  -- entry           a share of one auction lot (includes naked shorts + synthetics)
  -- book            a levered position on the SPREAD between two owners' books
  -- synthetic_book  a levered position on ONE owner's whole book
  -- sidebet         a prop wager between owners, unrelated to any book
  -- cash            a bare cash payment between owners
  scope         text not null default 'entry'
    check (scope in ('entry','book','synthetic_book','sidebet','cash')),
  entry_id      integer references entries(id),
  from_owner_id integer references owners(id),
  to_owner_id   integer references owners(id),
  pct           numeric(9,6),
  cash          numeric(14,2),         -- consideration; signed, may be negative
  status        text not null default 'approved',

  -- Book-level instruments. An owner may hold synthetic exposure to another
  -- owner's whole book without winning any lot at auction.
  --   spread:       value(holder) = factor x ( book(A) - book(B) )
  --   single-sided: value(holder) = factor x book(reference_owner)
  reference_owner_id integer references owners(id),
  factor        numeric(9,4),
  basis         text check (basis in ('lion_king','net')),

  -- lion_king: auction lots ONLY (trades excluded), each counted at 100% of its
  --            gain regardless of the share actually bought.
  -- net:       share-weighted and trade-adjusted.
  -- Every crossbook in Calcuttas I-XI was intended as lion_king.
  -- A book trade needs a basis to be interpretable. `factor` may be null for a
  -- historical trade whose leverage was never recorded cleanly (Calcutta IV's
  -- "2x 3x levered" bet) — such a trade is stored but cannot be recomputed, and
  -- the engine must treat a null factor as "carry the booked cash, do not derive".
  constraint trades_scope_shape check (
    (scope = 'entry' and entry_id is not null and basis is null)
    or (scope in ('book','synthetic_book') and basis is not null)
    or (scope in ('sidebet','cash') and basis is null and factor is null)
  )
);

-- --------------------------------------------------------- scoring events ---
-- THE generic fact table. One row per (entry, period, metric).
create table scoring_events (
  id          serial primary key,
  entry_id    integer not null references entries(id) on delete cascade,
  period_key  text,                    -- null for tournament-wide metrics (upsets)
  metric      text not null,           -- 'win','tie','advance','game_win','sweep',
                                       -- 'top_table','so_loss','upset_3plus', ...
  units       numeric(12,4) not null,
  source      text not null default 'sheet',
  unique (entry_id, period_key, metric)
);
create index scoring_events_entry_idx on scoring_events (entry_id);

-- ------------------------------------------------------ expected (tie-out) --
-- The workbook's own answers, loaded so the engine can be reconciled against
-- them. Never an input to a calculation.
create table expected_entry_results (
  entry_id        integer primary key references entries(id) on delete cascade,
  points          numeric(14,4),
  realized_return numeric(14,2)
);

create table expected_owner_results (
  calcutta_id integer not null references calcuttas(id) on delete cascade,
  owner_id    integer not null references owners(id),
  cost        numeric(14,2),
  realized    numeric(14,2),
  primary key (calcutta_id, owner_id)
);
