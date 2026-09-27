import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  auctionLotsTable,
  auctionSessionsTable,
  calcuttaEntriesTable,
  calcuttaRulesTable,
  calcuttasTable,
  seasonsTable,
  teamsTable,
} from "@workspace/db";
import { CreateCalcuttaBody, CreateCalcuttaResponse, GetCalcuttasResponse } from "@workspace/api-zod";
import { ErrorResponse, sendParsedJson } from "../lib/sendParsedJson";
import { requireAdmin } from "../middlewares/requireAdmin";
import { hasCalcuttaPoolType } from "../lib/calcuttaContext";

const router: IRouter = Router();

const legacyEditionNames: Record<string, string> = {
  "NCAAM:2022": "Calcutta I",
  "NCAAM:2023": "Calcutta II",
  "NFL:2023": "Calcutta III",
  "NCAAM:2024": "Calcutta IV",
  "NFL:2024": "Calcutta V",
  "NCAAM:2025": "Calcutta VI",
  "NBA:2025": "Calcutta VII",
  "NFL:2025": "Calcutta VIII",
  "NCAAM:2026": "Calcutta IX",
  "NBA:2026": "Calcutta X",
  "Soccer:2026": "Calcutta XI",
  "NFL:2026": "Calcutta XII",
};

function selectorName(args: { name: string; sport: string; year: number }): string {
  if (args.name.startsWith("Calcutta ")) return args.name;
  return legacyEditionNames[`${args.sport}:${args.year}`] ?? args.name;
}

const romanValues: Record<string, number> = {
  I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000,
};

function selectorOrder(name: string): number {
  const match = /^Calcutta\s+([IVXLCDM]+)\b/.exec(name);
  if (!match) return 0;
  const numeral = match[1]!;
  let value = 0;
  for (let index = 0; index < numeral.length; index += 1) {
    const current = romanValues[numeral[index]!] ?? 0;
    const next = romanValues[numeral[index + 1]!] ?? 0;
    value += current < next ? -current : current;
  }
  return value;
}

