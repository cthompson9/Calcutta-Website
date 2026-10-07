import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { SQL, is, getTableName } from 'drizzle-orm';
import * as schema from '@workspace/db';
import { mlbEventIdentityMigration } from '../../../../lib/db/src/migrations/0066MlbEventIdentity.ts';
import { MLB_RULE_NAMES, parseMlbRules } from './mlbRealizedScoring.ts';
import { mlbDiscoveryDates, emptyMlbCache } from './mlbRefresh.ts';

export const now = new Date('2026-10-05T20:00:00Z');
export const pool = {id:13,seasonId:1,year:2026,sport:'MLB',competitionFormat:'MLB_POSTSEASON',name:'Calcutta XIII'};
export const ruleRows = MLB_RULE_NAMES.map((ruleName,index)=>({
  ruleName, value: [1,3,5,2,5,4,10,8,10][index], active:true,ruleType:'points',
}));
export const rules = parseMlbRules(ruleRows);
export const ids = Array.from({length:12},(_,i)=>i+1);
const bestOf = {wild_card:3,division_series:5,league_championship:7,world_series:7};
const code = {wild_card:'ALWC',division_series:'ALDS',league_championship:'ALCS',world_series:'WS'};

export function series(round, home, away, winners = [], scheduled = 0) {
  return Array.from({length:Math.max(winners.length,scheduled)},(_,i)=>{
    const gameNumber=i+1, winner=winners[i];
    return {providerId:`${round}:${home}:${away}:${gameNumber}`,
      seriesKey:`${round}:${[home,away].sort((a,b)=>a-b).join(':')}`,round,gameNumber,
      homeTeamId:home,awayTeamId:away,homeName:`Team ${home}`,awayName:`Team ${away}`,
      scheduledAt:'2026-10-05T17:00:00Z',status:winner ? 'final' : 'scheduled',
      homeScore:winner ? winner===home ? 5 : 1 : null,awayScore:winner ? winner===away ? 5 : 1 : null,
      sourceUrl:'https://site.api.espn.com/test-fixture'};
  });
}
export const wcGames = [
  ...series('wild_card',1,2,[1,2,1]), ...series('wild_card',3,4,[3,3]),
  ...series('wild_card',5,6,[5,5]), ...series('wild_card',7,8,[7,7]),
];
export const referenceGames = [...wcGames,
  ...series('division_series',9,1,[],1), ...series('division_series',10,3,[],1),
  ...series('division_series',11,5,[],1), ...series('division_series',12,7,[],1)];
export const terminalGames = [...wcGames,
  ...series('division_series',9,1,[9,9,9]), ...series('division_series',10,3,[10,10,10]),
  ...series('division_series',11,5,[11,11,11]), ...series('division_series',12,7,[12,12,12]),
  ...series('league_championship',9,10,[9,9,9,9]), ...series('league_championship',11,12,[11,11,11,11]),
  ...series('world_series',9,11,[9,9,9,9])];

export function payload(games, requestedDate='20261005') {
  return {provenance:{requestedDate,fetchedAt:now.toISOString(),sourceUrl:`https://site.api.espn.com/test?dates=${requestedDate}`},
    events:games.map(g=>({
      id:g.providerId,date:g.scheduledAt,season:{year:2026,type:3},
      competitions:[{notes:[{headline:`${code[g.round]} - Game ${g.gameNumber}`}],
        series:{totalCompetitions:bestOf[g.round]}, status:{type:{
          name:g.status==='final'?'STATUS_FINAL':g.status==='suspended'?'STATUS_SUSPENDED':'STATUS_SCHEDULED',
          state:g.status==='final'?'post':g.status==='suspended'?'in':'pre',completed:g.status==='final'}},
        competitors:[
          {homeAway:'home',team:{id:String(g.homeTeamId),displayName:g.homeName},
            ...(g.status==='final'?{score:String(g.homeScore),winner:g.homeScore>g.awayScore}:{})},
          {homeAway:'away',team:{id:String(g.awayTeamId),displayName:g.awayName},
            ...(g.status==='final'?{score:String(g.awayScore),winner:g.awayScore>g.homeScore}:{})},
        ]}]}))};
}

