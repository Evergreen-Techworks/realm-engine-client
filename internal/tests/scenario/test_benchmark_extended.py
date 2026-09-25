import unittest
from benchmark_navigation import environment, validate_metrics, METRICS
from benchmark_extended import safety_regressions
from benchmark_frame_cost import timing_status


class ExtendedBenchmarkTests(unittest.TestCase):
    def test_identical_binary_timing_flags_are_not_a_controller_regression(self):
        self.assertEqual(timing_status(dict(baseline='same',candidate='same'),['p99']),
                         'inconclusive_environment_noise')
        self.assertEqual(timing_status(dict(baseline='old',candidate='new'),['p99']), 'regression_flags')
    def test_live_profile_matches_recent_route_and_standoff_settings(self):
        e=environment(dict(profile='live',navigator='legacy',speed='',start_shift=''))
        self.assertEqual(e['HARNESS_ROUTE_COMMIT'],'off')
        self.assertEqual(e['HARNESS_ENEMY_STANDOFF'],'auto')
        self.assertEqual(e['HARNESS_FRAME_BUDGET'],'off')

    def test_invalid_telemetry_cannot_pass(self):
        row={k:0 for k in METRICS};row.update(scenario='test',benchmark_valid=True)
        validate_metrics(row,'test')
        for key,value in (('hits',float('nan')),('time_s',float('inf')),('benchmark_valid',False)):
            with self.assertRaises(ValueError):validate_metrics({**row,key:value},'test')
        with self.assertRaises(ValueError):validate_metrics(row,'wrong')

    def test_fewer_hits_cannot_hide_death_burst_or_incomplete_route(self):
        old=dict(deaths=0,escapes=0,hits=10,damaging_ground_frames=0,refused_moves=0,overspeed_moves=0,
                 damage_peak_100ms=50,damage_peak_250ms=50,damage_peak_500ms=50,success=True)
        new={**old,'hits':1,'deaths':1,'damage_peak_100ms':100,'success':False}
        reasons=safety_regressions(old,new)
        self.assertIn('deaths increased',reasons)
        self.assertIn('damage_peak_100ms increased',reasons)
        self.assertIn('completion lost',reasons)
