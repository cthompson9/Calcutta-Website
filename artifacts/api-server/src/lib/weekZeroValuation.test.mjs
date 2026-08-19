import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWeekZeroSnapshotRows,
  calculateWeekZeroValuations,
  getKalshiSeasonContracts,
  marketQuoteFromTopOfBook,
} from "./weekZeroValuation.ts";

function liveQuote(ticker, kind, probability, line = null) {
  return marketQuoteFromTopOfBook({
    ticker,
    kind,
    line,
    bid: Math.max(0, probability - 0.01),
    ask: Math.min(1, probability + 0.01),
    last: probability,
    bidDepth: 250,
    askDepth: 250,
    updatedAt: "2026-08-19T12:00:00Z",
  });
}

function teamSnapshot(index, overrides = {}) {
  const expectedWins = 4 + (index % 13) * 0.75;
  const winThresholds = Array.from({ length: 17 }, (_, thresholdIndex) => {
    const threshold = thresholdIndex + 1;
    const probability = Math.max(
      0.01,
      Math.min(0.99, 1 / (1 + Math.exp((threshold - expectedWins) / 1.4))),
    );
    return liveQuote(
      `KXNFLWINS-27T${index}-${threshold}`,
      "win_threshold",
      probability,
      threshold - 0.5,
    );
  });

  const playoff = Math.min(0.85, 0.18 + expectedWins / 20);
  const conferenceChampion = Math.min(0.22, playoff / 5);
  const championship = Math.min(0.12, conferenceChampion / 2);

  return {
    teamId: index + 1,
    teamName: `Team ${index + 1}`,
    conference: index < 16 ? "AFC" : "NFC",
    contractSetId: "nfl-2026-27-v1",
    winThresholds,
    playoff: liveQuote(`PLAYOFF-${index}`, "playoff", playoff),
    conferenceChampion: liveQuote(
      `CONF-${index}`,
      "conference_champion",
      conferenceChampion,
    ),
    championship: liveQuote(
      `CHAMP-${index}`,
      "championship",
      championship,
    ),
    ...overrides,
  };
}

test("top-of-book quote quality enforces spread and depth", () => {
  const live = liveQuote("LIVE", "playoff", 0.6);
  assert.equal(live.quality, "live");
  assert.equal(live.probability, 0.6);

  const stale = marketQuoteFromTopOfBook({
    ticker: "STALE",
    kind: "playoff",
    bid: 0.45,
    ask: 0.55,
    bidDepth: 500,
    askDepth: 500,
  });
  assert.equal(stale.quality, "stale");

  const unavailable = marketQuoteFromTopOfBook({
    ticker: "EMPTY",
    kind: "playoff",
  });
  assert.equal(unavailable.quality, "unavailable");
  assert.equal(unavailable.probability, null);
});

test("Week 0 calculation reconciles points, shares, pot, and round totals", () => {
  const snapshots = Array.from({ length: 32 }, (_, index) =>
    teamSnapshot(index),
  );
  const result = calculateWeekZeroValuations(snapshots, 48_300);

  assert.equal(result.valuations.length, 32);
  assert.ok(Math.abs(result.rawPointTotal - 11_420) < 1e-6);
  assert.ok(Math.abs(result.normalizedShareTotal - 1) < 1e-10);
  assert.ok(
    Math.abs(
      result.valuations.reduce((total, value) => total + value.fairValue, 0) -
        48_300,
    ) < 0.01,
  );
  assert.ok(
    Math.abs(
      result.valuations.reduce(
        (total, value) => total + value.expectedWins,
        0,
      ) - 272,
    ) < 1e-8,
  );
  assert.ok(
    Math.abs(
      result.valuations.reduce(
        (total, value) => total + value.playoffProbability,
        0,
      ) - 14,
    ) < 1e-8,
  );
  assert.ok(
    Math.abs(
      result.valuations.reduce(
        (total, value) => total + value.divisionalProbability,
        0,
      ) - 8,
    ) < 1e-8,
  );
  assert.ok(
    Math.abs(
      result.valuations.reduce(
        (total, value) => total + value.conferenceGameProbability,
        0,
      ) - 4,
    ) < 1e-8,
  );
  assert.equal(result.statusCounts.live, 32);
});

