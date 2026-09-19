import unittest
import numpy as np
from market_policy_review import DEFAULTS, eligible_book, latest_trade, win_quality, select_playoff_constraint, fit_intervals, timestamp, captured_win_targets, resolve_provisional_conflicts

NOW=timestamp('2026-09-15T12:00:00Z')
def quote(**changes):
    row=dict(id='CHI-WC',team='CHI',family='elimination',outcome='wild_card',eligible=True,
        bounds={'lower':.3,'upper':.5},captured_at='2026-09-15T11:59:00Z',
        material_event_at='2026-09-15T11:50:00Z',trades=[dict(id='t',price=.4,size=10,timestamp='2026-09-15T11:58:00Z')])
    row.update(changes);return row
STRONG={'qualified':True,'median_spread':.02}

class EvidencePolicyTests(unittest.TestCase):
    def test_recent_sized_trade_confirms_conflict_and_tighter_wins_get_priority(self):
        d=select_playoff_constraint(quote(),.1,STRONG,NOW,DEFAULTS)
        self.assertEqual(d['mode'],'soft');self.assertEqual(d['penalty'],25)
        self.assertEqual(d['bounds'],{'lower':.3,'upper':.5})
    def test_bare_last_is_low_weight_context_not_a_verified_trade(self):
        for trades in [[],[dict(id='t',price=.4,size=10)],
                       [dict(id='t',price=.4,timestamp='2026-09-15T11:58:00Z')],
                       [dict(id='t',price=.4,size=.1,timestamp='2026-09-15T11:58:00Z')]]:
            d=select_playoff_constraint(quote(trades=trades,last_price=.4),.1,STRONG,NOW,DEFAULTS)
            self.assertEqual(d['mode'],'soft');self.assertEqual(d['reason'],'wide_book_with_last_context')
            self.assertEqual(d['penalty'],5);self.assertEqual(d['last_price_context'],.4)
    def test_pre_event_stale_and_future_trades_do_not_qualify(self):
        for at in ['2026-09-15T11:49:00Z','2026-09-15T11:00:00Z','2026-09-15T12:01:00Z']:
            self.assertEqual(latest_trade(quote(trades=[dict(id='t',price=.4,size=10,timestamp=at)]),NOW,DEFAULTS)['status'],'unavailable')
    def test_outside_book_trade_is_visible_not_clipped(self):
        q=quote(trades=[dict(id='t',price=.7,size=10,timestamp='2026-09-15T11:58:00Z')])
        d=select_playoff_constraint(q,.1,STRONG,NOW,DEFAULTS)
        self.assertEqual(d['trade_check']['status'],'outside_book');self.assertEqual(d['trade_check']['trade']['price'],.7)
        self.assertEqual(d['mode'],'soft');self.assertEqual(d['reason'],'active_book_interval')
    def test_settlement_and_narrow_book_never_discounted(self):
        settled=select_playoff_constraint(quote(resolved=True,bounds={'lower':1,'upper':1}),.1,STRONG,NOW,DEFAULTS)
        self.assertEqual(settled['mode'],'hard');self.assertEqual(settled['reason'],'settlement_fact')
        narrow=select_playoff_constraint(quote(bounds={'lower':.39,'upper':.41}),.1,STRONG,NOW,DEFAULTS)
        self.assertEqual(narrow['mode'],'soft');self.assertEqual(narrow['reason'],'active_book_interval')
        self.assertEqual(narrow['penalty'],100)
    def test_conflicting_duplicate_trades_are_ambiguous(self):
        q=quote();q['trades'].append(dict(q['trades'][0],price=.45))
        self.assertEqual(latest_trade(q,NOW,DEFAULTS)['status'],'ambiguous')
    def test_liquidity_not_assumed_from_market_name_or_tail_quotes(self):
        rows=[quote(id='w'+str(i),family='wins',outcome=str(i),bounds={'lower':.98,'upper':.99}) for i in range(3)]
        self.assertFalse(win_quality(rows,NOW,DEFAULTS)['CHI']['qualified'])
        rows=[quote(id='w'+str(i),family='wins',outcome=str(i),bounds={'lower':.48,'upper':.5}) for i in range(2)]
        self.assertTrue(win_quality(rows,NOW,DEFAULTS)['CHI']['qualified'])
        for r in rows:r['captured_at']='2026-09-15T11:00:00Z'
        self.assertFalse(win_quality(rows,NOW,DEFAULTS)['CHI']['qualified'])
    def test_ineligible_future_and_pre_event_books_rejected(self):
        for q in [quote(eligible=False),quote(captured_at='2026-09-15T12:01:00Z'),quote(captured_at='2026-09-15T11:49:00Z')]:
            self.assertFalse(eligible_book(q,NOW,DEFAULTS))
    def test_missing_event_cutoff_uses_last_only_as_weak_context(self):
        d=select_playoff_constraint(quote(material_event_at=None,last_price=.4),.1,STRONG,NOW,DEFAULTS)
        self.assertFalse(d.get('blocked',False));self.assertEqual(d['mode'],'soft')
        self.assertEqual(d['reason'],'wide_book_with_last_context')
    def test_missing_trade_and_last_context_still_blocks(self):
        d=select_playoff_constraint(quote(material_event_at=None,trades=[],last_price=None),.1,STRONG,NOW,DEFAULTS)
        self.assertFalse(d.get('blocked',False));self.assertEqual(d['reason'],'active_book_interval')
        self.assertEqual(d['penalty'],100)
    def test_new_capture_changes_win_target_without_previous_rating_state(self):
        config={'games_per_team':17,'pricing':{'max_spread_for_mid':.15}}
        rows=[quote(id='w'+str(i),family='wins',outcome=str(i),bounds={'lower':.5,'upper':.5}) for i in range(1,18)]
        first=captured_win_targets(rows,NOW,DEFAULTS,config)['CHI']
        for row in rows:row['bounds']={'lower':.6,'upper':.6}
        second=captured_win_targets(rows,NOW,DEFAULTS,config)['CHI']
        self.assertAlmostEqual(first,8.5);self.assertAlmostEqual(second,10.2)

