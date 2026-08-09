"""Tests for the clarification-gate toggle wiring.

These tests exercise only the toggle / outcome logic.
judge_ambiguity is stubbed / injected so the tests remain hermetic.
"""

import unittest
from unittest.mock import patch

from clarification_gate.src.engine.clarity_check import (
    GateOutcome,
    OFF_MODE_SURFACES_FLAG,
    run_clarification_gate,
)


class TestClarificationGateToggle(unittest.TestCase):
    def test_on_ambiguous_bounces(self):
        with patch("clarification_gate.src.engine.clarity_check.judge_ambiguity", return_value=True):
            outcome = run_clarification_gate("anything", gate_enabled=True)
        self.assertEqual(outcome, GateOutcome.BOUNCE_BACK)

    def test_on_clear_proceeds(self):
        with patch("clarification_gate.src.engine.clarity_check.judge_ambiguity", return_value=False):
            outcome = run_clarification_gate("anything", gate_enabled=True)
        self.assertEqual(outcome, GateOutcome.CLEAR)

    def test_off_clear_proceeds(self):
        with patch("clarification_gate.src.engine.clarity_check.judge_ambiguity", return_value=False):
            outcome = run_clarification_gate("anything", gate_enabled=False)
        self.assertEqual(outcome, GateOutcome.CLEAR)

    def test_off_ambiguous_flagged_when_surface_flag_true(self):
        self.assertTrue(OFF_MODE_SURFACES_FLAG)
        with patch("clarification_gate.src.engine.clarity_check.judge_ambiguity", return_value=True):
            outcome = run_clarification_gate("anything", gate_enabled=False)
        self.assertEqual(outcome, GateOutcome.FLAGGED_PROCEED)

    def test_judge_ambiguity_raises_not_implemented(self):
        from clarification_gate.src.engine.clarity_check import judge_ambiguity
        with self.assertRaises(NotImplementedError):
            judge_ambiguity("anything")


if __name__ == "__main__":
    unittest.main()
