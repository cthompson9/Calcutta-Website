import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { db } from "./index";

export type HistoricalConsortiumRosterRecord = {
  edition: number;
  sourceOwnerLabel: string;
  normalizedOwnerLabel: string;
  consortium: string | null;
};

const romanEditions = new Map([
  ["I", 1],
  ["II", 2],
  ["III", 3],
  ["IV", 4],
  ["V", 5],
  ["VI", 6],
  ["VII", 7],
  ["VIII", 8],
  ["IX", 9],
  ["X", 10],
  ["XI", 11],
]);

/**
 * These are exact pool-local label bridges. They deliberately do not change or
 * merge normalized owner identities.
 */
const normalizedLabelOverrides = new Map([
  ["2|Matt", "Matt M."],
  ["3|Matt", "Matt M."],
  ["5|Ian Culnane", "Ian"],
  ["6|Shaun McGuire", "Shaun"],
  ["9|Ezra Pemstein", "Ezra"],
  ["9|Joshua Melnick", "Josh"],
  ["10|Kevin/Daniel?", "KD"],
]);

export function parseHistoricalConsortiumRosters(
  source: string,
): HistoricalConsortiumRosterRecord[] {
  const records: HistoricalConsortiumRosterRecord[] = [];
  let edition: number | null = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = /^Calcutta ([IVX]+)$/.exec(line);
    if (heading) {
      edition = romanEditions.get(heading[1]) ?? null;
      if (edition == null) throw new Error(`Unknown Calcutta edition ${heading[1]}.`);
      continue;
    }
    if (edition == null) {
      throw new Error(`Historical roster owner appears before an edition: ${line}`);
    }
    const assignment = /^(.*?) \((.+)\)$/.exec(line);
    const sourceOwnerLabel = (assignment?.[1] ?? line).trim();
    const consortium = assignment?.[2].trim() ?? null;
    records.push({
      edition,
      sourceOwnerLabel,
      normalizedOwnerLabel:
        normalizedLabelOverrides.get(`${edition}|${sourceOwnerLabel}`) ??
        sourceOwnerLabel,
      consortium,
    });
  }

  const keys = records.map(
    (record) => `${record.edition}|${record.sourceOwnerLabel}`,
  );
  if (records.length !== 88 || new Set(keys).size !== records.length) {
    throw new Error(
      `Historical consortium roster must contain 88 unique pool-owner records; found ${records.length}.`,
    );
  }
  if (
    records.some(
      (record) =>
        record.edition < 1 ||
        record.edition > 11 ||
        !record.sourceOwnerLabel ||
        record.consortium === "",
    )
  ) {
    throw new Error("Historical consortium roster contains an invalid record.");
  }
  return records;
}

const exactLegacyBidderNames = new Set([
  "Craig Thompson",
  "Ed Zhang",
  "Ezra Pemstein",
  "Ian Culnane",
  "Joey Anthony",
  "Joshua Melnick",
  "Samuel Rosen",
  "Shaun McGuire",
  "Zachary Long",
  "Zack Miller",
]);

