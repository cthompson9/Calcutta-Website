export const LEAGUE_POINT_TOTAL = 11_420;
export const REGULAR_SEASON_GAMES = 272;
export const MAX_QUOTE_SPREAD = 0.08;
export const MIN_TOP_OF_BOOK_DEPTH = 100;
export const MAX_QUOTE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const WEEK_ZERO_SNAPSHOT_KEY = "week-0";

export interface KalshiSeasonContracts {
  contractSetId: string;
  winsEventPrefix: string;
  playoffEvent: string;
  afcChampionEvent: string;
  nfcChampionEvent: string;
  championshipEvent: string;
}

const KALSHI_SEASON_CONTRACTS: Record<number, KalshiSeasonContracts> = {
  2025: {
    contractSetId: "nfl-2025-26-v1",
    winsEventPrefix: "KXNFLWINS-26",
    playoffEvent: "KXNFLPLAYOFF-26",
    afcChampionEvent: "KXNFLAFCCHAMP-26",
    nfcChampionEvent: "KXNFLNFCCHAMP-26",
    championshipEvent: "KXSB-26",
  },
  2026: {
    contractSetId: "nfl-2026-27-v1",
    winsEventPrefix: "KXNFLWINS-27",
    playoffEvent: "KXNFLPLAYOFF-27",
    afcChampionEvent: "KXNFLAFCCHAMP-27",
    nfcChampionEvent: "KXNFLNFCCHAMP-27",
    championshipEvent: "KXSB-27",
  },
  // Year 9999 reuses the 2026-27 contract set for integration test isolation.
  // Tests create a disposable season with year=9999 so they never touch production
  // season records.  The fetch mock intercepts these URLs at test time.
  9999: {
    contractSetId: "nfl-2026-27-v1",
    winsEventPrefix: "KXNFLWINS-27",
    playoffEvent: "KXNFLPLAYOFF-27",
    afcChampionEvent: "KXNFLAFCCHAMP-27",
    nfcChampionEvent: "KXNFLNFCCHAMP-27",
    championshipEvent: "KXSB-27",
  },
};

export function getKalshiSeasonContracts(
  seasonYear: number,
): KalshiSeasonContracts {
  const contracts = KALSHI_SEASON_CONTRACTS[seasonYear];
  if (!contracts) {
    throw new Error(
      `No reviewed Kalshi contract mapping is configured for NFL season ${seasonYear}.`,
    );
  }
  return contracts;
}

export type MarketQuoteQuality = "live" | "stale" | "unavailable";
export type WeekZeroMarketStatus = "live" | "stale" | "incomplete";
export type MarketQuoteKind =
  | "win_threshold"
  | "playoff"
  | "conference_champion"
  | "championship";

export interface MarketQuote {
  ticker: string;
  kind: MarketQuoteKind;
  line: number | null;
  bid: number | null;
  ask: number | null;
  last: number | null;
  probability: number | null;
  spread: number | null;
  bidDepth: number | null;
  askDepth: number | null;
  quality: MarketQuoteQuality;
  updatedAt: string | null;
  derived: boolean;
}

export interface TeamMarketSnapshot {
  teamId: number;
  teamName: string;
  conference: string;
  contractSetId: string;
  winThresholds: MarketQuote[];
  playoff: MarketQuote | null;
  conferenceChampion: MarketQuote | null;
  championship: MarketQuote | null;
}

export interface WeekZeroValuation {
  teamId: number;
  teamName: string;
  conference: string;
  contractSetId: string;
  marketStatus: WeekZeroMarketStatus;
  marketStatusReasons: string[];
  bankedPoints: number;
  seasonEquityPoints: number;
  bonusEquityPoints: number;
  totalPoints: number;
  normalizedShare: number;
  fairValue: number;
  winTotalLine: number | null;
  winTotalOverProbability: number | null;
  rawExpectedWins: number;
  expectedWins: number;
  playoffProbability: number;
  divisionalProbability: number;
  conferenceGameProbability: number;
  superBowlProbability: number;
  championshipProbability: number;
  regularSeasonMethod: string;
  intermediateRoundMethod: string;
  quotes: MarketQuote[];
}

