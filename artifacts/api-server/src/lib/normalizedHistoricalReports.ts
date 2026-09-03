import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  getKnownHistoricalBookVariance,
  isKnownHistoricalSourceVariance,
} from "./historicalScoring";

type NumericValue = string | number | null;

type HistoricalPoolRow = {
  id: number;
  editionNumber: number;
  name: string;
  sport: string;
  formatKey: string;
  seasonYear: number;
  asOfDate: string | null;
  potSize: NumericValue;
  entryPriceTotal: NumericValue;
  status: string;
};

type HistoricalEntryRow = {
  id: number;
  label: string;
  kind: "single" | "bundle" | "placeholder";
  attributes: Record<string, unknown> | null;
  price: NumericValue;
  tracking: string | null;
  points: NumericValue;
  payout: NumericValue;
};

type HistoricalEntryTeamRow = {
  entryId: number;
  id: number;
  name: string;
  seed: number | null;
  resolved: boolean;
};

type HistoricalEntryOwnerRow = {
  entryId: number;
  ownerId: number;
  ownerName: string;
  label: string;
  share: NumericValue;
  source: "primary" | "trade";
  consortium: string | null;
  rosterStatus: "mapped" | "unassigned" | "not_supplied";
  rosterSourceOwnerLabel: string | null;
};

type HistoricalOwnerRow = {
  ownerId: number;
  ownerName: string;
  labels: string[];
  lotCount: NumericValue;
  cost: NumericValue;
  payout: NumericValue;
  consortium: string | null;
  rosterStatus: "mapped" | "unassigned" | "not_supplied";
  rosterSourceOwnerLabel: string | null;
};

type HistoricalCrossPoolOwnerRow = HistoricalOwnerRow & {
  poolId: number;
  editionNumber: number;
  poolName: string;
};

type HistoricalTradeRow = {
  id: number;
  sheetRef: string | null;
  tradeDate: string | null;
  detail: string | null;
  scope: "entry" | "book" | "synthetic_book" | "sidebet" | "cash";
  entryId: number | null;
  entryLabel: string | null;
  fromOwnerId: number | null;
  fromOwnerName: string | null;
  toOwnerId: number | null;
  toOwnerName: string | null;
  pct: NumericValue;
  cash: NumericValue;
  factor: NumericValue;
  basis: "lion_king" | "net" | null;
  status: string;
};

function numberOrNull(value: NumericValue): number | null {
  return value == null ? null : Number(value);
}

function hasValue(value: NumericValue): boolean {
  return value != null;
}

const FIRST_LIVE_EDITION = 12;

export async function loadNormalizedHistoricalPools() {
  const result = await db.execute(sql`
    select
      c.id,
      c.edition_number as "editionNumber",
      c.name,
      c.sport,
      c.format_key as "formatKey",
      c.season_year as "seasonYear",
      c.as_of_date::text as "asOfDate",
      c.pot_size as "potSize",
      sum(e.price) as "entryPriceTotal",
      c.status
    from normalized_calcuttas c
    left join normalized_entries e on e.calcutta_id = c.id
    where c.edition_number < ${FIRST_LIVE_EDITION}
    group by c.id
    order by c.edition_number desc
  `);

  return (result.rows as HistoricalPoolRow[]).map((row) => {
    const potSize = numberOrNull(row.potSize);
    const entryPriceTotal = numberOrNull(row.entryPriceTotal);
    const difference =
      potSize == null || entryPriceTotal == null
        ? null
        : entryPriceTotal - potSize;
    const varianceStatus =
      potSize == null || entryPriceTotal == null
        ? "unavailable"
        : Math.abs(entryPriceTotal - potSize) <= 0.01
          ? "matched"
          : isKnownHistoricalSourceVariance(
                row.editionNumber,
                potSize,
                entryPriceTotal,
              )
            ? "known_variance"
            : "unexpected_variance";
    return {
      id: row.id,
      editionNumber: row.editionNumber,
      name: row.name,
      sport: row.sport,
      formatKey: row.formatKey,
      seasonYear: row.seasonYear,
      asOfDate: row.asOfDate,
      potSize,
      potSizeAvailable: hasValue(row.potSize),
      entryPriceTotal,
      entryPriceTotalAvailable: hasValue(row.entryPriceTotal),
      entryPricePotDifference: difference,
      entryPricePotDifferenceAvailable: difference != null,
      entryPricePotVarianceStatus: varianceStatus,
      status: row.status,
    };
  });
}

