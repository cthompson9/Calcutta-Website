/**
 * Pure Stage-1 scorer.  It intentionally accepts only rules, events and pool
 * configuration: expected workbook values are not part of its input type.
 */
export type HistoricalRule = {
  kind: "per_unit" | "direct_share" | "group_rank_bonus" | "split_pool";
  metric?: string | null; period_key?: string | null; rate: number;
  group_attr?: string | null; fallback?: string[] | null;
};
export type HistoricalEntry = {
  id: string | number;
  attributes?: Record<string, unknown> | null;
  events?: Array<{ period_key?: string | null; metric: string; units: number }>;
};
export type HistoricalPool = {
  pot_size: number; normalization: { mode: "direct" | "direct_share" | "earned_total" | "fixed_inventory"; denominator?: number };
  periods?: Array<{ key: string; weight?: number }>; rules: HistoricalRule[];
};
export type HistoricalScore = { points: Map<string | number, number>; payouts: Map<string | number, number> };

export type HistoricalBookBasis = "lion_king" | "net";
export type HistoricalBookPosition = {
  id: string;
  shape: "spread" | "single_sided";
  basis: HistoricalBookBasis;
  factor: number | null;
  holderOwner: string;
  counterpartyOwner: string;
  longBookOwner: string;
  shortBookOwner?: string;
  bookedCash?: number | null;
};
export type HistoricalBookEvaluation = {
  id: string;
  basis: HistoricalBookBasis;
  factor: number | null;
  unitValue: number | null;
  derivedValue: number | null;
  bookedCash: number | null;
  usedBookedCash: boolean;
};
export type HistoricalBookSourceTrade = {
  sheet_ref?: string | number | null;
  detail?: string | null;
  scope?: string | null;
  from?: string | null;
  to?: string | null;
  pct?: number | null;
  factor?: number | null;
  cash?: number | null;
  basis?: HistoricalBookBasis | null;
  reference_owner?: string | null;
  leg_owner?: string | null;
};

export type HistoricalReconciliationDocument = HistoricalPool & {
  edition: number;
  name: string;
  sport: string;
  owners: Array<{ label: string }>;
  trades?: HistoricalBookSourceTrade[];
  entries: Array<HistoricalEntry & {
    label: string;
    price: number;
    owners: Array<{ label: string; share: number }>;
    expected: { points: number | null; realized_return: number | null };
  }>;
  expected_owners?: Array<{
    label: string;
    cost: number | null;
    realized: number | null;
  }>;
};

export type HistoricalPoolParityReport = {
  edition: number;
  name: string;
  sport: string;
  entries: number;
  teams: { matched: number; expected: number };
  points: { matched: number; expected: number };
  owners: { matched: number; expected: number };
  pot: { expected: number; calculated: number; matched: boolean };
  auctionPricePot: {
    expected: number;
    entryPriceTotal: number;
    matched: boolean;
  };
  splits: { matched: number; expected: number };
  books: {
    sourcePositions: number;
    computable: number;
    matched: number;
    knownVariances: number;
    zeroSum: boolean;
  };
  passed: boolean;
  mismatches: string[];
};

export type HistoricalParityReport = {
  generatedFrom: "rules-events-primary-and-pre-book-positions";
  tolerance: { money: 0.01; points: 0.01; shares: 0.000001 };
  pools: HistoricalPoolParityReport[];
  totals: {
    teams: { matched: number; expected: number };
    points: { matched: number; expected: number };
    owners: { matched: number; expected: number };
    pots: { matched: number; expected: number };
    splits: { matched: number; expected: number };
    books: { matched: number; expected: number; knownVariances: number };
  };
  sourceVariances: Array<{
    edition: number;
    kind: "entry_prices_vs_pot";
    expected: number;
    actual: number;
  }>;
  knownBookVariances: Array<{
    edition: number;
    id: string;
    derived: number;
    booked: number;
  }>;
  passed: boolean;
};

const knownBookVarianceAllowlist = new Map<
  string,
  { derived: number; booked: number }
>([
  [
    "7:Tracker!B40",
    { derived: 16027.02602230483, booked: 14721.022305 },
  ],
  ["9:1", { derived: 1425.2513888888866, booked: -6166.698611 }],
  [
    "10:Tracker!B35",
    { derived: 5404.817518248175, booked: 2964.963504 },
  ],
  [
    "10:Tracker!B36",
    { derived: 2702.4087591240873, booked: 1482.481752 },
  ],
  [
    "10:Tracker!B37",
    { derived: 12.759124087591227, booked: 96.27737226 },
  ],
]);

