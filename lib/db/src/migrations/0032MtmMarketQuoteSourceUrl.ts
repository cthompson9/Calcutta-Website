export const mtmMarketQuoteSourceUrlMigration = {
  version: "0032_mtm_market_quote_source_url",
  sql: `
    alter table mtm_market_quote
      add column if not exists source_url text;
  `,
} as const;