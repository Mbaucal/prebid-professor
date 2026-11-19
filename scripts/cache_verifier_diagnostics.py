"""Strict request lookup and failure receipts for isolated cache browser checks."""
import copy


def require_request(rows, code, round_number, scenario):
    """An absent or ambiguous round is a failed check, never an inferred row."""
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise AssertionError(f"Invalid GAM request observations: {scenario!r}")
    candidates = [row for row in rows if row.get('id') == code]
    matches = [row for row in candidates
               if type(row.get('round')) is int and row['round'] == round_number]
    if len(matches) != 1:
        observed = [row.get('round') for row in candidates]
        reason = 'missing' if not matches else 'duplicate'
        raise AssertionError(
            f"{reason}: expected exactly one GAM request for slot={code} round={round_number}; "
            f"found={len(matches)} observedRounds={observed!r} scenario={scenario!r}"
        )
    return copy.deepcopy(matches[0])


def build_failure_receipt(scenario, error, observations):
    """Keep the failed chronology separate from successful browser reports."""
    return {
        'schemaVersion': 1,
        'passed': False,
        'scope': 'CI loopback; synthetic demand only; no live ad traffic',
        'scenario': copy.deepcopy(scenario),
        'failure': {'type': type(error).__name__, 'message': str(error)},
        'observations': copy.deepcopy(observations),
    }