export function scoreHistoricalPool(pool: HistoricalPool, entries: HistoricalEntry[]): HistoricalScore {
  const periodWeights = new Map((pool.periods ?? []).map((period) => [period.key, period.weight ?? 1]));
  const events = new Map(entries.map((entry) => [entry.id, entry.events ?? []]));
  const points = new Map(entries.map((entry) => [entry.id, 0]));
  const shares = new Map(entries.map((entry) => [entry.id, 0]));
  const rules = pool.rules;
  for (const entry of entries) for (const event of events.get(entry.id) ?? []) {
    for (const rule of rules) {
      if (rule.metric !== event.metric || (rule.period_key != null && rule.period_key !== event.period_key)) continue;
      if (rule.kind === "per_unit") {
        points.set(entry.id, points.get(entry.id)! + event.units * rule.rate * (event.period_key ? periodWeights.get(event.period_key) ?? 1 : 1));
      } else if (rule.kind === "direct_share") {
        shares.set(entry.id, shares.get(entry.id)! + event.units * rule.rate);
      }
    }
  }
  // Cross-entry awards are deliberately evaluated after all base points exist.
  for (const rule of rules.filter((rule) => rule.kind === "group_rank_bonus")) {
    const groups = new Map<string, HistoricalEntry[]>();
    for (const entry of entries) {
      const group = entry.attributes?.[rule.group_attr ?? ""];
      if (group != null) groups.set(String(group), [...(groups.get(String(group)) ?? []), entry]);
    }
    for (const group of groups.values()) {
      const top = Math.max(...group.map((entry) => points.get(entry.id)!));
      const winners = group.filter((entry) => points.get(entry.id) === top);
      for (const winner of winners) points.set(winner.id, points.get(winner.id)! + rule.rate / winners.length);
    }
  }
  const splitAwards = new Map(entries.map((entry) => [entry.id, 0]));
  for (const rule of rules.filter((rule) => rule.kind === "split_pool")) {
    const metric = (rule.fallback ?? [rule.metric!]).find((candidate) =>
      entries.some((entry) => (events.get(entry.id) ?? []).some((event) => event.metric === candidate && event.units > 0)));
    if (!metric) continue;
    const total = entries.reduce((sum, entry) => sum + (events.get(entry.id) ?? [])
      .filter((event) => event.metric === metric).reduce((n, event) => n + event.units, 0), 0);
    if (total <= 0) continue;
    for (const entry of entries) {
      const units = (events.get(entry.id) ?? []).filter((event) => event.metric === metric)
        .reduce((n, event) => n + event.units, 0);
      splitAwards.set(entry.id, splitAwards.get(entry.id)! + units * rule.rate * pool.pot_size / total);
    }
  }
  const totalPoints = [...points.values()].reduce((sum, value) => sum + value, 0);
  const payouts = new Map<string | number, number>();
  for (const entry of entries) {
    const split = splitAwards.get(entry.id)!;
    switch (pool.normalization.mode) {
      case "direct":
      case "direct_share": payouts.set(entry.id, shares.get(entry.id)! * pool.pot_size + split); break;
      case "earned_total": payouts.set(entry.id, (totalPoints ? points.get(entry.id)! / totalPoints * pool.pot_size : 0) + split); break;
      case "fixed_inventory":
        if (!pool.normalization.denominator) throw new Error("fixed_inventory requires a denominator");
        payouts.set(entry.id, points.get(entry.id)! / pool.normalization.denominator * pool.pot_size + split);
    }
  }
  return { points, payouts };
}

export function calculatePreBookOwnerBooks(
  entries: Array<HistoricalEntry & {
    price: number;
    owners: Array<{ label: string; share: number }>;
  }>,
  payouts: ReadonlyMap<string | number, number>,
  basis: HistoricalBookBasis,
): Map<string, number> {
  const books = new Map<string, number>();
  for (const entry of entries) {
    const gain = (payouts.get(entry.id) ?? 0) - entry.price;
    for (const owner of entry.owners) {
      const exposure =
        basis === "lion_king"
          ? owner.share > 0
            ? 1
            : 0
          : owner.share;
      books.set(
        owner.label,
        (books.get(owner.label) ?? 0) + exposure * gain,
      );
    }
  }
  return books;
}

