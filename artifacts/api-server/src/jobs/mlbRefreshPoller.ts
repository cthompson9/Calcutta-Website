import { and, eq } from "drizzle-orm";
import { db, calcuttasTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { todayInNewYork } from "../lib/newYorkTime";
import { refreshMlbResults } from "../lib/mlbRefresh";

/** Independent of the NFL poller and never invokes MTM or publication. */
export function startMlbRefreshPoller(): () => void {
  let running = false, stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const today = todayInNewYork(new Date());
      const year = Number(today.slice(0, 4));
      if (today < `${year}-09-15` || today > `${year}-11-15`) return;
      const pools = await db.select().from(calcuttasTable).where(and(
        eq(calcuttasTable.sport, "MLB"), eq(calcuttasTable.competitionFormat, "MLB_POSTSEASON"),
        eq(calcuttasTable.year, year),
      ));
      for (const pool of pools) {
        try { await refreshMlbResults(pool); }
        catch (err) { logger.warn({ err, calcuttaId: pool.id }, "MLB realized results refresh failed"); }
      }
    } catch (err) { logger.warn({ err }, "MLB results poller failed"); }
    finally { running = false; }
  };
  const timer = setInterval(() => void tick(), 5 * 60_000);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
