// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {ScoreMath} from "../contracts/lib/ScoreMath.sol";

/// @title ScoreMathTest
/// @notice Exhaustive tests for the ScoreMath piecewise-linear function
///         per SPEC.md §4.
///
/// Anchors (totalPoints → score):
///     0 →   0
///   100 → 100
///   300 → 400
///   700 → 700
///  1200 → 850   (cap)
///
/// Slopes within each segment (integer division → floor):
///   seg 1 [   0,  100]: dy/dx = 1/1   = 1.0
///   seg 2 ( 100,  300]: dy/dx = 3/2   = 1.5
///   seg 3 ( 300,  700]: dy/dx = 3/4   = 0.75
///   seg 4 ( 700, 1200]: dy/dx = 3/10  = 0.30
///
/// For p > 1200 the function saturates at 850.
/// For p ≤ 0 it returns 0.
contract ScoreMathTest is Test {
    uint64 internal constant MAX_SCORE = 850;

    // ─────────────────────── Anchor points ───────────────────────

    function test_computeScore_zero() public pure {
        assertEq(ScoreMath.computeScore(0), 0);
    }

    function test_computeScore_allAnchors() public pure {
        assertEq(ScoreMath.computeScore(0), 0, "anchor 0");
        assertEq(ScoreMath.computeScore(100), 100, "anchor 100");
        assertEq(ScoreMath.computeScore(300), 400, "anchor 300");
        assertEq(ScoreMath.computeScore(700), 700, "anchor 700");
        assertEq(ScoreMath.computeScore(1200), MAX_SCORE, "anchor 1200 (cap)");
    }

    // ─────────────────────── Boundaries: just-below, just-above ───────────────────────

    function test_computeScore_justBelowAnchors() public pure {
        // seg1 ends at 100 with slope 1 → p=99 gives 99.
        assertEq(ScoreMath.computeScore(99), 99, "99 on seg1");
        // seg2 ends at 300 with slope 3/2, floor.
        // p=299: 100 + (199 * 3) / 2 = 100 + 298 = 398
        assertEq(ScoreMath.computeScore(299), 398, "299 on seg2");
        // seg3 ends at 700 with slope 3/4, floor.
        // p=699: 400 + (399 * 3) / 4 = 400 + 299 = 699
        assertEq(ScoreMath.computeScore(699), 699, "699 on seg3");
        // seg4 ends at 1200 with slope 3/10, floor.
        // p=1199: 700 + (499 * 3) / 10 = 700 + 149 = 849
        assertEq(ScoreMath.computeScore(1199), 849, "1199 on seg4");
    }

    function test_computeScore_justAboveAnchors() public pure {
        assertEq(ScoreMath.computeScore(1), 1, "1 on seg1");
        // seg2 first step: 100 + (1*3)/2 = 100 + 1 = 101
        assertEq(ScoreMath.computeScore(101), 101, "101 on seg2");
        // seg3 first step: 400 + (1*3)/4 = 400 + 0 = 400
        assertEq(ScoreMath.computeScore(301), 400, "301 on seg3");
        // seg4 first step: 700 + (1*3)/10 = 700 + 0 = 700
        assertEq(ScoreMath.computeScore(701), 700, "701 on seg4");
    }

    /// @dev Verifies the function is continuous at every internal anchor —
    ///      both the end of the prior segment and the start of the next
    ///      evaluate to the anchor value.
    function test_computeScore_continuityAtAnchors() public pure {
        // Anchor 100: seg1 end and seg1 value must coincide at 100.
        assertEq(ScoreMath.computeScore(100), 100);
        // Anchor 300: seg2 evaluates to 400 at 300; seg3 also evaluates to 400 at 301 → 400.
        assertEq(ScoreMath.computeScore(300), 400);
        // Anchor 700: seg3 end value.
        assertEq(ScoreMath.computeScore(700), 700);
        // Anchor 1200: saturation boundary.
        assertEq(ScoreMath.computeScore(1200), MAX_SCORE);
    }

    // ─────────────────────── Saturation ───────────────────────

    function test_computeScore_capsAbove1200() public pure {
        assertEq(ScoreMath.computeScore(1201), MAX_SCORE);
        assertEq(ScoreMath.computeScore(5_000), MAX_SCORE);
        assertEq(ScoreMath.computeScore(type(int64).max), MAX_SCORE);
    }

    function test_computeScore_zeroForNonPositive() public pure {
        assertEq(ScoreMath.computeScore(-1), 0);
        assertEq(ScoreMath.computeScore(-1_000), 0);
        assertEq(ScoreMath.computeScore(type(int64).min), 0);
    }

    // ─────────────────────── Segment formulas (interior sweeps) ───────────────────────

    function test_computeScore_segment1_formula() public pure {
        // score = p for p in [0, 100]
        for (int64 p = 0; p <= 100; p++) {
            assertEq(ScoreMath.computeScore(p), uint64(uint256(int256(p))), "seg1");
        }
    }

    function test_computeScore_segment2_formula() public pure {
        // score = 100 + floor((p-100) * 3 / 2) for p in (100, 300]
        for (int64 p = 101; p <= 300; p++) {
            uint64 expected = 100 + uint64(uint256(int256(p - 100)) * 3 / 2);
            assertEq(ScoreMath.computeScore(p), expected, "seg2");
        }
    }

    function test_computeScore_segment3_formula() public pure {
        // score = 400 + floor((p-300) * 3 / 4) for p in (300, 700]
        for (int64 p = 301; p <= 700; p++) {
            uint64 expected = 400 + uint64(uint256(int256(p - 300)) * 3 / 4);
            assertEq(ScoreMath.computeScore(p), expected, "seg3");
        }
    }

    function test_computeScore_segment4_formula() public pure {
        // score = 700 + floor((p-700) * 3 / 10) for p in (700, 1200]
        for (int64 p = 701; p <= 1200; p++) {
            uint64 expected = 700 + uint64(uint256(int256(p - 700)) * 3 / 10);
            assertEq(ScoreMath.computeScore(p), expected, "seg4");
        }
    }

    // ─────────────────────── Invariants via fuzzing ───────────────────────

    function testFuzz_computeScore_boundedByMax(int64 p) public pure {
        assertLe(ScoreMath.computeScore(p), MAX_SCORE);
    }

    function testFuzz_computeScore_nonPositiveIsZero(int64 p) public pure {
        vm.assume(p <= 0);
        assertEq(ScoreMath.computeScore(p), 0);
    }

    function testFuzz_computeScore_saturatesAtOrAbove1200(int64 p) public pure {
        vm.assume(p >= 1200);
        assertEq(ScoreMath.computeScore(p), MAX_SCORE);
    }

    /// @notice computeScore is monotonically non-decreasing on the positive
    ///         domain. If a + 1 has strictly lower score than a, something
    ///         is broken in a segment's formula.
    function testFuzz_computeScore_monotonic(int64 a) public pure {
        a = int64(bound(int256(a), 0, 1199));
        int64 b = a + 1;
        assertLe(ScoreMath.computeScore(a), ScoreMath.computeScore(b));
    }

    // ─────────────────────── Named reference values ───────────────────────

    /// @dev Values taken directly from SPEC.md §5.1 worked calculations.
    ///      Any drift here means the curve no longer matches the documented
    ///      spec and external verifiers will reject indexer proposals.
    function test_computeScore_referenceTable() public pure {
        // Boundary + stake grant
        assertEq(ScoreMath.computeScore(100), 100, "stake grant");

        // Participation boost segment
        assertEq(ScoreMath.computeScore(200), 250, "light user");

        // Steady segment
        assertEq(ScoreMath.computeScore(360), 445, "defaulter");
        assertEq(ScoreMath.computeScore(410), 482, "typical");
        assertEq(ScoreMath.computeScore(610), 632, "loans-alone max");
        assertEq(ScoreMath.computeScore(690), 692, "pure-participation ceiling");

        // Saturation segment
        assertEq(ScoreMath.computeScore(720), 706, "modest borrower");
        assertEq(ScoreMath.computeScore(840), 742, "established");
        assertEq(ScoreMath.computeScore(1200), 850, "elite / absolute max");
    }
}
