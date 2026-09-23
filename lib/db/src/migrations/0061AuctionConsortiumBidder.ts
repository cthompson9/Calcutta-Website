export const auctionConsortiumBidderMigration = {
  version: "0061_auction_consortium_bidder",
  sql: `
    do $guard$
    begin
      if exists (
        select auction_id, bidder_id from auction_consortia
        where bidder_id is not null group by auction_id, bidder_id having count(*) > 1
      ) then raise exception 'duplicate auction consortium bidder mappings must be resolved before 0061'; end if;
    end $guard$;
    create unique index if not exists auction_consortia_bidder_idx
      on auction_consortia(auction_id, bidder_id) where bidder_id is not null;
  `,
} as const;