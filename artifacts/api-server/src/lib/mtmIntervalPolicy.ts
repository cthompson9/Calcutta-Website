/** Publication checks independent of the Python solver's residual/status claims. */
export const INTERVAL_POLICY = "market-interval-win-priority-v1";
export const LEGACY_POLICY = "normalized-point-v2";
const STAGES = ["berth", "divisional", "conference", "sb_berth", "sb_win"];
const OUTCOMES = ["no_playoffs", "wild_card", "divisional", "conference", "sb_loss", "sb_win"];
const ALIASES: Record<string, string> = Object.fromEntries(["REG", "WC", "DIV", "CONF", "FL", "FW"].map((s, i) => [s, OUTCOMES[i]!]));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const time = (v: unknown) => typeof v === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(v) ? Date.parse(v) : NaN;
const probability = (v: unknown): v is number => finite(v) && v >= 0 && v <= 1;
type Row = Record<string, any>;

function evidenceTier(row: Row, decision: Row): "settled_fact" | "strong_active_book" | "verified_trade" | "last_context" | "active_book" {
  if (row.resolved === true) return "settled_fact";
  if (decision.reason === "active_book_interval") return "strong_active_book";
  if (decision.reason === "fresh_tighter_wins_preferred_after_trade_check") return "verified_trade";
  if (decision.reason === "wide_book_with_last_context") return "last_context";
  return "active_book";
}

export function selectedMtmPolicy(config: Row): string {
  const selected = config.sim?.pricing_policy ?? LEGACY_POLICY;
  if (selected !== LEGACY_POLICY && selected !== INTERVAL_POLICY) throw new Error(`Unknown MTM pricing_policy: ${selected}`);
  return selected;
}

export function validateMtmPolicyIdentity(engine: Row, config: Row): string | null {
  let selected: string;
  try { selected = selectedMtmPolicy(config); } catch (e) { return String(e); }
  const actual = engine.model?.pricing_policy ??
    (engine.model?.name === INTERVAL_POLICY ? INTERVAL_POLICY : LEGACY_POLICY);
  if (actual !== selected || (selected === INTERVAL_POLICY &&
      (engine.model?.name !== INTERVAL_POLICY || engine.review_only === true ||
       engine.diagnostics?.market_policy?.policy_version !== INTERVAL_POLICY ||
       engine.diagnostics?.market_policy?.review_only !== false))) {
    return `MTM pricing policy mismatch: requested ${selected}, received ${actual}.`;
  }
  return null;
}

function eligible(r: Row, now: number): boolean {
  const lo = r.bounds?.lower, hi = r.bounds?.upper;
  if (r.eligible !== true || !probability(lo) || !probability(hi) || lo > hi) return false;
  if (r.resolved === true) return lo === hi && (lo === 0 || lo === 1);
  const at = time(r.captured_at), cutoff = time(r.material_event_at);
  return Number.isFinite(at) && now >= at && now - at <= 900_000 &&
    (r.material_event_at == null || (Number.isFinite(cutoff) && at >= cutoff));
}

function validatedSoftException(r: Row, d: Row, rows: Row[], now: number): boolean {
  if (r.resolved === true || !probability(d.win_implied_probability)) return false;
  if (d.reason === "active_book_interval") return d.penalty === 100;
  const { lower: lo, upper: hi } = r.bounds;
  const width = hi - lo, mid = (hi + lo) / 2, implied = d.win_implied_probability;
  if (!(width >= .10 || width / Math.max(mid, .01) >= .50) ||
      Math.max(0, lo - implied, implied - hi) <= .03) return false;
  const central = new Map<string, number>();
  for (const w of rows) {
    if (w.team !== r.team || w.family !== "wins" || w.resolved || !eligible(w, now)) continue;
    const midWin = (w.bounds.lower + w.bounds.upper) / 2;
    if (midWin >= .1 && midWin <= .9) central.set(String(w.outcome), w.bounds.upper - w.bounds.lower);
  }
  const spreads = [...central.values()].sort((a, b) => a - b), n = spreads.length;
  if (n < 2) return false;
  const median = (spreads[Math.floor((n - 1) / 2)]! + spreads[Math.floor(n / 2)]!) / 2;
  if (median > .05 || median >= width) return false;
  if (d.reason === "wide_book_with_last_context") {
    return d.penalty === 5 && probability(r.last_price) &&
      d.last_price_context === r.last_price;
  }
  if (d.reason !== "fresh_tighter_wins_preferred_after_trade_check" || d.penalty !== 25) return false;
  const cutoff = time(r.material_event_at);
  if (!Number.isFinite(cutoff)) return false;
  const trades = (Array.isArray(r.trades) ? r.trades : []).filter((t: Row) => {
    const at = time(t.timestamp);
    return typeof t.id === "string" && t.id.length > 0 && finite(t.size) && t.size >= 1 &&
      probability(t.price) && Number.isFinite(at) && at >= cutoff && now >= at && now - at <= 900_000;
  });
  if (!trades.length) return false;
  const latest = Math.max(...trades.map((t: Row) => time(t.timestamp)));
  const newest = trades.filter((t: Row) => time(t.timestamp) === latest);
  if (new Set(newest.map((t: Row) => JSON.stringify([t.price, t.size]))).size !== 1) return false;
  const price = newest[0]!.price;
  return price >= lo && price <= hi && Math.abs(price - implied) > .03;
}