export function adaptHistoricalBookTrades(
  document: Pick<
    HistoricalReconciliationDocument,
    "edition" | "owners" | "trades"
  >,
): HistoricalBookPosition[] {
  const labels = document.owners.map((owner) => owner.label);
  const candidates = (document.trades ?? []).filter((trade) => {
    const detail = trade.detail ?? "";
    return (
      (trade.scope === "book" || trade.scope === "synthetic_book") &&
      !/^\s*(SIDEBET|CASH SIDE PAYMENT)/i.test(detail) &&
      (trade.factor != null || trade.pct != null || trade.cash != null)
    );
  });
  const seenMirrors = new Set<string>();
  const positions: HistoricalBookPosition[] = [];
  for (const [index, trade] of candidates.entries()) {
    const mirrorKey = `${String(trade.sheet_ref ?? "")}`;
    const mirrorGroup = candidates.filter(
      (candidate) =>
        String(candidate.sheet_ref ?? "") === mirrorKey &&
        candidate !== trade,
    );
    if (
      mirrorGroup.some(
        (candidate) =>
          trade.cash != null &&
          candidate.cash != null &&
          Math.abs(trade.cash + candidate.cash) <= 0.000001,
      )
    ) {
      if (seenMirrors.has(mirrorKey)) continue;
      seenMirrors.add(mirrorKey);
    }
    const holder =
      trade.leg_owner && labels.includes(trade.leg_owner)
        ? trade.leg_owner
        : trade.to && labels.includes(trade.to)
          ? trade.to
          : null;
    if (!holder) continue;
    const counterparty =
      trade.from && trade.from !== holder
        ? trade.from
        : trade.to && trade.to !== holder
          ? trade.to
          : null;
    if (!counterparty) continue;
    const detail = trade.detail ?? "";
    const singleReference =
      trade.reference_owner ??
      labels.find((label) =>
        new RegExp(
          `\\b${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b(?:'s)?\\s+book`,
          "i",
        ).test(detail),
      );
    const pair = labels.flatMap((left) =>
      labels
        .filter((right) => right !== left)
        .map((right) => [left, right] as const),
    ).find(([left, right]) =>
      new RegExp(
        `${left.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*\\/\\s*${right.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`,
        "i",
      ).test(detail),
    );
    const factor = trade.factor ?? trade.pct ?? null;
    if (singleReference && /synthetic/i.test(detail) && /\bof\b/i.test(detail)) {
      positions.push({
        id: `${document.edition}:${String(trade.sheet_ref ?? index)}`,
        shape: "single_sided",
        basis: trade.basis ?? "lion_king",
        factor,
        holderOwner: holder,
        counterpartyOwner: counterparty,
        longBookOwner: singleReference,
        bookedCash: trade.cash ?? null,
      });
      continue;
    }
    const bookOwners = pair ?? [holder, counterparty];
    const longBookOwner = bookOwners.includes(holder)
      ? holder
      : bookOwners[0];
    const shortBookOwner =
      bookOwners.find((owner) => owner !== longBookOwner) ?? counterparty;
    positions.push({
      id: `${document.edition}:${String(trade.sheet_ref ?? index)}`,
      shape: "spread",
      basis: trade.basis ?? "lion_king",
      factor,
      holderOwner: holder,
      counterpartyOwner: counterparty,
      longBookOwner,
      shortBookOwner,
      bookedCash: trade.cash ?? null,
    });
  }
  return positions;
}

/**
 * Third pass for book instruments. Every position is valued independently
 * against pre-book auction books, so stacked instruments never feed back into
 * later instruments. A null factor is intentionally not derived; its booked
 * cash is carried as the historical observation.
 */
export function evaluateHistoricalBookPositions(
  entries: Array<HistoricalEntry & {
    price: number;
    owners: Array<{ label: string; share: number }>;
  }>,
  payouts: ReadonlyMap<string | number, number>,
  positions: HistoricalBookPosition[],
): {
  evaluations: HistoricalBookEvaluation[];
  ownerImpacts: Map<string, number>;
} {
  const booksByBasis = new Map<HistoricalBookBasis, Map<string, number>>();
  const books = (basis: HistoricalBookBasis) => {
    const existing = booksByBasis.get(basis);
    if (existing) return existing;
    const calculated = calculatePreBookOwnerBooks(entries, payouts, basis);
    booksByBasis.set(basis, calculated);
    return calculated;
  };
  const ownerImpacts = new Map<string, number>();
  const evaluations = positions.map((position): HistoricalBookEvaluation => {
    const ownerBooks = books(position.basis);
    const longValue = ownerBooks.get(position.longBookOwner) ?? 0;
    const unitValue =
      position.shape === "single_sided"
        ? longValue
        : longValue - (ownerBooks.get(position.shortBookOwner ?? "") ?? 0);
    const derivedValue =
      position.factor == null ? null : position.factor * unitValue;
    const bookedCash = position.bookedCash ?? null;
    const impact = derivedValue ?? bookedCash ?? 0;
    ownerImpacts.set(
      position.holderOwner,
      (ownerImpacts.get(position.holderOwner) ?? 0) + impact,
    );
    ownerImpacts.set(
      position.counterpartyOwner,
      (ownerImpacts.get(position.counterpartyOwner) ?? 0) - impact,
    );
    return {
      id: position.id,
      basis: position.basis,
      factor: position.factor,
      unitValue: position.factor == null ? null : unitValue,
      derivedValue,
      bookedCash,
      usedBookedCash: derivedValue == null && bookedCash != null,
    };
  });
  const netImpact = [...ownerImpacts.values()].reduce(
    (total, value) => total + value,
    0,
  );
  if (!within(netImpact, 0, 0.000001)) {
    throw new Error(`Book positions must be zero-sum; got ${netImpact}.`);
  }
  return { evaluations, ownerImpacts };
}

