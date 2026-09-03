import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "./index";
import {
  historicalOwnerRecordKey,
  loadOwnerIdentityFile,
  ownerIdentityError,
  type OwnerIdentityDocument,
  validateOwnerIdentity,
} from "./ownerIdentity";
import {
  resolveHistoricalOwnerIdentity,
  validateHistoricalOwnerIdentityRecords,
  validatePersistedHistoricalOwnerIdentities,
} from "./historicalOwnerIdentity";

export type HistoricalTrade = {
  sheet_ref?: string | number | null;
  date?: string | null;
  detail?: string | null;
  scope?: "entry" | "book" | "synthetic_book" | "sidebet" | "cash";
  entry_label?: string | null;
  from?: string | null;
  to?: string | null;
  pct?: number | null;
  cash?: number | null;
  reference_owner?: string | null;
  factor?: number | null;
  basis?: "lion_king" | "net" | null;
  [key: string]: unknown;
};

export type HistoricalDocument = {
  edition: number;
  name: string;
  sport: string;
  format_key: string;
  season_year: number;
  pot_size: number;
  as_of_date?: string;
  normalization: {
    mode?: "direct" | "direct_share" | "earned_total" | "fixed_inventory";
    denominator?: number;
  };
  periods?: Array<{
    key: string;
    seq: number;
    label?: string;
    kind?: string;
    weight?: number;
    is_scored?: boolean;
  }>;
  rules: Array<{
    kind: string;
    metric?: string;
    period_key?: string;
    rate: number;
    group_attr?: string;
    fallback?: string[];
    note?: string;
  }>;
  owners: Array<{ label: string; name?: string; email?: string | null }>;
  entries: Array<{
    label: string;
    lot_order?: number;
    price: number;
    kind?: string;
    attributes?: Record<string, unknown>;
    teams?: Array<{ name: string; seed?: number; resolved?: boolean }>;
    owners: Array<{ label: string; share: number }>;
    events?: Array<{ period_key?: string | null; metric: string; units: number }>;
    expected?: { points?: number | null; realized_return?: number | null };
  }>;
  trades?: HistoricalTrade[];
  expected_owners?: Array<{
    label: string;
    cost?: number | null;
    realized?: number | null;
  }>;
};

export type HistoricalValidation = {
  edition: number;
  entryCount: number;
  memberTeamCount: number;
  ownerCount: number;
  tradeCount: number;
  potSize: number;
  entryPriceTotal: number;
  potMatchesPrices: boolean;
  ownershipSplitsValid: true;
  ownerReferencesValid: true;
  periodReferencesValid: true;
};

const formats: Record<string, [string, string]> = {
  NCAA_MM_64: ["NCAAM", "single_elim"],
  NFL_REGULAR_SEASON_18W: ["NFL", "league"],
  NBA_PLAYOFFS_16: ["NBA", "series_bracket"],
  WORLD_CUP_48: ["SOCCER", "group_knockout"],
};

const validRuleKinds = new Set([
  "per_unit",
  "direct_share",
  "group_rank_bonus",
  "split_pool",
]);
const validEntryKinds = new Set(["single", "bundle", "placeholder"]);

