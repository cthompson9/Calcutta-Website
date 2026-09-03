-- Calcutta production schema baseline captured 2026-09-03 UTC after schema convergence.
-- Source: the reviewed development schema after the production backup baseline was reconciled.
-- Regenerate this file in the same PR as any intentional schema change.
-- Capture with: pg_dump --schema-only --no-owner --no-privileges.

--
-- PostgreSQL database dump
--

\restrict wQdQBHLvx0SIU4ws6cym9RR0WfECpTbbYFFmynMX9n56Hz7MU2FhUp947YnQfaN

-- Dumped from database version 16.10
-- Dumped by pg_dump version 16.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: enforce_normalized_entry_ownership_total(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_normalized_entry_ownership_total() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    declare t numeric;
    begin
      select coalesce(sum(share),0) into t from normalized_positions
        where entry_id=coalesce(new.entry_id,old.entry_id);
      if t <> 1.000000 then
        raise exception 'normalized entry % ownership must net exactly 1.000000, got %',
          coalesce(new.entry_id,old.entry_id),t using errcode='23514';
      end if;
      return null;
    end $$;


--
-- Name: enforce_positions_entry_ownership_total(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_positions_entry_ownership_total() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    declare
      checked_entry_id integer;
      signed_total numeric;
    begin
      foreach checked_entry_id in array array[
        case when tg_op in ('INSERT', 'UPDATE') then new.entry_id end,
        case when tg_op in ('DELETE', 'UPDATE') then old.entry_id end
      ]
      loop
        if checked_entry_id is null then
          continue;
        end if;

        select sum(ownership_share)
          into signed_total
        from positions
        where entry_id = checked_entry_id;

        -- Empty ledgers are allowed while an entry is being set up. Every
        -- nonempty ledger, including one with signed trade legs, must net 100%.
        if signed_total is not null and signed_total <> 1.0000::numeric then
          raise exception
            'Positions for entry % must net exactly 1.0000; received %',
            checked_entry_id, signed_total
            using errcode = '23514';
        end if;
      end loop;

      return null;
    end
    $$;


--
-- Name: populate_trade_entry_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.populate_trade_entry_id() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    declare
      canonical_calcutta_id integer;
      canonical_calcutta_count integer;
    begin
      if new.entry_id is null then
        select min(c.id), count(*)
          into canonical_calcutta_id, canonical_calcutta_count
        from calcuttas c
        where c.season_id = new.season_id
          and c.is_canonical = true
          and c.sport = 'NFL';

        if canonical_calcutta_count = 0 then
          insert into calcuttas (
            season_id, name, year, sport, competition_format, status, is_canonical
          )
          select
            s.id,
            s.year::text || ' NFL Calcutta',
            s.year,
            'NFL',
            'NFL_REGULAR_SEASON',
            'active',
            true
          from seasons s
          where s.id = new.season_id
          on conflict (name) do nothing;

          select min(c.id), count(*)
            into canonical_calcutta_id, canonical_calcutta_count
          from calcuttas c
          where c.season_id = new.season_id
            and c.is_canonical = true
            and c.sport = 'NFL';
        end if;

        if canonical_calcutta_count <> 1 then
          raise exception 'Cannot derive trade entry_id: season % has % canonical NFL Calcuttas',
            new.season_id, canonical_calcutta_count;
        end if;

        select ce.id
          into new.entry_id
        from calcutta_entries ce
        where ce.calcutta_id = canonical_calcutta_id
          and ce.team_id = new.team_id;

        if new.entry_id is null then
          insert into calcutta_entries (calcutta_id, team_id)
            values (canonical_calcutta_id, new.team_id)
            on conflict (calcutta_id, team_id) do nothing;

          select ce.id
            into new.entry_id
          from calcutta_entries ce
          where ce.calcutta_id = canonical_calcutta_id
            and ce.team_id = new.team_id;
        end if;
      end if;

      if new.entry_id is null or not exists (
        select 1
        from calcutta_entries ce
        inner join calcuttas c on c.id = ce.calcutta_id
        where ce.id = new.entry_id
          and c.season_id = new.season_id
          and ce.team_id = new.team_id
      ) then
        raise exception 'Trade entry_id must match its season_id and team_id';
      end if;

      return new;
    end
    $$;


--
-- Name: prevent_approved_trade_primary_position_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_approved_trade_primary_position_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    declare
      protected_entry_id integer;
    begin
      if tg_op = 'DELETE' then
        if old.source <> 'primary' then
          return old;
        end if;
        protected_entry_id := old.entry_id;
        if exists (
          select 1 from trades
          where entry_id = protected_entry_id and status = 'approved'
        ) then
          raise exception
            'Primary positions for entry % cannot change after an approved trade exists',
            protected_entry_id
            using errcode = '23514';
        end if;
        return old;
      end if;

      -- An UPDATE may move a primary position between entries or change its
      -- source. Protect both the source and destination ledgers in that case.
      if tg_op = 'UPDATE' and old.source = 'primary' then
        protected_entry_id := old.entry_id;
        if exists (
          select 1 from trades
          where entry_id = protected_entry_id and status = 'approved'
        ) then
          raise exception
            'Primary positions for entry % cannot change after an approved trade exists',
            protected_entry_id
            using errcode = '23514';
        end if;
      end if;

      if new.source = 'primary'
        and not (
          tg_op = 'UPDATE'
          and old.source = 'primary'
          and old.entry_id = new.entry_id
        ) then
        protected_entry_id := new.entry_id;
        if exists (
          select 1 from trades
          where entry_id = protected_entry_id and status = 'approved'
        ) then
          raise exception
            'Primary positions for entry % cannot change after an approved trade exists',
            protected_entry_id
            using errcode = '23514';
        end if;
      end if;

      return new;
    end
    $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: app_schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_schema_migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bidders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bidders (
    id integer NOT NULL,
    name text NOT NULL
);


--
-- Name: bidders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bidders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bidders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bidders_id_seq OWNED BY public.bidders.id;


--
-- Name: calcutta_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calcutta_entries (
    id integer NOT NULL,
    calcutta_id integer NOT NULL,
    team_id integer NOT NULL,
    metadata jsonb,
    realized_return numeric(10,4) DEFAULT '0'::numeric,
    realized_multiple numeric(10,7) DEFAULT '0'::numeric,
    net_return numeric(10,4) DEFAULT '0'::numeric,
    net_pct_return numeric(10,7) DEFAULT '0'::numeric,
    mark_to_market numeric(10,4) DEFAULT '0'::numeric
);


--
-- Name: calcutta_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.calcutta_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: calcutta_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.calcutta_entries_id_seq OWNED BY public.calcutta_entries.id;


--
-- Name: calcutta_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calcutta_rules (
    id integer NOT NULL,
    calcutta_id integer NOT NULL,
    rule_name text NOT NULL,
    rule_type text,
    value numeric(16,6),
    multiplier numeric(16,6),
    description text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    calculation text,
    condition text,
    CONSTRAINT calcutta_rules_multiplier_non_negative CHECK (((multiplier IS NULL) OR (multiplier >= (0)::numeric))),
    CONSTRAINT calcutta_rules_rule_name_nonempty CHECK ((length(TRIM(BOTH FROM rule_name)) > 0)),
    CONSTRAINT calcutta_rules_rule_type_supported CHECK (((rule_type IS NULL) OR (rule_type = ANY (ARRAY['points'::text, 'fixed_pct'::text, 'shared_pool'::text]))))
);


--
-- Name: calcutta_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.calcutta_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: calcutta_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.calcutta_rules_id_seq OWNED BY public.calcutta_rules.id;


--
-- Name: calcuttas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calcuttas (
    id integer NOT NULL,
    season_id integer NOT NULL,
    name text NOT NULL,
    year integer NOT NULL,
    sport text DEFAULT 'NFL'::text NOT NULL,
    is_canonical boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    as_of_date date,
    competition_format text DEFAULT 'NFL_REGULAR_SEASON'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL
);


--
-- Name: calcuttas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.calcuttas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: calcuttas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.calcuttas_id_seq OWNED BY public.calcuttas.id;


--
-- Name: competition_formats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.competition_formats (
    key text NOT NULL,
    sport text NOT NULL,
    structure text NOT NULL,
    definition jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT competition_formats_structure_check CHECK ((structure = ANY (ARRAY['league'::text, 'single_elim'::text, 'series_bracket'::text, 'group_knockout'::text])))
);


--
-- Name: consortia; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consortia (
    id integer NOT NULL,
    name text NOT NULL
);


--
-- Name: consortia_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.consortia_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: consortia_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.consortia_id_seq OWNED BY public.consortia.id;


--
-- Name: consortium_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consortium_memberships (
    id integer NOT NULL,
    bidder_id integer NOT NULL,
    consortium_id integer NOT NULL,
    from_date date NOT NULL,
    to_date date,
    CONSTRAINT consortium_memberships_date_order CHECK (((to_date IS NULL) OR (to_date > from_date)))
);


--
-- Name: consortium_memberships_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.consortium_memberships_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: consortium_memberships_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.consortium_memberships_id_seq OWNED BY public.consortium_memberships.id;


--
-- Name: event_market_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_market_snapshots (
    id integer NOT NULL,
    event_id integer NOT NULL,
    snapshot_at timestamp with time zone NOT NULL,
    source text NOT NULL,
    spread numeric(7,2),
    home_moneyline integer,
    away_moneyline integer,
    home_implied_probability numeric(8,6),
    away_implied_probability numeric(8,6),
    total numeric(7,2),
    source_data jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT event_market_snapshots_away_probability_bounds CHECK (((away_implied_probability IS NULL) OR ((away_implied_probability >= (0)::numeric) AND (away_implied_probability <= (1)::numeric)))),
    CONSTRAINT event_market_snapshots_home_probability_bounds CHECK (((home_implied_probability IS NULL) OR ((home_implied_probability >= (0)::numeric) AND (home_implied_probability <= (1)::numeric))))
);


--
-- Name: event_market_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.event_market_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: event_market_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.event_market_snapshots_id_seq OWNED BY public.event_market_snapshots.id;


--
-- Name: event_projections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_projections (
    id integer NOT NULL,
    event_id integer NOT NULL,
    snapshot_at timestamp with time zone NOT NULL,
    model_name text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    home_win_probability numeric(8,6),
    away_win_probability numeric(8,6),
    projected_home_score numeric(7,2),
    projected_away_score numeric(7,2),
    projected_point_differential numeric(7,2),
    source_data jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT event_projections_away_probability_bounds CHECK (((away_win_probability IS NULL) OR ((away_win_probability >= (0)::numeric) AND (away_win_probability <= (1)::numeric)))),
    CONSTRAINT event_projections_home_probability_bounds CHECK (((home_win_probability IS NULL) OR ((home_win_probability >= (0)::numeric) AND (home_win_probability <= (1)::numeric)))),
    CONSTRAINT event_projections_probability_pair CHECK ((((home_win_probability IS NULL) AND (away_win_probability IS NULL)) OR ((home_win_probability IS NOT NULL) AND (away_win_probability IS NOT NULL) AND (abs(((home_win_probability + away_win_probability) - (1)::numeric)) <= 0.000001))))
);


--
-- Name: event_projections_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.event_projections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: event_projections_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.event_projections_id_seq OWNED BY public.event_projections.id;


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id integer NOT NULL,
    season_id integer NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    source_event_id text NOT NULL,
    week integer NOT NULL,
    event_date date NOT NULL,
    kickoff_at timestamp with time zone,
    timezone text DEFAULT 'America/New_York'::text NOT NULL,
    away_team_id integer NOT NULL,
    home_team_id integer NOT NULL,
    venue text,
    network text,
    status text DEFAULT 'scheduled'::text NOT NULL,
    away_score integer,
    home_score integer,
    source_data jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sport text DEFAULT 'NFL'::text NOT NULL,
    competition text DEFAULT 'NFL_REGULAR_SEASON'::text NOT NULL,
    CONSTRAINT events_distinct_teams CHECK ((home_team_id <> away_team_id)),
    CONSTRAINT events_week_non_negative CHECK ((week >= 0))
);


--
-- Name: events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.events_id_seq OWNED BY public.events.id;


--
-- Name: format_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.format_periods (
    format_key text NOT NULL,
    key text NOT NULL,
    seq integer NOT NULL,
    label text NOT NULL,
    kind text DEFAULT 'regular'::text NOT NULL,
    weight numeric(10,4) DEFAULT '1'::numeric NOT NULL,
    is_scored boolean DEFAULT true NOT NULL,
    CONSTRAINT format_periods_kind_check CHECK ((kind = ANY (ARRAY['baseline'::text, 'regular'::text, 'group'::text, 'knockout'::text])))
);


--
-- Name: historical_calcutta_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.historical_calcutta_links (
    normalized_calcutta_id integer NOT NULL,
    legacy_calcutta_id integer NOT NULL,
    source_path text NOT NULL,
    source_hash text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: historical_calcutta_rosters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.historical_calcutta_rosters (
    calcutta_id integer NOT NULL,
    owner_id integer,
    bidder_id integer,
    consortium_id integer,
    source_owner_label text NOT NULL,
    source_path text NOT NULL,
    source_hash text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    id integer NOT NULL
);


--
-- Name: historical_calcutta_rosters_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.historical_calcutta_rosters_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: historical_calcutta_rosters_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.historical_calcutta_rosters_id_seq OWNED BY public.historical_calcutta_rosters.id;


--
-- Name: import_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_runs (
    id integer NOT NULL,
    season_id integer NOT NULL,
    source text NOT NULL,
    source_hash text NOT NULL,
    imported_teams integer NOT NULL,
    imported_owners integer NOT NULL,
    requested_by text NOT NULL,
    request_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: import_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.import_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: import_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.import_runs_id_seq OWNED BY public.import_runs.id;


--
-- Name: mcp_oauth_authorization_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_oauth_authorization_codes (
    code_hash text NOT NULL,
    client_id text NOT NULL,
    redirect_uri text NOT NULL,
    code_challenge text NOT NULL,
    scope text DEFAULT 'mcp'::text NOT NULL,
    resource text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mcp_oauth_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_oauth_clients (
    client_id text NOT NULL,
    redirect_uris jsonb NOT NULL,
    client_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mcp_oauth_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_oauth_tokens (
    token_hash text NOT NULL,
    token_type text NOT NULL,
    client_id text NOT NULL,
    scope text DEFAULT 'mcp'::text NOT NULL,
    resource text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_oauth_tokens_token_type_check CHECK ((token_type = ANY (ARRAY['access'::text, 'refresh'::text])))
);


--
-- Name: mtm_entry_valuation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mtm_entry_valuation (
    snapshot_id integer NOT NULL,
    entry_id integer NOT NULL,
    expected_points numeric(10,2),
    expected_share numeric(9,6),
    expected_payout numeric(12,2),
    auction_price numeric(12,2),
    mtm_multiple numeric(12,3)
);


--
-- Name: mtm_market_quote; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mtm_market_quote (
    snapshot_id integer NOT NULL,
    source text DEFAULT 'kalshi'::text NOT NULL,
    series text NOT NULL,
    market_ticker text NOT NULL,
    team text,
    strike numeric(6,2),
    yes_bid numeric(5,4),
    yes_ask numeric(5,4),
    volume integer,
    fetched_at timestamp with time zone NOT NULL,
    raw_quote jsonb
);


--
-- Name: mtm_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mtm_snapshot (
    id integer NOT NULL,
    pool_id integer NOT NULL,
    as_of timestamp with time zone NOT NULL,
    as_of_hour timestamp with time zone NOT NULL,
    trigger text NOT NULL,
    status text NOT NULL,
    method_version text NOT NULL,
    error text,
    diagnostics jsonb,
    state_json jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mtm_snapshot_status_supported CHECK ((status = ANY (ARRAY['ok'::text, 'failed'::text]))),
    CONSTRAINT mtm_snapshot_trigger_supported CHECK ((trigger = ANY (ARRAY['scheduled'::text, 'manual'::text])))
);


--
-- Name: mtm_snapshot_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mtm_snapshot_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mtm_snapshot_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mtm_snapshot_id_seq OWNED BY public.mtm_snapshot.id;


--
-- Name: mtm_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mtm_snapshots (
    id integer NOT NULL,
    team_id integer NOT NULL,
    season_id integer NOT NULL,
    week_num integer,
    snapshot_date date NOT NULL,
    mtm_value numeric(10,4) DEFAULT '0'::numeric NOT NULL,
    snapshot_key text,
    source text DEFAULT 'manual'::text NOT NULL,
    captured_at timestamp with time zone,
    market_status text,
    banked_points numeric(12,6),
    season_equity_points numeric(12,6),
    bonus_equity_points numeric(12,6),
    total_points numeric(12,6),
    normalized_share numeric(14,12),
    market_data jsonb,
    entry_id integer NOT NULL,
    CONSTRAINT mtm_snapshots_value_non_negative CHECK ((mtm_value >= (0)::numeric))
);


--
-- Name: mtm_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mtm_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mtm_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mtm_snapshots_id_seq OWNED BY public.mtm_snapshots.id;


--
-- Name: mtm_team_projection; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mtm_team_projection (
    snapshot_id integer NOT NULL,
    team text NOT NULL,
    e_wins_total numeric(6,3),
    e_remaining_wins numeric(6,3),
    p_berth numeric(5,4),
    p_divisional numeric(5,4),
    p_conf numeric(5,4),
    p_sb_berth numeric(5,4),
    p_sb_win numeric(5,4),
    e_remaining_raw_diff numeric(8,2),
    e_remaining_marquee_addon numeric(8,2),
    rating numeric(12,3)
);


--
-- Name: nfl_games; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nfl_games (
    id integer NOT NULL,
    season_id integer NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    source_game_id text NOT NULL,
    period_sequence integer NOT NULL,
    round text DEFAULT 'regular'::text NOT NULL,
    home_team_id integer NOT NULL,
    away_team_id integer NOT NULL,
    home_score integer NOT NULL,
    away_score integer NOT NULL,
    actual_kickoff_at timestamp with time zone NOT NULL,
    is_marquee boolean DEFAULT false NOT NULL,
    marquee_multiplier integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'final'::text NOT NULL,
    source_data jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: nfl_games_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.nfl_games_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: nfl_games_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.nfl_games_id_seq OWNED BY public.nfl_games.id;


--
-- Name: normalized_calcutta_owners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.normalized_calcutta_owners (
    calcutta_id integer NOT NULL,
    owner_id integer NOT NULL,
    label text NOT NULL
);


--
-- Name: normalized_calcuttas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.normalized_calcuttas (
    id integer NOT NULL,
    edition_number integer NOT NULL,
    name text NOT NULL,
    sport text NOT NULL,
    format_key text NOT NULL,
    season_year integer NOT NULL,
    pot_size numeric(14,2),
    as_of_date date,
    normalization jsonb NOT NULL,
    status text DEFAULT 'complete'::text NOT NULL
);


--
-- Name: normalized_calcuttas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.normalized_calcuttas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: normalized_calcuttas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.normalized_calcuttas_id_seq OWNED BY public.normalized_calcuttas.id;


--
-- Name: normalized_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.normalized_entries (
    id integer NOT NULL,
    calcutta_id integer NOT NULL,
    label text NOT NULL,
    lot_order integer,
    price numeric(14,2) NOT NULL,
    kind text DEFAULT 'single'::text NOT NULL,
    attributes jsonb,
    CONSTRAINT normalized_entries_kind_check CHECK ((kind = ANY (ARRAY['single'::text, 'bundle'::text, 'placeholder'::text])))
);


--
-- Name: normalized_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.normalized_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: normalized_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.normalized_entries_id_seq OWNED BY public.normalized_entries.id;


--
-- Name: normalized_entry_teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.normalized_entry_teams (
    entry_id integer NOT NULL,
    team_id integer NOT NULL,
    seed integer,
    resolved boolean DEFAULT true NOT NULL
);


--
-- Name: normalized_expected_entry_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.normalized_expected_entry_results (
    entry_id integer NOT NULL,
    points numeric(14,4),
    realized_return numeric(14,2)
);


--
-- Name: normalized_expected_owner_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.normalized_expected_owner_results (
    calcutta_id integer NOT NULL,
    owner_id integer NOT NULL,
    cost numeric(14,2),
    realized numeric(14,2)
);


--
-- Name: normalized_import_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.normalized_import_runs (
    id integer NOT NULL,
    edition_number integer NOT NULL,
    source text NOT NULL,
    source_hash text NOT NULL,
    imported_teams integer NOT NULL,
    imported_owners integer NOT NULL,
    requested_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: normalized_import_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.normalized_import_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: normalized_import_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.normalized_import_runs_id_seq OWNED BY public.normalized_import_runs.id;


--
-- Name: normalized_owners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.normalized_owners (
    id integer NOT NULL,
    display_name text NOT NULL,
    email text
);


--
-- Name: normalized_owners_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.normalized_owners_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: normalized_owners_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.normalized_owners_id_seq OWNED BY public.normalized_owners.id;


--
-- Name: normalized_positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.normalized_positions (
    id integer NOT NULL,
    entry_id integer NOT NULL,
    owner_id integer NOT NULL,
    share numeric(9,6) NOT NULL,
    source text DEFAULT 'primary'::text NOT NULL,
    trade_id integer,
    CONSTRAINT normalized_positions_source_check CHECK ((source = ANY (ARRAY['primary'::text, 'trade'::text])))
);


--
-- Name: normalized_positions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.normalized_positions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: normalized_positions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.normalized_positions_id_seq OWNED BY public.normalized_positions.id;


--
-- Name: normalized_scoring_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.normalized_scoring_events (
    id integer NOT NULL,
    entry_id integer NOT NULL,
    period_key text,
    metric text NOT NULL,
    units numeric(12,4) NOT NULL,
    source text DEFAULT 'sheet'::text NOT NULL
);


--
-- Name: normalized_scoring_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.normalized_scoring_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: normalized_scoring_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.normalized_scoring_events_id_seq OWNED BY public.normalized_scoring_events.id;


--
-- Name: normalized_scoring_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.normalized_scoring_rules (
    id integer NOT NULL,
    calcutta_id integer NOT NULL,
    kind text NOT NULL,
    metric text,
    period_key text,
    rate numeric(14,8) NOT NULL,
    group_attr text,
    fallback text[],
    note text,
    CONSTRAINT normalized_scoring_rules_kind_check CHECK ((kind = ANY (ARRAY['per_unit'::text, 'direct_share'::text, 'group_rank_bonus'::text, 'split_pool'::text])))
);


--
-- Name: normalized_scoring_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.normalized_scoring_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: normalized_scoring_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.normalized_scoring_rules_id_seq OWNED BY public.normalized_scoring_rules.id;


--
-- Name: normalized_teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.normalized_teams (
    id integer NOT NULL,
    sport text NOT NULL,
    name text NOT NULL
);


--
-- Name: normalized_teams_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.normalized_teams_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: normalized_teams_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.normalized_teams_id_seq OWNED BY public.normalized_teams.id;


--
-- Name: normalized_trades; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.normalized_trades (
    id integer NOT NULL,
    calcutta_id integer NOT NULL,
    sheet_ref text,
    trade_date date,
    detail text,
    scope text DEFAULT 'entry'::text NOT NULL,
    entry_id integer,
    from_owner_id integer,
    to_owner_id integer,
    pct numeric(9,6),
    cash numeric(14,6),
    status text DEFAULT 'approved'::text NOT NULL,
    reference_owner_id integer,
    factor numeric(9,4),
    basis text,
    source_data jsonb NOT NULL,
    CONSTRAINT normalized_trades_basis_check CHECK (((basis IS NULL) OR (basis = ANY (ARRAY['lion_king'::text, 'net'::text])))),
    CONSTRAINT normalized_trades_scope_check CHECK ((scope = ANY (ARRAY['entry'::text, 'book'::text, 'synthetic_book'::text, 'sidebet'::text, 'cash'::text]))),
    CONSTRAINT normalized_trades_scope_shape CHECK ((((scope = 'entry'::text) AND (entry_id IS NOT NULL) AND (basis IS NULL)) OR ((scope = ANY (ARRAY['book'::text, 'synthetic_book'::text])) AND (basis IS NOT NULL)) OR ((scope = ANY (ARRAY['sidebet'::text, 'cash'::text])) AND (basis IS NULL) AND (factor IS NULL))))
);


--
-- Name: normalized_trades_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.normalized_trades_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: normalized_trades_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.normalized_trades_id_seq OWNED BY public.normalized_trades.id;


--
-- Name: ownership_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ownership_adjustments (
    id integer NOT NULL,
    season_id integer NOT NULL,
    team_id integer NOT NULL,
    source text NOT NULL,
    note text,
    owners jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ownership_adjustments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ownership_adjustments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ownership_adjustments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ownership_adjustments_id_seq OWNED BY public.ownership_adjustments.id;


--
-- Name: payout_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payout_rules (
    id integer NOT NULL,
    calcutta_id integer NOT NULL,
    metric text NOT NULL,
    dollars_per_unit numeric(12,4),
    playoff_multiplier numeric(8,4),
    CONSTRAINT payout_rules_metric_supported CHECK ((metric ~ '^[a-z][a-z0-9_]*$'::text)),
    CONSTRAINT payout_rules_multiplier_non_negative CHECK (((playoff_multiplier IS NULL) OR (playoff_multiplier >= (0)::numeric)))
);


--
-- Name: payout_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payout_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payout_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payout_rules_id_seq OWNED BY public.payout_rules.id;


--
-- Name: positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.positions (
    id integer NOT NULL,
    entry_id integer NOT NULL,
    bidder_id integer NOT NULL,
    ownership_share numeric(9,6) NOT NULL,
    source text NOT NULL,
    cost_basis numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    trade_id integer,
    CONSTRAINT positions_primary_positive CHECK (((source <> 'primary'::text) OR (ownership_share > (0)::numeric))),
    CONSTRAINT positions_source_values CHECK ((source = ANY (ARRAY['primary'::text, 'trade'::text])))
);


--
-- Name: positions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.positions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: positions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.positions_id_seq OWNED BY public.positions.id;


--
-- Name: provider_team_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_team_identities (
    id integer NOT NULL,
    sport text NOT NULL,
    competition text NOT NULL,
    provider text NOT NULL,
    provider_team_id text NOT NULL,
    team_id integer NOT NULL,
    canonical_name text NOT NULL,
    aliases jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: provider_team_identities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.provider_team_identities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: provider_team_identities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.provider_team_identities_id_seq OWNED BY public.provider_team_identities.id;


--
-- Name: refresh_job_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_job_states (
    id integer NOT NULL,
    season_id integer NOT NULL,
    job text NOT NULL,
    schedule_cache jsonb,
    schedule_fetched_at timestamp with time zone,
    last_succeeded_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_game_status_signature text,
    sport text DEFAULT 'NFL'::text NOT NULL,
    competition text DEFAULT 'NFL_REGULAR_SEASON'::text NOT NULL
);


--
-- Name: refresh_job_states_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.refresh_job_states_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: refresh_job_states_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.refresh_job_states_id_seq OWNED BY public.refresh_job_states.id;


--
-- Name: seasons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seasons (
    id integer NOT NULL,
    year integer NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    is_complete boolean DEFAULT false NOT NULL,
    label text NOT NULL
);


--
-- Name: seasons_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.seasons_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: seasons_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.seasons_id_seq OWNED BY public.seasons.id;


--
-- Name: snapshot_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.snapshot_metrics (
    id integer NOT NULL,
    entry_id integer,
    period_id integer NOT NULL,
    basis text NOT NULL,
    metric text NOT NULL,
    value numeric(16,6) NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    source_data jsonb,
    snapshot_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    calcutta_id integer NOT NULL,
    CONSTRAINT snapshot_metrics_basis_supported CHECK ((basis = ANY (ARRAY['realized'::text, 'mtm'::text]))),
    CONSTRAINT snapshot_metrics_metric_supported CHECK ((metric ~ '^[a-z][a-z0-9_]*$'::text))
);


--
-- Name: snapshot_metrics_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.snapshot_metrics_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: snapshot_metrics_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.snapshot_metrics_id_seq OWNED BY public.snapshot_metrics.id;


--
-- Name: sport_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sport_periods (
    id integer NOT NULL,
    sport text NOT NULL,
    sequence integer NOT NULL,
    label text NOT NULL,
    is_playoff boolean DEFAULT false NOT NULL,
    competition text NOT NULL,
    CONSTRAINT sport_periods_competition_nonempty CHECK ((length(TRIM(BOTH FROM competition)) > 0)),
    CONSTRAINT sport_periods_sequence_non_negative CHECK ((sequence >= 0)),
    CONSTRAINT sport_periods_sport_nonempty CHECK ((length(TRIM(BOTH FROM sport)) > 0))
);


--
-- Name: sport_periods_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sport_periods_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sport_periods_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sport_periods_id_seq OWNED BY public.sport_periods.id;


--
-- Name: team_bidders; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.team_bidders AS
 SELECT ce.team_id,
    p.bidder_id,
    c.season_id,
    p.ownership_share
   FROM ((public.positions p
     JOIN public.calcutta_entries ce ON ((ce.id = p.entry_id)))
     JOIN public.calcuttas c ON ((c.id = ce.calcutta_id)))
  WHERE (p.source = 'primary'::text);


--
-- Name: team_period_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_period_snapshots (
    id integer NOT NULL,
    entry_id integer NOT NULL,
    period_id integer NOT NULL,
    basis text NOT NULL,
    wins numeric(8,4) DEFAULT '0'::numeric NOT NULL,
    losses numeric(8,4) DEFAULT '0'::numeric NOT NULL,
    ties numeric(8,4) DEFAULT '0'::numeric NOT NULL,
    pt_diff numeric(10,4) DEFAULT '0'::numeric NOT NULL,
    playoff_berth numeric(8,6) DEFAULT '0'::numeric NOT NULL,
    div_round numeric(8,6) DEFAULT '0'::numeric NOT NULL,
    conf_round numeric(8,6) DEFAULT '0'::numeric NOT NULL,
    sb_berth numeric(8,6) DEFAULT '0'::numeric NOT NULL,
    win_super_bowl numeric(8,6) DEFAULT '0'::numeric NOT NULL,
    playoff_status text DEFAULT 'unknown'::text NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    ordinary_wins numeric(8,4) DEFAULT '0'::numeric NOT NULL,
    marquee_wins numeric(8,4) DEFAULT '0'::numeric NOT NULL,
    ordinary_ties numeric(8,4) DEFAULT '0'::numeric NOT NULL,
    marquee_ties numeric(8,4) DEFAULT '0'::numeric NOT NULL,
    ordinary_pt_diff numeric(10,4) DEFAULT '0'::numeric NOT NULL,
    marquee_pt_diff numeric(10,4) DEFAULT '0'::numeric NOT NULL,
    CONSTRAINT team_period_snapshots_basis_supported CHECK ((basis = ANY (ARRAY['realized'::text, 'mtm'::text]))),
    CONSTRAINT team_period_snapshots_losses_non_negative CHECK ((losses >= (0)::numeric)),
    CONSTRAINT team_period_snapshots_playoff_bounds CHECK (((playoff_berth >= (0)::numeric) AND (playoff_berth <= (1)::numeric) AND (div_round >= (0)::numeric) AND (div_round <= (1)::numeric) AND (conf_round >= (0)::numeric) AND (conf_round <= (1)::numeric) AND (sb_berth >= (0)::numeric) AND (sb_berth <= (1)::numeric) AND (win_super_bowl >= (0)::numeric) AND (win_super_bowl <= (1)::numeric))),
    CONSTRAINT team_period_snapshots_playoff_status_supported CHECK ((playoff_status = ANY (ARRAY['unknown'::text, 'alive'::text, 'clinched'::text, 'eliminated'::text]))),
    CONSTRAINT team_period_snapshots_ties_non_negative CHECK ((ties >= (0)::numeric)),
    CONSTRAINT team_period_snapshots_wins_non_negative CHECK ((wins >= (0)::numeric))
);


--
-- Name: team_period_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.team_period_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: team_period_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.team_period_snapshots_id_seq OWNED BY public.team_period_snapshots.id;


--
-- Name: team_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_results (
    id integer NOT NULL,
    team_id integer NOT NULL,
    season_id integer NOT NULL,
    wins numeric(4,1) DEFAULT '0'::numeric NOT NULL,
    pt_diff integer DEFAULT 0 NOT NULL,
    starting_points numeric(8,4) DEFAULT '150'::numeric NOT NULL,
    draft_order integer,
    playoff_berth boolean DEFAULT false NOT NULL,
    div_round boolean DEFAULT false NOT NULL,
    conf_round boolean DEFAULT false NOT NULL,
    sb_berth boolean DEFAULT false NOT NULL,
    win_super_bowl boolean DEFAULT false NOT NULL,
    realized_return numeric(10,4) DEFAULT '0'::numeric NOT NULL,
    realized_multiple numeric(10,7) DEFAULT '0'::numeric NOT NULL,
    net_return numeric(10,4) DEFAULT '0'::numeric NOT NULL,
    net_pct_return numeric(10,7) DEFAULT '0'::numeric NOT NULL,
    mark_to_market numeric(10,4) DEFAULT '0'::numeric NOT NULL,
    seed integer,
    losses integer DEFAULT 0 NOT NULL,
    ties integer DEFAULT 0 NOT NULL,
    playoff_status text DEFAULT 'unknown'::text NOT NULL,
    CONSTRAINT team_results_losses_nonneg CHECK ((losses >= 0)),
    CONSTRAINT team_results_playoff_status_values CHECK ((playoff_status = ANY (ARRAY['unknown'::text, 'alive'::text, 'clinched'::text, 'eliminated'::text]))),
    CONSTRAINT team_results_seed_range CHECK (((seed IS NULL) OR ((seed >= 1) AND (seed <= 7)))),
    CONSTRAINT team_results_ties_nonneg CHECK ((ties >= 0)),
    CONSTRAINT team_results_wins_nonneg CHECK ((wins >= (0)::numeric))
);


--
-- Name: team_results_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.team_results_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: team_results_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.team_results_id_seq OWNED BY public.team_results.id;


--
-- Name: team_season_auctions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_season_auctions (
    team_id integer NOT NULL,
    season_id integer NOT NULL,
    bid_amount numeric(10,2) DEFAULT '0'::numeric NOT NULL,
    CONSTRAINT team_season_auctions_bid_nonneg CHECK ((bid_amount >= (0)::numeric))
);


--
-- Name: teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams (
    id integer NOT NULL,
    name text NOT NULL,
    conference text NOT NULL,
    division text NOT NULL
);


--
-- Name: teams_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.teams_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: teams_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.teams_id_seq OWNED BY public.teams.id;


--
-- Name: trades; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trades (
    id integer NOT NULL,
    season_id integer NOT NULL,
    team_id integer NOT NULL,
    from_bidder_id integer NOT NULL,
    to_bidder_id integer NOT NULL,
    price numeric(10,2) DEFAULT '0'::numeric NOT NULL,
    trade_date date NOT NULL,
    notes text,
    percentage numeric(5,2) DEFAULT '100'::numeric NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    decision_at timestamp with time zone,
    decision_source text,
    voided_at timestamp with time zone,
    voided_source text,
    void_reason text,
    entry_id integer NOT NULL,
    CONSTRAINT trades_percentage_range CHECK (((percentage >= (1)::numeric) AND (percentage <= (100)::numeric))),
    CONSTRAINT trades_price_nonneg CHECK ((price >= (0)::numeric)),
    CONSTRAINT trades_seller_ne_buyer CHECK ((from_bidder_id <> to_bidder_id)),
    CONSTRAINT trades_status_values CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'voided'::text])))
);


--
-- Name: trades_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trades_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trades_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trades_id_seq OWNED BY public.trades.id;


--
-- Name: v_tracking; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_tracking AS
 SELECT s.entry_id,
        CASE
            WHEN (s.metric = 'banked_points'::text) THEN 2147483647
            ELSE p.seq
        END AS seq,
        CASE
            WHEN ((s.metric = 'advance'::text) AND (s.period_key = 'R32'::text)) THEN 'Advanced to Round of 32'::text
            WHEN ((s.metric = 'advance'::text) AND (s.period_key = 'S16'::text)) THEN 'Advanced to Sweet 16'::text
            WHEN ((s.metric = 'advance'::text) AND (s.period_key = 'E8'::text)) THEN 'Advanced to Elite 8'::text
            WHEN ((s.metric = 'advance'::text) AND (s.period_key = 'F4'::text)) THEN 'Advanced to Final Four'::text
            WHEN ((s.metric = 'advance'::text) AND (s.period_key = ANY (ARRAY['CHAMP'::text, 'NCG'::text]))) THEN 'Reached the Championship'::text
            WHEN ((s.metric = 'advance'::text) AND (s.period_key = 'TITLE'::text)) THEN 'Won the Championship'::text
            WHEN (s.metric ~~ 'upset_%plus'::text) THEN ((('Upset by '::text || replace(replace(s.metric, 'upset_'::text, ''::text), 'plus'::text, ''::text)) || '+ seeds x'::text) || TRIM(BOTH FROM to_char(s.units, 'FM999990'::text)))
            WHEN ((s.metric = 'win'::text) AND (s.period_key = 'GROUP'::text)) THEN (('Group stage: '::text || TRIM(BOTH FROM to_char(s.units, 'FM999990'::text))) || ' win(s)'::text)
            WHEN ((s.metric = 'tie'::text) AND (s.period_key = 'GROUP'::text)) THEN (('Group stage: '::text || TRIM(BOTH FROM to_char(s.units, 'FM999990'::text))) || ' draw(s)'::text)
            WHEN ((s.metric = 'loss'::text) AND (s.period_key = 'GROUP'::text)) THEN (('Group stage: '::text || TRIM(BOTH FROM to_char(s.units, 'FM999990'::text))) || ' loss(es)'::text)
            WHEN (s.metric = 'top_table'::text) THEN 'Won its group'::text
            WHEN (s.metric = 'knockouts'::text) THEN 'Advanced to the knockout round'::text
            WHEN ((s.metric = 'win'::text) AND (s.period_key IS NOT NULL) AND (s.period_key <> 'GROUP'::text)) THEN ('Won in the '::text || COALESCE(p.label, s.period_key))
            WHEN (s.metric = 'shootout_loss'::text) THEN ('Lost on penalties in the '::text || COALESCE(p.label, s.period_key))
            WHEN (s.metric = 'game_win'::text) THEN (((COALESCE(p.label, s.period_key) || ': '::text) || TRIM(BOTH FROM to_char(s.units, 'FM999990'::text))) || ' game(s) won'::text)
            WHEN (s.metric = 'sweep'::text) THEN ('Swept a series x'::text || TRIM(BOTH FROM to_char(s.units, 'FM999990'::text)))
            WHEN (s.metric = 'upset_series_win'::text) THEN ('Won a series as the lower seed x'::text || TRIM(BOTH FROM to_char(s.units, 'FM999990'::text)))
            WHEN (s.metric = 'banked_points'::text) THEN 'Banked opening points'::text
            WHEN (s.metric = 'reg_season_win'::text) THEN (TRIM(BOTH FROM to_char(s.units, 'FM999990'::text)) || ' regular-season win(s)'::text)
            WHEN (s.metric = 'tie'::text) THEN (TRIM(BOTH FROM to_char(s.units, 'FM999990'::text)) || ' tie(s)'::text)
            WHEN (s.metric = ANY (ARRAY['adj_point_differential'::text, 'pt_diff'::text])) THEN ('Point differential '::text || TRIM(BOTH FROM to_char(s.units, 'SFM999990'::text)))
            WHEN (s.metric = 'pt_diff_rank_bonus'::text) THEN 'Point-differential rank bonus'::text
            WHEN (s.metric = 'win_20plus'::text) THEN (TRIM(BOTH FROM to_char(s.units, 'FM999990'::text)) || ' win(s) by 20+'::text)
            WHEN (s.metric = 'weekly_big_winner'::text) THEN ('Weekly big winner x'::text || TRIM(BOTH FROM to_char(s.units, 'FM999990'::text)))
            WHEN (s.metric = 'reg_season_big_win'::text) THEN 'Regular-season big win'::text
            WHEN (s.metric = 'playoff_berth'::text) THEN 'Made the playoffs'::text
            WHEN (s.metric = 'div_round'::text) THEN 'Reached the divisional round'::text
            WHEN (s.metric = 'conf_round'::text) THEN 'Reached the conference championship'::text
            WHEN (s.metric = 'sb_berth'::text) THEN 'Reached the Super Bowl'::text
            WHEN (s.metric = 'win_super_bowl'::text) THEN 'Won the Super Bowl'::text
            ELSE ((s.metric || ' x'::text) || TRIM(BOTH FROM to_char(s.units, 'FM999990.99'::text)))
        END AS phrase
   FROM (((public.normalized_scoring_events s
     JOIN public.normalized_entries e ON ((e.id = s.entry_id)))
     JOIN public.normalized_calcuttas c ON ((c.id = e.calcutta_id)))
     LEFT JOIN public.format_periods p ON (((p.format_key = c.format_key) AND (p.key = s.period_key))));


--
-- Name: v_entry_results; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_entry_results AS
 SELECT c.edition_number AS ed,
    c.name AS calcutta,
    c.sport,
    e.label AS lot,
    e.kind,
    (e.attributes ->> 'seed'::text) AS seed,
    COALESCE((e.attributes ->> 'region'::text), (e.attributes ->> 'group'::text), (e.attributes ->> 'division'::text)) AS "grouping",
    e.price,
    ( SELECT string_agg((((o.display_name || ' '::text) || TRIM(BOTH FROM to_char((p.share * (100)::numeric), 'FM999990.0'::text))) || '%'::text), ', '::text ORDER BY p.share DESC, o.display_name) AS string_agg
           FROM (public.normalized_positions p
             JOIN public.normalized_owners o ON ((o.id = p.owner_id)))
          WHERE ((p.entry_id = e.id) AND (p.source = 'primary'::text))) AS ownership,
    ( SELECT string_agg(t.phrase, ' · '::text ORDER BY t.seq, t.phrase) AS string_agg
           FROM public.v_tracking t
          WHERE (t.entry_id = e.id)) AS tracking,
    x.points,
    x.realized_return AS payout
   FROM ((public.normalized_entries e
     JOIN public.normalized_calcuttas c ON ((c.id = e.calcutta_id)))
     LEFT JOIN public.normalized_expected_entry_results x ON ((x.entry_id = e.id)));


--
-- Name: v_owner_results; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_owner_results AS
 SELECT c.edition_number AS ed,
    c.name AS calcutta,
    c.sport,
    o.display_name AS owner,
    round(sum(p.share), 4) AS lots,
    round(sum((p.share * e.price)), 2) AS cost,
    round(sum((p.share * x.realized_return)), 2) AS payout
   FROM ((((public.normalized_positions p
     JOIN public.normalized_entries e ON ((e.id = p.entry_id)))
     JOIN public.normalized_calcuttas c ON ((c.id = e.calcutta_id)))
     JOIN public.normalized_owners o ON ((o.id = p.owner_id)))
     LEFT JOIN public.normalized_expected_entry_results x ON ((x.entry_id = e.id)))
  WHERE (p.source = 'primary'::text)
  GROUP BY c.edition_number, c.name, c.sport, o.display_name
  ORDER BY c.edition_number, (round(sum((p.share * x.realized_return)), 2)) DESC NULLS LAST;


--
-- Name: bidders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidders ALTER COLUMN id SET DEFAULT nextval('public.bidders_id_seq'::regclass);


--
-- Name: calcutta_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calcutta_entries ALTER COLUMN id SET DEFAULT nextval('public.calcutta_entries_id_seq'::regclass);


--
-- Name: calcutta_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calcutta_rules ALTER COLUMN id SET DEFAULT nextval('public.calcutta_rules_id_seq'::regclass);


--
-- Name: calcuttas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calcuttas ALTER COLUMN id SET DEFAULT nextval('public.calcuttas_id_seq'::regclass);


--
-- Name: consortia id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consortia ALTER COLUMN id SET DEFAULT nextval('public.consortia_id_seq'::regclass);


--
-- Name: consortium_memberships id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consortium_memberships ALTER COLUMN id SET DEFAULT nextval('public.consortium_memberships_id_seq'::regclass);


--
-- Name: event_market_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_market_snapshots ALTER COLUMN id SET DEFAULT nextval('public.event_market_snapshots_id_seq'::regclass);


--
-- Name: event_projections id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_projections ALTER COLUMN id SET DEFAULT nextval('public.event_projections_id_seq'::regclass);


--
-- Name: events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events ALTER COLUMN id SET DEFAULT nextval('public.events_id_seq'::regclass);


--
-- Name: historical_calcutta_rosters id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_calcutta_rosters ALTER COLUMN id SET DEFAULT nextval('public.historical_calcutta_rosters_id_seq'::regclass);


--
-- Name: import_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_runs ALTER COLUMN id SET DEFAULT nextval('public.import_runs_id_seq'::regclass);


--
-- Name: mtm_snapshot id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mtm_snapshot ALTER COLUMN id SET DEFAULT nextval('public.mtm_snapshot_id_seq'::regclass);


--
-- Name: mtm_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mtm_snapshots ALTER COLUMN id SET DEFAULT nextval('public.mtm_snapshots_id_seq'::regclass);


--
-- Name: nfl_games id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nfl_games ALTER COLUMN id SET DEFAULT nextval('public.nfl_games_id_seq'::regclass);


--
-- Name: normalized_calcuttas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_calcuttas ALTER COLUMN id SET DEFAULT nextval('public.normalized_calcuttas_id_seq'::regclass);


--
-- Name: normalized_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_entries ALTER COLUMN id SET DEFAULT nextval('public.normalized_entries_id_seq'::regclass);


--
-- Name: normalized_import_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_import_runs ALTER COLUMN id SET DEFAULT nextval('public.normalized_import_runs_id_seq'::regclass);


--
-- Name: normalized_owners id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_owners ALTER COLUMN id SET DEFAULT nextval('public.normalized_owners_id_seq'::regclass);


--
-- Name: normalized_positions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_positions ALTER COLUMN id SET DEFAULT nextval('public.normalized_positions_id_seq'::regclass);


--
-- Name: normalized_scoring_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_scoring_events ALTER COLUMN id SET DEFAULT nextval('public.normalized_scoring_events_id_seq'::regclass);


--
-- Name: normalized_scoring_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_scoring_rules ALTER COLUMN id SET DEFAULT nextval('public.normalized_scoring_rules_id_seq'::regclass);


--
-- Name: normalized_teams id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_teams ALTER COLUMN id SET DEFAULT nextval('public.normalized_teams_id_seq'::regclass);


--
-- Name: normalized_trades id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_trades ALTER COLUMN id SET DEFAULT nextval('public.normalized_trades_id_seq'::regclass);


--
-- Name: ownership_adjustments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ownership_adjustments ALTER COLUMN id SET DEFAULT nextval('public.ownership_adjustments_id_seq'::regclass);


--
-- Name: payout_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payout_rules ALTER COLUMN id SET DEFAULT nextval('public.payout_rules_id_seq'::regclass);


--
-- Name: positions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions ALTER COLUMN id SET DEFAULT nextval('public.positions_id_seq'::regclass);


--
-- Name: provider_team_identities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_team_identities ALTER COLUMN id SET DEFAULT nextval('public.provider_team_identities_id_seq'::regclass);


--
-- Name: refresh_job_states id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_job_states ALTER COLUMN id SET DEFAULT nextval('public.refresh_job_states_id_seq'::regclass);


--
-- Name: seasons id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seasons ALTER COLUMN id SET DEFAULT nextval('public.seasons_id_seq'::regclass);


--
-- Name: snapshot_metrics id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshot_metrics ALTER COLUMN id SET DEFAULT nextval('public.snapshot_metrics_id_seq'::regclass);


--
-- Name: sport_periods id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sport_periods ALTER COLUMN id SET DEFAULT nextval('public.sport_periods_id_seq'::regclass);


--
-- Name: team_period_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_period_snapshots ALTER COLUMN id SET DEFAULT nextval('public.team_period_snapshots_id_seq'::regclass);


--
-- Name: team_results id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_results ALTER COLUMN id SET DEFAULT nextval('public.team_results_id_seq'::regclass);


--
-- Name: teams id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams ALTER COLUMN id SET DEFAULT nextval('public.teams_id_seq'::regclass);


--
-- Name: trades id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trades ALTER COLUMN id SET DEFAULT nextval('public.trades_id_seq'::regclass);


--
-- Name: app_schema_migrations app_schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_schema_migrations
    ADD CONSTRAINT app_schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: bidders bidders_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidders
    ADD CONSTRAINT bidders_name_unique UNIQUE (name);


--
-- Name: bidders bidders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidders
    ADD CONSTRAINT bidders_pkey PRIMARY KEY (id);


--
-- Name: calcutta_entries calcutta_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calcutta_entries
    ADD CONSTRAINT calcutta_entries_pkey PRIMARY KEY (id);


--
-- Name: calcutta_rules calcutta_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calcutta_rules
    ADD CONSTRAINT calcutta_rules_pkey PRIMARY KEY (id);


--
-- Name: calcuttas calcuttas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calcuttas
    ADD CONSTRAINT calcuttas_pkey PRIMARY KEY (id);


--
-- Name: competition_formats competition_formats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_formats
    ADD CONSTRAINT competition_formats_pkey PRIMARY KEY (key);


--
-- Name: consortia consortia_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consortia
    ADD CONSTRAINT consortia_pkey PRIMARY KEY (id);


--
-- Name: consortium_memberships consortium_memberships_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consortium_memberships
    ADD CONSTRAINT consortium_memberships_no_overlap EXCLUDE USING gist (bidder_id WITH =, daterange(from_date, COALESCE(to_date, 'infinity'::date), '[)'::text) WITH &&);


--
-- Name: consortium_memberships consortium_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consortium_memberships
    ADD CONSTRAINT consortium_memberships_pkey PRIMARY KEY (id);


--
-- Name: event_market_snapshots event_market_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_market_snapshots
    ADD CONSTRAINT event_market_snapshots_pkey PRIMARY KEY (id);


--
-- Name: event_projections event_projections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_projections
    ADD CONSTRAINT event_projections_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: format_periods format_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.format_periods
    ADD CONSTRAINT format_periods_pkey PRIMARY KEY (format_key, key);


--
-- Name: historical_calcutta_links historical_calcutta_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_calcutta_links
    ADD CONSTRAINT historical_calcutta_links_pkey PRIMARY KEY (normalized_calcutta_id);


--
-- Name: historical_calcutta_rosters historical_calcutta_rosters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_calcutta_rosters
    ADD CONSTRAINT historical_calcutta_rosters_pkey PRIMARY KEY (id);


--
-- Name: import_runs import_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_pkey PRIMARY KEY (id);


--
-- Name: mcp_oauth_authorization_codes mcp_oauth_authorization_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_authorization_codes
    ADD CONSTRAINT mcp_oauth_authorization_codes_pkey PRIMARY KEY (code_hash);


--
-- Name: mcp_oauth_clients mcp_oauth_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_clients
    ADD CONSTRAINT mcp_oauth_clients_pkey PRIMARY KEY (client_id);


--
-- Name: mcp_oauth_tokens mcp_oauth_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_tokens
    ADD CONSTRAINT mcp_oauth_tokens_pkey PRIMARY KEY (token_hash);


--
-- Name: mtm_snapshot mtm_snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mtm_snapshot
    ADD CONSTRAINT mtm_snapshot_pkey PRIMARY KEY (id);


--
-- Name: mtm_snapshots mtm_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mtm_snapshots
    ADD CONSTRAINT mtm_snapshots_pkey PRIMARY KEY (id);


--
-- Name: nfl_games nfl_games_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nfl_games
    ADD CONSTRAINT nfl_games_pkey PRIMARY KEY (id);


--
-- Name: normalized_calcutta_owners normalized_calcutta_owners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_calcutta_owners
    ADD CONSTRAINT normalized_calcutta_owners_pkey PRIMARY KEY (calcutta_id, owner_id);


--
-- Name: normalized_calcuttas normalized_calcuttas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_calcuttas
    ADD CONSTRAINT normalized_calcuttas_pkey PRIMARY KEY (id);


--
-- Name: normalized_entries normalized_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_entries
    ADD CONSTRAINT normalized_entries_pkey PRIMARY KEY (id);


--
-- Name: normalized_entry_teams normalized_entry_teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_entry_teams
    ADD CONSTRAINT normalized_entry_teams_pkey PRIMARY KEY (entry_id, team_id);


--
-- Name: normalized_expected_entry_results normalized_expected_entry_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_expected_entry_results
    ADD CONSTRAINT normalized_expected_entry_results_pkey PRIMARY KEY (entry_id);


--
-- Name: normalized_expected_owner_results normalized_expected_owner_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_expected_owner_results
    ADD CONSTRAINT normalized_expected_owner_results_pkey PRIMARY KEY (calcutta_id, owner_id);


--
-- Name: normalized_import_runs normalized_import_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_import_runs
    ADD CONSTRAINT normalized_import_runs_pkey PRIMARY KEY (id);


--
-- Name: normalized_owners normalized_owners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_owners
    ADD CONSTRAINT normalized_owners_pkey PRIMARY KEY (id);


--
-- Name: normalized_positions normalized_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_positions
    ADD CONSTRAINT normalized_positions_pkey PRIMARY KEY (id);


--
-- Name: normalized_scoring_events normalized_scoring_events_entry_period_metric_idx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_scoring_events
    ADD CONSTRAINT normalized_scoring_events_entry_period_metric_idx UNIQUE NULLS NOT DISTINCT (entry_id, period_key, metric);


--
-- Name: normalized_scoring_events normalized_scoring_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_scoring_events
    ADD CONSTRAINT normalized_scoring_events_pkey PRIMARY KEY (id);


--
-- Name: normalized_scoring_rules normalized_scoring_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_scoring_rules
    ADD CONSTRAINT normalized_scoring_rules_pkey PRIMARY KEY (id);


--
-- Name: normalized_teams normalized_teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_teams
    ADD CONSTRAINT normalized_teams_pkey PRIMARY KEY (id);


--
-- Name: normalized_trades normalized_trades_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_trades
    ADD CONSTRAINT normalized_trades_pkey PRIMARY KEY (id);


--
-- Name: ownership_adjustments ownership_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ownership_adjustments
    ADD CONSTRAINT ownership_adjustments_pkey PRIMARY KEY (id);


--
-- Name: payout_rules payout_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payout_rules
    ADD CONSTRAINT payout_rules_pkey PRIMARY KEY (id);


--
-- Name: positions positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT positions_pkey PRIMARY KEY (id);


--
-- Name: provider_team_identities provider_team_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_team_identities
    ADD CONSTRAINT provider_team_identities_pkey PRIMARY KEY (id);


--
-- Name: refresh_job_states refresh_job_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_job_states
    ADD CONSTRAINT refresh_job_states_pkey PRIMARY KEY (id);


--
-- Name: seasons seasons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seasons
    ADD CONSTRAINT seasons_pkey PRIMARY KEY (id);


--
-- Name: seasons seasons_year_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seasons
    ADD CONSTRAINT seasons_year_unique UNIQUE (year);


--
-- Name: snapshot_metrics snapshot_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshot_metrics
    ADD CONSTRAINT snapshot_metrics_pkey PRIMARY KEY (id);


--
-- Name: sport_periods sport_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sport_periods
    ADD CONSTRAINT sport_periods_pkey PRIMARY KEY (id);


--
-- Name: team_period_snapshots team_period_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_period_snapshots
    ADD CONSTRAINT team_period_snapshots_pkey PRIMARY KEY (id);


--
-- Name: team_results team_results_team_id_season_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_results
    ADD CONSTRAINT team_results_team_id_season_id_pk PRIMARY KEY (team_id, season_id);


--
-- Name: team_season_auctions team_season_auctions_team_id_season_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_season_auctions
    ADD CONSTRAINT team_season_auctions_team_id_season_id_pk PRIMARY KEY (team_id, season_id);


--
-- Name: teams teams_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_name_unique UNIQUE (name);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);


--
-- Name: trades trades_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trades
    ADD CONSTRAINT trades_pkey PRIMARY KEY (id);


--
-- Name: calcutta_entries_calcutta_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX calcutta_entries_calcutta_team_idx ON public.calcutta_entries USING btree (calcutta_id, team_id);


--
-- Name: calcutta_entries_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calcutta_entries_team_idx ON public.calcutta_entries USING btree (team_id);


--
-- Name: calcutta_rules_calcutta_rule_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX calcutta_rules_calcutta_rule_idx ON public.calcutta_rules USING btree (calcutta_id, rule_name);


--
-- Name: calcuttas_canonical_season_sport_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX calcuttas_canonical_season_sport_idx ON public.calcuttas USING btree (season_id, sport) WHERE (is_canonical = true);


--
-- Name: calcuttas_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX calcuttas_name_idx ON public.calcuttas USING btree (name);


--
-- Name: calcuttas_season_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX calcuttas_season_idx ON public.calcuttas USING btree (season_id);


--
-- Name: consortia_name_lower_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX consortia_name_lower_unique ON public.consortia USING btree (lower(name));


--
-- Name: consortium_memberships_bidder_dates_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX consortium_memberships_bidder_dates_idx ON public.consortium_memberships USING btree (bidder_id, from_date, to_date);


--
-- Name: consortium_memberships_consortium_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX consortium_memberships_consortium_idx ON public.consortium_memberships USING btree (consortium_id);


--
-- Name: consortium_memberships_exact_interval_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX consortium_memberships_exact_interval_idx ON public.consortium_memberships USING btree (bidder_id, consortium_id, from_date);


--
-- Name: consortium_memberships_one_active_bidder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX consortium_memberships_one_active_bidder_idx ON public.consortium_memberships USING btree (bidder_id) WHERE (to_date IS NULL);


--
-- Name: event_market_snapshots_event_source_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX event_market_snapshots_event_source_time_idx ON public.event_market_snapshots USING btree (event_id, source, snapshot_at);


--
-- Name: event_market_snapshots_event_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_market_snapshots_event_time_idx ON public.event_market_snapshots USING btree (event_id, snapshot_at);


--
-- Name: event_projections_event_model_source_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX event_projections_event_model_source_time_idx ON public.event_projections USING btree (event_id, model_name, source, snapshot_at);


--
-- Name: event_projections_event_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_projections_event_time_idx ON public.event_projections USING btree (event_id, snapshot_at);


--
-- Name: events_away_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_away_team_idx ON public.events USING btree (away_team_id);


--
-- Name: events_home_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_home_team_idx ON public.events USING btree (home_team_id);


--
-- Name: events_season_scope_source_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX events_season_scope_source_event_idx ON public.events USING btree (season_id, sport, competition, source, source_event_id);


--
-- Name: events_season_scope_week_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_season_scope_week_idx ON public.events USING btree (season_id, sport, competition, week);


--
-- Name: events_season_scope_week_matchup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX events_season_scope_week_matchup_idx ON public.events USING btree (season_id, sport, competition, week, away_team_id, home_team_id);


--
-- Name: format_periods_format_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX format_periods_format_seq_idx ON public.format_periods USING btree (format_key, seq);


--
-- Name: historical_calcutta_links_legacy_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX historical_calcutta_links_legacy_idx ON public.historical_calcutta_links USING btree (legacy_calcutta_id);


--
-- Name: historical_calcutta_rosters_bidder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX historical_calcutta_rosters_bidder_idx ON public.historical_calcutta_rosters USING btree (calcutta_id, bidder_id);


--
-- Name: historical_calcutta_rosters_consortium_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX historical_calcutta_rosters_consortium_idx ON public.historical_calcutta_rosters USING btree (consortium_id);


--
-- Name: historical_calcutta_rosters_pool_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX historical_calcutta_rosters_pool_owner_idx ON public.historical_calcutta_rosters USING btree (calcutta_id, owner_id) WHERE (owner_id IS NOT NULL);


--
-- Name: historical_calcutta_rosters_source_label_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX historical_calcutta_rosters_source_label_idx ON public.historical_calcutta_rosters USING btree (calcutta_id, source_owner_label);


--
-- Name: import_runs_season_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_runs_season_created_idx ON public.import_runs USING btree (season_id, created_at);


--
-- Name: import_runs_season_source_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX import_runs_season_source_hash_idx ON public.import_runs USING btree (season_id, source, source_hash);


--
-- Name: mcp_oauth_codes_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_oauth_codes_client_idx ON public.mcp_oauth_authorization_codes USING btree (client_id);


--
-- Name: mcp_oauth_codes_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_oauth_codes_expires_idx ON public.mcp_oauth_authorization_codes USING btree (expires_at);


--
-- Name: mcp_oauth_tokens_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_oauth_tokens_client_idx ON public.mcp_oauth_tokens USING btree (client_id);


--
-- Name: mcp_oauth_tokens_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_oauth_tokens_expires_idx ON public.mcp_oauth_tokens USING btree (expires_at);


--
-- Name: mtm_entry_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mtm_entry_date_idx ON public.mtm_snapshots USING btree (entry_id, snapshot_date);


--
-- Name: mtm_entry_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mtm_entry_key_idx ON public.mtm_snapshots USING btree (entry_id, snapshot_key) WHERE (snapshot_key IS NOT NULL);


--
-- Name: mtm_entry_valuation_snapshot_entry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mtm_entry_valuation_snapshot_entry_idx ON public.mtm_entry_valuation USING btree (snapshot_id, entry_id);


--
-- Name: mtm_market_quote_snapshot_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mtm_market_quote_snapshot_idx ON public.mtm_market_quote USING btree (snapshot_id);


--
-- Name: mtm_market_quote_snapshot_ticker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mtm_market_quote_snapshot_ticker_idx ON public.mtm_market_quote USING btree (snapshot_id, market_ticker);


--
-- Name: mtm_snapshot_pool_as_of_hour_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mtm_snapshot_pool_as_of_hour_idx ON public.mtm_snapshot USING btree (pool_id, as_of_hour);


--
-- Name: mtm_snapshot_pool_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mtm_snapshot_pool_created_idx ON public.mtm_snapshot USING btree (pool_id, created_at);


--
-- Name: mtm_snapshots_entry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mtm_snapshots_entry_idx ON public.mtm_snapshots USING btree (entry_id);


--
-- Name: mtm_snapshots_season_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mtm_snapshots_season_idx ON public.mtm_snapshots USING btree (season_id);


--
-- Name: mtm_team_projection_snapshot_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mtm_team_projection_snapshot_team_idx ON public.mtm_team_projection USING btree (snapshot_id, team);


--
-- Name: nfl_games_away_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nfl_games_away_team_idx ON public.nfl_games USING btree (away_team_id);


--
-- Name: nfl_games_home_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nfl_games_home_team_idx ON public.nfl_games USING btree (home_team_id);


--
-- Name: nfl_games_season_period_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nfl_games_season_period_idx ON public.nfl_games USING btree (season_id, period_sequence);


--
-- Name: nfl_games_season_source_game_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX nfl_games_season_source_game_idx ON public.nfl_games USING btree (season_id, source, source_game_id);


--
-- Name: normalized_calcutta_owners_label_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX normalized_calcutta_owners_label_idx ON public.normalized_calcutta_owners USING btree (calcutta_id, label);


--
-- Name: normalized_calcuttas_edition_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX normalized_calcuttas_edition_idx ON public.normalized_calcuttas USING btree (edition_number);


--
-- Name: normalized_calcuttas_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX normalized_calcuttas_name_idx ON public.normalized_calcuttas USING btree (name);


--
-- Name: normalized_entries_calcutta_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX normalized_entries_calcutta_idx ON public.normalized_entries USING btree (calcutta_id);


--
-- Name: normalized_entries_calcutta_label_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX normalized_entries_calcutta_label_idx ON public.normalized_entries USING btree (calcutta_id, label);


--
-- Name: normalized_import_runs_edition_source_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX normalized_import_runs_edition_source_hash_idx ON public.normalized_import_runs USING btree (edition_number, source, source_hash);


--
-- Name: normalized_owners_display_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX normalized_owners_display_name_idx ON public.normalized_owners USING btree (display_name);


--
-- Name: normalized_positions_entry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX normalized_positions_entry_idx ON public.normalized_positions USING btree (entry_id);


--
-- Name: normalized_scoring_events_entry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX normalized_scoring_events_entry_idx ON public.normalized_scoring_events USING btree (entry_id);


--
-- Name: normalized_scoring_rules_calcutta_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX normalized_scoring_rules_calcutta_idx ON public.normalized_scoring_rules USING btree (calcutta_id);


--
-- Name: normalized_teams_sport_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX normalized_teams_sport_name_idx ON public.normalized_teams USING btree (sport, name);


--
-- Name: normalized_trades_calcutta_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX normalized_trades_calcutta_idx ON public.normalized_trades USING btree (calcutta_id);


--
-- Name: normalized_trades_entry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX normalized_trades_entry_idx ON public.normalized_trades USING btree (entry_id);


--
-- Name: payout_rules_calcutta_metric_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payout_rules_calcutta_metric_idx ON public.payout_rules USING btree (calcutta_id, metric);


--
-- Name: positions_bidder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX positions_bidder_idx ON public.positions USING btree (bidder_id);


--
-- Name: positions_entry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX positions_entry_idx ON public.positions USING btree (entry_id);


--
-- Name: positions_primary_entry_bidder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX positions_primary_entry_bidder_idx ON public.positions USING btree (entry_id, bidder_id) WHERE (source = 'primary'::text);


--
-- Name: positions_source_trade_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX positions_source_trade_idx ON public.positions USING btree (entry_id, bidder_id, source, trade_id);


--
-- Name: positions_trade_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX positions_trade_idx ON public.positions USING btree (trade_id);


--
-- Name: provider_team_identities_scope_provider_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX provider_team_identities_scope_provider_id_idx ON public.provider_team_identities USING btree (sport, competition, provider, provider_team_id);


--
-- Name: provider_team_identities_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_team_identities_team_idx ON public.provider_team_identities USING btree (team_id);


--
-- Name: refresh_job_states_season_scope_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX refresh_job_states_season_scope_job_idx ON public.refresh_job_states USING btree (season_id, sport, competition, job);


--
-- Name: snapshot_metrics_calcutta_entry_period_basis_metric_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX snapshot_metrics_calcutta_entry_period_basis_metric_idx ON public.snapshot_metrics USING btree (calcutta_id, entry_id, period_id, basis, metric) WHERE (entry_id IS NOT NULL);


--
-- Name: snapshot_metrics_calcutta_period_basis_metric_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX snapshot_metrics_calcutta_period_basis_metric_idx ON public.snapshot_metrics USING btree (calcutta_id, period_id, basis, metric) WHERE (entry_id IS NULL);


--
-- Name: snapshot_metrics_entry_basis_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX snapshot_metrics_entry_basis_idx ON public.snapshot_metrics USING btree (entry_id, basis);


--
-- Name: snapshot_metrics_period_basis_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX snapshot_metrics_period_basis_idx ON public.snapshot_metrics USING btree (period_id, basis);


--
-- Name: sport_periods_competition_sequence_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sport_periods_competition_sequence_idx ON public.sport_periods USING btree (sport, competition, sequence);


--
-- Name: team_period_snapshots_entry_period_basis_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_period_snapshots_entry_period_basis_idx ON public.team_period_snapshots USING btree (entry_id, period_id, basis);


--
-- Name: team_results_season_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_results_season_idx ON public.team_results USING btree (season_id);


--
-- Name: team_season_auctions_season_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_season_auctions_season_idx ON public.team_season_auctions USING btree (season_id);


--
-- Name: trades_entry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trades_entry_idx ON public.trades USING btree (entry_id);


--
-- Name: trades_season_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trades_season_idx ON public.trades USING btree (season_id);


--
-- Name: trades_season_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trades_season_team_idx ON public.trades USING btree (season_id, team_id);


--
-- Name: trades_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trades_status_idx ON public.trades USING btree (status);


--
-- Name: normalized_positions normalized_positions_net_one; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER normalized_positions_net_one AFTER INSERT OR DELETE OR UPDATE ON public.normalized_positions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_normalized_entry_ownership_total();


--
-- Name: positions positions_entry_ownership_total; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER positions_entry_ownership_total AFTER INSERT OR DELETE OR UPDATE ON public.positions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_positions_entry_ownership_total();


--
-- Name: positions positions_primary_approved_trade_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER positions_primary_approved_trade_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.positions FOR EACH ROW EXECUTE FUNCTION public.prevent_approved_trade_primary_position_change();


--
-- Name: trades trades_populate_entry_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trades_populate_entry_id BEFORE INSERT OR UPDATE OF season_id, team_id, entry_id ON public.trades FOR EACH ROW EXECUTE FUNCTION public.populate_trade_entry_id();


--
-- Name: calcutta_entries calcutta_entries_calcutta_id_calcuttas_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calcutta_entries
    ADD CONSTRAINT calcutta_entries_calcutta_id_calcuttas_id_fk FOREIGN KEY (calcutta_id) REFERENCES public.calcuttas(id) ON DELETE CASCADE;


--
-- Name: calcutta_entries calcutta_entries_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calcutta_entries
    ADD CONSTRAINT calcutta_entries_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: calcutta_rules calcutta_rules_calcutta_id_calcuttas_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calcutta_rules
    ADD CONSTRAINT calcutta_rules_calcutta_id_calcuttas_id_fk FOREIGN KEY (calcutta_id) REFERENCES public.calcuttas(id) ON DELETE CASCADE;


--
-- Name: calcuttas calcuttas_season_id_seasons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calcuttas
    ADD CONSTRAINT calcuttas_season_id_seasons_id_fk FOREIGN KEY (season_id) REFERENCES public.seasons(id) ON DELETE CASCADE;


--
-- Name: consortium_memberships consortium_memberships_bidder_id_bidders_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consortium_memberships
    ADD CONSTRAINT consortium_memberships_bidder_id_bidders_id_fk FOREIGN KEY (bidder_id) REFERENCES public.bidders(id) ON DELETE CASCADE;


--
-- Name: consortium_memberships consortium_memberships_consortium_id_consortia_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consortium_memberships
    ADD CONSTRAINT consortium_memberships_consortium_id_consortia_id_fk FOREIGN KEY (consortium_id) REFERENCES public.consortia(id) ON DELETE CASCADE;


--
-- Name: event_market_snapshots event_market_snapshots_event_id_events_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_market_snapshots
    ADD CONSTRAINT event_market_snapshots_event_id_events_id_fk FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: event_projections event_projections_event_id_events_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_projections
    ADD CONSTRAINT event_projections_event_id_events_id_fk FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: events events_away_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_away_team_id_teams_id_fk FOREIGN KEY (away_team_id) REFERENCES public.teams(id);


--
-- Name: events events_home_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_home_team_id_teams_id_fk FOREIGN KEY (home_team_id) REFERENCES public.teams(id);


--
-- Name: events events_season_id_seasons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_season_id_seasons_id_fk FOREIGN KEY (season_id) REFERENCES public.seasons(id) ON DELETE CASCADE;


--
-- Name: format_periods format_periods_format_key_competition_formats_key_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.format_periods
    ADD CONSTRAINT format_periods_format_key_competition_formats_key_fk FOREIGN KEY (format_key) REFERENCES public.competition_formats(key) ON DELETE CASCADE;


--
-- Name: historical_calcutta_links historical_calcutta_links_legacy_calcutta_id_calcuttas_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_calcutta_links
    ADD CONSTRAINT historical_calcutta_links_legacy_calcutta_id_calcuttas_id_fk FOREIGN KEY (legacy_calcutta_id) REFERENCES public.calcuttas(id) ON DELETE RESTRICT;


--
-- Name: historical_calcutta_rosters historical_calcutta_rosters_bidder_id_bidders_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_calcutta_rosters
    ADD CONSTRAINT historical_calcutta_rosters_bidder_id_bidders_id_fk FOREIGN KEY (bidder_id) REFERENCES public.bidders(id) ON DELETE SET NULL;


--
-- Name: historical_calcutta_rosters historical_calcutta_rosters_consortium_id_consortia_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_calcutta_rosters
    ADD CONSTRAINT historical_calcutta_rosters_consortium_id_consortia_id_fk FOREIGN KEY (consortium_id) REFERENCES public.consortia(id) ON DELETE RESTRICT;


--
-- Name: historical_calcutta_rosters historical_calcutta_rosters_owner_id_normalized_owners_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_calcutta_rosters
    ADD CONSTRAINT historical_calcutta_rosters_owner_id_normalized_owners_id_fk FOREIGN KEY (owner_id) REFERENCES public.normalized_owners(id);


--
-- Name: historical_calcutta_rosters historical_calcutta_rosters_pool_owner_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_calcutta_rosters
    ADD CONSTRAINT historical_calcutta_rosters_pool_owner_fkey FOREIGN KEY (calcutta_id, owner_id) REFERENCES public.normalized_calcutta_owners(calcutta_id, owner_id) ON DELETE CASCADE;


--
-- Name: historical_calcutta_links historical_links_normalized_calcutta_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_calcutta_links
    ADD CONSTRAINT historical_links_normalized_calcutta_fk FOREIGN KEY (normalized_calcutta_id) REFERENCES public.normalized_calcuttas(id) ON DELETE CASCADE;


--
-- Name: historical_calcutta_rosters historical_rosters_calcutta_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_calcutta_rosters
    ADD CONSTRAINT historical_rosters_calcutta_fk FOREIGN KEY (calcutta_id) REFERENCES public.normalized_calcuttas(id) ON DELETE CASCADE;


--
-- Name: import_runs import_runs_season_id_seasons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_season_id_seasons_id_fk FOREIGN KEY (season_id) REFERENCES public.seasons(id);


--
-- Name: mcp_oauth_authorization_codes mcp_oauth_codes_client_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_authorization_codes
    ADD CONSTRAINT mcp_oauth_codes_client_fk FOREIGN KEY (client_id) REFERENCES public.mcp_oauth_clients(client_id) ON DELETE CASCADE;


--
-- Name: mcp_oauth_tokens mcp_oauth_tokens_client_id_mcp_oauth_clients_client_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_tokens
    ADD CONSTRAINT mcp_oauth_tokens_client_id_mcp_oauth_clients_client_id_fk FOREIGN KEY (client_id) REFERENCES public.mcp_oauth_clients(client_id) ON DELETE CASCADE;


--
-- Name: mtm_entry_valuation mtm_entry_valuation_entry_id_calcutta_entries_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mtm_entry_valuation
    ADD CONSTRAINT mtm_entry_valuation_entry_id_calcutta_entries_id_fk FOREIGN KEY (entry_id) REFERENCES public.calcutta_entries(id) ON DELETE CASCADE;


--
-- Name: mtm_entry_valuation mtm_entry_valuation_snapshot_id_mtm_snapshot_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mtm_entry_valuation
    ADD CONSTRAINT mtm_entry_valuation_snapshot_id_mtm_snapshot_id_fk FOREIGN KEY (snapshot_id) REFERENCES public.mtm_snapshot(id) ON DELETE CASCADE;


--
-- Name: mtm_market_quote mtm_market_quote_snapshot_id_mtm_snapshot_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mtm_market_quote
    ADD CONSTRAINT mtm_market_quote_snapshot_id_mtm_snapshot_id_fk FOREIGN KEY (snapshot_id) REFERENCES public.mtm_snapshot(id) ON DELETE CASCADE;


--
-- Name: mtm_snapshot mtm_snapshot_pool_id_calcuttas_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mtm_snapshot
    ADD CONSTRAINT mtm_snapshot_pool_id_calcuttas_id_fk FOREIGN KEY (pool_id) REFERENCES public.calcuttas(id) ON DELETE CASCADE;


--
-- Name: mtm_snapshots mtm_snapshots_entry_id_calcutta_entries_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mtm_snapshots
    ADD CONSTRAINT mtm_snapshots_entry_id_calcutta_entries_id_fk FOREIGN KEY (entry_id) REFERENCES public.calcutta_entries(id) ON DELETE CASCADE;


--
-- Name: mtm_snapshots mtm_snapshots_season_id_seasons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mtm_snapshots
    ADD CONSTRAINT mtm_snapshots_season_id_seasons_id_fk FOREIGN KEY (season_id) REFERENCES public.seasons(id) ON DELETE CASCADE;


--
-- Name: mtm_snapshots mtm_snapshots_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mtm_snapshots
    ADD CONSTRAINT mtm_snapshots_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: mtm_team_projection mtm_team_projection_snapshot_id_mtm_snapshot_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mtm_team_projection
    ADD CONSTRAINT mtm_team_projection_snapshot_id_mtm_snapshot_id_fk FOREIGN KEY (snapshot_id) REFERENCES public.mtm_snapshot(id) ON DELETE CASCADE;


--
-- Name: nfl_games nfl_games_away_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nfl_games
    ADD CONSTRAINT nfl_games_away_team_id_teams_id_fk FOREIGN KEY (away_team_id) REFERENCES public.teams(id);


--
-- Name: nfl_games nfl_games_home_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nfl_games
    ADD CONSTRAINT nfl_games_home_team_id_teams_id_fk FOREIGN KEY (home_team_id) REFERENCES public.teams(id);


--
-- Name: nfl_games nfl_games_season_id_seasons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nfl_games
    ADD CONSTRAINT nfl_games_season_id_seasons_id_fk FOREIGN KEY (season_id) REFERENCES public.seasons(id) ON DELETE CASCADE;


--
-- Name: normalized_calcutta_owners normalized_calcutta_owners_calcutta_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_calcutta_owners
    ADD CONSTRAINT normalized_calcutta_owners_calcutta_fk FOREIGN KEY (calcutta_id) REFERENCES public.normalized_calcuttas(id) ON DELETE CASCADE;


--
-- Name: normalized_calcutta_owners normalized_calcutta_owners_owner_id_normalized_owners_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_calcutta_owners
    ADD CONSTRAINT normalized_calcutta_owners_owner_id_normalized_owners_id_fk FOREIGN KEY (owner_id) REFERENCES public.normalized_owners(id);


--
-- Name: normalized_calcuttas normalized_calcuttas_format_key_competition_formats_key_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_calcuttas
    ADD CONSTRAINT normalized_calcuttas_format_key_competition_formats_key_fk FOREIGN KEY (format_key) REFERENCES public.competition_formats(key);


--
-- Name: normalized_entries normalized_entries_calcutta_id_normalized_calcuttas_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_entries
    ADD CONSTRAINT normalized_entries_calcutta_id_normalized_calcuttas_id_fk FOREIGN KEY (calcutta_id) REFERENCES public.normalized_calcuttas(id) ON DELETE CASCADE;


--
-- Name: normalized_entry_teams normalized_entry_teams_entry_id_normalized_entries_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_entry_teams
    ADD CONSTRAINT normalized_entry_teams_entry_id_normalized_entries_id_fk FOREIGN KEY (entry_id) REFERENCES public.normalized_entries(id) ON DELETE CASCADE;


--
-- Name: normalized_entry_teams normalized_entry_teams_team_id_normalized_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_entry_teams
    ADD CONSTRAINT normalized_entry_teams_team_id_normalized_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.normalized_teams(id);


--
-- Name: normalized_expected_entry_results normalized_expected_entry_results_entry_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_expected_entry_results
    ADD CONSTRAINT normalized_expected_entry_results_entry_fk FOREIGN KEY (entry_id) REFERENCES public.normalized_entries(id) ON DELETE CASCADE;


--
-- Name: normalized_expected_owner_results normalized_expected_owner_results_calcutta_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_expected_owner_results
    ADD CONSTRAINT normalized_expected_owner_results_calcutta_fk FOREIGN KEY (calcutta_id) REFERENCES public.normalized_calcuttas(id) ON DELETE CASCADE;


--
-- Name: normalized_expected_owner_results normalized_expected_owner_results_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_expected_owner_results
    ADD CONSTRAINT normalized_expected_owner_results_owner_fk FOREIGN KEY (owner_id) REFERENCES public.normalized_owners(id);


--
-- Name: normalized_positions normalized_positions_entry_id_normalized_entries_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_positions
    ADD CONSTRAINT normalized_positions_entry_id_normalized_entries_id_fk FOREIGN KEY (entry_id) REFERENCES public.normalized_entries(id) ON DELETE CASCADE;


--
-- Name: normalized_positions normalized_positions_owner_id_normalized_owners_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_positions
    ADD CONSTRAINT normalized_positions_owner_id_normalized_owners_id_fk FOREIGN KEY (owner_id) REFERENCES public.normalized_owners(id);


--
-- Name: normalized_scoring_events normalized_scoring_events_entry_id_normalized_entries_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_scoring_events
    ADD CONSTRAINT normalized_scoring_events_entry_id_normalized_entries_id_fk FOREIGN KEY (entry_id) REFERENCES public.normalized_entries(id) ON DELETE CASCADE;


--
-- Name: normalized_scoring_rules normalized_scoring_rules_calcutta_id_normalized_calcuttas_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_scoring_rules
    ADD CONSTRAINT normalized_scoring_rules_calcutta_id_normalized_calcuttas_id_fk FOREIGN KEY (calcutta_id) REFERENCES public.normalized_calcuttas(id) ON DELETE CASCADE;


--
-- Name: normalized_trades normalized_trades_calcutta_id_normalized_calcuttas_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_trades
    ADD CONSTRAINT normalized_trades_calcutta_id_normalized_calcuttas_id_fk FOREIGN KEY (calcutta_id) REFERENCES public.normalized_calcuttas(id) ON DELETE CASCADE;


--
-- Name: normalized_trades normalized_trades_entry_id_normalized_entries_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_trades
    ADD CONSTRAINT normalized_trades_entry_id_normalized_entries_id_fk FOREIGN KEY (entry_id) REFERENCES public.normalized_entries(id);


--
-- Name: normalized_trades normalized_trades_from_owner_id_normalized_owners_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_trades
    ADD CONSTRAINT normalized_trades_from_owner_id_normalized_owners_id_fk FOREIGN KEY (from_owner_id) REFERENCES public.normalized_owners(id);


--
-- Name: normalized_trades normalized_trades_reference_owner_id_normalized_owners_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_trades
    ADD CONSTRAINT normalized_trades_reference_owner_id_normalized_owners_id_fk FOREIGN KEY (reference_owner_id) REFERENCES public.normalized_owners(id);


--
-- Name: normalized_trades normalized_trades_to_owner_id_normalized_owners_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.normalized_trades
    ADD CONSTRAINT normalized_trades_to_owner_id_normalized_owners_id_fk FOREIGN KEY (to_owner_id) REFERENCES public.normalized_owners(id);


--
-- Name: ownership_adjustments ownership_adjustments_season_id_seasons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ownership_adjustments
    ADD CONSTRAINT ownership_adjustments_season_id_seasons_id_fk FOREIGN KEY (season_id) REFERENCES public.seasons(id) ON DELETE CASCADE;


--
-- Name: ownership_adjustments ownership_adjustments_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ownership_adjustments
    ADD CONSTRAINT ownership_adjustments_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: payout_rules payout_rules_calcutta_id_calcuttas_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payout_rules
    ADD CONSTRAINT payout_rules_calcutta_id_calcuttas_id_fk FOREIGN KEY (calcutta_id) REFERENCES public.calcuttas(id) ON DELETE CASCADE;


--
-- Name: positions positions_bidder_id_bidders_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT positions_bidder_id_bidders_id_fk FOREIGN KEY (bidder_id) REFERENCES public.bidders(id) ON DELETE CASCADE;


--
-- Name: positions positions_entry_id_calcutta_entries_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT positions_entry_id_calcutta_entries_id_fk FOREIGN KEY (entry_id) REFERENCES public.calcutta_entries(id) ON DELETE CASCADE;


--
-- Name: positions positions_trade_id_trades_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT positions_trade_id_trades_id_fk FOREIGN KEY (trade_id) REFERENCES public.trades(id) ON DELETE CASCADE;


--
-- Name: provider_team_identities provider_team_identities_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_team_identities
    ADD CONSTRAINT provider_team_identities_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: refresh_job_states refresh_job_states_season_id_seasons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_job_states
    ADD CONSTRAINT refresh_job_states_season_id_seasons_id_fk FOREIGN KEY (season_id) REFERENCES public.seasons(id) ON DELETE CASCADE;


--
-- Name: snapshot_metrics snapshot_metrics_calcutta_id_calcuttas_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshot_metrics
    ADD CONSTRAINT snapshot_metrics_calcutta_id_calcuttas_id_fk FOREIGN KEY (calcutta_id) REFERENCES public.calcuttas(id) ON DELETE CASCADE;


--
-- Name: snapshot_metrics snapshot_metrics_entry_id_calcutta_entries_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshot_metrics
    ADD CONSTRAINT snapshot_metrics_entry_id_calcutta_entries_id_fk FOREIGN KEY (entry_id) REFERENCES public.calcutta_entries(id) ON DELETE CASCADE;


--
-- Name: snapshot_metrics snapshot_metrics_period_id_sport_periods_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshot_metrics
    ADD CONSTRAINT snapshot_metrics_period_id_sport_periods_id_fk FOREIGN KEY (period_id) REFERENCES public.sport_periods(id) ON DELETE CASCADE;


--
-- Name: team_period_snapshots team_period_snapshots_entry_id_calcutta_entries_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_period_snapshots
    ADD CONSTRAINT team_period_snapshots_entry_id_calcutta_entries_id_fk FOREIGN KEY (entry_id) REFERENCES public.calcutta_entries(id) ON DELETE CASCADE;


--
-- Name: team_period_snapshots team_period_snapshots_period_id_sport_periods_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_period_snapshots
    ADD CONSTRAINT team_period_snapshots_period_id_sport_periods_id_fk FOREIGN KEY (period_id) REFERENCES public.sport_periods(id) ON DELETE CASCADE;


--
-- Name: team_results team_results_season_id_seasons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_results
    ADD CONSTRAINT team_results_season_id_seasons_id_fk FOREIGN KEY (season_id) REFERENCES public.seasons(id) ON DELETE CASCADE;


--
-- Name: team_results team_results_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_results
    ADD CONSTRAINT team_results_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_season_auctions team_season_auctions_season_id_seasons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_season_auctions
    ADD CONSTRAINT team_season_auctions_season_id_seasons_id_fk FOREIGN KEY (season_id) REFERENCES public.seasons(id) ON DELETE CASCADE;


--
-- Name: team_season_auctions team_season_auctions_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_season_auctions
    ADD CONSTRAINT team_season_auctions_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: trades trades_entry_id_calcutta_entries_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trades
    ADD CONSTRAINT trades_entry_id_calcutta_entries_id_fk FOREIGN KEY (entry_id) REFERENCES public.calcutta_entries(id) ON DELETE RESTRICT;


--
-- Name: trades trades_from_bidder_id_bidders_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trades
    ADD CONSTRAINT trades_from_bidder_id_bidders_id_fk FOREIGN KEY (from_bidder_id) REFERENCES public.bidders(id);


--
-- Name: trades trades_season_id_seasons_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trades
    ADD CONSTRAINT trades_season_id_seasons_id_fk FOREIGN KEY (season_id) REFERENCES public.seasons(id) ON DELETE CASCADE;


--
-- Name: trades trades_team_id_teams_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trades
    ADD CONSTRAINT trades_team_id_teams_id_fk FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: trades trades_to_bidder_id_bidders_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trades
    ADD CONSTRAINT trades_to_bidder_id_bidders_id_fk FOREIGN KEY (to_bidder_id) REFERENCES public.bidders(id);


--
-- PostgreSQL database dump complete
--

\unrestrict wQdQBHLvx0SIU4ws6cym9RR0WfECpTbbYFFmynMX9n56Hz7MU2FhUp947YnQfaN

