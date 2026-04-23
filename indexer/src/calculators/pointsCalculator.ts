/**
 * Points calculator — canonical implementation of SPEC.md §2 and §3.
 *
 * Pure function of its input event log: same events in → same point total
 * out. This is the algorithm external verifiers re-run against the raw
 * event stream to challenge a posted score.
 *
 * The calculator consumes *synthetic* event types that listeners produce
 * after parsing contract logs — e.g. one `VouchOpened_vouchee` marker per
 * vouch open, one `VouchResolvedSuccess_vouchee` / `_voucher` pair per
 * successful resolve, one `LoanRepaid` per tier-crossing repayment. This
 * keeps the calculator ignorant of which contract emitted what, and
 * makes the translation layer (listeners) the only place that needs
 * updating when contract ABIs change.
 *
 * SPEC §2.3 refinement (deferred-credit model): vouch_received points
 * are NOT awarded at `VouchOpened_vouchee`. Both `vouch_received` (to
 * vouchee) and `vouch_given` (to voucher) are minted on
 * `VouchResolvedSuccess_*` events only. Failure / default events never
 * produce point changes; the deterrent is the stake slash, which is a
 * stablecoin transfer outside the point ledger.
 */

export type ReasonCode =
  | "stake_first"
  | "vouch_given"
  | "vouch_received"
  | "vouch_given_clawback"
  | "vouch_received_clawback"
  | "opengov_vote"
  | "transfer_band"
  | "loan_band"
  | "loan_default"
  | "default_vouch_clawback"
  | "inactivity";

export interface EventInput {
  source: "polkacredit" | "opengov";
  event_type: string;
  account: string;
  block_number: number;
  block_timestamp: number;
  data: Record<string, any>;
}

export interface PointAward {
  account: string;
  amount: number;
  reason: ReasonCode;
  block_number: number;
  source_event_id?: number;
}

// Block constants (12 s/block on Polkadot relay cadence).
const BLOCKS_PER_DAY = 7_200;

/** Flat point values, per SPEC.md §2. */
export const POINTS = {
  GOV_VOTE: 5,

  LOAN_DEFAULT: -100,
  INACTIVITY_PER_WEEK: -5,
};

/**
 * Stake-deposit points as a function of the base stake tier (USD).
 * Sublinear: 10× capital → 2.5× points. Prevents wealth-for-score gaming.
 * See SPEC.md §2.1.
 */
export function pointsForStakeTier(stakeAmount: number): number {
  if (stakeAmount >= 10_000) return 100;
  if (stakeAmount >= 5_000) return 70;
  if (stakeAmount >= 1_000) return 40;
  return 0;
}

/**
 * Per-vouch point value as a function of the voucher's committed stake (USD).
 * Identical on both sides: voucher on successful resolve, vouchee at vouch-open.
 * See SPEC.md §2.2.
 */
export function pointsForCommittedStake(committedStake: number): number {
  if (committedStake >= 10_000) return 80;
  if (committedStake >= 5_000) return 60;
  if (committedStake >= 1_000) return 40;
  return 0;
}

/** Transfer volume → point award for crossing that band (once per band). */
export function pointsForTransferBand(band: number): number {
  if (band >= 1_000_000) return 40;
  if (band >= 100_000) return 30;
  if (band >= 10_000) return 20;
  if (band >= 1_000) return 10;
  return 0;
}

/** Loan amount → point award for crossing that tier (once per tier). */
export function pointsForLoanBand(band: number): number {
  if (band >= 1_000_000) return 210;
  if (band >= 500_000) return 150;
  if (band >= 100_000) return 80;
  if (band >= 50_000) return 40;
  if (band >= 10_000) return 20;
  if (band >= 1_000) return 10;
  return 0;
}

