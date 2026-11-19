"""Offline regression checks for the legacy cache verifier's failure evidence.

Only the pure diagnostics module is imported. These tests never launch Chromium,
run a publisher script, contact GAM, or supply a substitute row on failed lookup.
"""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    'cache_verifier_diagnostics_under_test', ROOT / 'scripts/cache_verifier_diagnostics.py'
)
DIAGNOSTICS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DIAGNOSTICS)


class RequestLookupTests(unittest.TestCase):
    def setUp(self):
        self.scenario = 'S 390 normal'
        # Deliberately out of order and with the same round on another position.
        self.rows = [
            {'id': 'Sticky', 'round': 2, 'latestAuction': 'sticky-a2',
             'bid': {'cpm': 4, 'auctionId': 'sticky-a1', 'adUnitCode': 'Sticky'}},
            {'id': 'Billboard', 'round': 3, 'latestAuction': 'billboard-a3'},
            {'id': 'Billboard', 'round': 1, 'latestAuction': 'billboard-a1'},
            {'id': 'Billboard', 'round': 2, 'latestAuction': 'billboard-a2',
             'bid': {'cpm': 1, 'auctionId': 'billboard-a2', 'adUnitCode': 'Billboard'},
             'hbTargeting': {'hb_adid': ['native-b2'], 'hb_pb': ['1.00']}},
            {'id': 'Billboard-extra', 'round': 2, 'latestAuction': 'other-a2'},
        ]

    def assert_context(self, error, code='Billboard', round_number=2):
        message = str(error)
        self.assertIn(code, message)
        self.assertIn(str(round_number), message)
        self.assertIn(self.scenario, message)
        return message.lower()

    def test_exact_lookup_keeps_selected_bid_and_request_auction_separate(self):
        original = copy.deepcopy(self.rows)
        board = DIAGNOSTICS.require_request(self.rows, 'Billboard', 2, self.scenario)
        sticky = DIAGNOSTICS.require_request(self.rows, 'Sticky', 2, self.scenario)
        self.assertEqual(board, original[3])
        self.assertEqual(sticky, original[0])
        self.assertEqual(sticky['latestAuction'], 'sticky-a2')
        self.assertEqual(sticky['bid']['auctionId'], 'sticky-a1')
        self.assertEqual(self.rows, original, 'Lookup must not rewrite attribution evidence')

    def test_lookup_works_with_copied_out_of_order_records(self):
        copied = copy.deepcopy(self.rows)
        copied.reverse()
        self.assertEqual(
            DIAGNOSTICS.require_request(copied, 'Billboard', 2, self.scenario), self.rows[3]
        )
        self.assertEqual(copied, list(reversed(self.rows)))

    def test_missing_middle_round_fails_with_context_and_observed_rounds(self):
        rows = [row for row in self.rows if not (row['id'] == 'Billboard' and row['round'] == 2)]
        original = copy.deepcopy(rows)
        with self.assertRaises(AssertionError) as caught:
            DIAGNOSTICS.require_request(rows, 'Billboard', 2, self.scenario)
        message = self.assert_context(caught.exception)
        self.assertIn('observed', message)
        self.assertIn('1', message)
        self.assertIn('3', message)
        self.assertEqual(rows, original, 'A missing round cannot be filled or dropped')

    def test_a_later_round_does_not_substitute_for_the_missing_round(self):
        rows = [{'id': 'Billboard', 'round': 5, 'latestAuction': 'a5'}]
        with self.assertRaises(AssertionError) as caught:
            DIAGNOSTICS.require_request(rows, 'Billboard', 2, self.scenario)
        self.assert_context(caught.exception)
        self.assertEqual(rows, [{'id': 'Billboard', 'round': 5, 'latestAuction': 'a5'}])

    def test_duplicate_exact_round_fails_instead_of_choosing_the_first(self):
        rows = copy.deepcopy(self.rows)
        duplicate = copy.deepcopy(rows[3])
        duplicate['latestAuction'] = 'different-a2'
        rows.append(duplicate)
        original = copy.deepcopy(rows)
        with self.assertRaises(AssertionError) as caught:
            DIAGNOSTICS.require_request(rows, 'Billboard', 2, self.scenario)
        message = self.assert_context(caught.exception)
        self.assertIn('duplicat', message)
        self.assertIn('observed', message)
        self.assertEqual(rows, original)

    def test_identical_duplicates_are_also_ambiguous(self):
        row = copy.deepcopy(self.rows[3])
        with self.assertRaises(AssertionError) as caught:
            DIAGNOSTICS.require_request([row, copy.deepcopy(row)], 'Billboard', 2, self.scenario)
        self.assert_context(caught.exception)

    def test_other_slots_and_unlabeled_requests_cannot_supply_a_missing_round(self):
        rows = [self.rows[0], self.rows[4], {'id': 'Billboard', 'round': None},
                {'id': 'Billboard'}, {'id': 'billboard', 'round': 2}]
        with self.assertRaises(AssertionError) as caught:
            DIAGNOSTICS.require_request(rows, 'Billboard', 2, self.scenario)
        self.assert_context(caught.exception)

    def test_text_round_number_is_not_silently_coerced_into_native_numeric_round(self):
        rows = [{'id': 'Billboard', 'round': '2', 'latestAuction': 'not-native-numeric'}]
        with self.assertRaises(AssertionError) as caught:
            DIAGNOSTICS.require_request(rows, 'Billboard', 2, self.scenario)
        self.assert_context(caught.exception)


