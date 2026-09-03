export const consortiumTypoCorrectionMigration = {
  version: "0028_consortium_typo_correction_v1",
  sql: `
    do $$
    declare
      typo_id integer;
      canonical_id integer;
      typo_membership record;
    begin
      select id
        into typo_id
        from consortia
       where lower(name) = lower('Zack L. / Greg K.');

      if typo_id is null then
        return;
      end if;

      select id
        into canonical_id
        from consortia
       where lower(name) = lower('Zach L. / Greg K.');

      if canonical_id is null then
        update consortia
           set name = 'Zach L. / Greg K.'
         where id = typo_id;
        return;
      end if;

      if typo_id = canonical_id then
        return;
      end if;

      update historical_calcutta_rosters
         set consortium_id = canonical_id
       where consortium_id = typo_id;

      for typo_membership in
        select id, bidder_id, from_date, to_date
          from consortium_memberships
         where consortium_id = typo_id
      loop
        if exists (
          select 1
            from consortium_memberships canonical_membership
           where canonical_membership.consortium_id = canonical_id
             and canonical_membership.bidder_id = typo_membership.bidder_id
             and canonical_membership.from_date = typo_membership.from_date
             and canonical_membership.to_date is not distinct from typo_membership.to_date
        ) then
          delete from consortium_memberships
           where id = typo_membership.id;
        elsif exists (
          select 1
            from consortium_memberships canonical_membership
           where canonical_membership.consortium_id = canonical_id
             and canonical_membership.bidder_id = typo_membership.bidder_id
             and canonical_membership.from_date <
               coalesce(typo_membership.to_date, '9999-12-31'::date)
             and typo_membership.from_date <
               coalesce(canonical_membership.to_date, '9999-12-31'::date)
        ) then
          raise exception
            'Cannot merge consortium typo: overlapping membership for bidder %',
            typo_membership.bidder_id;
        else
          update consortium_memberships
             set consortium_id = canonical_id
           where id = typo_membership.id;
        end if;
      end loop;

      delete from consortia where id = typo_id;
      update consortia
         set name = 'Zach L. / Greg K.'
       where id = canonical_id;

      if exists (
        select 1
          from consortia
         where lower(name) = lower('Zack L. / Greg K.')
      ) then
        raise exception 'Consortium typo correction left the old name behind';
      end if;
    end
    $$;
  `,
} as const;