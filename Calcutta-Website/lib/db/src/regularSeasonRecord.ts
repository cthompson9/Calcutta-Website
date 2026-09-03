export type ExplicitRegularSeasonRecord = {
  wins: number;
  losses: number;
  ties: number;
};

/**
 * Convert the completed-season convention used by the original seed data,
 * where each tie was represented as half a win, into an explicit record.
 */
export function explicitRecordFromLegacyWins(
  legacyWins: number,
): ExplicitRegularSeasonRecord {
  if (!Number.isFinite(legacyWins) || legacyWins < 0 || legacyWins > 17) {
    throw new Error(
      `Legacy wins must be between 0 and 17, received ${legacyWins}`,
    );
  }

  const wins = Math.floor(legacyWins);
  const fraction = legacyWins - wins;
  const ties = fraction === 0 ? 0 : fraction === 0.5 ? 1 : NaN;
  if (Number.isNaN(ties)) {
    throw new Error(
      `Legacy wins must use whole wins or half-win ties, received ${legacyWins}`,
    );
  }

  return {
    wins,
    losses: 17 - wins - ties,
    ties,
  };
}

/**
 * Read an explicit record, converting a pre-migration half-win value only
 * when its accompanying loss and tie columns still have their default values.
 */
export function explicitRecordFromStoredValues(
  winsValue: string | number,
  losses: number,
  ties: number,
): ExplicitRegularSeasonRecord {
  const wins = Number(winsValue);
  if (!Number.isFinite(wins)) {
    throw new Error(`Stored wins must be numeric, received ${winsValue}`);
  }

  if (!Number.isInteger(wins) && losses === 0 && ties === 0) {
    return explicitRecordFromLegacyWins(wins);
  }

  return { wins, losses, ties };
}