export interface WeekZeroCalculation {
  valuations: WeekZeroValuation[];
  rawPointTotal: number;
  normalizedShareTotal: number;
  statusCounts: Record<WeekZeroMarketStatus, number>;
}

export interface WeekZeroSnapshotRow {
  entryId: number;
  teamId: number;
  seasonId: number;
  weekNum: number;
  snapshotDate: string;
  mtmValue: string;
  snapshotKey: string;
  source: string;
  capturedAt: Date;
  marketStatus: WeekZeroMarketStatus;
  bankedPoints: string;
  seasonEquityPoints: string;
  bonusEquityPoints: string;
  totalPoints: string;
  normalizedShare: string;
  marketData: Record<string, unknown>;
}

export function buildWeekZeroSnapshotRows(
  calculation: WeekZeroCalculation,
  context: {
    seasonId: number;
    entryIdByTeam: ReadonlyMap<number, number>;
    snapshotDate: string;
    capturedAt: Date;
  },
): WeekZeroSnapshotRow[] {
  return calculation.valuations.map((valuation) => {
    const entryId = context.entryIdByTeam.get(valuation.teamId);
    if (entryId == null) {
      throw new Error(`No selected Calcutta entry exists for team ${valuation.teamId}.`);
    }
    return {
      entryId,
      teamId: valuation.teamId,
      seasonId: context.seasonId,
      weekNum: 0,
      snapshotDate: context.snapshotDate,
      mtmValue: valuation.fairValue.toString(),
      snapshotKey: WEEK_ZERO_SNAPSHOT_KEY,
      source: "kalshi",
      capturedAt: context.capturedAt,
      marketStatus: valuation.marketStatus,
      bankedPoints: valuation.bankedPoints.toString(),
      seasonEquityPoints: valuation.seasonEquityPoints.toString(),
      bonusEquityPoints: valuation.bonusEquityPoints.toString(),
      totalPoints: valuation.totalPoints.toString(),
      normalizedShare: valuation.normalizedShare.toString(),
      marketData: {
        winTotalLine: valuation.winTotalLine,
        winTotalOverProbability: valuation.winTotalOverProbability,
        rawExpectedWins: valuation.rawExpectedWins,
        expectedWins: valuation.expectedWins,
        playoffProbability: valuation.playoffProbability,
        divisionalProbability: valuation.divisionalProbability,
        conferenceGameProbability: valuation.conferenceGameProbability,
        superBowlProbability: valuation.superBowlProbability,
        championshipProbability: valuation.championshipProbability,
        contractSetId: valuation.contractSetId,
        marketStatusReasons: valuation.marketStatusReasons,
        regularSeasonMethod: valuation.regularSeasonMethod,
        intermediateRoundMethod: valuation.intermediateRoundMethod,
        quotes: valuation.quotes,
      },
    };
  });
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function normalizeBounded(
  values: number[],
  target: number,
  minimums: number[],
  maximums: number[],
): number[] {
  const normalized = values.map((value, index) =>
    clamp(value, minimums[index] ?? 0, maximums[index] ?? 1),
  );

  for (let iteration = 0; iteration < 50; iteration += 1) {
    const difference = target - sum(normalized);
    if (Math.abs(difference) < 1e-10) break;

    const capacities = normalized.map((value, index) =>
      difference > 0
        ? Math.max(0, (maximums[index] ?? 1) - value)
        : Math.max(0, value - (minimums[index] ?? 0)),
    );
    const totalCapacity = sum(capacities);
    if (totalCapacity <= 1e-12) break;

    for (let index = 0; index < normalized.length; index += 1) {
      const adjustment = difference * (capacities[index] / totalCapacity);
      normalized[index] = clamp(
        normalized[index] + adjustment,
        minimums[index] ?? 0,
        maximums[index] ?? 1,
      );
    }
  }

  return normalized;
}

function thresholdProbabilityMap(quotes: MarketQuote[]): Map<number, number> {
  const known = new Map<number, number>();
  for (const quote of quotes) {
    if (
      quote.kind === "win_threshold" &&
      quote.line != null &&
      quote.probability != null
    ) {
      const threshold = Math.round(quote.line + 0.5);
      if (threshold >= 1 && threshold <= 17) {
        known.set(threshold, clamp(quote.probability));
      }
    }
  }
  return known;
}

function fillWinThresholds(quotes: MarketQuote[]): number[] {
  const known = thresholdProbabilityMap(quotes);
  const probabilities: number[] = [];

  for (let threshold = 1; threshold <= 17; threshold += 1) {
    const exact = known.get(threshold);
    if (exact != null) {
      probabilities.push(exact);
      continue;
    }

    let lowerThreshold = 0;
    let lowerProbability = 1;
    let upperThreshold = 18;
    let upperProbability = 0;

    for (const [candidateThreshold, candidateProbability] of known) {
      if (candidateThreshold < threshold && candidateThreshold > lowerThreshold) {
        lowerThreshold = candidateThreshold;
        lowerProbability = candidateProbability;
      }
      if (candidateThreshold > threshold && candidateThreshold < upperThreshold) {
        upperThreshold = candidateThreshold;
        upperProbability = candidateProbability;
      }
    }

    const fraction =
      (threshold - lowerThreshold) / Math.max(upperThreshold - lowerThreshold, 1);
    probabilities.push(
      lowerProbability + (upperProbability - lowerProbability) * fraction,
    );
  }

  let previous = 1;
  return probabilities.map((probability) => {
    const monotoneProbability = Math.min(previous, clamp(probability));
    previous = monotoneProbability;
    return monotoneProbability;
  });
}

function quoteProbability(quote: MarketQuote | null): number {
  return quote?.probability == null ? 0 : clamp(quote.probability);
}

function primaryWinQuote(quotes: MarketQuote[]): MarketQuote | null {
  const usable = quotes.filter((quote) => quote.probability != null);
  if (usable.length === 0) return null;
  return usable.reduce((closest, quote) =>
    Math.abs((quote.probability ?? 0) - 0.5) <
    Math.abs((closest.probability ?? 0) - 0.5)
      ? quote
      : closest,
  );
}

function determineMarketStatus(
  snapshot: TeamMarketSnapshot,
  primaryQuote: MarketQuote | null,
  capturedAt: Date,
): { status: WeekZeroMarketStatus; reasons: string[] } {
  const reasons: string[] = [];
  const thresholdNumbers = new Set(
    snapshot.winThresholds
      .filter(
        (quote) =>
          quote.line != null &&
          quote.probability != null &&
          quote.kind === "win_threshold",
      )
      .map((quote) => Math.round((quote.line ?? 0) + 0.5))
      .filter((threshold) => threshold >= 1 && threshold <= 17),
  );
  if (thresholdNumbers.size !== 17) {
    reasons.push(
      `Incomplete win ladder: ${thresholdNumbers.size} of 17 thresholds are usable.`,
    );
  }

  const required = [
    primaryQuote,
    snapshot.playoff,
    snapshot.conferenceChampion,
    snapshot.championship,
  ];
  if (required.some((quote) => quote?.probability == null)) {
    reasons.push("One or more required postseason or primary win markets is unavailable.");
  }

  const allQuotes = [
    ...snapshot.winThresholds,
    ...required.filter((quote): quote is MarketQuote => quote != null),
  ];
  if (allQuotes.some((quote) => quote.quality === "unavailable")) {
    reasons.push("One or more required contracts has no usable price.");
  }
  if (allQuotes.some((quote) => quote.quality === "stale")) {
    reasons.push("One or more contracts has a wide spread or low top-of-book depth.");
  }

  const captureTime = capturedAt.getTime();
  let missingTimestamp = false;
  let oldTimestamp = false;
  for (const quote of allQuotes) {
    if (!quote.updatedAt) {
      missingTimestamp = true;
      continue;
    }
    const updatedTime = Date.parse(quote.updatedAt);
    if (!Number.isFinite(updatedTime)) {
      missingTimestamp = true;
      continue;
    }
    if (captureTime - updatedTime > MAX_QUOTE_AGE_MS) {
      oldTimestamp = true;
    }
  }
  if (missingTimestamp) {
    reasons.push("One or more contracts is missing a valid market update timestamp.");
  }
  if (oldTimestamp) {
    reasons.push("One or more contracts was not updated within the last 7 days.");
  }

  const incomplete = reasons.some(
    (reason) =>
      reason.startsWith("Incomplete") ||
      reason.includes("unavailable") ||
      reason.includes("no usable price"),
  );
  return {
    status: incomplete ? "incomplete" : reasons.length > 0 ? "stale" : "live",
    reasons,
  };
}

export function calculateWeekZeroValuations(
  snapshots: TeamMarketSnapshot[],
  potSize: number,
  capturedAt = new Date(),
): WeekZeroCalculation {
  if (snapshots.length !== 32) {
    throw new Error(`Week 0 requires all 32 teams; received ${snapshots.length}.`);
  }

  const rawExpectedWins = snapshots.map((snapshot) =>
    sum(fillWinThresholds(snapshot.winThresholds)),
  );
  const expectedWins = normalizeBounded(
    rawExpectedWins,
    REGULAR_SEASON_GAMES,
    snapshots.map(() => 0),
    snapshots.map(() => 17),
  );

  const rawPlayoff = snapshots.map((snapshot) => quoteProbability(snapshot.playoff));
  const playoff = normalizeBounded(
    rawPlayoff,
    14,
    snapshots.map(() => 0),
    snapshots.map(() => 1),
  );

  const conferenceChampion = snapshots.map(() => 0);
  for (const conference of ["AFC", "NFC"]) {
    const indices = snapshots
      .map((snapshot, index) => ({ snapshot, index }))
      .filter(({ snapshot }) => snapshot.conference === conference)
      .map(({ index }) => index);
    const normalized = normalizeBounded(
      indices.map((index) =>
        quoteProbability(snapshots[index].conferenceChampion),
      ),
      1,
      indices.map(() => 0),
      indices.map(() => 1),
    );
    indices.forEach((index, conferenceIndex) => {
      conferenceChampion[index] = normalized[conferenceIndex];
    });
  }

  const championship = normalizeBounded(
    snapshots.map((snapshot) => quoteProbability(snapshot.championship)),
    1,
    snapshots.map(() => 0),
    conferenceChampion.map((probability) => Math.max(probability, 1e-9)),
  );

  const rawDivisional = playoff.map((playoffProbability, index) =>
    Math.pow(Math.max(playoffProbability, 1e-9), 2 / 3) *
    Math.pow(Math.max(conferenceChampion[index], 1e-9), 1 / 3),
  );
  const divisional = normalizeBounded(
    rawDivisional,
    8,
    conferenceChampion,
    playoff,
  );

  const rawConferenceGame = playoff.map((playoffProbability, index) =>
    Math.pow(Math.max(playoffProbability, 1e-9), 1 / 3) *
    Math.pow(Math.max(conferenceChampion[index], 1e-9), 2 / 3),
  );
  const conferenceGame = normalizeBounded(
    rawConferenceGame,
    4,
    conferenceChampion,
    divisional,
  );

  const unnormalized = snapshots.map((snapshot, index) => {
    const primaryQuote = primaryWinQuote(snapshot.winThresholds);
    const marketAssessment = determineMarketStatus(
      snapshot,
      primaryQuote,
      capturedAt,
    );
    const bankedPoints = 150;
    const seasonEquityPoints = 10 * expectedWins[index];
    const bonusEquityPoints =
      50 * playoff[index] +
      100 * divisional[index] +
      200 * conferenceGame[index] +
      400 * conferenceChampion[index] +
      800 * championship[index];
    const totalPoints = bankedPoints + seasonEquityPoints + bonusEquityPoints;

    return {
      snapshot,
      primaryQuote,
      marketAssessment,
      bankedPoints,
      seasonEquityPoints,
      bonusEquityPoints,
      totalPoints,
    };
  });

  const rawPointTotal = sum(unnormalized.map((entry) => entry.totalPoints));
  const shares = normalizeBounded(
    unnormalized.map((entry) => entry.totalPoints / LEAGUE_POINT_TOTAL),
    1,
    snapshots.map(() => 0),
    snapshots.map(() => 1),
  );

  const valuations = unnormalized.map((entry, index): WeekZeroValuation => ({
    teamId: entry.snapshot.teamId,
    teamName: entry.snapshot.teamName,
    conference: entry.snapshot.conference,
    contractSetId: entry.snapshot.contractSetId,
    marketStatus: entry.marketAssessment.status,
    marketStatusReasons: entry.marketAssessment.reasons,
    bankedPoints: entry.bankedPoints,
    seasonEquityPoints: entry.seasonEquityPoints,
    bonusEquityPoints: entry.bonusEquityPoints,
    totalPoints: entry.totalPoints,
    normalizedShare: shares[index],
    fairValue: shares[index] * potSize,
    winTotalLine: entry.primaryQuote?.line ?? null,
    winTotalOverProbability: entry.primaryQuote?.probability ?? null,
    rawExpectedWins: rawExpectedWins[index],
    expectedWins: expectedWins[index],
    playoffProbability: playoff[index],
    divisionalProbability: divisional[index],
    conferenceGameProbability: conferenceGame[index],
    superBowlProbability: conferenceChampion[index],
    championshipProbability: championship[index],
    regularSeasonMethod:
      "Kalshi P(at least N wins) ladder; E[wins]=sum P(W>=N), normalized to 272 league wins/tie-equivalents; point differential and 2x equity held at 0.",
    intermediateRoundMethod:
      "Divisional and conference-game probabilities are log-interpolated between Kalshi playoff and conference-champion probabilities, then normalized to 8 and 4 league participants.",
    quotes: [
      ...entry.snapshot.winThresholds,
      ...(entry.snapshot.playoff ? [entry.snapshot.playoff] : []),
      ...(entry.snapshot.conferenceChampion
        ? [entry.snapshot.conferenceChampion]
        : []),
      ...(entry.snapshot.championship ? [entry.snapshot.championship] : []),
    ],
  }));

  const statusCounts: Record<WeekZeroMarketStatus, number> = {
    live: 0,
    stale: 0,
    incomplete: 0,
  };
  for (const valuation of valuations) {
    statusCounts[valuation.marketStatus] += 1;
  }

  return {
    valuations,
    rawPointTotal,
    normalizedShareTotal: sum(shares),
    statusCounts,
  };
}

export function marketQuoteFromTopOfBook(input: {
  ticker: string;
  kind: MarketQuoteKind;
  line?: number | null;
  bid?: number | null;
  ask?: number | null;
  last?: number | null;
  bidDepth?: number | null;
  askDepth?: number | null;
  updatedAt?: string | null;
}): MarketQuote {
  const bid = input.bid == null ? null : clamp(input.bid);
  const ask = input.ask == null ? null : clamp(input.ask);
  const last = input.last == null ? null : clamp(input.last);
  const hasBook = bid != null && ask != null && ask >= bid;
  const probability = hasBook
    ? (bid + ask) / 2
    : last ?? bid ?? ask ?? null;
  const spread = hasBook ? ask - bid : null;
  const quality: MarketQuoteQuality =
    probability == null
      ? "unavailable"
      : hasBook &&
          spread != null &&
          spread <= MAX_QUOTE_SPREAD &&
          (input.bidDepth ?? 0) >= MIN_TOP_OF_BOOK_DEPTH &&
          (input.askDepth ?? 0) >= MIN_TOP_OF_BOOK_DEPTH
        ? "live"
        : "stale";

  return {
    ticker: input.ticker,
    kind: input.kind,
    line: input.line ?? null,
    bid,
    ask,
    last,
    probability,
    spread,
    bidDepth: input.bidDepth ?? null,
    askDepth: input.askDepth ?? null,
    quality,
    updatedAt: input.updatedAt ?? null,
    derived: false,
  };
}