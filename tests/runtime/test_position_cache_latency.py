"""Offline checks for the native-latency wrapper; Chromium is not imported."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('position_cache_latency', ROOT / 'scripts/verify-position-cache-latency.py')
LATENCY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LATENCY)


class ControlledLatencyTests(unittest.TestCase):
    def test_only_billboard_round_three_is_delayed_once(self):
        seen = set()
        for code, number in [('Sticky', 3), ('Billboard', 2), ('Billboard_2', 3), ('Billboard', 4)]:
            self.assertIsNone(LATENCY.delayed_round([{'fixtureCode': code, 'fixtureRound': number}], seen))
        rows = [{'fixtureCode': 'Billboard', 'fixtureRound': 3}]
        self.assertEqual(LATENCY.delayed_round(rows, seen), 3)
        self.assertIsNone(LATENCY.delayed_round(rows, seen))
        self.assertEqual(rows, [{'fixtureCode': 'Billboard', 'fixtureRound': 3}])

    def test_each_browser_context_can_exercise_its_own_delay(self):
        rows = [{'fixtureCode': 'Billboard', 'fixtureRound': 3}]
        self.assertEqual(LATENCY.delayed_round(rows, set()), 3)
        self.assertEqual(LATENCY.delayed_round(rows, set()), 3)


if __name__ == '__main__':
    unittest.main()