/** Lifetime caps and gating thresholds. */
export const CAPS = {
  VOUCH_GIVEN_TOTAL: 200,
  VOUCH_RECEIVED_VOUCHERS: 3,
  GOV_VOTES_LIFETIME: 10,

  GOV_MIN_CONVICTION: 1,
  GOV_MIN_DOT_COMMITTED: 5,

  INACTIVITY_GRACE_DAYS: 90,
};

/**
 * Per-pop scoring state. `scoreSingleEvent` both reads and mutates this.
 * Keys are flat strings so the state can be persisted or reloaded trivially
 * from a key/value store or reconstructed from prior raw_events.
 */
export interface ScoringContext {
  counters: Record<string, number>;
}

function get(ctx: ScoringContext, key: string): number {
  return ctx.counters[key] ?? 0;
}

function set(ctx: ScoringContext, key: string, v: number) {
  ctx.counters[key] = v;
}

/// Convert a stable amount to whole-dollar USD for tier lookup.
/// Accepts raw 18-decimal wei (bigint / string / number) or a pre-scaled
/// whole-dollar number < 1e6 (legacy synthetic-event path).
function toUsd(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0 && asNum < 1_000_000) return asNum;
  try {
    return Number(BigInt(String(raw)) / 10n ** 18n);
  } catch {
    return 0;
  }
}

/**
 * Score a single event in isolation, enforcing lifetime caps via `ctx`.
 * Returns `null` if the event produces no point delta (capped out,
 * below threshold, duplicate tier, etc.).
 */
export function scoreSingleEvent(
  ev: EventInput,
  ctx: ScoringContext
): PointAward | null {
  const make = (amount: number, reason: ReasonCode): PointAward => ({
    account: ev.account,
    amount,
    reason,
    block_number: ev.block_number,
  });

  if (ev.source === "polkacredit") {
    switch (ev.event_type) {
      case "Staked": {
        if (get(ctx, "stake_first_seen") === 1) return null;
        // `amount` is the staked amount in stablecoin base units (18 decimals).
        // Convert to USD dollars to look up the tier.
        const amountWei = BigInt(ev.data.amount ?? 0);
        const amountUsd = Number(amountWei / 10n ** 18n);
        const pts = pointsForStakeTier(amountUsd);
        if (pts === 0) return null;
        set(ctx, "stake_first_seen", 1);
        return make(pts, "stake_first");
      }

      case "VouchOpened_vouchee": {
        // Deferred-credit model (SPEC §2.3 refinement): no mint happens at
        // vouch-open. The 3-distinct-voucher cap is enforced on-chain at
        // vouch() time. Marker event only — returns no points.
        return null;
      }

      case "VouchResolvedSuccess_vouchee": {
        // Deferred-credit: vouch_received is minted HERE, on success, not
        // at open. Cap on distinct credited vouchers enforced by the
        // calculator's counter (matches on-chain distinctVouchersCount
        // ceiling of 3).
        if (get(ctx, "vouch_received_vouchers") >= CAPS.VOUCH_RECEIVED_VOUCHERS)
          return null;
        const committedUsd = toUsd(ev.data.committedStake);
        const pts = pointsForCommittedStake(committedUsd);
        if (pts === 0) return null;
        set(ctx, "vouch_received_vouchers", get(ctx, "vouch_received_vouchers") + 1);
        return make(pts, "vouch_received");
      }

      case "VouchResolvedSuccess_voucher": {
        const committedUsd = toUsd(ev.data.committedStake);
        const pts = pointsForCommittedStake(committedUsd);
        if (pts === 0) return null;
        const already = get(ctx, "vouch_given_total");
        const remaining = CAPS.VOUCH_GIVEN_TOTAL - already;
        if (remaining <= 0) return null;
        const credit = Math.min(pts, remaining);
        set(ctx, "vouch_given_total", already + credit);
        return make(credit, "vouch_given");
      }

      case "VouchResolvedFail_voucher": {
        // Deferred-credit: voucher's credit is only minted on success, so
        // an Active→Failed transition has no vouch_given credit to claw
        // back. The -2× rule from the original SPEC is void under this
        // model — only the committed stake slash applies (off-ledger, in
        // stablecoin via StakingVault, not a point event).
        return null;
      }

      case "VouchResolvedFail_vouchee": {
        // Deferred-credit: no front-load existed, so nothing to claw back
        // from the vouchee side on failure.
        return null;
      }

      case "TransferVolumeThreshold": {
        const band = Number(ev.data.band ?? 0);
        const key = `transfer_band_${band}`;
        if (get(ctx, key) === 1) return null;
        const pts = pointsForTransferBand(band);
        if (pts === 0) return null;
        set(ctx, key, 1);
        return make(pts, "transfer_band");
      }

      case "LoanRepaid": {
        const band = Number(ev.data.band ?? 0);
        const key = `loan_band_${band}`;
        if (get(ctx, key) === 1) return null;
        const pts = pointsForLoanBand(band);
        if (pts === 0) return null;
        set(ctx, key, 1);
        return make(pts, "loan_band");
      }

      case "LoanDefaulted": {
        // Clawback of active-vouch front-loads is expressed as separate
        // `VouchResolvedFail_vouchee` events emitted alongside the default
        // by the listener. This event only carries the flat -100.
        return make(POINTS.LOAN_DEFAULT, "loan_default");
      }

      default:
        return null;
    }
  }

  if (ev.source === "opengov") {
    if (ev.event_type !== "Voted") return null;

    const conviction = Number(ev.data.conviction ?? 0);
    const dotCommitted = Number(ev.data.dotCommitted ?? 0);
    if (conviction < CAPS.GOV_MIN_CONVICTION) return null;
    if (dotCommitted < CAPS.GOV_MIN_DOT_COMMITTED) return null;

    if (get(ctx, "gov_votes_count") >= CAPS.GOV_VOTES_LIFETIME) return null;
    set(ctx, "gov_votes_count", get(ctx, "gov_votes_count") + 1);
    return make(POINTS.GOV_VOTE, "opengov_vote");
  }

  return null;
}

