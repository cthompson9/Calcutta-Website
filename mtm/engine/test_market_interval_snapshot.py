import copy
import unittest
from unittest.mock import patch
import numpy as np
import market_interval_snapshot as adapter
import run_mtm
import simulate


class SnapshotBridgeTests(unittest.TestCase):
    def fixture(self):
        teams=['A','B'];w=np.array([.1,.2,.3,.4]);wins=np.array([[1,0],[1,0],[0,1],[0,1]])
        raw=np.array([[1,-1],[2,-2],[-3,3],[-4,4]],dtype=float)
        inventory={'teams':teams,'prior':np.ones(4),'wins':wins,'gross':np.array([[80,20],[60,40],[30,70],[10,90]]),
            'outcomes':np.array([[0,0,1,1]],dtype=np.uint8),'raw_diff':raw,'adjusted_diff':raw*2,
            'hits':np.zeros((4,10))}
        config={'season':2026,'games_per_team':17,'pricing':{'max_spread_for_mid':.15},
            'rubric':{'banked':150,'per_win':10,'per_tie':5,'per_pt_diff':1,'denominator':320,
                      'bonuses':dict.fromkeys(adapter.policy.STAGES,0)},
            'sim':{'margin_sd':13.5,'hfa_points':1.6,'pricing_policy':adapter.POLICY}}
        capture={'schema_version':'market-policy-input-v1','evaluation_time':'2026-09-15T12:00:00Z',
            'rows':[{'id':t,'team':t,'family':'wins','outcome':'1','eligible':True,
                'bounds':{'lower':.5,'upper':.5},'captured_at':'2026-09-15T11:59:00Z'} for t in teams]}
        state={'pot':200,'entries':[{'entry_id':t,'team':t,'price':10} for t in teams],
            'realized':{t:{'wins':0,'ties':0,'adj_pt_diff':0} for t in teams},
            'remaining_schedule':[{'home':'A','away':'B','marquee':True,'week':1,'event_id':1}],
            'market_evidence_review':capture}
        report={'status':'shadow_candidate','ess':float(1/(w@w)),'max_weight':.4,
            'settings':{'win_tolerance':.03},'pricing_basis':'joint_market_intervals','decisions':[],
            'constraint_residuals':[]}
        generation={'seed':7,'rating_fit':{'ratings':{'A':0,'B':0}}}
        return config,state,inventory,generation,report,w

    def test_all_outputs_reduce_the_final_posterior_with_actual_pool_scale(self):
        args=self.fixture();out=adapter.assemble_snapshot(*args)
        self.assertAlmostEqual(out['projections']['A']['e_remaining_wins'],.3)
        self.assertAlmostEqual(out['projections']['A']['e_remaining_raw_diff'],-2.)
        self.assertAlmostEqual(out['projections']['A']['e_remaining_marquee_addon'],-2.)
        self.assertEqual(out['team_valuations']['A']['gross_expected_payout'],66.)
        self.assertEqual(sum(r['expected_payout'] for r in out['valuations']),200.)
        buckets=out['conditional_payouts']['0']['outcomes']
        self.assertAlmostEqual(buckets['home_win']['A']['sample_share'],.3)
        self.assertAlmostEqual(buckets['home_win']['A']['gross_expected_payout'],133.33,places=2)
        self.assertEqual(buckets['home_win']['A']['reconciliation_residual'],0.)
        metric=out['diagnostics']['market_calibration']['metrics'][0]
        self.assertAlmostEqual(metric['sample_metadata']['posterior_probability'],.3)
        self.assertAlmostEqual(metric['effective_sample_size'],1/.3)

    def test_different_or_invalid_weights_cannot_reuse_success_report(self):
        for w in [np.ones(4)/4,np.array([np.nan,.2,.3,.4]),np.array([-.1,.2,.3,.6])]:
            args=list(self.fixture());args[-1]=w
            with self.assertRaises(ValueError):adapter.assemble_snapshot(*args)

    def test_actual_runner_routes_explicit_policy_and_rejects_unknown(self):
        config,state,*_=self.fixture()
        with patch.object(adapter,'build_interval_snapshot',return_value={'status':'ok'}) as interval, \
             patch.object(run_mtm,'_build_snapshot',side_effect=AssertionError('legacy route used')):
            self.assertEqual(run_mtm.build_snapshot(config,state)['status'],'ok');interval.assert_called_once()
        config['sim']['pricing_policy']='typo'
        with self.assertRaisesRegex(ValueError,'unknown MTM'):run_mtm.build_snapshot(config,state)

    def test_actual_runner_routes_reference_mark_power_policy(self):
        config,state,*_=self.fixture()
        config['sim']['pricing_policy']=adapter.REFERENCE_MARK_POWER_POLICY
        with patch.object(run_mtm,'_build_snapshot',return_value={'status':'ok'}) as reference:
            self.assertEqual(run_mtm.build_snapshot(config,state)['status'],'ok')
            reference.assert_called_once_with(
                config, state, runtime=None, enforce_gate=True, reference_policy=True)

    def test_legacy_is_explicit_and_review_cannot_override_interval_selection(self):
        config,state,*_=self.fixture()
        with self.assertRaisesRegex(ValueError,'review-only'):run_mtm.build_snapshot(config,state,review_joint_fit=True)
        del config['sim']['pricing_policy']
        with patch.object(run_mtm,'_build_snapshot',return_value={'status':'ok'}) as legacy:
            run_mtm.build_snapshot(config,state);legacy.assert_called_once()

    def test_failed_rating_details_survive_the_canonical_failure_path(self):
        config,state,*_=self.fixture();config['sim']['monte_carlo_runs']=40000
        fit={'status':'failed','termination':{'reason':'maximum_iterations'},'fit':{'gradient_norm':.01}}
        runtime=simulate.RuntimeDiagnostics()
        with patch.object(adapter.policy,'generate_inventory',side_effect=adapter.policy.RatingFitFailure(fit)):
            with self.assertRaisesRegex(ValueError,'fresh rating fit failed: maximum_iterations'):
                adapter.build_interval_snapshot(config,state,runtime)
        self.assertEqual(runtime.snapshot()['details']['rating_fit'],fit)


if __name__=='__main__':unittest.main()