export async function loadHistoricalConsortiumRosters(
  sourcePath: string,
): Promise<{
  sourceHash: string;
  recordCount: number;
  consortiumCount: number;
  legacyBridgeCount: number;
  unresolvedOwnerCount: number;
}> {
  const bytes = await readFile(sourcePath);
  const source = bytes.toString("utf8");
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const records = parseHistoricalConsortiumRosters(source);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(841204, 47)`);
    const pools = await tx.execute(sql`
      select id, edition_number, season_year, sport
      from normalized_calcuttas
      where edition_number between 1 and 11
    `);
    if (pools.rows.length !== 11) {
      throw new Error(
        `Historical consortium roster requires exactly one normalized pool for each edition; found ${pools.rows.length} rows.`,
      );
    }
    const poolIdByEdition = new Map(
      (
        pools.rows as Array<{
          id: number;
          edition_number: number;
          season_year: number;
          sport: string;
        }>
      ).map((row) => [Number(row.edition_number), Number(row.id)]),
    );
    if (poolIdByEdition.size !== 11) {
      throw new Error(
        `Historical consortium roster requires 11 normalized pools; found ${poolIdByEdition.size}.`,
      );
    }

    const legacyPools = await tx.execute(sql`
      select id, year, sport from calcuttas
    `);
    for (const pool of pools.rows as Array<{
      id: number;
      edition_number: number;
      season_year: number;
      sport: string;
    }>) {
      const matches = (
        legacyPools.rows as Array<{ id: number; year: number; sport: string }>
      ).filter(
        (candidate) =>
          Number(candidate.year) === Number(pool.season_year) &&
          candidate.sport.toLowerCase() === pool.sport.toLowerCase(),
      );
      if (matches.length !== 1) {
        throw new Error(
          `Historical Calcutta ${pool.edition_number} requires exactly one explicit legacy pool candidate; found ${matches.length}.`,
        );
      }
      await tx.execute(sql`
        insert into historical_calcutta_links(
          normalized_calcutta_id,
          legacy_calcutta_id,
          source_path,
          source_hash
        )
        values(
          ${Number(pool.id)},
          ${Number(matches[0].id)},
          ${sourcePath},
          ${sourceHash}
        )
        on conflict(normalized_calcutta_id) do update set
          legacy_calcutta_id = excluded.legacy_calcutta_id,
          source_path = excluded.source_path,
          source_hash = excluded.source_hash
        where historical_calcutta_links.legacy_calcutta_id is distinct from excluded.legacy_calcutta_id
           or historical_calcutta_links.source_path is distinct from excluded.source_path
           or historical_calcutta_links.source_hash is distinct from excluded.source_hash
      `);
    }

    const owners = await tx.execute(sql`
      select co.calcutta_id, co.owner_id, co.label, o.display_name
      from normalized_calcutta_owners co
      join normalized_owners o on o.id = co.owner_id
      join normalized_calcuttas c on c.id = co.calcutta_id
      where c.edition_number between 1 and 11
    `);
    const ownerByPoolIdentity = new Map<
      string,
      { ownerId: number; displayName: string }
    >();
    for (const row of owners.rows as Array<{
      calcutta_id: number;
      owner_id: number;
      label: string;
      display_name: string;
    }>) {
      const owner = {
        ownerId: Number(row.owner_id),
        displayName: row.display_name,
      };
      for (const identity of new Set([row.label, row.display_name])) {
        const key = `${Number(row.calcutta_id)}|${identity}`;
        const existing = ownerByPoolIdentity.get(key);
        if (existing && existing.ownerId !== owner.ownerId) {
          throw new Error(
            `Historical pool owner identity ${key} is not unique.`,
          );
        }
        ownerByPoolIdentity.set(key, owner);
      }
    }

    const bidderRows = await tx.execute(sql`select id, name from bidders`);
    const bidderIdByName = new Map(
      (bidderRows.rows as Array<{ id: number; name: string }>).map((row) => [
        row.name,
        Number(row.id),
      ]),
    );

    const consortiumNames = [
      ...new Set(
        records
          .map((record) => record.consortium)
          .filter((name): name is string => name != null),
      ),
    ].sort();
    const consortiumIdByName = new Map<string, number>();
    for (const name of consortiumNames) {
      const inserted = await tx.execute(sql`
        insert into consortia(name)
        values(${name})
        on conflict ((lower(name))) do update set name = excluded.name
        returning id
      `);
      consortiumIdByName.set(
        name,
        Number((inserted.rows[0] as { id: number }).id),
      );
    }

    const persistedKeys = new Set<string>();
    let legacyBridgeCount = 0;
    let unresolvedOwnerCount = 0;
    for (const record of records) {
      const calcuttaId = poolIdByEdition.get(record.edition);
      if (calcuttaId == null) {
        throw new Error(`Missing normalized Calcutta ${record.edition}.`);
      }
      const owner = ownerByPoolIdentity.get(
        `${calcuttaId}|${record.normalizedOwnerLabel}`,
      );
      if (!owner) unresolvedOwnerCount += 1;
      const bidderId = owner && exactLegacyBidderNames.has(owner.displayName)
        ? bidderIdByName.get(owner.displayName) ?? null
        : null;
      if (bidderId != null) legacyBridgeCount += 1;
      const consortiumId =
        record.consortium == null
          ? null
          : consortiumIdByName.get(record.consortium);
      if (record.consortium != null && consortiumId == null) {
        throw new Error(`Missing consortium ${record.consortium}.`);
      }
      await tx.execute(sql`
        insert into historical_calcutta_rosters(
          calcutta_id,
          owner_id,
          bidder_id,
          consortium_id,
          source_owner_label,
          source_path,
          source_hash
        )
        values(
          ${calcuttaId},
          ${owner?.ownerId ?? null},
          ${bidderId},
          ${consortiumId},
          ${record.sourceOwnerLabel},
          ${sourcePath},
          ${sourceHash}
        )
        on conflict(calcutta_id, source_owner_label) do update set
          owner_id = excluded.owner_id,
          bidder_id = excluded.bidder_id,
          consortium_id = excluded.consortium_id,
          source_owner_label = excluded.source_owner_label,
          source_path = excluded.source_path,
          source_hash = excluded.source_hash,
          recorded_at = now()
        where historical_calcutta_rosters.owner_id is distinct from excluded.owner_id
           or historical_calcutta_rosters.bidder_id is distinct from excluded.bidder_id
           or historical_calcutta_rosters.consortium_id is distinct from excluded.consortium_id
           or historical_calcutta_rosters.source_path is distinct from excluded.source_path
           or historical_calcutta_rosters.source_hash is distinct from excluded.source_hash
      `);
      persistedKeys.add(`${calcuttaId}|${record.sourceOwnerLabel}`);
    }

    const existing = await tx.execute(sql`
      select r.calcutta_id, r.owner_id, r.source_owner_label
      from historical_calcutta_rosters r
      join normalized_calcuttas c on c.id = r.calcutta_id
      where c.edition_number between 1 and 11
    `);
    const unexpected = (
      existing.rows as Array<{
      calcutta_id: number;
      owner_id: number | null;
      source_owner_label: string;
      }>
    ).filter((row) => {
      const key = `${Number(row.calcutta_id)}|${row.source_owner_label}`;
      return !persistedKeys.has(key);
    });
    if (unexpected.length > 0) {
      throw new Error(
        `Historical consortium roster has ${unexpected.length} retained record(s) absent from the authoritative source; manual review is required.`,
      );
    }

    return {
      sourceHash,
      recordCount: records.length,
      consortiumCount: consortiumNames.length,
      legacyBridgeCount,
      unresolvedOwnerCount,
    };
  });
}