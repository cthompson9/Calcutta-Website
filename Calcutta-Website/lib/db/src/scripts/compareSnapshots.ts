import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type SnapshotRow = Record<string, JsonValue>;

type LogicalSnapshot = {
  data: Record<string, SnapshotRow[]>;
};

export const appendOnlyNaturalKeyColumns = {
  trades: [
    "entry_id",
    "from_bidder_id",
    "to_bidder_id",
    "percentage",
    "trade_date",
  ],
  mtm_snapshots: ["entry_id", "snapshot_date"],
  ownership_adjustments: ["season_id", "team_id", "source", "created_at"],
  snapshot_metrics: ["calcutta_id", "entry_id", "period_id", "basis", "metric"],
  import_runs: ["season_id", "source", "source_hash"],
  team_results: ["team_id", "season_id"],
  mtm_snapshot: ["pool_id", "as_of", "as_of_hour", "trigger", "method_version"],
  mtm_market_quote: ["snapshot_id", "market_ticker"],
  mtm_team_projection: ["snapshot_id", "team"],
  mtm_entry_valuation: ["snapshot_id", "entry_id"],
} as const;

export type AppendOnlyTable = keyof typeof appendOnlyNaturalKeyColumns;

export type RowCountDecrease = {
  table: AppendOnlyTable;
  previousCount: number;
  currentCount: number;
  removedNaturalKeys: SnapshotRow[];
};

export type SnapshotComparison = {
  decreases: RowCountDecrease[];
  truncations: RowCountDecrease[];
};

function tableRows(
  snapshot: LogicalSnapshot,
  table: AppendOnlyTable,
): SnapshotRow[] {
  const rows = snapshot.data[table];
  if (rows === undefined) {
    return [];
  }
  if (!Array.isArray(rows)) {
    throw new Error(`Snapshot table ${table} is not an array`);
  }
  return rows;
}

function naturalKey(table: AppendOnlyTable, row: SnapshotRow): SnapshotRow {
  const key: SnapshotRow = {};
  for (const column of appendOnlyNaturalKeyColumns[table]) {
    if (!(column in row)) {
      throw new Error(
        `Snapshot row for ${table} is missing natural-key column ${column}`,
      );
    }
    key[column] = row[column];
  }
  return key;
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            (value as Record<string, JsonValue>)[key],
          )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function removedNaturalKeys(
  table: AppendOnlyTable,
  previousRows: SnapshotRow[],
  currentRows: SnapshotRow[],
): SnapshotRow[] {
  const currentCounts = new Map<string, number>();
  for (const row of currentRows) {
    const serialized = canonicalJson(naturalKey(table, row));
    currentCounts.set(serialized, (currentCounts.get(serialized) ?? 0) + 1);
  }

  const removed: SnapshotRow[] = [];
  for (const row of previousRows) {
    const key = naturalKey(table, row);
    const serialized = canonicalJson(key);
    const remaining = currentCounts.get(serialized) ?? 0;
    if (remaining > 0) {
      currentCounts.set(serialized, remaining - 1);
    } else if (removed.length < 10) {
      removed.push(key);
    }
  }
  return removed;
}

export function compareSnapshots(
  previous: LogicalSnapshot,
  current: LogicalSnapshot,
): SnapshotComparison {
  if (!previous?.data || typeof previous.data !== "object") {
    throw new Error("Previous snapshot is missing its data object");
  }
  if (!current?.data || typeof current.data !== "object") {
    throw new Error("Current snapshot is missing its data object");
  }

  const decreases: RowCountDecrease[] = [];
  for (const table of Object.keys(
    appendOnlyNaturalKeyColumns,
  ) as AppendOnlyTable[]) {
    const previousRows = tableRows(previous, table);
    const currentRows = tableRows(current, table);
    if (currentRows.length >= previousRows.length) {
      continue;
    }
    decreases.push({
      table,
      previousCount: previousRows.length,
      currentCount: currentRows.length,
      removedNaturalKeys: removedNaturalKeys(table, previousRows, currentRows),
    });
  }

  return {
    decreases,
    truncations: decreases.filter(
      ({ previousCount, currentCount }) =>
        previousCount > 0 && currentCount === 0,
    ),
  };
}

async function main(): Promise<void> {
  const positionalArguments = process.argv
    .slice(2)
    .filter((argument) => argument !== "--");
  if (positionalArguments.length < 2 || positionalArguments.length > 3) {
    throw new Error(
      "Usage: compare-snapshots <previous.json> <current.json> [report.json]",
    );
  }

  const [previousPath, currentPath, reportPath] = positionalArguments.map(
    (path) => resolve(process.cwd(), path),
  );
  const [previous, current] = await Promise.all([
    readFile(previousPath, "utf8").then(JSON.parse),
    readFile(currentPath, "utf8").then(JSON.parse),
  ]);
  const comparison = compareSnapshots(previous, current);
  const serialized = `${JSON.stringify(comparison, null, 2)}\n`;
  if (reportPath) {
    await writeFile(reportPath, serialized, "utf8");
  } else {
    process.stdout.write(serialized);
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(
      `[compare-snapshots] ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  }
}