async function loadPool(poolId: number): Promise<HistoricalPoolRow | null> {
  const result = await db.execute(sql`
    select
      id,
      edition_number as "editionNumber",
      name,
      sport,
      format_key as "formatKey",
      season_year as "seasonYear",
      as_of_date::text as "asOfDate",
      pot_size as "potSize",
      status
    from normalized_calcuttas
    where id = ${poolId}
      and edition_number < ${FIRST_LIVE_EDITION}
    limit 1
  `);
  return (result.rows[0] as HistoricalPoolRow | undefined) ?? null;
}

export async function normalizedHistoricalPoolExists(poolId: number): Promise<boolean> {
  return (await loadPool(poolId)) != null;
}

export async function loadNormalizedHistoricalEntries(poolId: number) {
  const pool = await loadPool(poolId);
  if (!pool) return null;

  const [entryResult, teamResult, ownerResult] = await Promise.all([
    db.execute(sql`
      select
        e.id,
        e.label,
        e.kind,
        e.attributes,
        e.price,
        v.tracking,
        v.points,
        v.payout
      from normalized_entries e
      join normalized_calcuttas c on c.id = e.calcutta_id
      left join v_entry_results v
        on v.ed = c.edition_number
       and v.calcutta = c.name
       and v.lot = e.label
      where e.calcutta_id = ${poolId}
      order by e.lot_order nulls last, e.id
    `),
    db.execute(sql`
      select
        et.entry_id as "entryId",
        t.id,
        t.name,
        et.seed,
        et.resolved
      from normalized_entry_teams et
      join normalized_teams t on t.id = et.team_id
      join normalized_entries e on e.id = et.entry_id
      where e.calcutta_id = ${poolId}
      order by e.lot_order nulls last, et.entry_id, t.name
    `),
    db.execute(sql`
      select
        p.entry_id as "entryId",
        o.id as "ownerId",
        o.display_name as "ownerName",
        co.label,
        p.share,
        p.source,
        consortium.name as consortium,
        case
          when roster.owner_id is null then 'not_supplied'
          when roster.consortium_id is null then 'unassigned'
          else 'mapped'
        end as "rosterStatus",
        roster.source_owner_label as "rosterSourceOwnerLabel"
      from normalized_positions p
      join normalized_entries e on e.id = p.entry_id
      join normalized_owners o on o.id = p.owner_id
      join normalized_calcutta_owners co
        on co.calcutta_id = e.calcutta_id
       and co.owner_id = o.id
      left join historical_calcutta_rosters roster
        on roster.calcutta_id = e.calcutta_id
       and roster.owner_id = o.id
      left join consortia consortium on consortium.id = roster.consortium_id
      where e.calcutta_id = ${poolId}
      order by p.entry_id, p.source, o.display_name
    `),
  ]);

  const teamsByEntry = new Map<number, HistoricalEntryTeamRow[]>();
  for (const row of teamResult.rows as HistoricalEntryTeamRow[]) {
    const teams = teamsByEntry.get(row.entryId) ?? [];
    teams.push(row);
    teamsByEntry.set(row.entryId, teams);
  }
  const ownersByEntry = new Map<number, HistoricalEntryOwnerRow[]>();
  for (const row of ownerResult.rows as HistoricalEntryOwnerRow[]) {
    const owners = ownersByEntry.get(row.entryId) ?? [];
    owners.push(row);
    ownersByEntry.set(row.entryId, owners);
  }

  return (entryResult.rows as HistoricalEntryRow[]).map((row) => ({
    id: row.id,
    label: row.label,
    kind: row.kind,
    attributes: row.attributes,
    price: numberOrNull(row.price),
    priceAvailable: hasValue(row.price),
    teams: (teamsByEntry.get(row.id) ?? []).map((team) => ({
      id: team.id,
      name: team.name,
      seed: team.seed,
      resolved: team.resolved,
    })),
    ownership: (ownersByEntry.get(row.id) ?? []).map((owner) => ({
      ownerId: owner.ownerId,
      ownerName: owner.ownerName,
      label: owner.label,
      share: numberOrNull(owner.share) ?? 0,
      source: owner.source,
      consortium: owner.consortium,
      rosterStatus: owner.rosterStatus,
      rosterSourceOwnerLabel: owner.rosterSourceOwnerLabel,
    })),
    tracking: row.tracking,
    points: numberOrNull(row.points),
    pointsAvailable: hasValue(row.points),
    payout: numberOrNull(row.payout),
    payoutAvailable: hasValue(row.payout),
  }));
}

