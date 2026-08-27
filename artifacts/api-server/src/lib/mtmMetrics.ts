import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  snapshotMetricsTable,
  type SnapshotMetric,
} from "@workspace/db";
import type { WeekZeroCalculation } from "./weekZeroValuation";
import { NFL_RETURN_METRICS } from "./competitionScoring";

export const MTM_METRICS = NFL_RETURN_METRICS;

export type MtmMetric = (typeof MTM_METRICS)[number];

type DbWriter = Pick<typeof db, "delete" | "insert">;

export type MtmMetricRow = {
  calcuttaId: number;
  entryId: number;
  periodId: number;
  basis: "mtm";
  metric: MtmMetric;
  value: string;
  source: "kalshi";
  sourceData: Record<string, unknown>;
  snapshotAt: Date;
};

export function buildMtmMetricRows(
  calculation: WeekZeroCalculation,
  context: {
    calcuttaId: number;
    periodId: number;
    periodSequence: number;
    snapshotKey: string;
    snapshotDate: string;
    capturedAt: Date;
    entryIdByTeam: ReadonlyMap<number, number>;
    realizedPtDiffByEntry?: ReadonlyMap<number, number>;
  },
): MtmMetricRow[] {
  const rows: MtmMetricRow[] = [];

  // The valuation normalizes several league-wide probability totals. If one
  // team is incomplete, zero-imputing its missing quote can distort every
  // other team's normalized value. Preserve the raw capture, but publish no
  // derived assertions until the full market set is defensible.
  if (calculation.valuations.some(
    (valuation) => valuation.marketStatus === "incomplete",
  )) {
    return rows;
  }

  for (const valuation of calculation.valuations) {
    const entryId = context.entryIdByTeam.get(valuation.teamId);
    if (entryId == null) {
      throw new Error(`No selected Calcutta entry exists for team ${valuation.teamId}.`);
    }
    if (
      context.periodSequence > 0 &&
      !context.realizedPtDiffByEntry?.has(entryId)
    ) {
      throw new Error(
        `NFL period ${context.periodSequence} requires realized point differential for entry ${entryId}.`,
      );
    }

    const sourceData = {
      provider: "kalshi",
      rawSnapshotKey: context.snapshotKey,
      rawSnapshotDate: context.snapshotDate,
      marketStatus: valuation.marketStatus,
      marketStatusReasons: valuation.marketStatusReasons,
      contractSetId: valuation.contractSetId,
      expectedWinsPolicy: "kalshi_win_ladder_normalized_to_272",
      pointDifferentialPolicy: "realized_to_date_plus_zero_forward_expectation",
    };
    const values: Array<[MtmMetric, number]> = [
      ["win", valuation.expectedWins],
      // Week 0 has no tie market. The explicit zero policy matches the
      // existing Kalshi valuation, which treats the win ladder as the
      // season win/tie-equivalent expectation.
      ["tie", 0],
      [
        "pt_diff",
        context.realizedPtDiffByEntry?.get(entryId) ?? 0,
      ],
      ["playoff_berth", valuation.playoffProbability],
      ["div_round", valuation.divisionalProbability],
      ["conf_round", valuation.conferenceGameProbability],
      ["sb_berth", valuation.superBowlProbability],
      ["win_super_bowl", valuation.championshipProbability],
    ];

    for (const [metric, value] of values) {
      rows.push({
        calcuttaId: context.calcuttaId,
        entryId,
        periodId: context.periodId,
        basis: "mtm",
        metric,
        value: String(value),
        source: "kalshi",
        sourceData: { ...sourceData, metric },
        snapshotAt: context.capturedAt,
      });
    }
  }

  return rows;
}

export async function replaceMtmMetricRows(
  writer: DbWriter,
  context: {
    calcuttaId: number;
    entryIds: number[];
    periodId: number;
  },
  rows: MtmMetricRow[],
): Promise<number> {
  if (context.entryIds.length > 0) {
    await writer.delete(snapshotMetricsTable).where(and(
      eq(snapshotMetricsTable.calcuttaId, context.calcuttaId),
      inArray(snapshotMetricsTable.entryId, context.entryIds),
      eq(snapshotMetricsTable.periodId, context.periodId),
      eq(snapshotMetricsTable.basis, "mtm"),
    ));
  }

  for (const row of rows) {
    await writer.insert(snapshotMetricsTable).values(row).onConflictDoUpdate({
      target: [
        snapshotMetricsTable.calcuttaId,
        snapshotMetricsTable.entryId,
        snapshotMetricsTable.periodId,
        snapshotMetricsTable.basis,
        snapshotMetricsTable.metric,
      ],
      targetWhere: sql`${snapshotMetricsTable.entryId} is not null`,
      set: row,
    });
  }
  return rows.length;
}

export function hasCompleteMtmMetricCoverage(
  rows: Array<Pick<SnapshotMetric, "entryId" | "metric">>,
  entryIds: readonly number[],
): boolean {
  if (entryIds.length === 0) return false;
  const expected = new Set(
    entryIds.flatMap((entryId) =>
      MTM_METRICS.map((metric) => `${entryId}:${metric}`),
    ),
  );
  for (const row of rows) expected.delete(`${row.entryId}:${row.metric}`);
  return expected.size === 0;
}