#!/usr/bin/env python3
"""Load all 11 Calcutta workbooks into the generic schema, recompute every
payout from events + rules alone, and reconcile against the workbooks."""
import json, glob, os, sys
from decimal import Decimal, ROUND_HALF_UP
import psycopg2, psycopg2.extras

DSN = "postgres://postgres@/calcutta_v2?host=/tmp&port=5433"
DATA = sorted(glob.glob("/tmp/cal/data/calcutta-*.json"))

FORMATS = {
    "NCAA_MM_64":            ("NCAAM",  "single_elim"),
    "NFL_REGULAR_SEASON_18W":("NFL",    "league"),
    "NBA_PLAYOFFS_16":       ("NBA",    "series_bracket"),
    "WORLD_CUP_48":          ("SOCCER", "group_knockout"),
}

def q(cur, sql, args=None):
    cur.execute(sql, args or ())
    return cur

def load():
    conn = psycopg2.connect(DSN); conn.autocommit = False
    cur = conn.cursor()
    cur.execute(open("/tmp/cal/schema.sql").read())
    conn.commit()
    cur.execute("set search_path to cal")

    owners = {}      # global display_name -> id
    teams  = {}      # (sport,name) -> id
    pools  = {}

    for path in DATA:
        d = json.load(open(path))
        ed = d["edition"]; fk = d["format_key"]
        sport, structure = FORMATS.get(fk, (d["sport"], "league"))

        cur.execute("""insert into competition_formats(key,sport,structure,definition)
                       values(%s,%s,%s,%s) on conflict (key) do nothing""",
                    (fk, sport, structure, json.dumps({"periods":[p["key"] for p in d.get("periods",[])]})))
        for p in d.get("periods", []):
            cur.execute("""insert into format_periods(format_key,key,seq,label,kind,weight,is_scored)
                           values(%s,%s,%s,%s,%s,%s,%s) on conflict do nothing""",
                        (fk, p["key"], p["seq"], p.get("label",p["key"]), p.get("kind","regular"),
                         p.get("weight",1), p.get("is_scored",True)))

        cur.execute("""insert into calcuttas(edition_number,name,sport,format_key,season_year,
                        pot_size,as_of_date,normalization) values(%s,%s,%s,%s,%s,%s,%s,%s) returning id""",
                    (ed, d["name"], d["sport"], fk, d["season_year"], d["pot_size"],
                     d.get("as_of_date"), json.dumps(d["normalization"])))
        cid = cur.fetchone()[0]; pools[ed] = cid

        for r in d["rules"]:
            cur.execute("""insert into scoring_rules(calcutta_id,kind,metric,period_key,rate,
                            group_attr,fallback,note) values(%s,%s,%s,%s,%s,%s,%s,%s)""",
                        (cid, r["kind"], r.get("metric"), r.get("period_key"), r["rate"],
                         r.get("group_attr"), r.get("fallback"), r.get("note")))

        # ---- owners: a full name (has a space) is a global identity; a bare
        # label stays scoped to its pool, because Zach/Zack are different people.
        label2owner = {}
        for o in d["owners"]:
            nm = (o.get("name") or "").strip()
            key = nm if (nm and " " in nm) else f'{o["label"]} [ed{ed}]'
            if key not in owners:
                cur.execute("insert into owners(display_name,email) values(%s,%s) returning id",
                            (key, o.get("email")))
                owners[key] = cur.fetchone()[0]
            label2owner[o["label"]] = owners[key]
            cur.execute("""insert into calcutta_owners(calcutta_id,owner_id,label)
                           values(%s,%s,%s) on conflict do nothing""", (cid, owners[key], o["label"]))

        for e in d["entries"]:
            cur.execute("""insert into entries(calcutta_id,label,lot_order,price,kind,attributes)
                           values(%s,%s,%s,%s,%s,%s) returning id""",
                        (cid, e["label"], e.get("lot_order"), e["price"], e.get("kind","single"),
                         json.dumps(e.get("attributes") or {})))
            eid = cur.fetchone()[0]

            for t in e.get("teams", []):
                tk = (d["sport"], t["name"])
                if tk not in teams:
                    cur.execute("insert into teams(sport,name) values(%s,%s) returning id", tk)
                    teams[tk] = cur.fetchone()[0]
                cur.execute("""insert into entry_teams(entry_id,team_id,seed,resolved)
                               values(%s,%s,%s,%s) on conflict do nothing""",
                            (eid, teams[tk], t.get("seed"), t.get("resolved", True)))

            for o in e["owners"]:
                oid = label2owner.get(o["label"])
                if oid is None:
                    cur.execute("insert into owners(display_name) values(%s) returning id",
                                (f'{o["label"]} [ed{ed}]',))
                    oid = owners[f'{o["label"]} [ed{ed}]'] = cur.fetchone()[0]
                    label2owner[o["label"]] = oid
                    cur.execute("""insert into calcutta_owners(calcutta_id,owner_id,label)
                                   values(%s,%s,%s) on conflict do nothing""", (cid, oid, o["label"]))
                cur.execute("""insert into positions(entry_id,owner_id,share,source)
                               values(%s,%s,%s,'primary')""", (eid, oid, o["share"]))

            for ev in e.get("events", []):
                cur.execute("""insert into scoring_events(entry_id,period_key,metric,units)
                               values(%s,%s,%s,%s)
                               on conflict (entry_id,period_key,metric) do update set units =
                               scoring_events.units + excluded.units""",
                            (eid, ev.get("period_key"), ev["metric"], ev["units"]))

            exp = e.get("expected") or {}
            cur.execute("""insert into expected_entry_results(entry_id,points,realized_return)
                           values(%s,%s,%s)""", (eid, exp.get("points"), exp.get("realized_return")))

        for t in d.get("trades", []):
            scope = t.get("scope", "entry")
            # A book trade's "pct" is its leverage factor, not an ownership share.
            # Every historical crossbook was a Lion King: auction lots only, each
            # counted at 100% regardless of the share actually bought.
            det = (t.get("detail") or "").upper()
            if scope != "entry" and ("SIDEBET" in det or "CASH SIDE PAYMENT" in det):
                scope = "cash" if "CASH SIDE PAYMENT" in det else "sidebet"
            is_book = scope in ("book", "synthetic_book")
            factor = t.get("factor", t.get("pct")) if is_book else None
            basis  = t.get("basis", "lion_king")   if is_book else None
            pct    = t.get("pct") if scope == "entry" else None
            cur.execute("""insert into trades(calcutta_id,sheet_ref,trade_date,detail,scope,
                            entry_id,from_owner_id,to_owner_id,pct,cash,
                            reference_owner_id,factor,basis)
                           values(%s,%s,%s,%s,%s,
                            (select id from entries where calcutta_id=%s and label=%s),
                            %s,%s,%s,%s,%s,%s,%s)""",
                        (cid, str(t.get("sheet_ref") or ""), t.get("date"), t.get("detail"),
                         scope, cid, t.get("entry_label"),
                         label2owner.get(t.get("from")), label2owner.get(t.get("to")),
                         pct, t.get("cash"),
                         label2owner.get(t.get("reference_owner")), factor, basis))

        for eo in d.get("expected_owners", []):
            oid = label2owner.get(eo["label"])
            if oid:
                cur.execute("""insert into expected_owner_results(calcutta_id,owner_id,cost,realized)
                               values(%s,%s,%s,%s) on conflict do nothing""",
                            (cid, oid, eo.get("cost"), eo.get("realized")))
        conn.commit()
    return conn, pools