export async function loadNormalizedHistoricalOwners(poolId: number) {
  const pool = await loadPool(poolId);
  if (!pool) return null;

  const result = await db.execute(sql`
    with primary_rollups as (
      select
        p.owner_id,
        round(sum(p.share), 4) as lots,
        round(sum(p.share * e.price), 2) as cost,
        case
          when bool_and(x.realized_return is not null)
            then sum(p.share * x.realized_return)
          else null
        end as payout
      from normalized_positions p
      join normalized_entries e on e.id = p.entry_id
      left join normalized_expected_entry_results x on x.entry_id = e.id
      where e.calcutta_id = ${poolId}
        and p.source = 'primary'
      group by p.owner_id
    ),
    trade_impacts as (
      select
        co.owner_id,
        sum(tr.cash) as cash
      from normalized_trades tr
      join normalized_calcutta_owners co
        on co.calcutta_id = tr.calcutta_id
       and co.label = tr.source_data->>'leg_owner'
      where tr.calcutta_id = ${poolId}
        and tr.status = 'approved'
        and tr.cash is not null
      group by co.owner_id
    ),
    trade_owners as (
      select from_owner_id as owner_id
      from normalized_trades
      where calcutta_id = ${poolId} and from_owner_id is not null
      union
      select to_owner_id as owner_id
      from normalized_trades
      where calcutta_id = ${poolId} and to_owner_id is not null
      union
      select reference_owner_id as owner_id
      from normalized_trades
      where calcutta_id = ${poolId} and reference_owner_id is not null
    )
    select
      o.id as "ownerId",
      o.display_name as "ownerName",
      array[co.label] as labels,
      coalesce(r.lots, 0) as "lotCount",
      case when r.owner_id is not null then r.cost else expected.cost end as cost,
      case
        when r.owner_id is not null and r.payout is not null
          then round(
            (
              case
                when expected.realized is not null
                  and abs(expected.realized - r.payout) <= 0.01
                  then expected.realized
                else r.payout
              end
            ) + coalesce(trade_impact.cash, 0),
            2
          )
        when r.owner_id is not null then null
        when expected.realized is not null
          then round(expected.realized + coalesce(trade_impact.cash, 0), 2)
        else null
      end as payout,
      consortium.name as consortium,
      case
        when roster.owner_id is null then 'not_supplied'
        when roster.consortium_id is null then 'unassigned'
        else 'mapped'
      end as "rosterStatus",
      roster.source_owner_label as "rosterSourceOwnerLabel"
    from normalized_calcutta_owners co
    join normalized_owners o on o.id = co.owner_id
    left join primary_rollups r on r.owner_id = o.id
    left join trade_impacts trade_impact on trade_impact.owner_id = o.id
    left join trade_owners trade_owner on trade_owner.owner_id = o.id
    left join normalized_expected_owner_results expected
      on expected.calcutta_id = co.calcutta_id
     and expected.owner_id = o.id
    left join historical_calcutta_rosters roster
      on roster.calcutta_id = co.calcutta_id
     and roster.owner_id = o.id
    left join consortia consortium on consortium.id = roster.consortium_id
    where co.calcutta_id = ${poolId}
      and (
        r.owner_id is not null
        or trade_owner.owner_id is not null
        or expected.cost is not null
        or expected.realized is not null
      )
    order by payout desc nulls last, o.display_name
  `);

  return (result.rows as HistoricalOwnerRow[]).map((row) => ({
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    labels: row.labels,
    lotCount: numberOrNull(row.lotCount) ?? 0,
    cost: numberOrNull(row.cost),
    costAvailable: hasValue(row.cost),
    payout: numberOrNull(row.payout),
    payoutAvailable: hasValue(row.payout),
    consortium: row.consortium,
    rosterStatus: row.rosterStatus,
    rosterSourceOwnerLabel: row.rosterSourceOwnerLabel,
  }));
}

