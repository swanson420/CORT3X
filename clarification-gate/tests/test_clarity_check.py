"""Tests for the clarification-gate toggle wiring.

These tests exercise only the toggle / outcome logic.
judge_ambiguity is stubbed / injected so the tests remain hermetic.
"""

import unittest
from unittest.mock import patch

from src.engine.clarity_check import (
    ClarityResult,
    OFF_MODE_SURFACES_FLAG,
    AmbiguityJudgment,
    run_clarification_gate,
)


def _judgment(is_ambiguous):
    return AmbiguityJudgment(is_ambiguous=is_ambiguous)


class TestClarificationGateToggle(unittest.TestCase):
    def test_on_ambiguous_bounces(self):
        with patch("src.engine.clarity_check.judge_ambiguity",
                   return_value=_judgment(True)):
            outcome = run_clarification_gate("anything", gate_enabled=True)
        self.assertEqual(outcome.result, ClarityResult.BOUNCE_BACK)

    def test_on_clear_proceeds(self):
        with patch("src.engine.clarity_check.judge_ambiguity",
                   return_value=_judgment(False)):
            outcome = run_clarification_gate("anything", gate_enabled=True)
        self.assertEqual(outcome.result, ClarityResult.CLEAR)

    def test_off_clear_proceeds(self):
        with patch("src.engine.clarity_check.judge_ambiguity",
                   return_value=_judgment(False)):
            outcome = run_clarification_gate("anything", gate_enabled=False)
        self.assertEqual(outcome.result, ClarityResult.CLEAR)

    def test_off_ambiguous_flagged_when_surface_flag_true(self):
        self.assertTrue(OFF_MODE_SURFACES_FLAG)
        with patch("src.engine.clarity_check.judge_ambiguity",
                   return_value=_judgment(True)):
            outcome = run_clarification_gate("anything", gate_enabled=False)
        self.assertEqual(outcome.result, ClarityResult.FLAGGED_PROCEED)

    def test_judge_ambiguity_raises_not_implemented(self):
        from src.engine.clarity_check import judge_ambiguity
        with self.assertRaises(NotImplementedError):
            judge_ambiguity("anything")


if __name__ == "__main__":
    unittest.main()