# --------------------------------------------------------------- the engine --
def compute(conn, cid):
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("set search_path to cal")
    cur.execute("select * from calcuttas where id=%s", (cid,))
    pool = cur.fetchone()
    pot = Decimal(str(pool["pot_size"])); norm = pool["normalization"]

    cur.execute("select * from format_periods where format_key=%s", (pool["format_key"],))
    weight = {r["key"]: Decimal(str(r["weight"])) for r in cur.fetchall()}
    cur.execute("select * from scoring_rules where calcutta_id=%s", (cid,))
    rules = cur.fetchall()
    cur.execute("select id,label,attributes from entries where calcutta_id=%s order by id", (cid,))
    entries = cur.fetchall()
    cur.execute("""select e.id eid, s.period_key, s.metric, s.units from entries e
                   join scoring_events s on s.entry_id=e.id where e.calcutta_id=%s""", (cid,))
    events = cur.fetchall()

    ev = {}
    for r in events:
        ev.setdefault(r["eid"], []).append(r)

    per_unit = [r for r in rules if r["kind"] == "per_unit"]
    direct   = [r for r in rules if r["kind"] == "direct_share"]
    ranks    = [r for r in rules if r["kind"] == "group_rank_bonus"]
    splits   = [r for r in rules if r["kind"] == "split_pool"]

    # ---- pass 1: per-entry base points and direct shares
    points, share = {}, {}
    for e in entries:
        p = Decimal(0); s = Decimal(0)
        for x in ev.get(e["id"], []):
            u = Decimal(str(x["units"]))
            for r in per_unit:
                if r["metric"] == x["metric"] and (r["period_key"] in (None, x["period_key"])):
                    p += u * Decimal(str(r["rate"])) * weight.get(x["period_key"], Decimal(1))
            for r in direct:
                if r["metric"] == x["metric"] and (r["period_key"] in (None, x["period_key"])):
                    s += u * Decimal(str(r["rate"]))
        points[e["id"]] = p; share[e["id"]] = s

    # ---- pass 2a: group_rank_bonus (needs every entry's pass-1 points)
    bonus = {e["id"]: Decimal(0) for e in entries}
    for r in ranks:
        groups = {}
        for e in entries:
            g = (e["attributes"] or {}).get(r["group_attr"])
            if g is not None:
                groups.setdefault(str(g), []).append(e["id"])
        for g, ids in groups.items():
            top = max(points[i] for i in ids)
            winners = [i for i in ids if points[i] == top]
            each = Decimal(str(r["rate"])) / Decimal(len(winners))
            for i in winners:
                bonus[i] += each
    for e in entries:
        points[e["id"]] += bonus[e["id"]]

    # ---- pass 2b: split_pool (needs every entry's units, with fallback chain)
    split_award = {e["id"]: Decimal(0) for e in entries}
    for r in splits:
        chain = r["fallback"] or [r["metric"]]
        chosen, total = None, Decimal(0)
        for m in chain:
            t = sum((Decimal(str(x["units"])) for xs in ev.values() for x in xs
                     if x["metric"] == m), Decimal(0))
            if t > 0:
                chosen, total = m, t; break
        if not chosen:
            continue
        unit = Decimal(str(r["rate"])) * pot / total
        for e in entries:
            u = sum((Decimal(str(x["units"])) for x in ev.get(e["id"], [])
                     if x["metric"] == chosen), Decimal(0))
            split_award[e["id"]] += u * unit

    # ---- normalization
    mode = norm["mode"]; out = {}
    if mode == "direct":
        for e in entries:
            out[e["id"]] = share[e["id"]] * pot + split_award[e["id"]]
    elif mode == "earned_total":
        tot = sum(points.values())
        for e in entries:
            out[e["id"]] = (points[e["id"]] / tot * pot if tot else Decimal(0)) + split_award[e["id"]]
    elif mode == "fixed_inventory":
        den = Decimal(str(norm["denominator"]))
        for e in entries:
            out[e["id"]] = points[e["id"]] / den * pot + split_award[e["id"]]
    else:
        raise ValueError(mode)
    return pool, entries, points, out

