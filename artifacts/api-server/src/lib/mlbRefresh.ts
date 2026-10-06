import { randomUUID, createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, calcuttasTable, refreshJobStatesTable } from "@workspace/db";
import { fetchEspnMlbForDate, type EspnMlbPayload } from "./mlbEspnClient";
import { isMlbGameWindowOpen, loadMlbGames, syncMlbEventsTx, MLB_SCOPE, type MlbPool } from "./mlbEventSync";
import { todayInNewYork } from "./newYorkTime";

export type MlbRefreshCache = {
  covered: Record<string, string>; leaseUntil: string | null; leaseToken: string | null;
  retryAt: string | null; pollAt: string | null; failures: number; advancementDiscovery: boolean;
};
export const emptyMlbCache = (): MlbRefreshCache => ({
  covered: {}, leaseUntil: null, leaseToken: null, retryAt: null, pollAt: null, failures: 0, advancementDiscovery: false,
});
export function readMlbCache(value: unknown): MlbRefreshCache {
  if (!value || typeof value !== "object") return emptyMlbCache();
  const raw = value as Partial<MlbRefreshCache>;
  if (!raw.covered || typeof raw.covered !== "object" || Object.values(raw.covered).some((v) => typeof v !== "string")) {
    throw new Error("Persisted MLB refresh coverage is malformed.");
  }
  return { ...emptyMlbCache(), ...raw, covered: raw.covered };
}
export function mlbDiscoveryDates(year: number, now: Date): string[] {
  const end = [todayInNewYork(now), `${year}-11-15`].sort()[0]!;
  const start = new Date(`${year}-09-15T12:00:00Z`);
  const dates: string[] = [];
  while (start.toISOString().slice(0, 10) <= end) {
    dates.push(start.toISOString().slice(0, 10).replaceAll("-", ""));
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return dates;
}
export const mlbRefreshScope = (pool: MlbPool) => and(
  eq(refreshJobStatesTable.seasonId, pool.seasonId),
  eq(refreshJobStatesTable.sport, MLB_SCOPE.sport),
  eq(refreshJobStatesTable.competition, MLB_SCOPE.competition),
  eq(refreshJobStatesTable.job, `realized:${pool.id}`),
);
export async function mlbIdentityMigrationReady(database: Pick<typeof db, "execute">): Promise<boolean> {
  const result = await database.execute(sql`
    select indexdef from pg_indexes where schemaname = current_schema()
      and indexname = 'events_season_scope_week_matchup_idx'
  `);
  return result.rows.some((row) => typeof row.indexdef === "string" && /WHERE.*sport.*<>.*MLB/i.test(row.indexdef));
}
export async function loadMlbPool(id: number, database: Pick<typeof db, "select"> = db): Promise<MlbPool | null> {
  const [pool] = await database.select().from(calcuttasTable).where(and(
    eq(calcuttasTable.id, id), eq(calcuttasTable.sport, "MLB"), eq(calcuttasTable.competitionFormat, "MLB_POSTSEASON"),
  ));
  return pool ?? null;
}
function tomorrowDate(now: Date): string {
  const date = new Date(`${todayInNewYork(now)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}
export function selectMlbRefreshDates(args: {
  year: number; now: Date; cache: MlbRefreshCache; activeGame: boolean; force?: boolean;
}): string[] {
  const { year, now, cache, activeGame, force } = args;
  const required = mlbDiscoveryDates(year, now);
  const recent = required.slice(-2);
  const requested = new Set<string>();
  if (required.length && (activeGame || force || cache.advancementDiscovery ||
      recent.some((date) => !cache.covered[date] || todayInNewYork(new Date(cache.covered[date]!)) !== todayInNewYork(now)))) {
    for (const date of recent) requested.add(date);
    if (year === Number(todayInNewYork(now).slice(0, 4)) && todayInNewYork(now) <= `${year}-11-15`) {
      requested.add(tomorrowDate(now));
    }
  }
  for (const date of required) {
    if (!cache.covered[date]) requested.add(date);
    if (requested.size >= 8) break;
  }
  // Daily bounded historical reconciliation detects corrections without
  // pretending that every empty response is a complete tournament snapshot.
  for (const date of required) {
    if (requested.size >= 8) break;
    if (cache.covered[date] && now.getTime() - Date.parse(cache.covered[date]!) >= 24 * 60 * 60 * 1000) requested.add(date);
  }
  return [...requested].slice(0, 8);
}

export async function refreshMlbResults(
  pool: MlbPool,
  options: { database?: typeof db; fetchDate?: (date: string) => Promise<EspnMlbPayload>; now?: Date; force?: boolean; authorized?: boolean } = {},
): Promise<{ ran: boolean; reason: string; games?: number }> {
  const database = options.database ?? db;
  const now = options.now ?? new Date();
  if (!(options.authorized ?? process.env.MLB_RESULTS_ENABLED === "true")) {
    return { ran: false, reason: "MLB results activation has not been authorized." };
  }
  if (!await mlbIdentityMigrationReady(database)) return { ran: false, reason: "MLB event identity migration has not been activated." };
  const initial = emptyMlbCache();
  await database.insert(refreshJobStatesTable).values({
    seasonId: pool.seasonId, ...{ sport: "MLB", competition: "MLB_POSTSEASON" },
    job: `realized:${pool.id}`, scheduleCache: initial,
  }).onConflictDoNothing();
  const [state] = await database.select().from(refreshJobStatesTable).where(mlbRefreshScope(pool));
  const cache = readMlbCache(state?.scheduleCache);
  if (!options.force && cache.retryAt && Date.parse(cache.retryAt) > now.getTime()) return { ran: false, reason: "retry-backoff" };
  if (!options.force && cache.pollAt && Date.parse(cache.pollAt) > now.getTime()) return { ran: false, reason: "not-due" };
  const games = await loadMlbGames(database, pool.seasonId);
  const activeGame = isMlbGameWindowOpen(games, now);
  const dates = selectMlbRefreshDates({ year: pool.year, now, cache, activeGame, force: options.force });
  if (!dates.length) return { ran: false, reason: "outside-game-window-and-discovery-current" };
  const token = randomUUID();
  const leased = { ...cache, leaseToken: token, leaseUntil: new Date(now.getTime() + 180_000).toISOString() };
  const claimed = await database.update(refreshJobStatesTable).set({
    scheduleCache: leased, lastAttemptedAt: now,
  }).where(and(mlbRefreshScope(pool),
    sql`${refreshJobStatesTable.scheduleCache} = ${JSON.stringify(state?.scheduleCache)}::jsonb`, sql`
    coalesce((${refreshJobStatesTable.scheduleCache}->>'leaseUntil')::timestamptz, '-infinity'::timestamptz) <= ${now.toISOString()}::timestamptz
  `)).returning({ id: refreshJobStatesTable.id });
  if (!claimed.length) return { ran: false, reason: "already-running" };
  try {
    const fetchDate = options.fetchDate ?? fetchEspnMlbForDate;
    const payloads: EspnMlbPayload[] = [];
    // At most four requests concurrently, eight daily pages per execution.
    for (let offset = 0; offset < dates.length; offset += 4) {
      payloads.push(...await Promise.all(dates.slice(offset, offset + 4).map((date) => fetchDate(date))));
    }
    return await database.transaction(async (tx) => {
      const [locked] = await tx.select().from(refreshJobStatesTable).where(mlbRefreshScope(pool)).for("update");
      if (readMlbCache(locked?.scheduleCache).leaseToken !== token) throw new Error("MLB refresh lease was superseded.");
      const count = await syncMlbEventsTx(tx, pool, payloads);
      const currentGames = await loadMlbGames(tx, pool.seasonId);
      const signature = createHash("sha256").update(JSON.stringify(currentGames
        .map((g) => ({ ...g, sourceUrl: undefined })).sort((a, b) => a.providerId.localeCompare(b.providerId)))).digest("hex");
      const next = { ...cache, covered: { ...cache.covered }, leaseToken: null, leaseUntil: null,
        retryAt: null, pollAt: new Date(now.getTime() + 5 * 60_000).toISOString(), failures: 0,
        advancementDiscovery: signature !== state?.lastGameStatusSignature && currentGames.some((g) => g.status === "final") };
      for (const payload of payloads) next.covered[payload.provenance.requestedDate] = now.toISOString();
      await tx.update(refreshJobStatesTable).set({
        scheduleCache: next, scheduleFetchedAt: now, lastSucceededAt: now,
        lastError: null, lastResult: { requestedDates: dates, gamesUpserted: count },
        lastGameStatusSignature: signature,
      }).where(mlbRefreshScope(pool));
      return { ran: true, reason: "refreshed", games: count };
    });
  } catch (error) {
    const failures = cache.failures + 1;
    const retryAt = new Date(now.getTime() + Math.min(60 * 60_000, 5 * 60_000 * 2 ** Math.min(failures - 1, 4))).toISOString();
    await database.update(refreshJobStatesTable).set({
      scheduleCache: { ...cache, failures, retryAt, leaseToken: null, leaseUntil: null },
      lastFailedAt: now, lastError: error instanceof Error ? error.message : String(error),
    }).where(and(mlbRefreshScope(pool), sql`${refreshJobStatesTable.scheduleCache}->>'leaseToken' = ${token}`));
    throw error;
  }
}