function requireUnique(values: string[], description: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${description} must be unique.`);
  }
}

/**
 * Validates the DATA-CONTRACT invariants before a transaction performs writes.
 * Money comparisons use integer cents and ownership uses millionths, matching
 * the database column scales rather than binary floating-point equality.
 */
export function validateHistoricalDocument(
  doc: HistoricalDocument,
): HistoricalValidation {
  if (!Number.isInteger(doc.edition) || doc.edition <= 0) {
    throw new Error("Historical edition must be a positive integer.");
  }
  if (!formats[doc.format_key]) {
    throw new Error(`Unsupported historical format ${doc.format_key}.`);
  }
  if (!doc.normalization?.mode) {
    throw new Error(`Calcutta ${doc.edition} is missing a normalization mode.`);
  }
  if (
    doc.normalization.mode === "fixed_inventory" &&
    (!Number.isFinite(doc.normalization.denominator) ||
      (doc.normalization.denominator ?? 0) <= 0)
  ) {
    throw new Error(
      `Calcutta ${doc.edition} fixed_inventory requires a positive denominator.`,
    );
  }

  requireUnique(doc.owners.map((owner) => owner.label), "Owner labels");
  requireUnique(doc.entries.map((entry) => entry.label), "Entry labels");
  validateHistoricalOwnerIdentityRecords(
    doc.edition,
    doc.owners.map((owner) => owner.label),
  );
  const periodKeys = new Set((doc.periods ?? []).map((period) => period.key));
  const ownerLabels = new Set(doc.owners.map((owner) => owner.label));
  const entryLabels = new Set(doc.entries.map((entry) => entry.label));
  const potCents = Math.round(doc.pot_size * 100);
  const priceCents = doc.entries.reduce(
    (total, entry) => total + Math.round(entry.price * 100),
    0,
  );
  for (const rule of doc.rules) {
    if (!validRuleKinds.has(rule.kind)) {
      throw new Error(
        `Calcutta ${doc.edition} has unsupported scoring rule ${rule.kind}.`,
      );
    }
    if (
      rule.period_key != null &&
      !periodKeys.has(rule.period_key)
    ) {
      throw new Error(
        `Calcutta ${doc.edition} rule references unknown period ${rule.period_key}.`,
      );
    }
  }
  for (const entry of doc.entries) {
    if (!validEntryKinds.has(entry.kind ?? "single")) {
      throw new Error(
        `Calcutta ${doc.edition} entry ${entry.label} has invalid kind ${entry.kind}.`,
      );
    }
    const shareMillionths = entry.owners.reduce(
      (total, owner) => total + Math.round(owner.share * 1_000_000),
      0,
    );
    if (shareMillionths !== 1_000_000) {
      throw new Error(
        `Calcutta ${doc.edition} entry ${entry.label} ownership totals ${shareMillionths} millionths, not 1000000.`,
      );
    }
    for (const owner of entry.owners) {
      if (!ownerLabels.has(owner.label)) {
        throw new Error(
          `Calcutta ${doc.edition} entry ${entry.label} references unknown owner ${owner.label}.`,
        );
      }
    }
    for (const event of entry.events ?? []) {
      if (event.period_key != null && !periodKeys.has(event.period_key)) {
        throw new Error(
          `Calcutta ${doc.edition} entry ${entry.label} references unknown period ${event.period_key}.`,
        );
      }
    }
  }
  for (const expected of doc.expected_owners ?? []) {
    if (!ownerLabels.has(expected.label)) {
      throw new Error(
        `Calcutta ${doc.edition} expected owner ${expected.label} is not declared.`,
      );
    }
  }
  for (const trade of doc.trades ?? []) {
    if (trade.entry_label && !entryLabels.has(trade.entry_label)) {
      throw new Error(
        `Calcutta ${doc.edition} trade ${trade.sheet_ref ?? ""} references unknown entry ${trade.entry_label}.`,
      );
    }
    for (const [role, label] of [
      ["seller", trade.from],
      ["buyer", trade.to],
      ["reference owner", trade.reference_owner],
    ] as const) {
      if (label && !ownerLabels.has(label)) {
        throw new Error(
          `Calcutta ${doc.edition} trade ${trade.sheet_ref ?? ""} references unknown ${role} ${label}.`,
        );
      }
    }
  }

  return {
    edition: doc.edition,
    entryCount: doc.entries.length,
    memberTeamCount: doc.entries.reduce(
      (total, entry) => total + (entry.teams?.length ?? 0),
      0,
    ),
    ownerCount: doc.owners.length,
    tradeCount: doc.trades?.length ?? 0,
    potSize: potCents / 100,
    entryPriceTotal: priceCents / 100,
    potMatchesPrices: potCents === priceCents,
    ownershipSplitsValid: true,
    ownerReferencesValid: true,
    periodReferencesValid: true,
  };
}

export function shouldRepairHistoricalTrades(
  persistedTradeCount: number,
  sourceTradeCount: number,
): boolean {
  if (
    !Number.isInteger(persistedTradeCount) ||
    persistedTradeCount < 0 ||
    !Number.isInteger(sourceTradeCount) ||
    sourceTradeCount < 0
  ) {
    throw new Error("Historical trade counts must be non-negative integers.");
  }
  if (persistedTradeCount === sourceTradeCount) return false;
  if (persistedTradeCount === 0) return sourceTradeCount > 0;
  throw new Error(
    `Historical pool has ${persistedTradeCount} of ${sourceTradeCount} source trades; refusing an ambiguous partial repair.`,
  );
}

function normalizedTradeScope(trade: HistoricalTrade): HistoricalTrade["scope"] {
  const detail = (trade.detail ?? "").toUpperCase();
  if (
    trade.scope !== "entry" &&
    (detail.includes("SIDEBET") || detail.includes("CASH SIDE PAYMENT"))
  ) {
    return detail.includes("CASH SIDE PAYMENT") ? "cash" : "sidebet";
  }
  return trade.scope ?? "entry";
}

/**
 * Loads one immutable historical source in one transaction. Expected result
 * tables are comparison targets only and are never queried by this loader.
 */
type PreparedHistoricalDocument = {
  doc: HistoricalDocument;
  source: string;
  sourceHash: string;
  validation: HistoricalValidation;
};

async function persistHistoricalCalcutta(
  prepared: PreparedHistoricalDocument,
  requestedBy: string,
  ownerIdentity: OwnerIdentityDocument,
): Promise<{
  loaded: boolean;
  edition: number;
  validation: HistoricalValidation;
}> {
  const { doc, source, sourceHash, validation } = prepared;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(841204, ${doc.edition})`);
    const [formatSport, structure] = formats[doc.format_key];
    const normalizedPeriods = (doc.periods ?? []).map((period) => ({
      key: period.key,
      seq: period.seq,
      label: period.label ?? period.key,
      kind: period.kind ?? "regular",
      weight: period.weight ?? 1,
      isScored: period.is_scored ?? true,
    }));
    const periodSignature = createHash("sha256")
      .update(JSON.stringify(normalizedPeriods))
      .digest("hex")
      .slice(0, 12);
    const effectiveFormatKey = `${doc.format_key}__${periodSignature}`;
    const metrics = [
      ...new Set(
        doc.entries.flatMap((entry) =>
          (entry.events ?? []).map((event) => event.metric),
        ),
      ),
    ].sort();
    const definition = {
      sourceFormatKey: doc.format_key,
      periods: normalizedPeriods.map((period) => period.key),
      metrics,
      ruleKinds: [...new Set(doc.rules.map((rule) => rule.kind))].sort(),
      intraBundleGames: "count",
    };
    await tx.execute(sql`
      insert into competition_formats(key,sport,structure,definition)
      values(
        ${effectiveFormatKey},
        ${formatSport},
        ${structure},
        ${JSON.stringify(definition)}::jsonb
      )
      on conflict(key) do update set
        sport=excluded.sport,
        structure=excluded.structure,
        definition=excluded.definition
    `);
    for (const period of normalizedPeriods) {
      await tx.execute(sql`
        insert into format_periods(
          format_key,key,seq,label,kind,weight,is_scored
        )
        values(
          ${effectiveFormatKey},
          ${period.key},
          ${period.seq},
          ${period.label},
          ${period.kind},
          ${period.weight},
          ${period.isScored}
        )
        on conflict(format_key,key) do update set
          seq=excluded.seq,
          label=excluded.label,
          kind=excluded.kind,
          weight=excluded.weight,
          is_scored=excluded.is_scored
      `);
    }
    const prior = await tx.execute(sql`
      select 1 from normalized_import_runs
      where edition_number=${doc.edition}
        and source=${source}
        and source_hash=${sourceHash}
    `);
    if (prior.rows.length) {
      const existingCalcutta = await tx.execute(sql`
        select id from normalized_calcuttas
        where edition_number=${doc.edition}
      `);
      const calcuttaId = Number(
        (existingCalcutta.rows[0] as { id: number } | undefined)?.id,
      );
      if (!calcuttaId) {
        throw new Error(
          `Historical import provenance exists for edition ${doc.edition} without its normalized pool.`,
        );
      }
      for (const owner of doc.owners) {
        const record = historicalOwnerRecordKey(
          owner.label,
          owner.name,
          doc.edition,
        );
        const previouslyApprovedPerson = ownerIdentity.records.find(
          (mapping) => mapping.record === record,
        )?.person;
        if (!previouslyApprovedPerson) {
          throw new Error(`Missing approved owner identity for ${record}.`);
        }
        const resolvedIdentity = resolveHistoricalOwnerIdentity(
          doc.edition,
          owner.label,
        );
        const person = resolvedIdentity.person;
        const linked = await tx.execute(sql`
          select co.owner_id,o.display_name
          from normalized_calcutta_owners co
          join normalized_owners o on o.id=co.owner_id
          where co.calcutta_id=${calcuttaId} and co.label=${owner.label}
        `);
        const priorLink = linked.rows[0] as
          | { owner_id: number; display_name: string }
          | undefined;
        const priorOwnerId = Number(priorLink?.owner_id);
        if (!priorOwnerId) {
          throw new Error(
            `Historical edition ${doc.edition} is missing owner link ${owner.label}.`,
          );
        }
        const permittedPriorPeople = new Set([
          record,
          previouslyApprovedPerson,
          person,
          ...resolvedIdentity.approvedPriorPeople,
        ]);
        if (!permittedPriorPeople.has(String(priorLink?.display_name))) {
          throw new Error(
            `Historical edition ${doc.edition} owner ${owner.label} has a different owner identity mapping.`,
          );
        }
        const canonical = await tx.execute(sql`
          insert into normalized_owners(display_name,email)
          values(${person},${owner.email ?? null})
          on conflict(display_name) do update set display_name=excluded.display_name
          returning id
        `);
        const canonicalOwnerId = Number(
          (canonical.rows[0] as { id: number }).id,
        );
        if (canonicalOwnerId === priorOwnerId) continue;
        await tx.execute(sql`
          update normalized_positions
          set owner_id=${canonicalOwnerId}
          where owner_id=${priorOwnerId}
            and entry_id in (
              select id from normalized_entries where calcutta_id=${calcuttaId}
            )
        `);
        await tx.execute(sql`
          update normalized_trades
          set
            from_owner_id=case
              when from_owner_id=${priorOwnerId} then ${canonicalOwnerId}
              else from_owner_id
            end,
            to_owner_id=case
              when to_owner_id=${priorOwnerId} then ${canonicalOwnerId}
              else to_owner_id
            end,
            reference_owner_id=case
              when reference_owner_id=${priorOwnerId} then ${canonicalOwnerId}
              else reference_owner_id
            end
          where calcutta_id=${calcuttaId}
            and ${priorOwnerId} in (
              from_owner_id,
              to_owner_id,
              reference_owner_id
            )
        `);
        await tx.execute(sql`
          update normalized_expected_owner_results
          set owner_id=${canonicalOwnerId}
          where calcutta_id=${calcuttaId} and owner_id=${priorOwnerId}
        `);
        await tx.execute(sql`
          update normalized_calcutta_owners
          set owner_id=${canonicalOwnerId}
          where calcutta_id=${calcuttaId} and owner_id=${priorOwnerId}
        `);
        await tx.execute(sql`
          delete from normalized_owners old
          where old.id=${priorOwnerId}
            and not exists (
              select 1 from normalized_calcutta_owners where owner_id=old.id
            )
            and not exists (
              select 1 from normalized_positions where owner_id=old.id
            )
            and not exists (
              select 1 from normalized_trades
              where old.id in (from_owner_id,to_owner_id,reference_owner_id)
            )
            and not exists (
              select 1 from normalized_expected_owner_results where owner_id=old.id
            )
        `);
      }
      const persistedOwners = await tx.execute(sql`
        select co.label,o.display_name
        from normalized_calcutta_owners co
        join normalized_owners o on o.id=co.owner_id
        where co.calcutta_id=${calcuttaId}
      `);
      validatePersistedHistoricalOwnerIdentities(
        doc.edition,
        doc.owners.map((owner) => owner.label),
        persistedOwners.rows.map((row) => ({
          label: String(row.label),
          person: String(row.display_name),
        })),
      );
      const existingTrades = await tx.execute(sql`
        select count(*)::integer as count
        from normalized_trades
        where calcutta_id=${calcuttaId}
      `);
      const persistedTradeCount = Number(
        (existingTrades.rows[0] as { count: number } | undefined)?.count ?? 0,
      );
      const sourceTrades = doc.trades ?? [];
      let shouldRepairTrades = false;
      try {
        shouldRepairTrades = shouldRepairHistoricalTrades(
          persistedTradeCount,
          sourceTrades.length,
        );
      } catch (error) {
        throw new Error(
          `Historical edition ${doc.edition}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (shouldRepairTrades) {
        const persistedEntries = await tx.execute(sql`
          select id,label
          from normalized_entries
          where calcutta_id=${calcuttaId}
        `);
        const entryIds = new Map(
          persistedEntries.rows.map((row) => [
            String(row.label),
            Number(row.id),
          ]),
        );
        const ownerIds = new Map(
          persistedOwners.rows.map((row) => [
            String(row.label),
            Number(row.owner_id),
          ]),
        );
        for (const trade of sourceTrades) {
          const scope = normalizedTradeScope(trade);
          const entryId = trade.entry_label
            ? entryIds.get(trade.entry_label)
            : undefined;
          if (trade.entry_label && !entryId) {
            throw new Error(
              `Trade ${trade.sheet_ref ?? ""} references unknown entry ${trade.entry_label}.`,
            );
          }
          const isBook = scope === "book" || scope === "synthetic_book";
          await tx.execute(sql`
            insert into normalized_trades(
              calcutta_id,sheet_ref,trade_date,detail,scope,entry_id,
              from_owner_id,to_owner_id,pct,cash,status,reference_owner_id,factor,basis,
              source_data
            )
            values(
              ${calcuttaId},
              ${trade.sheet_ref == null ? null : String(trade.sheet_ref)},
              ${trade.date ?? null},
              ${trade.detail ?? null},
              ${scope},
              ${entryId ?? null},
              ${trade.from ? ownerIds.get(trade.from) ?? null : null},
              ${trade.to ? ownerIds.get(trade.to) ?? null : null},
              ${scope === "entry" ? trade.pct ?? null : null},
              ${trade.cash ?? null},
              ${"approved"},
              ${trade.reference_owner
                ? ownerIds.get(trade.reference_owner) ?? null
                : null},
              ${isBook ? trade.factor ?? trade.pct ?? null : null},
              ${isBook ? trade.basis ?? "lion_king" : null},
              ${JSON.stringify(trade)}::jsonb
            )
          `);
        }
      }
      await tx.execute(sql`
        update normalized_calcuttas
        set format_key=${effectiveFormatKey}
        where edition_number=${doc.edition}
          and format_key<>${effectiveFormatKey}
      `);
      return {
        loaded: shouldRepairTrades,
        edition: doc.edition,
        validation,
      };
    }
    const conflictingEdition = await tx.execute(sql`
      select 1 from normalized_calcuttas where edition_number=${doc.edition}
    `);
    if (conflictingEdition.rows.length) {
      throw new Error(
        `Historical edition ${doc.edition} was already imported from a different source hash; refusing replacement.`,
      );
    }

    const inserted = await tx.execute(sql`
      insert into normalized_calcuttas(
        edition_number,name,sport,format_key,season_year,pot_size,as_of_date,
        normalization
      )
      values(
        ${doc.edition},
        ${doc.name},
        ${doc.sport},
        ${effectiveFormatKey},
        ${doc.season_year},
        ${doc.pot_size},
        ${doc.as_of_date ?? null},
        ${JSON.stringify(doc.normalization)}::jsonb
      )
      returning id
    `);
    const calcuttaId = Number((inserted.rows[0] as { id: number }).id);

    for (const rule of doc.rules) {
      await tx.execute(sql`
        insert into normalized_scoring_rules(
          calcutta_id,kind,metric,period_key,rate,group_attr,fallback,note
        )
        values(
          ${calcuttaId},
          ${rule.kind},
          ${rule.metric ?? null},
          ${rule.period_key ?? null},
          ${rule.rate},
          ${rule.group_attr ?? null},
          ${rule.fallback ?? null},
          ${rule.note ?? null}
        )
      `);
    }

    const ownerIds = new Map<string, number>();
    for (const owner of doc.owners) {
      // Identity is resolved by the reviewed mapping, never by fuzzy matching.
      const identity = resolveHistoricalOwnerIdentity(
        doc.edition,
        owner.label,
      ).person;
      const row = await tx.execute(sql`
        insert into normalized_owners(display_name,email)
        values(${identity},${owner.email ?? null})
        on conflict(display_name) do update
          set display_name=excluded.display_name
        returning id
      `);
      const id = Number((row.rows[0] as { id: number }).id);
      ownerIds.set(owner.label, id);
      await tx.execute(sql`
        insert into normalized_calcutta_owners(calcutta_id,owner_id,label)
        values(${calcuttaId},${id},${owner.label})
      `);
    }

    const entryIds = new Map<string, number>();
    let memberTeamCount = 0;
    for (const entry of doc.entries) {
      const entryRow = await tx.execute(sql`
        insert into normalized_entries(
          calcutta_id,label,lot_order,price,kind,attributes
        )
        values(
          ${calcuttaId},
          ${entry.label},
          ${entry.lot_order ?? null},
          ${entry.price},
          ${entry.kind ?? "single"},
          ${JSON.stringify(entry.attributes ?? {})}::jsonb
        )
        returning id
      `);
      const entryId = Number((entryRow.rows[0] as { id: number }).id);
      entryIds.set(entry.label, entryId);
      for (const team of entry.teams ?? []) {
        const teamRow = await tx.execute(sql`
          insert into normalized_teams(sport,name)
          values(${doc.sport},${team.name})
          on conflict(sport,name) do update set name=excluded.name
          returning id
        `);
        await tx.execute(sql`
          insert into normalized_entry_teams(entry_id,team_id,seed,resolved)
          values(
            ${entryId},
            ${Number((teamRow.rows[0] as { id: number }).id)},
            ${team.seed ?? null},
            ${team.resolved ?? true}
          )
        `);
        memberTeamCount++;
      }
      for (const owner of entry.owners) {
        await tx.execute(sql`
          insert into normalized_positions(entry_id,owner_id,share,source)
          values(
            ${entryId},
            ${ownerIds.get(owner.label)!},
            ${owner.share},
            'primary'
          )
        `);
      }
      for (const event of entry.events ?? []) {
        await tx.execute(sql`
          insert into normalized_scoring_events(
            entry_id,period_key,metric,units
          )
          values(
            ${entryId},
            ${event.period_key ?? null},
            ${event.metric},
            ${event.units}
          )
          on conflict(entry_id,period_key,metric)
          do update set units=normalized_scoring_events.units+excluded.units
        `);
      }
      await tx.execute(sql`
        insert into normalized_expected_entry_results(
          entry_id,points,realized_return
        )
        values(
          ${entryId},
          ${entry.expected?.points ?? null},
          ${entry.expected?.realized_return ?? null}
        )
      `);
    }

    for (const trade of doc.trades ?? []) {
      const scope = normalizedTradeScope(trade);
      const entryId = trade.entry_label
        ? entryIds.get(trade.entry_label)
        : undefined;
      if (trade.entry_label && !entryId) {
        throw new Error(
          `Trade ${trade.sheet_ref ?? ""} references unknown entry ${trade.entry_label}.`,
        );
      }
      const isBook = scope === "book" || scope === "synthetic_book";
      await tx.execute(sql`
        insert into normalized_trades(
          calcutta_id,sheet_ref,trade_date,detail,scope,entry_id,
          from_owner_id,to_owner_id,pct,cash,status,reference_owner_id,factor,basis,
          source_data
        )
        values(
          ${calcuttaId},
          ${trade.sheet_ref == null ? null : String(trade.sheet_ref)},
          ${trade.date ?? null},
          ${trade.detail ?? null},
          ${scope},
          ${entryId ?? null},
          ${trade.from ? ownerIds.get(trade.from) ?? null : null},
          ${trade.to ? ownerIds.get(trade.to) ?? null : null},
          ${scope === "entry" ? trade.pct ?? null : null},
          ${trade.cash ?? null},
          ${"approved"},
          ${trade.reference_owner
            ? ownerIds.get(trade.reference_owner) ?? null
            : null},
          ${isBook ? trade.factor ?? trade.pct ?? null : null},
          ${isBook ? trade.basis ?? "lion_king" : null},
          ${JSON.stringify(trade)}::jsonb
        )
      `);
    }

    for (const expected of doc.expected_owners ?? []) {
      await tx.execute(sql`
        insert into normalized_expected_owner_results(
          calcutta_id,owner_id,cost,realized
        )
        values(
          ${calcuttaId},
          ${ownerIds.get(expected.label)!},
          ${expected.cost ?? null},
          ${expected.realized ?? null}
        )
      `);
    }
    await tx.execute(sql`
      insert into normalized_import_runs(
        edition_number,source,source_hash,imported_teams,imported_owners,
        requested_by
      )
      values(
        ${doc.edition},
        ${source},
        ${sourceHash},
        ${memberTeamCount},
        ${ownerIds.size},
        ${requestedBy}
      )
    `);
    return { loaded: true, edition: doc.edition, validation };
  });
}

export async function loadAllHistoricalCalcuttas(
  directory: string,
  requestedBy = "stage-1-history-loader",
  ownerIdentityPath = resolve(directory, "../decisions/owner-identity.yaml"),
): Promise<
  Array<{
    loaded: boolean;
    edition: number;
    validation: HistoricalValidation;
  }>
> {
  const files = (await readdir(directory))
    .filter((file) => /^calcutta-\d\d\.json$/.test(file))
    .sort();
  if (files.length !== 11) {
    throw new Error(
      `Expected 11 historical Calcutta files in ${directory}, found ${files.length}.`,
    );
  }
  const prepared = await Promise.all(
    files.map(async (file): Promise<PreparedHistoricalDocument> => {
      const bytes = await readFile(join(directory, file));
      const doc = JSON.parse(bytes.toString("utf8")) as HistoricalDocument;
      return {
        doc,
        source: basename(file),
        sourceHash: createHash("sha256").update(bytes).digest("hex"),
        validation: validateHistoricalDocument(doc),
      };
    }),
  );
  const identityDocument = await loadOwnerIdentityFile(ownerIdentityPath);
  const identityReport = validateOwnerIdentity(
    identityDocument,
    prepared.map(({ doc }) => doc),
  );
  if (!identityReport.passed) throw ownerIdentityError(identityReport);
  const results = [];
  for (const source of prepared) {
    results.push(
      await persistHistoricalCalcutta(source, requestedBy, identityDocument),
    );
  }
  return results;
}