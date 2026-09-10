import test from "node:test";
import assert from "node:assert/strict";
import { calcuttaCalendarMigration } from "../migrations/0034CalcuttaCalendar";

test("0034 is guarded and installs database-boundary coupling checks", () => {
  const sql = calcuttaCalendarMigration.sql;
  assert.match(sql, /create table if not exists calcutta_calendars/);
  assert.match(sql, /create or replace function cal_validate_calendar_links/);
  assert.match(sql, /projection requires successful MTM snapshot/);
  assert.match(sql, /projection MTM pool does not match calendar/);
  assert.match(sql, /participant team is not entered in this Calcutta/);
  assert.match(sql, /unavailable projection cannot have candidates/);
  assert.match(sql, /create unique index if not exists cal_prj_slt_mtm_uq/);
});