export async function loadNormalizedHistoricalOwnerResults() {
  const result = await db.execute(sql`
    with primary_rollups as (
      select
        e.calcutta_id as pool_id,
        p.owner_id,
        round(sum(p.share), 4) as lots,
        round(sum(p.share * e.price), 2) as cost,
        case
          when bool_and(x.realized_return is not null)
            then sum(p.share * x.realized_return)
          else null
        end as payout
      from normalized_positions p
      join normalized_entries e on e.id = p.entry_id
      join normalized_calcuttas c on c.id = e.calcutta_id
      left join normalized_expected_entry_results x on x.entry_id = e.id
      where p.source = 'primary'
        and c.edition_number < ${FIRST_LIVE_EDITION}
      group by e.calcutta_id, p.owner_id
    ),
    trade_impacts as (
      select
        tr.calcutta_id as pool_id,
        co.owner_id,
        sum(tr.cash) as cash
      from normalized_trades tr
      join normalized_calcuttas c on c.id = tr.calcutta_id
      join normalized_calcutta_owners co
        on co.calcutta_id = tr.calcutta_id
       and co.label = tr.source_data->>'leg_owner'
      where c.edition_number < ${FIRST_LIVE_EDITION}
        and tr.status = 'approved'
        and tr.cash is not null
      group by tr.calcutta_id, co.owner_id
    ),
    covered_results as (
      select
        primary_result.pool_id,
        primary_result.owner_id,
        primary_result.lots,
        primary_result.cost,
        case
          when primary_result.payout is not null
            then round(
              (
                case
                  when expected.realized is not null
                    and abs(expected.realized - primary_result.payout) <= 0.01
                    then expected.realized
                  else primary_result.payout
                end
              ) + coalesce(trade_impact.cash, 0),
              2
            )
          else null
        end as payout
      from primary_rollups primary_result
      left join trade_impacts trade_impact
        on trade_impact.pool_id = primary_result.pool_id
       and trade_impact.owner_id = primary_result.owner_id
      left join normalized_expected_owner_results expected
        on expected.calcutta_id = primary_result.pool_id
       and expected.owner_id = primary_result.owner_id

      union all

      select
        expected.calcutta_id as pool_id,
        expected.owner_id,
        0::numeric as lots,
        expected.cost,
        case
          when expected.realized is not null
            then round(expected.realized + coalesce(trade_impact.cash, 0), 2)
          else null
        end as payout
      from normalized_expected_owner_results expected
      join normalized_calcuttas c on c.id = expected.calcutta_id
      left join trade_impacts trade_impact
        on trade_impact.pool_id = expected.calcutta_id
       and trade_impact.owner_id = expected.owner_id
      where c.edition_number < ${FIRST_LIVE_EDITION}
        and (expected.cost is not null or expected.realized is not null)
        and not exists (
          select 1
          from normalized_positions p
          join normalized_entries e on e.id = p.entry_id
          where e.calcutta_id = expected.calcutta_id
            and p.owner_id = expected.owner_id
            and p.source = 'primary'
        )
    )
    select
      c.id as "poolId",
      c.edition_number as "editionNumber",
      c.name as "poolName",
      o.id as "ownerId",
      o.display_name as "ownerName",
      array[co.label] as labels,
      covered.lots as "lotCount",
      covered.cost,
      covered.payout,
      consortium.name as consortium,
      case
        when roster.owner_id is null then 'not_supplied'
        when roster.consortium_id is null then 'unassigned'
        else 'mapped'
      end as "rosterStatus",
      roster.source_owner_label as "rosterSourceOwnerLabel"
    from covered_results covered
    join normalized_calcuttas c on c.id = covered.pool_id
    join normalized_owners o on o.id = covered.owner_id
    join normalized_calcutta_owners co
      on co.calcutta_id = c.id
     and co.owner_id = o.id
    left join historical_calcutta_rosters roster
      on roster.calcutta_id = c.id
     and roster.owner_id = o.id
    left join consortia consortium on consortium.id = roster.consortium_id
    order by c.edition_number desc, covered.payout desc nulls last, o.display_name
  `);

  return (result.rows as HistoricalCrossPoolOwnerRow[]).map((row) => ({
    poolId: row.poolId,
    editionNumber: row.editionNumber,
    poolName: row.poolName,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    labels: row.labels,
    lotCount: numberOrNull(row.lotCount) ?? 0,
    cost: numberOrNull(row.cost),
    costAvailable: hasValue(row.cost),
    payout: numberOrNull(row.payout),
    payoutAvailable: hasValue(row.payout),
    consortium: row.consortium,
    rosterStatus: row.rosterStatus,
    rosterSourceOwnerLabel: row.rosterSourceOwnerLabel,
  }));
}

