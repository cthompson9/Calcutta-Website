import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const parsedDatabaseUrl = new URL(databaseUrl);
const baselineRef = process.env.SCHEMA_CHECK_BASE_REF;
const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
if (!baselineRef) {
  throw new Error("SCHEMA_CHECK_BASE_REF is required");
}
if (
  process.env.SCHEMA_CHECK_DISPOSABLE !== "1" ||
  !localHosts.has(parsedDatabaseUrl.hostname) ||
  parsedDatabaseUrl.pathname !== "/calcutta_schema_check"
) {
  throw new Error(
    "Refusing schema drift check: use the local calcutta_schema_check database with SCHEMA_CHECK_DISPOSABLE=1",
  );
}

function runCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  return (result.stdout ?? "").trim();
}

const repositoryRoot = runCommand("git", ["rev-parse", "--show-toplevel"]);

const stripAnsi = (value: string): string =>
  value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");

function runDrizzlePush(
  label: string,
  options: { bootstrap?: boolean; configPath?: string } = {},
): { output: string; status: number | null; signal: NodeJS.Signals | null } {
  const args = [
    "--filter",
    "@workspace/db",
    "exec",
    "drizzle-kit",
    "push",
    "--config",
    options.configPath ?? join(repositoryRoot, "lib/db/drizzle.config.ts"),
  ];
  if (options.bootstrap) {
    args.push("--force");
  } else {
    args.push("--verbose");
  }

  const result = spawnSync("pnpm", args, {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
    input: "",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });
  const output = stripAnsi(`${result.stdout ?? ""}${result.stderr ?? ""}`);

  console.log(`\n--- ${label} ---`);
  process.stdout.write(output);

  if (result.error) {
    throw result.error;
  }
  return { output, status: result.status, signal: result.signal };
}

function assertEmptyNonInteractivePush(
  label: string,
  result: ReturnType<typeof runDrizzlePush>,
): void {
  assert.equal(
    result.signal,
    null,
    `${label} was terminated by ${result.signal ?? "an unknown signal"}`,
  );
  assert.equal(result.status, 0, `${label} exited with status ${result.status}`);

  const ddl =
    /(?:^|\n)\s*(?:create|alter|drop|truncate|comment\s+on|grant|revoke)\b/im;
  const promptOrDestructiveWarning =
    /\b(?:are you sure|do you want to|proceed with|confirmation|data loss|about to (?:delete|drop|truncate)|will be (?:deleted|dropped|truncated)|truncate table|drop table|drop column)\b/i;

  assert.match(
    result.output,
    /\bNo changes detected\b/,
    `${label} did not confirm an empty schema diff`,
  );
  assert.doesNotMatch(
    result.output,
    /\b(?:ReferenceError|TypeError|SyntaxError|Error):/,
    `${label} reported an execution error`,
  );
  assert.doesNotMatch(result.output, ddl, `${label} emitted DDL`);
  assert.doesNotMatch(
    result.output,
    promptOrDestructiveWarning,
    `${label} emitted a prompt or destructive warning`,
  );
}

const fixtureSql = `
  -- These final-schema indexes are owned by migration 0014 and intentionally
  -- absent at the start of the ordered migration path.
  drop index if exists mtm_entry_date_idx;
  drop index if exists mtm_entry_key_idx;
  alter table snapshot_metrics
    drop constraint if exists snapshot_metrics_calcutta_id_calcuttas_id_fk;
  alter table trades
    drop constraint if exists trades_entry_id_fkey;
  alter table trades
    drop constraint if exists trades_entry_id_calcutta_entries_id_fk;

  create table team_bidders (
    team_id integer not null references teams(id) on delete cascade,
    bidder_id integer not null references bidders(id) on delete cascade,
    season_id integer not null references seasons(id) on delete cascade,
    ownership_share numeric(5, 4) not null default 1.0000,
    constraint team_bidders_pkey primary key (team_id, bidder_id, season_id),
    constraint team_bidders_ownership_share_range
      check (ownership_share > 0 and ownership_share <= 1)
  );

  insert into seasons (year, is_active, is_complete, label)
  values
    (2025, false, true, '2025 schema check'),
    (2026, true, false, '2026 schema check');

  insert into teams (name, conference, division)
  values ('Schema Check Team', 'AFC', 'East');

  insert into bidders (name)
  values ('Schema Check Bidder');

  insert into calcuttas (
    season_id,
    name,
    year,
    sport,
    competition_format,
    status,
    is_canonical
  )
  select
    id,
    year::text || ' Schema Check Calcutta',
    year,
    'NFL',
    'NFL_REGULAR_SEASON',
    case when year = 2025 then 'complete' else 'active' end,
    true
  from seasons;

  insert into calcutta_entries (calcutta_id, team_id)
  select c.id, t.id
  from calcuttas c
  cross join teams t;

  insert into positions (
    entry_id,
    bidder_id,
    ownership_share,
    source,
    cost_basis
  )
  select ce.id, b.id, 1.000000, 'primary', 100.00
  from calcutta_entries ce
  cross join bidders b;

  insert into team_bidders (
    team_id,
    bidder_id,
    season_id,
    ownership_share
  )
  select ce.team_id, p.bidder_id, c.season_id, p.ownership_share
  from positions p
  inner join calcutta_entries ce on ce.id = p.entry_id
  inner join calcuttas c on c.id = ce.calcutta_id
  where p.source = 'primary';
`;

