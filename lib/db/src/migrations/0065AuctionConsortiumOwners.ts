export const auctionConsortiumOwnersMigration = {
  version: "0065_auction_consortium_owners",
  sql: `
    create table if not exists auction_consortium_owners (
      id serial primary key,
      auction_id integer not null references auction_sessions(id) on delete cascade,
      consortium_id integer not null references auction_consortia(id) on delete cascade,
      bidder_id integer not null references bidders(id),
      share numeric(5,4) not null,
      constraint auction_consortium_owners_share_check check (share > 0 and share <= 1)
    );
    create unique index if not exists auction_consortium_owners_identity_idx
      on auction_consortium_owners(auction_id, bidder_id);
    create unique index if not exists auction_consortium_owners_consortium_idx
      on auction_consortium_owners(consortium_id, bidder_id);
    create index if not exists auction_consortium_owners_consortium_order_idx
      on auction_consortium_owners(consortium_id, id);
    insert into auction_consortium_owners(auction_id, consortium_id, bidder_id, share)
      select c.auction_id, c.id, c.bidder_id, 1
      from auction_consortia c
      where c.bidder_id is not null
        and not exists (
          select 1 from auction_consortium_owners o
          where o.auction_id = c.auction_id and o.bidder_id = c.bidder_id
        );
    alter table auction_sale_allocations
      add column if not exists consortium_id integer
      references auction_consortia(id) on delete set null;
    update auction_sale_allocations a
      set consortium_id = c.id
      from auction_sales s, auction_consortia c
      where a.sale_id = s.id
        and c.auction_id = s.auction_id
        and c.bidder_id = a.bidder_id
        and a.consortium_id is null;
  `,
} as const;