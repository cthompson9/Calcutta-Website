import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type OwnerIdentityDecision = "approved_alias" | "approved_non_merge" | "unresolved" | "ambiguous";

type IdentityDecisionGroup = {
  person: string;
  decision: OwnerIdentityDecision;
  rationale: string;
  records: string[];
  approvedPriorPeople?: string[];
};

type IdentityMappingFile = {
  version: number;
  record_format: "edition|label";
  decisions: IdentityDecisionGroup[];
};

export type HistoricalOwnerIdentity = {
  person: string;
  decision: OwnerIdentityDecision;
  rationale: string;
  approvedPriorPeople: string[];
};

const mappingPath = fileURLToPath(
  new URL("../../../decisions/owner-identity.json", import.meta.url),
);
const mapping = JSON.parse(
  readFileSync(mappingPath, "utf8"),
) as IdentityMappingFile;

if (mapping.version !== 1 || mapping.record_format !== "edition|label") {
  throw new Error(`Unsupported owner identity mapping format in ${mappingPath}.`);
}

const decisionsByRecord = new Map<
  string,
  HistoricalOwnerIdentity
>();

const validDecisions = new Set<OwnerIdentityDecision>([
  "approved_alias",
  "approved_non_merge",
  "unresolved",
  "ambiguous",
]);

for (const group of mapping.decisions) {
  if (!group.person.trim() || !group.rationale.trim()) {
    throw new Error("Every owner identity decision needs a person and rationale.");
  }
  if (!validDecisions.has(group.decision)) {
    throw new Error(`Unsupported owner identity decision ${group.decision}.`);
  }
  for (const record of group.records) {
    if (decisionsByRecord.has(record)) {
      throw new Error(`Owner identity record ${record} is mapped more than once.`);
    }
    decisionsByRecord.set(record, {
      person: group.person,
      decision: group.decision,
      rationale: group.rationale,
      approvedPriorPeople: group.approvedPriorPeople ?? [],
    });
  }
}

export function ownerIdentityRecordKey(edition: number, label: string): string {
  return `${edition}|${label}`;
}

export function requireApprovedHistoricalOwnerIdentity(
  edition: number,
  label: string,
  resolved: HistoricalOwnerIdentity | undefined,
): HistoricalOwnerIdentity {
  if (!resolved) {
    throw new Error(
      `Calcutta ${edition} owner ${label} has no approved identity decision; historical backload is blocked.`,
    );
  }
  if (resolved.decision === "unresolved" || resolved.decision === "ambiguous") {
    throw new Error(
      `Calcutta ${edition} owner ${label} is ${resolved.decision}; historical backload is blocked.`,
    );
  }
  return resolved;
}

export function resolveHistoricalOwnerIdentity(
  edition: number,
  label: string,
): HistoricalOwnerIdentity {
  return requireApprovedHistoricalOwnerIdentity(
    edition,
    label,
    decisionsByRecord.get(ownerIdentityRecordKey(edition, label)),
  );
}

export function validateHistoricalOwnerIdentityRecords(
  edition: number,
  labels: string[],
): void {
  for (const label of labels) {
    resolveHistoricalOwnerIdentity(edition, label);
  }
}

export function validatePersistedHistoricalOwnerIdentities(
  edition: number,
  labels: string[],
  persisted: Array<{ label: string; person: string }>,
): void {
  const persistedIdentityByLabel = new Map(
    persisted.map((owner) => [owner.label, owner.person]),
  );
  for (const label of labels) {
    const expectedIdentity = resolveHistoricalOwnerIdentity(
      edition,
      label,
    ).person;
    if (persistedIdentityByLabel.get(label) !== expectedIdentity) {
      throw new Error(
        `Historical edition ${edition} was imported under a different owner identity mapping; refusing a silent replay.`,
      );
    }
  }
  if (
    persistedIdentityByLabel.size !== labels.length ||
    persisted.length !== labels.length
  ) {
    throw new Error(
      `Historical edition ${edition} has a different persisted owner roster; refusing a silent replay.`,
    );
  }
}

export function listHistoricalOwnerIdentityDecisions(): IdentityDecisionGroup[] {
  return mapping.decisions;
}