class FailureReceiptTests(unittest.TestCase):
    def test_receipt_preserves_full_scenario_and_per_slot_auction_evidence(self):
        scenario = {'arm': 'S', 'width': 390, 'case': 'normal'}
        observations = {
            'requests': [
                {'id': 'Billboard', 'round': 1, 'latestAuction': 'b-a1'},
                {'id': 'Billboard', 'round': 3, 'latestAuction': 'b-a3'},
                {'id': 'Sticky', 'round': 2, 'latestAuction': 's-a2',
                 'bid': {'cpm': 4, 'auctionId': 's-a1', 'adUnitCode': 'Sticky'}},
            ],
            'fixtureBidTrace': [
                {'auctionId': 'b-a2', 'code': 'Billboard', 'bidder': 'pubmatic',
                 'requestId': 'b-request-2', 'round': 2},
                {'auctionId': 'b-a3', 'code': 'Billboard', 'bidder': 'pubmatic',
                 'requestId': 'b-request-3', 'round': 3},
            ],
            'nativeEvents': [
                {'eventType': 'auctionInit', 'auctionId': 'b-a2', 'code': 'Billboard'},
                {'eventType': 'auctionEnd', 'auctionId': 'b-a2', 'code': 'Billboard'},
            ],
            'deadline': {'expected': {'Billboard': [1, 2, 3, 4, 5], 'Sticky': [1, 2, 3, 4]},
                         'timeoutMs': 45000, 'elapsedMs': 45000},
            'pageErrors': [],
        }
        original = copy.deepcopy(observations)
        error = AssertionError('Missing Billboard round 2 in S 390 normal')
        receipt = DIAGNOSTICS.build_failure_receipt(scenario, error, observations)
        self.assertEqual(receipt['schemaVersion'], 1)
        self.assertIs(receipt['passed'], False)
        self.assertEqual(receipt['scenario'], scenario)
        self.assertEqual(receipt['failure'], {'type': 'AssertionError', 'message': str(error)})
        self.assertEqual(receipt['observations'], original)
        self.assertEqual(observations, original)
        self.assertEqual(scenario, {'arm': 'S', 'width': 390, 'case': 'normal'})
        # Persistence must retain both sides of the missing-round diagnosis.
        restored = json.loads(json.dumps(receipt))
        self.assertEqual(restored, receipt)
        self.assertEqual(restored['observations']['fixtureBidTrace'][0]['round'], 2)
        self.assertEqual([row['round'] for row in restored['observations']['requests']
                          if row['id'] == 'Billboard'], [1, 3])

    def test_empty_observations_still_record_the_actual_failure(self):
        error = RuntimeError('Native fixture failed before first request')
        receipt = DIAGNOSTICS.build_failure_receipt('S 390 normal', error, {})
        self.assertEqual(receipt['schemaVersion'], 1)
        self.assertIs(receipt['passed'], False)
        self.assertEqual(receipt['scenario'], 'S 390 normal')
        self.assertEqual(receipt['failure']['type'], 'RuntimeError')
        self.assertEqual(receipt['failure']['message'], str(error))
        self.assertEqual(receipt['observations'], {})
        json.dumps(receipt)


if __name__ == '__main__':
    unittest.main()