class JointSolverTests(unittest.TestCase):
    def setUp(self):self.policy=dict(DEFAULTS,max_weight=1)
    def test_known_bernoulli_kl_projection(self):
        r=fit_intervals([[1,0]],[.1,.9],[.4],[.6],[np.inf],self.policy)
        self.assertEqual(r['status'],'converged');self.assertAlmostEqual(r['weights'][0],.4,places=6)
    def test_joint_hard_and_soft_constraints(self):
        # A hard event partitions an independent four-state distribution.
        # The soft event is allowed to miss its interval, with a known KKT root.
        r=fit_intervals([[1,1,0,0],[1,0,1,0]],[.25]*4,[.5,.8],[.5,.9],[np.inf,2],self.policy)
        self.assertEqual(r['status'],'converged');self.assertAlmostEqual(r['achieved'][0],.5,places=6)
        q=r['achieved'][1]
        self.assertGreater(q,.5);self.assertLess(q,.8)
        self.assertAlmostEqual(np.log(q/(1-q))-4*(.8-q),0,places=5)
    def test_missing_support_stops_before_optimizer(self):
        r=fit_intervals([[1,1]],[1,1],[.95],[.98],[np.inf],self.policy)
        self.assertEqual(r['status'],'unsupported');self.assertIsNone(r['weights'])
    def test_one_path_cannot_carry_two_percent_under_one_percent_cap(self):
        r=fit_intervals([[1]+[0]*199],[1]*200,[.02],[.1],[np.inf],DEFAULTS)
        self.assertEqual(r['status'],'insufficient_support_for_weight_cap')
    def test_invalid_prior_rejected(self):
        for p in [[0,1],[float('nan'),1],[-1,2]]:
            with self.assertRaises(ValueError):fit_intervals([[1,0]],p,[.2],[.8],[np.inf],self.policy)

    def test_nested_fit_can_start_from_the_accepted_baseline_distribution(self):
        baseline=fit_intervals([[1,1,0,0]],[.25]*4,[.6],[.6],[np.inf],self.policy)
        self.assertEqual(baseline['status'],'converged')
        final=fit_intervals(
            [[1,1,0,0],[1,0,1,0]],
            baseline['weights'],
            [.6,.45],
            [.6,.55],
            [np.inf,np.inf],
            self.policy,
        )
        self.assertEqual(final['status'],'converged')
        self.assertLessEqual(final['max_hard_residual'],self.policy['numerical_tolerance'])

if __name__=='__main__':unittest.main()