test("missing and low-quality markets are visible in team status", () => {
  const snapshots = Array.from({ length: 32 }, (_, index) =>
    teamSnapshot(index),
  );
  snapshots[0] = teamSnapshot(0, { championship: null });
  snapshots[1] = teamSnapshot(1, {
    playoff: marketQuoteFromTopOfBook({
      ticker: "THIN",
      kind: "playoff",
      bid: 0.5,
      ask: 0.52,
      bidDepth: 2,
      askDepth: 3,
    }),
  });

  const result = calculateWeekZeroValuations(snapshots, 10_000);
  assert.equal(result.valuations[0].marketStatus, "incomplete");
  assert.equal(result.valuations[1].marketStatus, "stale");
  assert.equal(result.statusCounts.incomplete, 1);
  assert.equal(result.statusCounts.stale, 1);
});

test("Week 0 requires one valuation for every NFL team", () => {
  assert.throws(
    () => calculateWeekZeroValuations([teamSnapshot(0)], 1_000),
    /requires all 32 teams/,
  );
});

test("supported app seasons map to explicit reviewed Kalshi contracts", () => {
  assert.deepEqual(getKalshiSeasonContracts(2026), {
    contractSetId: "nfl-2026-27-v1",
    winsEventPrefix: "KXNFLWINS-27",
    playoffEvent: "KXNFLPLAYOFF-27",
    afcChampionEvent: "KXNFLAFCCHAMP-27",
    nfcChampionEvent: "KXNFLNFCCHAMP-27",
    championshipEvent: "KXSB-27",
  });
  assert.throws(
    () => getKalshiSeasonContracts(2099),
    /No reviewed Kalshi contract mapping/,
  );
});

test("sparse and old win ladders cannot be presented as live", () => {
  const current = new Date("2026-08-19T12:00:00Z");
  const snapshots = Array.from({ length: 32 }, (_, index) =>
    teamSnapshot(index),
  );
  snapshots[0] = teamSnapshot(0, {
    winThresholds: [
      liveQuote("ONLY-LINE", "win_threshold", 0.5, 8.5),
    ],
  });
  snapshots[1] = teamSnapshot(1);
  snapshots[1].winThresholds = snapshots[1].winThresholds.map((quote) => ({
    ...quote,
    updatedAt: "2026-07-01T12:00:00Z",
  }));

  const result = calculateWeekZeroValuations(snapshots, 48_300, current);
  assert.equal(result.valuations[0].marketStatus, "incomplete");
  assert.match(
    result.valuations[0].marketStatusReasons.join(" "),
    /Incomplete win ladder/,
  );
  assert.equal(result.valuations[1].marketStatus, "stale");
  assert.match(
    result.valuations[1].marketStatusReasons.join(" "),
    /last 7 days/,
  );
});

test("recapture rows retain stable Week 0 conflict identities", () => {
  const calculation = calculateWeekZeroValuations(
    Array.from({ length: 32 }, (_, index) => teamSnapshot(index)),
    48_300,
  );
  const first = buildWeekZeroSnapshotRows(calculation, {
    seasonId: 2,
    snapshotDate: "2026-08-19",
    capturedAt: new Date("2026-08-19T12:00:00Z"),
  });
  const recapture = buildWeekZeroSnapshotRows(calculation, {
    seasonId: 2,
    snapshotDate: "2026-08-19",
    capturedAt: new Date("2026-08-20T12:00:00Z"),
  });

  const identity = (row) =>
    `${row.teamId}:${row.seasonId}:${row.snapshotKey}`;
  assert.equal(new Set(first.map(identity)).size, 32);
  assert.deepEqual(first.map(identity), recapture.map(identity));
  assert.ok(
    recapture.every(
      (row) =>
        row.snapshotKey === "week-0" &&
        row.weekNum === 0 &&
        row.snapshotDate === "2026-08-19",
    ),
  );
});