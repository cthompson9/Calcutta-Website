"""Distributional and multi-step density checks, entirely offline."""
import math
import random
import unittest

from importance_sampling_review import MarginMixtureProposal


class ProposalTests(unittest.TestCase):
    def test_full_mixture_density_includes_unselected_components(self):
        proposal = MarginMixtureProposal(['A','B'],base_fraction=.4,regular_shift=2)
        rng=random.Random(13)
        proposal.start_path(rng)
        margins=[proposal.sample_margin('A','B',.5,3,playoff=False,rng=rng) for _ in range(3)]
        ratio_a=math.exp(sum(2*(x-.5)/9-4/18 for x in margins))
        ratio_b=math.exp(sum(-2*(x-.5)/9-4/18 for x in margins))
        self.assertAlmostEqual(proposal.path_weight(),1/(.4+.3*ratio_a+.3*ratio_b),places=13)

    def test_recovers_known_base_distribution_and_joint_event(self):
        proposal=MarginMixtureProposal(['A','B'],regular_shift=2.0,playoff_shift=2.5)
        rng=random.Random(20260915)
        mass=mean=second=joint=0.0
        n=100000
        for _ in range(n):
            proposal.start_path(rng)
            x=proposal.sample_margin('A','B',0,1,playoff=False,rng=rng)
            y=proposal.sample_margin('B','A',0,1,playoff=True,rng=rng)
            w=proposal.path_weight()
            self.assertLessEqual(w,2.0+1e-12)
            mass+=w; mean+=w*x; second+=w*x*x; joint+=w*(x>0 and y>0)
        self.assertAlmostEqual(mass/n,1,delta=.015)
        self.assertAlmostEqual(mean/mass,0,delta=.015)
        self.assertAlmostEqual(second/mass,1,delta=.025)
        self.assertAlmostEqual(joint/mass,.25,delta=.012)

    def test_zero_shift_and_base_only_are_identity_weights(self):
        for settings in ({'regular_shift':0,'playoff_shift':0},{'base_fraction':1}):
            proposal=MarginMixtureProposal(['A'],**settings)
            rng=random.Random(10)
            proposal.start_path(rng)
            proposal.sample_margin('A','B',0,1,playoff=False,rng=rng)
            self.assertAlmostEqual(proposal.path_weight(),1)

    def test_invalid_settings_fail(self):
        for settings in ({'base_fraction':0},{'regular_shift':float('nan')}):
            with self.assertRaises(ValueError):
                MarginMixtureProposal(['A'],**settings)

    def test_bracket_integration_is_reproducible_and_conserves_payouts(self):
        import simulate
        teams=[f'{c}{d}{i}' for c in ['A','N'] for d in range(4) for i in range(4)]
        divisions={f"{'AFC' if c=='A' else 'NFC'} D{d}":[f'{c}{d}{i}' for i in range(4)]
                   for c in ['A','N'] for d in range(4)}
        ratings={t:0.0 for t in teams}
        realized={t:{'wins':0,'ties':0,'adj_pt_diff':0} for t in teams}
        games=[simulate.Game(teams[0],teams[1],week=1)]
        rubric={'banked':150,'per_win':10,'per_tie':5,'per_pt_diff':1,
                'bonuses':{'berth':50,'divisional':100,'conference':200,'sb_berth':400,'sb_win':800}}
        def run():
            return simulate.monte_carlo(ratings,games,realized,divisions,runs=300,seed=19,
                rubric=rubric,pot=100,realized_stats=realized,return_path_library=True,
                review_proposal=MarginMixtureProposal([teams[0],teams[16]]))
        first,second=run(),run()
        self.assertEqual(first,second)
        self.assertEqual(sum(first['review_proposal']['component_counts']),300)
        for path in first['path_library']:
            self.assertAlmostEqual(sum(path['payout'].values()),100,places=10)
            self.assertEqual(sum(path['wins'].values()),1)
            for stage,count in [('berth',14),('divisional',8),('conference',4),('sb_berth',2),('sb_win',1)]:
                self.assertEqual(sum(v[stage] for v in path['advancement'].values()),count)
        with self.assertRaisesRegex(ValueError,'reflected support'):
            simulate.monte_carlo(ratings,games,realized,divisions,support_runs_per_team=1,
                                review_proposal=MarginMixtureProposal([teams[0]]))


if __name__=='__main__':
    unittest.main()