function toRoman(value: number): string {
  const numerals: Array<[number, string]> = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
    [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let remaining = value;
  let result = "";
  for (const [amount, numeral] of numerals) {
    while (remaining >= amount) {
      result += numeral;
      remaining -= amount;
    }
  }
  return result;
}

router.get("/calcuttas", async (_req, res): Promise<void> => {
  const calcuttas = await db
    .select({
      id: calcuttasTable.id,
      seasonId: calcuttasTable.seasonId,
      name: calcuttasTable.name,
      sport: calcuttasTable.sport,
      year: calcuttasTable.year,
      isActive: seasonsTable.isActive,
      isComplete: seasonsTable.isComplete,
      isCanonical: calcuttasTable.isCanonical,
    })
    .from(calcuttasTable)
    .innerJoin(seasonsTable, eq(seasonsTable.id, calcuttasTable.seasonId))
    .orderBy(
      desc(calcuttasTable.year),
      desc(calcuttasTable.createdAt),
      desc(calcuttasTable.id),
    );

  const options = calcuttas
    .map((calcutta) => ({
        ...calcutta,
        name: selectorName(calcutta),
      }))
    .sort(
      (left, right) =>
        selectorOrder(right.name) - selectorOrder(left.name) ||
        right.year - left.year ||
        right.id - left.id,
    );

  sendParsedJson(res, GetCalcuttasResponse, options);
});

router.post("/calcuttas", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateCalcuttaBody.safeParse(req.body);
  if (!parsed.success) {
    sendParsedJson(res, ErrorResponse, { error: parsed.error.message }, 400);
    return;
  }

  const input = parsed.data;
  const sport = input.sport.trim().toUpperCase();
  if (!Number.isInteger(input.year) || input.year < 1900 || input.year > 2200) {
    sendParsedJson(res, ErrorResponse, { error: "Year must be an integer between 1900 and 2200." }, 400);
    return;
  }
  const lots = input.lots.map((lot) => lot.trim().replace(/\s+/g, " "));
  const rubric = input.rubric.map((rule) => ({
    event: rule.event.trim().replace(/\s+/g, " "),
    value: rule.value,
  }));
  if (!/^[A-Z][A-Z0-9_ -]{0,49}$/.test(sport) || lots.some((lot) => !lot) ||
      rubric.some((rule) => !rule.event || !Number.isFinite(rule.value) || rule.value < 0)) {
    sendParsedJson(res, ErrorResponse, { error: "Sport, lots, or scoring rubric contains invalid values." }, 400);
    return;
  }
  const normalizedLots = lots.map((lot) => lot.toLocaleLowerCase("en-US"));
  const normalizedEvents = rubric.map((rule) => rule.event.toLocaleLowerCase("en-US"));
  if (new Set(normalizedLots).size !== lots.length) {
    sendParsedJson(res, ErrorResponse, { error: "Lot names must be unique." }, 400);
    return;
  }
  if (new Set(normalizedEvents).size !== rubric.length) {
    sendParsedJson(res, ErrorResponse, { error: "Scoring rubric events must be unique." }, 400);
    return;
  }
  if (rubric.some(({ value }) =>
    !Number.isSafeInteger(Math.round(value * 1_000_000)) ||
    Number(value.toFixed(6)) !== value ||
    value > 9_999_999_999
  )) {
    sendParsedJson(res, ErrorResponse, { error: "Scoring values must fit the supported six-decimal precision." }, 400);
    return;
  }
  if (input.scoringFormat === "percentage") {
    const scaledTotal = rubric.reduce((sum, rule) => sum + BigInt(Math.round(rule.value * 1_000_000)), 0n);
    if (rubric.some((rule) => rule.value <= 0) || scaledTotal !== 100_000_000n) {
      sendParsedJson(res, ErrorResponse, { error: "Percentage scoring values must be positive and total exactly 100." }, 400);
      return;
    }
  } else if (!rubric.some((rule) => rule.value > 0)) {
    sendParsedJson(res, ErrorResponse, { error: "At least one points scoring value must be positive." }, 400);
    return;
  }

  const format = input.type === "postseason" ? `${sport}_POSTSEASON` : `${sport}_FULL_SEASON`;
  const displayKind = input.type === "postseason" ? "Playoffs" : "Full Season";
  try {
    const created = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(118352, hashtext('calcutta-edition-sequence'))`);
      const existingPools = await tx.select({
        id: calcuttasTable.id,
        isCanonical: calcuttasTable.isCanonical,
        competitionFormat: calcuttasTable.competitionFormat,
      })
        .from(calcuttasTable)
        .where(and(eq(calcuttasTable.sport, sport), eq(calcuttasTable.year, input.year)))
      if (hasCalcuttaPoolType(existingPools.map((pool) => pool.competitionFormat), input.type)) {
        throw new Error("DUPLICATE_CALCUTTA_TYPE");
      }

      await tx.insert(seasonsTable).values({
        year: input.year,
        label: `${input.year} Season`,
      }).onConflictDoNothing({ target: seasonsTable.year });
      const [season] = await tx.select({ id: seasonsTable.id })
        .from(seasonsTable).where(eq(seasonsTable.year, input.year)).limit(1);
      if (!season) throw new Error("Could not create or resolve the shared season.");

      const existing = await tx.select({ name: calcuttasTable.name, sport: calcuttasTable.sport, year: calcuttasTable.year })
        .from(calcuttasTable);
      const nextEdition = Math.max(0, ...existing.map((row) => selectorOrder(selectorName(row)))) + 1;
      const name = `Calcutta ${toRoman(nextEdition)} - ${sport} ${displayKind} ${input.year}`;
      const [calcutta] = await tx.insert(calcuttasTable).values({
        seasonId: season.id,
        name,
        year: input.year,
        sport,
        competitionFormat: format,
        isCanonical: !existingPools.some((pool) => pool.isCanonical),
      }).returning({ id: calcuttasTable.id, name: calcuttasTable.name });
      if (!calcutta) throw new Error("Could not create Calcutta.");

      await tx.insert(calcuttaRulesTable).values(rubric.map((rule) => ({
        calcuttaId: calcutta.id,
        ruleName: rule.event,
        ruleType: input.scoringFormat === "points" ? "points" : "fixed_pct",
        value: String(rule.value),
        calculation: input.scoringFormat,
        active: true,
      })));

      const entryIds: number[] = [];
      for (const lot of lots) {
        await tx.insert(teamsTable).values({
          name: lot,
          sport,
          conference: sport,
          division: input.type === "postseason" ? "Playoffs" : "Participants",
        }).onConflictDoNothing({ target: [teamsTable.sport, teamsTable.name] });
        const [team] = await tx.select({ id: teamsTable.id })
          .from(teamsTable)
          .where(and(eq(teamsTable.sport, sport), eq(teamsTable.name, lot)))
          .limit(1);
        if (!team) throw new Error(`Could not create participant ${lot}.`);
        const [entry] = await tx.insert(calcuttaEntriesTable).values({
          calcuttaId: calcutta.id,
          teamId: team.id,
        }).returning({ id: calcuttaEntriesTable.id });
        if (!entry) throw new Error(`Could not create entry for ${lot}.`);
        entryIds.push(entry.id);
      }

      const [auction] = await tx.insert(auctionSessionsTable).values({
        calcuttaId: calcutta.id,
        status: "setup",
      }).returning({ id: auctionSessionsTable.id });
      if (!auction) throw new Error("Could not initialize auction session.");
      await tx.insert(auctionLotsTable).values(entryIds.map((entryId, index) => ({
        auctionId: auction.id,
        externalId: `entry-${entryId}`,
        displayName: lots[index]!,
        aliases: [],
        metadata: { sport, year: input.year, type: input.type },
        entryId,
        status: "available",
      })));
      return {
        id: calcutta.id,
        name: calcutta.name,
        sport,
        year: input.year,
        auctionId: auction.id,
      };
    });
    sendParsedJson(res, CreateCalcuttaResponse, created, 201);
  } catch (error) {
    if (error instanceof Error && error.message === "DUPLICATE_CALCUTTA_TYPE") {
      sendParsedJson(res, ErrorResponse, { error: `A ${input.type.replace("_", "-")} Calcutta already exists for this sport and year.` }, 409);
      return;
    }
    const message = error instanceof Error ? error.message : "Could not create Calcutta.";
    if (message.includes("calcuttas_name_idx")) {
      sendParsedJson(res, ErrorResponse, { error: "Could not allocate a unique Calcutta edition name." }, 409);
      return;
    }
    if (message.includes("calcuttas_canonical_season_sport_idx")) {
      sendParsedJson(res, ErrorResponse, { error: "Another Calcutta is already canonical for this sport and year." }, 409);
      return;
    }
    req.log?.error({ err: error }, "Failed to create Calcutta");
    sendParsedJson(res, ErrorResponse, { error: "Could not create Calcutta." }, 500);
  }
});

export default router;