/**
 * Given all events for every account, compute the running point total.
 * Reference implementation for the verifier script and for offline
 * reproducibility checks against on-chain scores.
 */
export function computePoints(events: EventInput[], currentBlock: number): number {
  const byPop = new Map<string, EventInput[]>();
  for (const ev of events) {
    const list = byPop.get(ev.account) ?? [];
    list.push(ev);
    byPop.set(ev.account, list);
  }

  let total = 0;
  for (const [, popEvents] of byPop) {
    const ctx: ScoringContext = { counters: {} };
    popEvents.sort((a, b) => a.block_number - b.block_number);

    for (const ev of popEvents) {
      const award = scoreSingleEvent(ev, ctx);
      if (award) total += award.amount;
    }

    // Inactivity penalty: -5/week after the 90-day grace from last event.
    // No floor — score can go negative per SPEC.md §3.3.
    const lastBlock = popEvents.length
      ? popEvents[popEvents.length - 1].block_number
      : 0;
    const daysSince = (currentBlock - lastBlock) / BLOCKS_PER_DAY;
    if (daysSince > CAPS.INACTIVITY_GRACE_DAYS) {
      const inactiveWeeks = Math.floor((daysSince - CAPS.INACTIVITY_GRACE_DAYS) / 7);
      total += inactiveWeeks * POINTS.INACTIVITY_PER_WEEK;
    }
  }
  return total;
}

/**
 * Reconstruct a pop's ScoringContext from its prior processed events.
 * Used by pointsJob on startup / per-batch so lifetime caps survive
 * restarts without a dedicated counter table.
 */
export function rebuildContext(priorEvents: EventInput[]): ScoringContext {
  const ctx: ScoringContext = { counters: {} };
  const sorted = [...priorEvents].sort((a, b) => a.block_number - b.block_number);
  for (const ev of sorted) scoreSingleEvent(ev, ctx);
  return ctx;
}
