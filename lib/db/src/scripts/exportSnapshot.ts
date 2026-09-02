import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { getTableColumns, getTableName, isTable } from "drizzle-orm";
import * as schema from "../schema/index";
import { assertForeignKeyTargetsHaveNaturalKeys } from "./snapshotNaturalKeys";

const { Pool } = pg;

type Scalar = string | number | boolean | null;
type JsonValue = Scalar | JsonValue[] | { [key: string]: JsonValue };
type RawRow = Record<string, unknown>;

type ExportedTable = {
  name: string;
  columns: string[];
};

type CatalogForeignKey = {
  sourceTable: string;
  sourceColumns: string[];
  targetTable: string;
  targetColumns: string[];
};

type CatalogUniqueKey = {
  table: string;
  columns: string[];
};

type TableInfo = ExportedTable & {
  primaryKey: string[];
  surrogatePrimaryKey: Set<string>;
  uniqueKeys: string[][];
  naturalKey: string[];
  naturalKeyResolvable: boolean;
  naturalKeySource: "declared unique key" | "registered key" | "none";
  rows: RawRow[];
};

type Catalog = {
  baseTables: string[];
  columns: Map<string, string[]>;
  timestampColumns: Array<{ table: string; column: string }>;
  primaryKeys: Map<string, string[]>;
  sequenceColumns: Set<string>;
  uniqueKeys: CatalogUniqueKey[];
  foreignKeys: CatalogForeignKey[];
};

const identifierPattern = /^[a-z_][a-z0-9_]*$/;

const registeredNaturalKeys: Readonly<Record<string, readonly string[]>> = {
  // Backed by the case-insensitive consortia_name_lower_unique index.
  consortia: ["name"],
  // Pipeline attempts are immutable and created_at distinguishes retries.
  // Runtime uniqueness validation below keeps this fail-loud.
  mtm_snapshot: ["pool_id", "as_of", "created_at"],
  // This business identity is validated against all exported rows before any
  // position FK is emitted.
  trades: [
    "entry_id",
    "from_bidder_id",
    "to_bidder_id",
    "percentage",
    "trade_date",
  ],
};