export async function loadNormalizedHistoricalTrades(poolId: number) {
  const pool = await loadPool(poolId);
  if (!pool) return null;

  const result = await db.execute(sql`
    select
      tr.id,
      tr.sheet_ref as "sheetRef",
      tr.trade_date::text as "tradeDate",
      tr.detail,
      tr.scope,
      tr.entry_id as "entryId",
      e.label as "entryLabel",
      tr.from_owner_id as "fromOwnerId",
      from_owner.display_name as "fromOwnerName",
      tr.to_owner_id as "toOwnerId",
      to_owner.display_name as "toOwnerName",
      tr.pct,
      tr.cash,
      tr.factor,
      tr.basis,
      tr.status
    from normalized_trades tr
    left join normalized_entries e on e.id = tr.entry_id
    left join normalized_owners from_owner on from_owner.id = tr.from_owner_id
    left join normalized_owners to_owner on to_owner.id = tr.to_owner_id
    where tr.calcutta_id = ${poolId}
    order by tr.trade_date nulls last, tr.id
  `);

  return (result.rows as HistoricalTradeRow[]).map((row) => {
    const knownVariance = getKnownHistoricalBookVariance(
      pool.editionNumber,
      row.sheetRef,
    );
    const absoluteCashDifference =
      knownVariance == null
        ? null
        : Math.abs(knownVariance.derived) - Math.abs(knownVariance.booked);
    return {
      id: row.id,
      sheetRef: row.sheetRef,
      tradeDate: row.tradeDate,
      detail: row.detail,
      scope: row.scope,
      entryId: row.entryId,
      entryLabel: row.entryLabel,
      fromOwnerId: row.fromOwnerId,
      fromOwnerName: row.fromOwnerName,
      toOwnerId: row.toOwnerId,
      toOwnerName: row.toOwnerName,
      pct: numberOrNull(row.pct),
      cash: numberOrNull(row.cash),
      cashAvailable: hasValue(row.cash),
      factor: numberOrNull(row.factor),
      basis: row.basis,
      knownBookVariance: knownVariance != null,
      derivedCash: knownVariance?.derived ?? null,
      derivedCashAvailable: knownVariance != null,
      absoluteCashDifference,
      absoluteCashDifferenceAvailable: absoluteCashDifference != null,
      status: row.status,
    };
  });
}