export async function fixture(t,{migrate=true}={}) {
  const pg = new PGlite(); await pg.waitReady; t.after(()=>pg.close());
  const db = drizzle(pg), dialect=new PgDialect();
  const tableNames=['seasonsTable','teamsTable','biddersTable','calcuttasTable','calcuttaEntriesTable',
    'calcuttaRulesTable','positionsTable','tradesTable','eventsTable','refreshJobStatesTable',
    'auctionSessionsTable','auctionConsortiaTable','auctionConsortiumOwnersTable','calcuttaCalendarsTable',
    'calendarParticipantsTable','calendarRoundsTable','calendarSlotsTable','calendarSlotCandidatesTable',
    'calendarSeriesTable','calendarGamesTable','calendarContingentGamesTable'];
  const configs = tableNames.map(name=>getTableConfig(schema[name]));
  for(const config of configs) {
    const columns=config.columns.map(c=>{
      let def='';
      if(is(c.default,SQL))def=` DEFAULT ${dialect.sqlToQuery(c.default).sql}`;
      else if(c.default!==undefined)def=` DEFAULT '${(typeof c.default==='object'?JSON.stringify(c.default):String(c.default)).replaceAll("'","''")}'`;
      return `"${c.name}" ${c.getSQLType()}${c.primary?' PRIMARY KEY':''}${c.notNull?' NOT NULL':''}${def}`;
    });
    await pg.exec(`CREATE TABLE "${config.name}" (${columns.join(',')});`);
    for(const check of config.checks) await pg.exec(`ALTER TABLE "${config.name}" ADD CONSTRAINT "${check.name}" CHECK (${dialect.sqlToQuery(check.value).sql});`);
    for(const index of config.indexes) {
      const c=index.config;
      const columns=c.columns.map(column=>`"${column.name}"`).join(',');
      const legacyMatchup = c.name===schema.NON_MLB_EVENT_MATCHUP_INDEX;
      const name=legacyMatchup?'events_season_scope_week_matchup_idx':c.name;
      const where=c.where && !legacyMatchup?` WHERE ${dialect.sqlToQuery(c.where).sql}`:'';
      await pg.exec(`CREATE ${c.unique?'UNIQUE ':''}INDEX "${name}" ON "${config.name}" (${columns})${where};`);
    }
  }
  const included=new Set(configs.map(c=>c.name));
  for(const config of configs) for(const fk of config.foreignKeys) {
    const ref=fk.reference(), foreignName=getTableName(ref.foreignTable);
    if(included.has(foreignName)) await pg.exec(`ALTER TABLE "${config.name}" ADD CONSTRAINT "${fk.getName()}" FOREIGN KEY (${ref.columns.map(c=>`"${c.name}"`).join(',')}) REFERENCES "${foreignName}" (${ref.foreignColumns.map(c=>`"${c.name}"`).join(',')});`);
  }
  if(migrate) await pg.exec(mlbEventIdentityMigration.sql);
  await db.insert(schema.seasonsTable).values({id:1,year:2026,label:'2026 fixture'});
  await db.insert(schema.teamsTable).values([
    ...ids.map(id=>({id,name:`Team ${id}`,sport:'MLB',conference:'AL',division:'Postseason'})),
    {id:101,name:'NFL fixture',sport:'NFL',conference:'AFC',division:'East'},
    {id:102,name:'NFL other',sport:'NFL',conference:'AFC',division:'East'},
  ]);
  await db.insert(schema.biddersTable).values([{id:201,name:'Buyer A'},{id:202,name:'Buyer B'},{id:203,name:'NFL Buyer'}]);
  await db.insert(schema.calcuttasTable).values([
    {...pool,isCanonical:false},{id:12,seasonId:1,year:2026,name:'Calcutta XII',sport:'NFL',competitionFormat:'NFL_REGULAR_SEASON',isCanonical:true},
  ]);
  await db.insert(schema.calcuttaEntriesTable).values([
    ...ids.map(id=>({id,calcuttaId:13,teamId:id})),{id:101,calcuttaId:12,teamId:101},
  ]);
  await db.insert(schema.calcuttaRulesTable).values([
    ...ruleRows.map(r=>({...r,value:String(r.value),calcuttaId:13})),
    {calcuttaId:12,ruleName:'normalization_denominator',value:'11420',active:true},
  ]);
  await db.insert(schema.positionsTable).values([
    ...ids.filter(id=>id!==9).map(id=>({entryId:id,bidderId:202,ownershipShare:'1.0000',costBasis:'1995.0000',source:'primary'})),
    {entryId:9,bidderId:201,ownershipShare:'.3333',costBasis:'664.9335',source:'primary'},
    {entryId:9,bidderId:202,ownershipShare:'.6667',costBasis:'1330.0665',source:'primary'},
    {entryId:101,bidderId:203,ownershipShare:'1.0000',costBasis:'999.0000',source:'primary'},
  ]);
  await db.insert(schema.eventsTable).values({seasonId:1,sport:'NFL',competition:'NFL_REGULAR_SEASON',source:'espn',sourceEventId:'NFL-event',
    week:1,eventDate:'2026-09-01',homeTeamId:101,awayTeamId:102,status:'final',homeScore:21,awayScore:7});
  await db.insert(schema.auctionSessionsTable).values({id:13,calcuttaId:13});
  await db.insert(schema.auctionConsortiaTable).values({id:1,auctionId:13,displayName:'Alpha'});
  await db.insert(schema.auctionConsortiumOwnersTable).values([
    {auctionId:13,consortiumId:1,bidderId:201,share:'.3333'},
    {auctionId:13,consortiumId:1,bidderId:202,share:'.6667'},
  ]);
  return {db,pg,schema};
}

export async function markCovered(f,at=now) {
  const cache={...emptyMlbCache(),covered:Object.fromEntries(mlbDiscoveryDates(2026,at).map(d=>[d,at.toISOString()]))};
  await f.db.insert(schema.refreshJobStatesTable).values({
    seasonId:1,sport:'MLB',competition:'MLB_POSTSEASON',job:'realized:13',scheduleCache:cache,
    lastSucceededAt:at,lastAttemptedAt:at,
  }).onConflictDoUpdate({target:[schema.refreshJobStatesTable.seasonId,schema.refreshJobStatesTable.sport,schema.refreshJobStatesTable.competition,schema.refreshJobStatesTable.job],
    set:{scheduleCache:cache,lastSucceededAt:at,lastAttemptedAt:at}});
}
