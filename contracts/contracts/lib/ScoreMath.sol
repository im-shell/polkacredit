// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ScoreMath
/// @notice On-chain reference implementation of the points → score mapping.
/// @dev Matches `computeScore` in `indexer/src/calculators/scoreCalculator.ts`.
///      Piecewise linear: 0→0, 50→100, 100→200, 250→500, 500→850.
library ScoreMath {
    uint64 internal constant MAX_SCORE = 850;

    function computeScore(int64 totalPoints) internal pure returns (uint64) {
        if (totalPoints <= 0) return 0;
        if (totalPoints >= 500) return MAX_SCORE;

        uint64 p = uint64(totalPoints);
        if (p < 50) return (p * 100) / 50;
        if (p < 100) return 100 + ((p - 50) * 100) / 50;
        if (p < 250) return 200 + ((p - 100) * 300) / 150;
        return 500 + ((p - 250) * 350) / 250;
    }
}