function within(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance + Number.EPSILON;
}

/**
 * Produces the Stage-1 parity gate as structured data. Workbook expectations
 * are consumed only here, after scoreHistoricalPool has completed from rules
 * and events alone.
 */
export function reconcileHistoricalPools(
  documents: HistoricalReconciliationDocument[],
): HistoricalParityReport {
  const pools = [...documents]
    .sort((left, right) => left.edition - right.edition)
    .map((document): HistoricalPoolParityReport => {
      const entries = document.entries.map((entry, index) => ({
        ...entry,
        id: index,
      }));
      const calculated = scoreHistoricalPool(document, entries);
      const ownerCosts = new Map<string, number>();
      const ownerPayouts = new Map<string, number>();
      const mismatches: string[] = [];
      let teamExpected = 0;
      let teamMatched = 0;
      let pointExpected = 0;
      let pointMatched = 0;
      let splitMatched = 0;

      for (const [index, entry] of document.entries.entries()) {
        const payout = calculated.payouts.get(index) ?? 0;
        const points = calculated.points.get(index) ?? 0;
        if (entry.expected.realized_return != null) {
          teamExpected++;
          if (within(payout, entry.expected.realized_return, 0.01)) {
            teamMatched++;
          } else {
            mismatches.push(
              `${entry.label} payout ${payout.toFixed(6)} != ${entry.expected.realized_return.toFixed(2)}`,
            );
          }
        }
        if (entry.expected.points != null) {
          pointExpected++;
          if (within(points, entry.expected.points, 0.01)) {
            pointMatched++;
          } else {
            mismatches.push(
              `${entry.label} points ${points.toFixed(6)} != ${entry.expected.points.toFixed(4)}`,
            );
          }
        }
        const share = entry.owners.reduce(
          (total, owner) => total + owner.share,
          0,
        );
        if (within(share, 1, 0.000001)) {
          splitMatched++;
        } else {
          mismatches.push(`${entry.label} ownership ${share} != 1`);
        }
        for (const owner of entry.owners) {
          ownerCosts.set(
            owner.label,
            (ownerCosts.get(owner.label) ?? 0) + owner.share * entry.price,
          );
          ownerPayouts.set(
            owner.label,
            (ownerPayouts.get(owner.label) ?? 0) + owner.share * payout,
          );
        }
      }

      let ownerExpected = 0;
      let ownerMatched = 0;
      for (const expected of document.expected_owners ?? []) {
        if (expected.cost == null && expected.realized == null) continue;
        ownerExpected++;
        const costMatches =
          expected.cost == null ||
          within(ownerCosts.get(expected.label) ?? 0, expected.cost, 0.01);
        const payoutMatches =
          expected.realized == null ||
          within(
            ownerPayouts.get(expected.label) ?? 0,
            expected.realized,
            0.01,
          );
        if (costMatches && payoutMatches) {
          ownerMatched++;
        } else {
          mismatches.push(`${expected.label} owner roll-up mismatch`);
        }
      }

      const calculatedPot = [...calculated.payouts.values()].reduce(
        (total, payout) => total + payout,
        0,
      );
      const entryPriceTotal = document.entries.reduce(
        (total, entry) => total + entry.price,
        0,
      );
      const potMatched = within(calculatedPot, document.pot_size, 0.01);
      if (!potMatched) {
        mismatches.push(
          `pool payout ${calculatedPot.toFixed(6)} != pot ${document.pot_size.toFixed(2)}`,
        );
      }
      const bookPositions = adaptHistoricalBookTrades(document);
      const bookResult = evaluateHistoricalBookPositions(
        entries,
        calculated.payouts,
        bookPositions,
      );
      const computableBooks = bookResult.evaluations.filter(
        (evaluation) =>
          evaluation.derivedValue != null && evaluation.bookedCash != null,
      );
      const matchedBooks = computableBooks.filter((evaluation) =>
        within(
          Math.abs(evaluation.derivedValue ?? 0),
          Math.abs(evaluation.bookedCash ?? 0),
          0.01,
        ),
      );
      const knownBookVariances = computableBooks.filter(
        (evaluation) => {
          if (matchedBooks.includes(evaluation)) return false;
          const allowed = knownBookVarianceAllowlist.get(evaluation.id);
          return (
            allowed != null &&
            within(evaluation.derivedValue ?? 0, allowed.derived, 0.01) &&
            within(evaluation.bookedCash ?? 0, allowed.booked, 0.01)
          );
        },
      );
      const unexpectedBookVariances = computableBooks.filter(
        (evaluation) =>
          !matchedBooks.includes(evaluation) &&
          !knownBookVariances.includes(evaluation),
      );
      for (const evaluation of unexpectedBookVariances) {
        mismatches.push(
          `book ${evaluation.id} ${evaluation.derivedValue?.toFixed(6)} != booked ${evaluation.bookedCash?.toFixed(6)}`,
        );
      }
      const bookNet = [...bookResult.ownerImpacts.values()].reduce(
        (total, value) => total + value,
        0,
      );
      const booksZeroSum = within(bookNet, 0, 0.000001);
      return {
        edition: document.edition,
        name: document.name,
        sport: document.sport,
        entries: document.entries.length,
        teams: { matched: teamMatched, expected: teamExpected },
        points: { matched: pointMatched, expected: pointExpected },
        owners: { matched: ownerMatched, expected: ownerExpected },
        pot: {
          expected: document.pot_size,
          calculated: calculatedPot,
          matched: potMatched,
        },
        auctionPricePot: {
          expected: document.pot_size,
          entryPriceTotal,
          matched: within(entryPriceTotal, document.pot_size, 0.01),
        },
        splits: {
          matched: splitMatched,
          expected: document.entries.length,
        },
        books: {
          sourcePositions: bookPositions.length,
          computable: computableBooks.length,
          matched: matchedBooks.length,
          knownVariances: knownBookVariances.length,
          zeroSum: booksZeroSum,
        },
        passed:
          teamMatched === teamExpected &&
          pointMatched === pointExpected &&
          ownerMatched === ownerExpected &&
          splitMatched === document.entries.length &&
          potMatched &&
          booksZeroSum &&
          unexpectedBookVariances.length === 0,
        mismatches,
      };
    });

  const sum = (
    select: (pool: HistoricalPoolParityReport) => {
      matched: number;
      expected: number;
    },
  ) => ({
    matched: pools.reduce(
      (total, pool) => total + select(pool).matched,
      0,
    ),
    expected: pools.reduce(
      (total, pool) => total + select(pool).expected,
      0,
    ),
  });
  const sourceVariances = pools
    .filter((pool) => !pool.auctionPricePot.matched)
    .map((pool) => ({
      edition: pool.edition,
      kind: "entry_prices_vs_pot" as const,
      expected: pool.auctionPricePot.expected,
      actual: pool.auctionPricePot.entryPriceTotal,
    }));
  const knownBookVariances = pools.flatMap((pool) =>
    adaptHistoricalBookTrades(
      documents.find((document) => document.edition === pool.edition)!,
    ).flatMap((position) => {
      const allowed = knownBookVarianceAllowlist.get(position.id);
      return allowed
        ? [{
            edition: pool.edition,
            id: position.id,
            derived: allowed.derived,
            booked: allowed.booked,
          }]
        : [];
    }),
  );
  return {
    generatedFrom: "rules-events-primary-and-pre-book-positions",
    tolerance: { money: 0.01, points: 0.01, shares: 0.000001 },
    pools,
    totals: {
      teams: sum((pool) => pool.teams),
      points: sum((pool) => pool.points),
      owners: sum((pool) => pool.owners),
      pots: {
        matched: pools.filter((pool) => pool.pot.matched).length,
        expected: pools.length,
      },
      splits: sum((pool) => pool.splits),
      books: {
        matched: pools.reduce(
          (total, pool) => total + pool.books.matched,
          0,
        ),
        expected: pools.reduce(
          (total, pool) => total + pool.books.computable,
          0,
        ),
        knownVariances: pools.reduce(
          (total, pool) => total + pool.books.knownVariances,
          0,
        ),
      },
    },
    sourceVariances,
    knownBookVariances,
    passed: pools.length === 11 && pools.every((pool) => pool.passed),
  };
}