export function validateFinalIntervalMarketQuality(engine: Row, state: Row, config: Row) {
  const reasons: string[] = [], audit: Row[] = [];
  const identity = validateMtmPolicyIdentity(engine, config);
  if (identity) reasons.push(identity);
  const report = engine.diagnostics?.market_policy;
  if (!report || report.solver_status !== "converged" || report.status !== "shadow_candidate" ||
      report.publishable !== true || report.numerical_checks_pass !== true ||
      !Array.isArray(report.blockers) || report.blockers.length) reasons.push("interval solver did not pass");
  const capture = state.market_evidence_review, now = time(capture?.evaluation_time);
  const rows: Row[] = Array.isArray(capture?.rows) ? capture.rows : [];
  if (capture?.schema_version !== "market-policy-input-v1" || !Number.isFinite(now)) reasons.push("invalid interval evidence capture");
  if (new Set(rows.map(r => r.id)).size !== rows.length) reasons.push("duplicate evidence identity");
  const teams = Object.keys(state.realized ?? {});
  const decisions: Row[] = Array.isArray(report?.decisions) ? report.decisions : [];
  const selected = rows.filter(r => r.family === "elimination" && eligible(r, now));
  if (selected.length !== teams.length * 6 || decisions.length !== selected.length) reasons.push("incomplete interval decision coverage");
  const stageTotals = Array(5).fill(0) as number[];
  for (const team of teams) {
    const p = STAGES.map(s => engine.projections?.[team]?.p_stage?.[s]);
    if (p.some(v => !probability(v)) || p.some((v, i) => i > 0 && v > p[i - 1])) {
      reasons.push(`invalid final stages: ${team}`); continue;
    }
    p.forEach((v, i) => { stageTotals[i]! += v; });
    const exclusive = [1 - p[0], p[0] - p[1], p[1] - p[2], p[2] - p[3], p[3] - p[4], p[4]];
    OUTCOMES.forEach((outcome, i) => {
      const matching = selected.filter(r => r.team === team && (ALIASES[r.outcome] ?? r.outcome) === outcome);
      if (matching.length !== 1) { reasons.push(`missing/duplicate interval: ${team}:${outcome}`); return; }
      const r = matching[0]!, ds = decisions.filter(d => d.id === r.id), d = ds[0];
      if (ds.length !== 1 || !d || d.team !== team || (ALIASES[d.outcome] ?? d.outcome) !== outcome ||
          d.bounds?.lower !== r.bounds.lower || d.bounds?.upper !== r.bounds.upper || d.blocked === true ||
          !["hard", "soft"].includes(d.mode)) { reasons.push(`invalid decision: ${r.id}`); return; }
      const violation = Math.max(0, r.bounds.lower - exclusive[i], exclusive[i] - r.bounds.upper);
      const soft = d.mode === "soft" && validatedSoftException(r, d, rows, now);
      const softViolationOk = d.reason !== "active_book_interval" || violation <= .10;
      if ((d.mode === "soft" && (!soft || !softViolationOk)) ||
          (d.mode === "hard" && violation > 1e-6)) reasons.push(`unmet interval: ${r.id}`);
      audit.push({
        id: r.id,
        team,
        outcome,
        final_probability: exclusive[i],
        bounds: r.bounds,
        mode: d.mode,
        reason: d.reason ?? null,
        evidence_tier: evidenceTier(r, d),
        last_price: probability(r.last_price) ? r.last_price : null,
        violation,
        near_publication_ceiling:
          d.reason === "active_book_interval" && violation >= 0.08,
        validated_exception: soft,
      });
    });
  }
  if (stageTotals.some((v, i) => Math.abs(v - [14, 8, 4, 2, 1][i]!) > 1e-6)) reasons.push("final playoff inventory does not conserve");
  const basis = decisions.some(d => d.mode === "soft") ? "wins_led" : "joint_market_intervals";
  if (report?.pricing_basis !== basis || engine.model?.pricing_basis !== basis) reasons.push("pricing basis mismatch");
  return { error: reasons.length ? `Final interval-market quality failed: ${reasons.join("; ")}.` : null,
    diagnostics: { status: reasons.length ? "failed" : "good", gate_result: reasons.length ? "failed" : "passed",
      pricing_policy: INTERVAL_POLICY, pricing_basis: basis, numerical_tolerance: 1e-6, reasons, rows: audit } };
}
