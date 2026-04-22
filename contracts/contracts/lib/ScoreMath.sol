// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title ScoreMath
/// @notice On-chain reference implementation of the points → score mapping.
/// @dev Matches `computeScore` in `indexer/src/calculators/scoreCalculator.ts`
///      and the curve in `SPEC.md` §4.
///
///      Piecewise linear:
///        [   0,  100]  slope 1.0    anchor   0 →   0, 100 → 100
///        ( 100,  300]  slope 1.5    anchor 100 → 100, 300 → 400
///        ( 300,  700]  slope 0.75   anchor 300 → 400, 700 → 700
///        ( 700, 1200]  slope 0.30   anchor 700 → 700, 1200 → 850
///        (1200,    ∞)  saturated at 850
///
///      Integer arithmetic uses floor division; `(dx * num) / den` ordering
///      preserves precision and matches the off-chain TS implementation
///      bit-for-bit so WrongArithmetic disputes resolve identically on
///      either side.
library ScoreMath {
    uint64 internal constant MAX_SCORE = 850;

    function computeScore(int64 totalPoints) internal pure returns (uint64) {
        if (totalPoints <= 0) return 0;
        if (totalPoints >= 1200) return MAX_SCORE;

        uint64 p = uint64(totalPoints);
        if (p <= 100) return p;
        if (p <= 300) return 100 + ((p - 100) * 3) / 2;
        if (p <= 700) return 400 + ((p - 300) * 3) / 4;
        return 700 + ((p - 700) * 3) / 10;
    }
}
