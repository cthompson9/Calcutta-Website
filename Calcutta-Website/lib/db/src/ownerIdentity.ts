import { readFile } from "node:fs/promises";

export type OwnerIdentityStatus = "approved" | "unresolved" | "ambiguous";

export type OwnerIdentityRecord = {
  record: string;
  person: string | null;
  status: OwnerIdentityStatus;
};

export type OwnerIdentityNonMerge = {
  leftPerson: string;
  leftRecords: string[];
  rightPerson: string;
  rightRecords: string[];
  reason: string;
};

export type OwnerIdentityDocument = {
  version: number;
  reviewStatus: string;
  records: OwnerIdentityRecord[];
  nonMerges: OwnerIdentityNonMerge[];
};

export type HistoricalOwnerSource = {
  edition: number;
  owners: Array<{ label: string; name?: string | null }>;
};

export type OwnerIdentityReport = {
  reviewApproved: boolean;
  sourceRecords: number;
  mappedRecords: number;
  personCount: number;
  duplicateMappings: string[];
  missingMappings: string[];
  unknownMappings: string[];
  unresolvedMappings: string[];
  nonMergeViolations: string[];
  passed: boolean;
};

function scalar(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null") return null;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\'", "'");
  }
  return trimmed;
}

/**
 * The decision file intentionally uses a small, review-friendly YAML subset.
 * Keeping the parser local avoids making the database package depend on a
 * transitive YAML package just to enforce a financial import gate.
 */
export function parseOwnerIdentityYaml(source: string): OwnerIdentityDocument {
  let section: "records" | "non_merges" | null = null;
  let current: Record<string, string | null> | null = null;
  const records: OwnerIdentityRecord[] = [];
  const nonMerges: OwnerIdentityNonMerge[] = [];
  let version: number | null = null;
  let reviewStatus = "";

  const commit = () => {
    if (!current || !section) return;
    if (section === "records") {
      const record = current.record;
      const status = current.status;
      if (!record || !status || !["approved", "unresolved", "ambiguous"].includes(status)) {
        throw new Error("Invalid owner identity record in owner-identity.yaml.");
      }
      records.push({
        record,
        person: current.person ?? null,
        status: status as OwnerIdentityStatus,
      });
    } else {
      if (
        !current.left_person ||
        !current.left_records ||
        !current.right_person ||
        !current.right_records ||
        !current.reason
      ) {
        throw new Error("Invalid owner identity non-merge in owner-identity.yaml.");
      }
      nonMerges.push({
        leftPerson: current.left_person,
        leftRecords: current.left_records.split("|"),
        rightPerson: current.right_person,
        rightRecords: current.right_records.split("|"),
        reason: current.reason,
      });
    }
    current = null;
  };

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    if (line === "records:") {
      commit();
      section = "records";
      continue;
    }
    if (line === "non_merges:") {
      commit();
      section = "non_merges";
      continue;
    }
    const topLevel = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!section && topLevel) {
      const [, key, value] = topLevel;
      if (key === "version") version = Number(scalar(value));
      if (key === "review_status") reviewStatus = scalar(value) ?? "";
      continue;
    }
    if (!section) continue;
    if (line.startsWith("- ")) {
      commit();
      current = {};
      const firstField = line.slice(2).match(/^([a-z_]+):\s*(.*)$/);
      if (!firstField) throw new Error("Invalid owner identity list item.");
      current[firstField[1]] = scalar(firstField[2]);
      continue;
    }
    const field = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!field || !current) throw new Error("Invalid owner identity YAML field.");
    current[field[1]] = scalar(field[2]);
  }
  commit();

  if (version !== 1 || !reviewStatus || records.length === 0) {
    throw new Error("owner-identity.yaml must declare version 1, review_status, and records.");
  }
  return { version, reviewStatus, records, nonMerges };
}

export async function loadOwnerIdentityFile(path: string): Promise<OwnerIdentityDocument> {
  return parseOwnerIdentityYaml(await readFile(path, "utf8"));
}