def main():
    conn, pools = load()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("set search_path to cal")
    C = Decimal("0.01")
    grand = {"entries":0,"pts_ok":0,"pts_n":0,"pay_ok":0,"pay_n":0}
    rows = []
    for ed in sorted(pools):
        cid = pools[ed]
        pool, entries, points, pay = compute(conn, cid)
        cur.execute("""select e.id, x.points ep, x.realized_return er from entries e
                       join expected_entry_results x on x.entry_id=e.id
                       where e.calcutta_id=%s""", (cid,))
        exp = {r["id"]: r for r in cur.fetchall()}
        pts_ok=pts_n=pay_ok=pay_n=0; worst=Decimal(0); worst_lbl=""
        for e in entries:
            x = exp.get(e["id"], {})
            if x.get("ep") is not None:
                pts_n += 1
                if abs(Decimal(str(x["ep"])) - points[e["id"]]) <= Decimal("0.01"): pts_ok += 1
            if x.get("er") is not None:
                pay_n += 1
                d = abs(Decimal(str(x["er"])) - pay[e["id"]])
                if d <= Decimal("0.02"): pay_ok += 1
                elif d > worst: worst, worst_lbl = d, e["label"]
        # owner roll-up
        cur.execute("""select p.entry_id, p.owner_id, p.share from positions p
                       join entries e on e.id=p.entry_id where e.calcutta_id=%s
                       and p.source='primary'""", (cid,))
        own = {}
        for r in cur.fetchall():
            own[r["owner_id"]] = own.get(r["owner_id"], Decimal(0)) + Decimal(str(r["share"])) * pay[r["entry_id"]]
        cur.execute("""select owner_id, realized from expected_owner_results
                       where calcutta_id=%s and realized is not null""", (cid,))
        eo = cur.fetchall()
        o_ok = sum(1 for r in eo if abs(Decimal(str(r["realized"])) - own.get(r["owner_id"], Decimal(0))) <= Decimal("0.05"))
        total_pay = sum(pay.values())
        rows.append(dict(ed=ed, name=pool["name"], sport=pool["sport"], mode=pool["normalization"]["mode"],
                         n=len(entries), pts=f"{pts_ok}/{pts_n}", pay=f"{pay_ok}/{pay_n}",
                         own=f"{o_ok}/{len(eo)}", worst=worst, worst_lbl=worst_lbl,
                         pot=Decimal(str(pool["pot_size"])), paid=total_pay))
        grand["entries"]+=len(entries); grand["pts_ok"]+=pts_ok; grand["pts_n"]+=pts_n
        grand["pay_ok"]+=pay_ok; grand["pay_n"]+=pay_n

    print(f"{'ed':>3} {'pool':<16}{'sport':<8}{'mode':<16}{'lots':>5} {'points':>8} {'payout':>9} {'owners':>7}  {'pot':>12} {'engine paid':>12} {'gap':>9}")
    print("-"*118)
    for r in rows:
        gap = r["paid"] - r["pot"]
        print(f'{r["ed"]:>3} {r["name"]:<16}{r["sport"]:<8}{r["mode"]:<16}{r["n"]:>5} {r["pts"]:>8} {r["pay"]:>9} {r["own"]:>7}  '
              f'{r["pot"]:>12,.2f} {r["paid"]:>12,.2f} {gap:>+9,.2f}')
        if r["worst"] > 0:
            print(f'      worst payout mismatch: {r["worst_lbl"]}  off by ${r["worst"]:,.2f}')
    print("-"*118)
    print(f'TOTAL  {grand["entries"]} lots | points {grand["pts_ok"]}/{grand["pts_n"]} | payouts {grand["pay_ok"]}/{grand["pay_n"]}')
    conn.commit()

if __name__ == "__main__":
    main()
