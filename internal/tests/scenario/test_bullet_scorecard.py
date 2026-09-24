"""Damage/completion acceptance must not be confused with optional standoff."""
import unittest
from unittest.mock import patch

from benchmark_navigation import bullet_cases, bullet_holdout_cases, bullet_outcome_passed, environment


class BulletScorecardTests(unittest.TestCase):
    def setUp(self):
        self.arrival = dict(success=False, final_dist=0.4, hits=0, stuck_s=0,
                            refused_moves=0, overspeed_moves=0, damaging_ground_frames=0)

    def test_safe_arrival_is_not_failed_by_optional_proximity(self):
        self.assertTrue(bullet_outcome_passed(self.arrival))

    def test_proximity_success_cannot_hide_damage_or_failed_movement(self):
        for metric in ('hits', 'stuck_s', 'refused_moves', 'overspeed_moves', 'damaging_ground_frames'):
            with self.subTest(metric=metric):
                self.assertFalse(bullet_outcome_passed(dict(self.arrival, success=True, **{metric: 1})))
        for distance in (0.6, 10, float('nan')):
            self.assertFalse(bullet_outcome_passed(dict(self.arrival, success=True, final_dist=distance)))

    def test_cases_are_unique_and_holdout_changes_encounters(self):
        primary, holdout = list(bullet_cases()), list(bullet_holdout_cases())
        self.assertEqual(len(primary), 72)
        self.assertEqual(len(holdout), 64)
        self.assertEqual(len({tuple(sorted(c.items())) for c in primary + holdout}), 136)
        self.assertEqual({c['shot_speed'] for c in holdout}, {6, 12})
        self.assertEqual({c['rotate'] for c in holdout}, {False, True})

    def test_shell_overrides_cannot_contaminate_paired_cases(self):
        with patch.dict('os.environ', {'HARNESS_PACK_MIRROR': '1', 'HARNESS_PACK_ROTATE': '1',
                                       'HARNESS_PACK_SHOT_SPEED': '99'}):
            env = environment(next(bullet_cases()))
        for key in ('HARNESS_PACK_MIRROR', 'HARNESS_PACK_ROTATE', 'HARNESS_PACK_SHOT_SPEED'):
            self.assertNotIn(key, env)
        self.assertEqual(env['HARNESS_FALLBACK_SIDESTEP'], 'off')


if __name__ == '__main__':
    unittest.main()