/**
 * This key mirrors the loader's pre-mapping source identity rule. Full names
 * remain global; abbreviated/bare source labels remain pool-scoped.
 */
export function historicalOwnerRecordKey(
  label: string,
  name: string | null | undefined,
  edition: number,
): string {
  const trimmedName = name?.trim();
  return trimmedName && trimmedName.includes(" ")
    ? trimmedName
    : `${label} [ed${edition}]`;
}

export function listHistoricalOwnerRecords(
  sources: HistoricalOwnerSource[],
): string[] {
  return [
    ...new Set(
      sources.flatMap((source) =>
        source.owners.map((owner) =>
          historicalOwnerRecordKey(owner.label, owner.name, source.edition),
        ),
      ),
    ),
  ];
}

export function validateOwnerIdentity(
  document: OwnerIdentityDocument,
  sources: HistoricalOwnerSource[],
): OwnerIdentityReport {
  const expected = new Set(listHistoricalOwnerRecords(sources));
  const mappings = new Map<string, OwnerIdentityRecord>();
  const duplicateMappings: string[] = [];
  for (const mapping of document.records) {
    if (mappings.has(mapping.record)) duplicateMappings.push(mapping.record);
    mappings.set(mapping.record, mapping);
  }

  const missingMappings = [...expected].filter((record) => !mappings.has(record));
  const unknownMappings = [...mappings.keys()].filter((record) => !expected.has(record));
  const unresolvedMappings = [...expected]
    .map((record) => mappings.get(record))
    .filter(
      (mapping): mapping is OwnerIdentityRecord =>
        !!mapping && (mapping.status !== "approved" || !mapping.person?.trim()),
    )
    .map((mapping) => mapping.record);
  const nonMergeViolations = [
    ...new Set(document.nonMerges.flatMap((pair) => {
    const violations: string[] = [];
    if (pair.leftPerson === pair.rightPerson) {
      violations.push(`${pair.leftPerson} cannot be non-merged from itself`);
    }
    for (const record of pair.leftRecords) {
      const mapping = mappings.get(record);
      if (!mapping) {
        violations.push(`protected non-merge references unknown record ${record}`);
      } else if (mapping.person !== pair.leftPerson) {
        violations.push(`${record} must remain mapped to ${pair.leftPerson}`);
      }
    }
    for (const record of pair.rightRecords) {
      const mapping = mappings.get(record);
      if (!mapping) {
        violations.push(`protected non-merge references unknown record ${record}`);
      } else if (mapping.person !== pair.rightPerson) {
        violations.push(`${record} must remain mapped to ${pair.rightPerson}`);
      }
    }
      return violations;
    })),
  ];
  const people = new Set(
    [...expected]
      .map((record) => mappings.get(record)?.person)
      .filter((person): person is string => !!person?.trim()),
  );

  return {
    reviewApproved: document.reviewStatus === "approved",
    sourceRecords: expected.size,
    mappedRecords: [...expected].filter((record) => mappings.has(record)).length,
    personCount: people.size,
    duplicateMappings,
    missingMappings,
    unknownMappings,
    unresolvedMappings,
    nonMergeViolations,
    passed:
      document.reviewStatus === "approved" &&
      duplicateMappings.length === 0 &&
      missingMappings.length === 0 &&
      unknownMappings.length === 0 &&
      unresolvedMappings.length === 0 &&
      nonMergeViolations.length === 0,
  };
}

export function ownerIdentityError(report: OwnerIdentityReport): Error {
  const details = [
    ...(report.reviewApproved ? [] : ["human review is pending"]),
    ...report.missingMappings.map((record) => `missing ${record}`),
    ...report.unknownMappings.map((record) => `unknown ${record}`),
    ...report.duplicateMappings.map((record) => `duplicate ${record}`),
    ...report.unresolvedMappings.map((record) => `unresolved ${record}`),
    ...report.nonMergeViolations,
  ];
  return new Error(
    `Historical owner identity review is not complete (${details.join("; ")}). ` +
      "No historical money was imported.",
  );
}