function quoteIdentifier(identifier: string): string {
  if (!identifierPattern.test(identifier)) {
    throw new Error(`Unsafe database identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function tableColumnKey(table: string, column: string): string {
  return `${table}.${column}`;
}

function parseCatalogArray(value: unknown, label: string): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === "string" && value.startsWith("{") && value.endsWith("}")) {
    const contents = value.slice(1, -1);
    if (contents.length === 0) {
      return [];
    }
    const values = contents.split(",");
    for (const item of values) {
      if (!identifierPattern.test(item)) {
        throw new Error(`Unexpected identifier in ${label}: ${item}`);
      }
    }
    return values;
  }
  throw new Error(`Expected a PostgreSQL identifier array for ${label}`);
}

function canonicalKeyPart(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }
  if (value === null || value === undefined) {
    return "<null>";
  }
  if (typeof value === "object") {
    return JSON.stringify(sortJsonValue(value)) ?? "<undefined>";
  }
  return String(value);
}

function rawKey(row: RawRow, columns: string[]): string {
  return columns.map((column) => canonicalKeyPart(row[column])).join("\u001f");
}

function sortJsonValue(value: unknown): JsonValue {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }
  if (typeof value === "object") {
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return String(value);
}

function compactJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function prettyJsonObject(value: Record<string, unknown>, indent: number): string {
  const keys = Object.keys(value).sort();
  if (keys.length === 0) {
    return "{}";
  }
  const padding = " ".repeat(indent);
  const childPadding = " ".repeat(indent + 2);
  const lines = keys.map(
    (key) =>
      `${childPadding}${JSON.stringify(key)}: ${prettyJsonValue(
        value[key],
        indent + 2,
      )}`,
  );
  return `{\n${lines.join(",\n")}\n${padding}}`;
}

function prettyJsonValue(value: unknown, indent: number): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    const padding = " ".repeat(indent);
    const childPadding = " ".repeat(indent + 2);
    return `[\n${value
      .map(
        (item) =>
          `${childPadding}${prettyJsonValue(item, indent + 2)}`,
      )
      .join(",\n")}\n${padding}]`;
  }
  if (value && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return prettyJsonObject(value as Record<string, unknown>, indent);
  }
  return compactJson(value);
}

function serializeRows(rows: Record<string, unknown>[], indent: number): string {
  if (rows.length === 0) {
    return "[]";
  }
  const padding = " ".repeat(indent);
  const childPadding = " ".repeat(indent + 2);
  return `[\n${rows
    .map((row) => `${childPadding}${compactJson(row)}`)
    .join(",\n")}\n${padding}]`;
}

function serializeDataObject(
  data: Record<string, Record<string, unknown>[]>,
): string {
  const tableNames = Object.keys(data).sort();
  const tableLines = tableNames.map(
    (tableName) =>
      `    ${JSON.stringify(tableName)}: ${serializeRows(data[tableName], 4)}`,
  );
  return `{\n${tableLines.join(",\n")}\n  }`;
}

function serializeData(data: Record<string, Record<string, unknown>[]>): string {
  return `{\n  "data": ${serializeDataObject(data)}\n}`;
}

function serializeSnapshot(
  data: Record<string, Record<string, unknown>[]>,
  meta: Record<string, unknown>,
): string {
  const metaJson = prettyJsonObject(meta, 2);
  return `{\n  "data": ${serializeDataObject(data)},\n  "meta": ${metaJson}\n}\n`;
}

function getExportedTables(): Map<string, ExportedTable> {
  const exported = new Map<string, ExportedTable>();

  for (const value of Object.values(schema)) {
    if (!value || typeof value !== "object" || !isTable(value)) {
      continue;
    }
    const table = value as Parameters<typeof getTableColumns>[0];
    const name = getTableName(table);
    const columns = Object.values(getTableColumns(table)).map((column) => column.name);
    if (exported.has(name)) {
      throw new Error(`Schema exports the database table more than once: ${name}`);
    }
    exported.set(name, { name, columns });
  }

  return exported;
}

async function readCatalog(client: pg.PoolClient): Promise<Catalog> {
  const baseTablesResult = await client.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  const columnsResult = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    column_default: string | null;
    is_identity: string;
  }>(`
    SELECT table_name, column_name, data_type, column_default, is_identity
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);

  const primaryKeysResult = await client.query<{
    table_name: string;
    column_name: string;
    ordinal_position: number;
  }>(`
    SELECT
      table_class.relname AS table_name,
      attribute.attname AS column_name,
      key_column.ordinality::integer AS ordinal_position
    FROM pg_constraint AS constraint_definition
    JOIN pg_class AS table_class
      ON table_class.oid = constraint_definition.conrelid
    JOIN pg_namespace AS table_namespace
      ON table_namespace.oid = table_class.relnamespace
    CROSS JOIN LATERAL unnest(constraint_definition.conkey)
      WITH ORDINALITY AS key_column(attnum, ordinality)
    JOIN pg_attribute AS attribute
      ON attribute.attrelid = table_class.oid
     AND attribute.attnum = key_column.attnum
    WHERE constraint_definition.contype = 'p'
      AND table_namespace.nspname = 'public'
    ORDER BY table_class.relname, key_column.ordinality
  `);

  const indexesResult = await client.query<{
    table: string;
    columns: unknown;
  }>(`
    SELECT
      table_class.relname AS table,
      array_agg(attribute.attname ORDER BY key_column.ordinality) AS columns
    FROM pg_index AS index_definition
    JOIN pg_class AS index_class
      ON index_class.oid = index_definition.indexrelid
    JOIN pg_class AS table_class
      ON table_class.oid = index_definition.indrelid
    JOIN pg_namespace AS table_namespace
      ON table_namespace.oid = table_class.relnamespace
    CROSS JOIN LATERAL unnest(index_definition.indkey)
      WITH ORDINALITY AS key_column(attnum, ordinality)
    JOIN pg_attribute AS attribute
      ON attribute.attrelid = table_class.oid
     AND attribute.attnum = key_column.attnum
    WHERE table_namespace.nspname = 'public'
      AND index_definition.indisunique
      AND index_definition.indpred IS NULL
      AND index_definition.indexprs IS NULL
      AND key_column.ordinality <= index_definition.indnkeyatts
      AND key_column.attnum > 0
    GROUP BY index_definition.indexrelid, table_class.relname
    ORDER BY table_class.relname, index_definition.indexrelid
  `);

  const foreignKeysResult = await client.query<{
    source_table: string;
    source_columns: unknown;
    target_table: string;
    target_columns: unknown;
  }>(`
    SELECT
      source_class.relname AS source_table,
      array_agg(source_attribute.attname ORDER BY source_key.ordinality) AS source_columns,
      target_class.relname AS target_table,
      array_agg(target_attribute.attname ORDER BY source_key.ordinality) AS target_columns
    FROM pg_constraint AS constraint_definition
    JOIN pg_class AS source_class
      ON source_class.oid = constraint_definition.conrelid
    JOIN pg_namespace AS source_namespace
      ON source_namespace.oid = source_class.relnamespace
    JOIN pg_class AS target_class
      ON target_class.oid = constraint_definition.confrelid
    JOIN pg_namespace AS target_namespace
      ON target_namespace.oid = target_class.relnamespace
    CROSS JOIN LATERAL unnest(constraint_definition.conkey)
      WITH ORDINALITY AS source_key(attnum, ordinality)
    JOIN pg_attribute AS source_attribute
      ON source_attribute.attrelid = source_class.oid
     AND source_attribute.attnum = source_key.attnum
    CROSS JOIN LATERAL unnest(constraint_definition.confkey)
      WITH ORDINALITY AS target_key(attnum, ordinality)
    JOIN pg_attribute AS target_attribute
      ON target_attribute.attrelid = target_class.oid
     AND target_attribute.attnum = target_key.attnum
     AND target_key.ordinality = source_key.ordinality
    WHERE constraint_definition.contype = 'f'
      AND source_namespace.nspname = 'public'
      AND target_namespace.nspname = 'public'
    GROUP BY constraint_definition.oid, source_class.relname, target_class.relname
    ORDER BY source_class.relname, constraint_definition.oid
  `);

  const columns = new Map<string, string[]>();
  const timestampColumns: Array<{ table: string; column: string }> = [];
  const sequenceColumns = new Set<string>();
  for (const row of columnsResult.rows) {
    const tableColumns = columns.get(row.table_name) ?? [];
    tableColumns.push(row.column_name);
    columns.set(row.table_name, tableColumns);
    const isTimestamp =
      row.data_type === "timestamp without time zone" ||
      row.data_type === "timestamp with time zone";
    const isFutureScheduleValue =
      row.column_name.includes("expires") ||
      row.column_name.includes("kickoff");
    if (isTimestamp && !isFutureScheduleValue) {
      timestampColumns.push({ table: row.table_name, column: row.column_name });
    }
    if (row.is_identity === "YES" || row.column_default?.startsWith("nextval(")) {
      sequenceColumns.add(tableColumnKey(row.table_name, row.column_name));
    }
  }

  const primaryKeys = new Map<string, string[]>();
  for (const row of primaryKeysResult.rows) {
    const key = primaryKeys.get(row.table_name) ?? [];
    key.push(row.column_name);
    primaryKeys.set(row.table_name, key);
  }

  const uniqueKeys = indexesResult.rows
    .map((key) => ({
      table: key.table,
      columns: parseCatalogArray(key.columns, `${key.table} unique key`),
    }))
    .filter((key) => key.columns.length > 0);

  return {
    baseTables: baseTablesResult.rows.map((row) => row.table_name),
    columns,
    timestampColumns,
    primaryKeys,
    sequenceColumns,
    uniqueKeys,
    foreignKeys: foreignKeysResult.rows.map((row) => ({
      sourceTable: row.source_table,
      sourceColumns: parseCatalogArray(
        row.source_columns,
        `${row.source_table} foreign-key columns`,
      ),
      targetTable: row.target_table,
      targetColumns: parseCatalogArray(
        row.target_columns,
        `${row.target_table} referenced columns`,
      ),
    })),
  };
}

function hasColumns(table: TableInfo, columns: string[]): boolean {
  return columns.every((column) => table.columns.includes(column));
}

function chooseNaturalKey(
  table: TableInfo,
  catalog: Catalog,
): {
  columns: string[];
  resolvable: boolean;
  source: TableInfo["naturalKeySource"];
} {
  const has = (columns: string[]) => hasColumns(table, columns);
  const containsSurrogate = (columns: readonly string[]) =>
    columns.some((column) => table.surrogatePrimaryKey.has(column));

  const registered = registeredNaturalKeys[table.name];
  if (registered) {
    const columns = [...registered];
    if (!has(columns)) {
      throw new Error(
        `Registered natural key for ${table.name} references missing columns: ${columns.join(", ")}`,
      );
    }
    if (containsSurrogate(columns)) {
      throw new Error(
        `Registered natural key for ${table.name} includes a surrogate column`,
      );
    }
    return { columns, resolvable: true, source: "registered key" };
  }

  const uniqueCandidates = catalog.uniqueKeys
    .filter((key) => key.table === table.name)
    .map((key) => key.columns)
    .filter((key) => has(key) && !containsSurrogate(key))
    .sort((left, right) => left.length - right.length || left.join().localeCompare(right.join()));
  if (uniqueCandidates[0]) {
    return {
      columns: uniqueCandidates[0],
      resolvable: true,
      source: "declared unique key",
    };
  }

  const sortableColumns = table.columns.filter(
    (column) => !table.surrogatePrimaryKey.has(column) && column !== "updated_at",
  );
  if (sortableColumns.length > 0) {
    return { columns: sortableColumns, resolvable: false, source: "none" };
  }

  throw new Error(`Cannot derive a natural key for table ${table.name}`);
}

function buildTableInfos(exported: Map<string, ExportedTable>, catalog: Catalog): TableInfo[] {
  const missingFromSchema = catalog.baseTables.filter((name) => !exported.has(name));
  if (missingFromSchema.length > 0) {
    throw new Error(
      `Database BASE TABLES missing from lib/db/src/schema/index.ts: ${missingFromSchema.join(", ")}`,
    );
  }

  const tables = catalog.baseTables.map((name) => {
    const exportedTable = exported.get(name);
    if (!exportedTable) {
      throw new Error(`Missing schema export for database table ${name}`);
    }
    const actualColumns = catalog.columns.get(name) ?? [];
    const missingColumns = actualColumns.filter((column) => !exportedTable.columns.includes(column));
    if (missingColumns.length > 0) {
      throw new Error(
        `Database table ${name} has columns missing from its schema export: ${missingColumns.join(", ")}`,
      );
    }

    const primaryKey = catalog.primaryKeys.get(name) ?? [];
    // Some migrated tables retain a legacy sequence-backed id even though a
    // natural composite key is now primary. It is still a surrogate identity
    // and must not make logical snapshots depend on database numbering.
    const surrogatePrimaryKey = new Set(
      actualColumns.filter((column) =>
        catalog.sequenceColumns.has(tableColumnKey(name, column)),
      ),
    );
    const table: TableInfo = {
      ...exportedTable,
      primaryKey,
      surrogatePrimaryKey,
      uniqueKeys: catalog.uniqueKeys
        .filter((key) => key.table === name)
        .map((key) => key.columns),
      naturalKey: [],
      naturalKeyResolvable: false,
      naturalKeySource: "none",
      rows: [],
    };
    const naturalKey = chooseNaturalKey(table, catalog);
    table.naturalKey = naturalKey.columns;
    table.naturalKeyResolvable = naturalKey.resolvable;
    table.naturalKeySource = naturalKey.source;
    return table;
  });

  return tables;
}

function printNaturalKeyAudit(tables: TableInfo[]): void {
  console.log("Natural key audit:");
  console.log("");
  console.log(`${"TABLE".padEnd(42)}${"NATURAL KEY".padEnd(64)}SOURCE`);
  console.log("-".repeat(126));
  for (const table of tables) {
    const key = table.naturalKeyResolvable
      ? table.naturalKey.join(", ")
      : "NONE";
    console.log(
      `${table.name.padEnd(42)}${key.padEnd(64)}${table.naturalKeySource}`,
    );
  }
  console.log("");
}

function buildForeignKeyMaps(catalog: Catalog): {
  simple: Map<string, CatalogForeignKey>;
  composite: CatalogForeignKey[];
} {
  const simple = new Map<string, CatalogForeignKey>();
  const composite: CatalogForeignKey[] = [];
  for (const foreignKey of catalog.foreignKeys) {
    if (foreignKey.sourceColumns.length === 1 && foreignKey.targetColumns.length === 1) {
      const key = tableColumnKey(foreignKey.sourceTable, foreignKey.sourceColumns[0]);
      if (!simple.has(key)) {
        simple.set(key, foreignKey);
      }
    } else {
      composite.push(foreignKey);
    }
  }
  return { simple, composite };
}

function compareNaturalKeys(left: unknown, right: unknown): number {
  const leftKey = canonicalKeyPart(left);
  const rightKey = canonicalKeyPart(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

async function exportSnapshot(
  client: pg.PoolClient,
  tables: TableInfo[],
  catalog: Catalog,
): Promise<{
  data: Record<string, Record<string, unknown>[]>;
  meta: Record<string, unknown>;
}> {
  for (const table of tables) {
    const result = await client.query<RawRow>(
      `SELECT * FROM ${quoteIdentifier(table.name)}`,
    );
    table.rows = result.rows;
  }

  const tableByName = new Map(tables.map((table) => [table.name, table]));
  const { simple, composite } = buildForeignKeyMaps(catalog);
  assertForeignKeyTargetsHaveNaturalKeys(
    new Map(
      tables
        .filter((table) => table.naturalKeyResolvable)
        .map((table) => [table.name, table.naturalKey]),
    ),
    catalog.foreignKeys,
  );

  for (const table of tables) {
    if (!table.naturalKeyResolvable) {
      continue;
    }
    const seen = new Set<string>();
    for (const row of table.rows) {
      const key = rawKey(row, table.naturalKey);
      if (seen.has(key)) {
        throw new Error(
          `Registered natural key for ${table.name} is not unique: ${table.naturalKey.join(", ")}`,
        );
      }
      seen.add(key);
    }
  }

  const foreignTargetRows = new Map<string, Map<string, RawRow>>();
  for (const foreignKey of catalog.foreignKeys) {
    const lookupIdentity = `${foreignKey.targetTable}:${foreignKey.targetColumns.join(",")}`;
    if (foreignTargetRows.has(lookupIdentity)) {
      continue;
    }
    const target = tableByName.get(foreignKey.targetTable);
    if (!target) {
      throw new Error(
        `Foreign key points to an unexported table ${foreignKey.targetTable}`,
      );
    }
    const rows = new Map<string, RawRow>();
    for (const row of target.rows) {
      const key = rawKey(row, foreignKey.targetColumns);
      if (rows.has(key)) {
        throw new Error(
          `Declared foreign key target ${foreignKey.targetTable}.${foreignKey.targetColumns.join(",")} is not unique`,
        );
      }
      rows.set(key, row);
    }
    foreignTargetRows.set(lookupIdentity, rows);
  }

  const resolving = new WeakSet<RawRow>();
  const naturalKeyCache = new WeakMap<RawRow, unknown>();

  const resolveNaturalKey = (tableName: string, row: RawRow): unknown => {
    const table = tableByName.get(tableName);
    if (!table) {
      throw new Error(`Foreign key points to an unexported table ${tableName}`);
    }
    if (!table.naturalKeyResolvable) {
      throw new Error(
        `Cannot resolve a foreign key to a natural key for table ${tableName}; no stable natural key is defined`,
      );
    }
    const cached = naturalKeyCache.get(row);
    if (cached !== undefined) {
      return cached;
    }
    if (resolving.has(row)) {
      throw new Error(`Circular natural-key resolution involving ${tableName}`);
    }
    resolving.add(row);
    const parts = table.naturalKey.map((column) =>
      resolveColumnValue(table, row, column),
    );
    resolving.delete(row);
    const naturalKey = parts.length === 1 ? parts[0] : parts;
    naturalKeyCache.set(row, naturalKey);
    return naturalKey;
  };

  const resolveForeignKey = (foreignKey: CatalogForeignKey, row: RawRow): unknown => {
    const target = tableByName.get(foreignKey.targetTable);
    if (!target) {
      throw new Error(
        `Foreign key ${foreignKey.sourceTable}.${foreignKey.sourceColumns.join(",")} references unexported table ${foreignKey.targetTable}`,
      );
    }
    if (!target.naturalKeyResolvable) {
      throw new Error(
        `Cannot resolve foreign key target ${target.name} without a registered natural key`,
      );
    }
    const lookupIdentity = `${foreignKey.targetTable}:${foreignKey.targetColumns.join(",")}`;
    const targetRows = foreignTargetRows.get(lookupIdentity);
    if (!targetRows) {
      throw new Error(
        `Missing declared foreign-key lookup for ${foreignKey.targetTable}.${foreignKey.targetColumns.join(",")}`,
      );
    }
    const targetRow = targetRows.get(rawKey(row, foreignKey.sourceColumns));
    if (!targetRow) {
      throw new Error(
        `Cannot resolve ${foreignKey.sourceTable}.${foreignKey.sourceColumns.join(",")} value to ${foreignKey.targetTable}.${foreignKey.targetColumns.join(",")}`,
      );
    }
    return resolveNaturalKey(target.name, targetRow);
  };

  function resolveColumnValue(table: TableInfo, row: RawRow, column: string): unknown {
    const foreignKey = simple.get(tableColumnKey(table.name, column));
    if (foreignKey && row[column] !== null && row[column] !== undefined) {
      return resolveForeignKey(foreignKey, row);
    }
    return sortJsonValue(row[column]);
  }

  const compositeByColumn = new Map<string, CatalogForeignKey>();
  for (const foreignKey of composite) {
    for (const column of foreignKey.sourceColumns) {
      const key = tableColumnKey(foreignKey.sourceTable, column);
      if (!compositeByColumn.has(key)) {
        compositeByColumn.set(key, foreignKey);
      }
    }
  }

  const data: Record<string, Record<string, unknown>[]> = {};
  const rowSortKeys = new Map<Record<string, unknown>, unknown>();
  for (const table of tables) {
    const outputRows = table.rows.map((row) => {
      const output: Record<string, unknown> = {};
      const compositeValues = new Map<CatalogForeignKey, unknown[]>();
      for (const column of table.columns) {
        if (table.surrogatePrimaryKey.has(column) || column === "updated_at") {
          continue;
        }
        const compositeForeignKey = compositeByColumn.get(tableColumnKey(table.name, column));
        const compositeIsPopulated =
          compositeForeignKey?.sourceColumns.every(
            (sourceColumn) =>
              row[sourceColumn] !== null && row[sourceColumn] !== undefined,
          ) ?? false;
        if (compositeForeignKey && compositeIsPopulated) {
          let values = compositeValues.get(compositeForeignKey);
          if (!values) {
            const naturalKey = resolveForeignKey(compositeForeignKey, row);
            if (!Array.isArray(naturalKey)) {
              throw new Error(
                `Composite foreign key ${table.name}.${compositeForeignKey.sourceColumns.join(",")} resolved to a scalar natural key`,
              );
            }
            values = naturalKey;
            compositeValues.set(compositeForeignKey, values);
          }
          const componentIndex = compositeForeignKey.sourceColumns.indexOf(column);
          output[column] = values[componentIndex];
          continue;
        }
        output[column] = resolveColumnValue(table, row, column);
      }
      return output;
    });

    for (let index = 0; index < table.rows.length; index += 1) {
      rowSortKeys.set(outputRows[index], table.naturalKey.map((column) => resolveColumnValue(table, table.rows[index], column)));
    }
    outputRows.sort((left, right) => {
      const leftKey = rowSortKeys.get(left);
      const rightKey = rowSortKeys.get(right);
      const leftParts = Array.isArray(leftKey) ? leftKey : [leftKey];
      const rightParts = Array.isArray(rightKey) ? rightKey : [rightKey];
      for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
        const comparison = compareNaturalKeys(leftParts[index], rightParts[index]);
        if (comparison !== 0) {
          return comparison;
        }
      }
      return compareNaturalKeys(compactJson(left), compactJson(right));
    });
    data[table.name] = outputRows;
  }

  const serializedByteSizes: Record<string, number> = {};
  const rowCounts: Record<string, number> = {};
  const naturalKeys: Record<string, string[] | null> = {};
  for (const table of tables) {
    rowCounts[table.name] = data[table.name].length;
    naturalKeys[table.name] = table.naturalKeyResolvable
      ? table.naturalKey
      : null;
    serializedByteSizes[table.name] = Buffer.byteLength(
      serializeRows(data[table.name], 4),
      "utf8",
    );
  }

  const dataSerialized = serializeData(data);
  const sha256 = createHash("sha256").update(dataSerialized, "utf8").digest("hex");

  // A wall-clock timestamp would make two unchanged exports differ. Use the
  // latest persisted audit timestamp as a deterministic snapshot watermark.
  const timestampValues: Date[] = [];
  for (const { table, column } of catalog.timestampColumns) {
    if (!tableByName.has(table)) {
      continue;
    }
    const result = await client.query<{ value: Date | null }>(
      `SELECT max(${quoteIdentifier(column)}) AS value FROM ${quoteIdentifier(table)}`,
    );
    const value = result.rows[0]?.value;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      timestampValues.push(value);
    }
  }
  timestampValues.sort((left, right) => left.getTime() - right.getTime());
  const generatedAt = (timestampValues.at(-1) ?? new Date(0)).toISOString();

  return {
    data,
    meta: {
      generatedAt,
      naturalKeys,
      rowCounts,
      serializedByteSizes,
      sha256,
    },
  };
}

async function main(): Promise<void> {
  const connectionString = process.env.BACKUP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("BACKUP_DATABASE_URL or DATABASE_URL must be set");
  }

  const positionalArguments = process.argv.slice(2).filter((argument) => argument !== "--");
  if (positionalArguments.length > 1) {
    throw new Error("Usage: export-snapshot [output-path]");
  }
  const outputPath = resolve(
    process.cwd(),
    positionalArguments[0] ?? "./snapshot.json",
  );
  const pool = new Pool({
    connectionString,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      let snapshot: Awaited<ReturnType<typeof exportSnapshot>>;
      try {
        const catalog = await readCatalog(client);
        const tables = buildTableInfos(getExportedTables(), catalog);
        printNaturalKeyAudit(tables);
        snapshot = await exportSnapshot(client, tables, catalog);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      const serialized = serializeSnapshot(snapshot.data, snapshot.meta);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, serialized, "utf8");

      console.log(`Snapshot written to ${outputPath}`);
      console.log("");
      console.log(`${"TABLE".padEnd(42)}${"ROWS".padStart(10)}${"BYTES".padStart(14)}`);
      console.log("-".repeat(66));
      const rowCounts = snapshot.meta.rowCounts as Record<string, number>;
      const serializedByteSizes = snapshot.meta.serializedByteSizes as Record<string, number>;
      for (const tableName of Object.keys(rowCounts).sort()) {
        console.log(
          `${tableName.padEnd(42)}${String(rowCounts[tableName]).padStart(10)}${String(
            serializedByteSizes[tableName],
          ).padStart(14)}`,
        );
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `[export-snapshot] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}