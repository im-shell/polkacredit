/**
 * Piecewise-linear points → score mapping per SPEC.md §4.
 *
 *    0   pts →   0
 *    100 pts → 100   (slope 1.0)
 *    300 pts → 400   (slope 1.5, participation boost)
 *    700 pts → 700   (slope 0.75, steady)
 *   1200 pts → 850   (slope 0.30, saturation)
 *   1200+    → 850   (clamped)
 *
 * Integer arithmetic: uses floor division so outputs match SPEC.md §5.1
 * worked examples exactly, and the on-chain `ScoreMath.computeScore`
 * reference implementation stays bit-identical.
 */
export function computeScore(totalPoints: number): number {
  if (totalPoints <= 0) return 0;
  if (totalPoints >= 1200) return 850;

  if (totalPoints <= 100) return totalPoints;
  if (totalPoints <= 300) return 100 + Math.floor(((totalPoints - 100) * 3) / 2);
  if (totalPoints <= 700) return 400 + Math.floor(((totalPoints - 300) * 3) / 4);
  return 700 + Math.floor(((totalPoints - 700) * 3) / 10);
}

import { createHash } from "node:crypto";

/// String tag baked into computationHash. Bump whenever the scoring
/// algorithm or leaf serialization changes so consumers can tell old
/// commitments apart from new ones.
export const ALGORITHM_VERSION = "2.0.0";

/// Numeric version tag posted on-chain with each proposal.
export const ALGORITHM_VERSION_ID = 2;

/**
 * Deterministic hash of the inputs used to compute a score. External parties
 * re-run the algorithm against the same raw events and recompute the same
 * hash as a verification check.
 */
export function computationHash(
  popId: string,
  totalPoints: number,
  blockNumber: number
): string {
  const h = createHash("sha256");
  h.update(ALGORITHM_VERSION);
  h.update(popId);
  h.update(String(totalPoints));
  h.update(String(blockNumber));
  return "0x" + h.digest("hex");
}
