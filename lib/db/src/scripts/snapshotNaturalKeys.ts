export type SnapshotForeignKey = {
  sourceTable: string;
  sourceColumns: string[];
  targetTable: string;
  targetColumns: string[];
};

export function assertForeignKeyTargetsHaveNaturalKeys(
  naturalKeys: ReadonlyMap<string, readonly string[]>,
  foreignKeys: readonly SnapshotForeignKey[],
): void {
  const missing = [
    ...new Set(
      foreignKeys
        .filter((foreignKey) => {
          const key = naturalKeys.get(foreignKey.targetTable);
          return !key || key.length === 0;
        })
        .map((foreignKey) => foreignKey.targetTable),
    ),
  ].sort();

  if (missing.length > 0) {
    throw new Error(
      `Foreign key target(s) have no registered natural key: ${missing.join(", ")}`,
    );
  }
}