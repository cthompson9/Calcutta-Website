export const tradeVoidingMigration = {
  version: "0010_trade_voiding",
  sql: `
    alter table trades
      drop constraint if exists trades_status_values;
    alter table trades
      add constraint trades_status_values
      check (status in ('pending', 'approved', 'rejected', 'voided'));

    alter table trades
      add column if not exists voided_at timestamptz;
    alter table trades
      add column if not exists voided_source text;
    alter table trades
      add column if not exists void_reason text;
  `,
} as const;