const expectedMigrationObjects = [
  "constraint:consortium_memberships_no_overlap",
  "trigger:normalized_positions_net_one",
  "trigger:positions_entry_ownership_total",
  "trigger:positions_primary_approved_trade_immutable",
  "trigger:trades_populate_entry_id",
  "view:team_bidders",
  "view:v_entry_results",
  "view:v_owner_results",
  "view:v_tracking",
];

async function assertMigrationObjects(pool: InstanceType<typeof Pool>, label: string) {
  const result = await pool.query<{ object_name: string }>(`
    select 'constraint:' || c.conname as object_name
    from pg_constraint c
    inner join pg_class r on r.oid = c.conrelid
    inner join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'public'
      and c.contype = 'x'
      and c.conname = 'consortium_memberships_no_overlap'

    union all

    select 'trigger:' || t.tgname
    from pg_trigger t
    inner join pg_class r on r.oid = t.tgrelid
    inner join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'public'
      and not t.tgisinternal
      and t.tgname in (
        'normalized_positions_net_one',
        'positions_entry_ownership_total',
        'positions_primary_approved_trade_immutable',
        'trades_populate_entry_id'
      )

    union all

    select 'view:' || c.relname
    from pg_class c
    inner join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'v'
      and c.relname in (
        'team_bidders',
        'v_entry_results',
        'v_owner_results',
        'v_tracking'
      )

    order by object_name
  `);

  assert.deepEqual(
    result.rows.map((row) => row.object_name),
    expectedMigrationObjects,
    `${label}: migration-owned database objects changed`,
  );
}

async function main(): Promise<void> {
  const baselineWorktree = mkdtempSync(
    join(tmpdir(), "calcutta-schema-baseline-"),
  );
  try {
    runCommand("git", [
      "worktree",
      "add",
      "--detach",
      baselineWorktree,
      baselineRef!,
    ]);
    symlinkSync(
      join(repositoryRoot, "node_modules"),
      join(baselineWorktree, "node_modules"),
      "dir",
    );

    const bootstrap = runDrizzlePush("bootstrap pre-change schema", {
      bootstrap: true,
      configPath: join(baselineWorktree, "lib/db/drizzle.config.ts"),
    });
    assert.equal(bootstrap.status, 0, "schema bootstrap failed");
    assert.equal(bootstrap.signal, null, "schema bootstrap was terminated");
    assert.doesNotMatch(
      bootstrap.output,
      /\b(?:ReferenceError|TypeError|SyntaxError|Error):/,
      "schema bootstrap reported an execution error",
    );
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", baselineWorktree], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    rmSync(baselineWorktree, { recursive: true, force: true });
  }

  const fixturePool = new Pool({ connectionString: databaseUrl });
  await fixturePool.query(fixtureSql);
  await fixturePool.end();

  const databaseModule = await import("../index");
  await databaseModule.runDatabaseMigrations();
  await databaseModule.closeDatabasePool();

  const verificationPool = new Pool({ connectionString: databaseUrl });
  try {
    await assertMigrationObjects(verificationPool, "after migrations");

    const firstPush = runDrizzlePush("schema synchronization pass 1");
    await assertMigrationObjects(verificationPool, "after synchronization pass 1");

    const secondPush = runDrizzlePush("schema synchronization pass 2");
    await assertMigrationObjects(verificationPool, "after synchronization pass 2");

    assertEmptyNonInteractivePush("schema synchronization pass 1", firstPush);
    assertEmptyNonInteractivePush("schema synchronization pass 2", secondPush);
  } finally {
    await verificationPool.end();
  }

  console.log("\nSchema drift check passed twice with all migration-owned objects intact.");
}

await main();