/**
 * PolkaCredit point-engine simulation.
 *
 * Drives the pure `pointsCalculator` against hand-constructed event streams
 * for six personas and ten adversarial probes. Every expected total is
 * derived directly from SPEC.md §2–§5 and hard-coded here so any drift in
 * the calculator trips an assertion.
 *
 * Run with:    npx tsx src/scripts/simulate.ts
 */

import assert from "node:assert/strict";
import {
  computePoints,
  scoreSingleEvent,
  type EventInput,
  type ScoringContext,
} from "../calculators/pointsCalculator.js";
import { computeScore } from "../calculators/scoreCalculator.js";

// Block cadence: same constant the calculator uses (12 s / block).
const BLOCKS_PER_DAY = 7_200;

// ─────────────────────── helpers ───────────────────────

let BLOCK = 100_000;
const nextBlock = (): number => (BLOCK += 100);

type EventInit = {
  source: "polkacredit" | "opengov";
  event_type: string;
  account: string;
  data?: Record<string, unknown>;
  block_number?: number;
};

const ev = (e: EventInit): EventInput => ({
  source: e.source,
  event_type: e.event_type,
  account: e.account,
  block_number: e.block_number ?? nextBlock(),
  block_timestamp: 0,
  data: (e.data ?? {}) as Record<string, unknown>,
});

const staked = (pop: string): EventInput =>
  ev({ source: "polkacredit", event_type: "Staked", account: pop });

const voted = (pop: string, conviction = 1, dotCommitted = 5): EventInput =>
  ev({
    source: "opengov",
    event_type: "Voted",
    account: pop,
    data: { conviction, dotCommitted },
  });

const vouchOpened = (pop: string, committedStake: number): EventInput =>
  ev({
    source: "polkacredit",
    event_type: "VouchOpened_vouchee",
    account: pop,
    data: { committedStake },
  });

const vouchResolvedOk = (pop: string, committedStake: number): EventInput =>
  ev({
    source: "polkacredit",
    event_type: "VouchResolvedSuccess_voucher",
    account: pop,
    data: { committedStake },
  });

const vouchResolvedFailVouchee = (pop: string, credited: number): EventInput =>
  ev({
    source: "polkacredit",
    event_type: "VouchResolvedFail_vouchee",
    account: pop,
    data: { creditedAmount: credited },
  });

const vouchResolvedFailVoucher = (pop: string, credited: number): EventInput =>
  ev({
    source: "polkacredit",
    event_type: "VouchResolvedFail_voucher",
    account: pop,
    data: { creditedAmount: credited },
  });

const transferBand = (pop: string, band: number): EventInput =>
  ev({
    source: "polkacredit",
    event_type: "TransferVolumeThreshold",
    account: pop,
    data: { band },
  });

const loanRepaid = (pop: string, band: number): EventInput =>
  ev({
    source: "polkacredit",
    event_type: "LoanRepaid",
    account: pop,
    data: { band },
  });

const loanDefault = (pop: string): EventInput =>
  ev({ source: "polkacredit", event_type: "LoanDefaulted", account: pop });

// ─────────────────────── personas ───────────────────────

type Persona = {
  id: string;
  summary: string;
  events: EventInput[];
  currentBlock: number;
  expectedPoints: number;
  expectedScore: number;
};

const makeWhale = (): Persona => {
  const pop = "WHALE";
  const es: EventInput[] = [];

  // Stake (+100).
  es.push(staked(pop));

  // Receive 3 whale vouches — front-loaded +80 each = +240 (cap on vouch-received).
  for (let i = 0; i < 3; i++) es.push(vouchOpened(pop, 10_000));

  // Give 3 whale vouches — on-resolve +80/+80/+40(truncated at 200 cap).
  for (let i = 0; i < 3; i++) es.push(vouchResolvedOk(pop, 10_000));

  // 10 governance votes at max conviction — +50.
  for (let i = 0; i < 10; i++) es.push(voted(pop));

  // Cross every transfer band — +10+20+30+40 = +100.
  for (const b of [1_000, 10_000, 100_000, 1_000_000]) es.push(transferBand(pop, b));

  // Repay across every loan tier — +10+20+40+80+150+210 = +510.
  for (const b of [1_000, 10_000, 50_000, 100_000, 500_000, 1_000_000]) {
    es.push(loanRepaid(pop, b));
  }

  // Total: 100 + 240 + 200 + 50 + 100 + 510 = 1200 → saturates at 850.
  return {
    id: pop,
    summary: "absolute-max profile: stake + max vouch both sides + full gov/transfers/loans",
    events: es,
    currentBlock: es[es.length - 1].block_number + BLOCKS_PER_DAY,
    expectedPoints: 1_200,
    expectedScore: 850,
  };
};

const makeNormal = (): Persona => {
  const pop = "NORMAL";
  const es: EventInput[] = [];
  es.push(staked(pop));

  // 2 medium vouches received — 2 × +40 = +80.
  for (let i = 0; i < 2; i++) es.push(vouchOpened(pop, 1_000));

  // 2 medium vouches given on-resolve — 2 × +40 = +80.
  for (let i = 0; i < 2; i++) es.push(vouchResolvedOk(pop, 1_000));

  // 3 gov votes — +15.
  for (let i = 0; i < 3; i++) es.push(voted(pop));

  // $10K transfer crossings — +10 + +20 = +30.
  for (const b of [1_000, 10_000]) es.push(transferBand(pop, b));

  // $10K loan repaid — +10 + +20 = +30.
  for (const b of [1_000, 10_000]) es.push(loanRepaid(pop, b));

  // Total: 100 + 80 + 80 + 15 + 30 + 30 = 335.
  // score(335) = 400 + (335-300) * 3/4 = 400 + 26 = 426.
  return {
    id: pop,
    summary: "mid-profile active user: stake + mid vouch both sides + light gov/transfers/loan",
    events: es,
    currentBlock: es[es.length - 1].block_number + BLOCKS_PER_DAY,
    expectedPoints: 335,
    expectedScore: 426,
  };
};

const makeVoucheeSuccess = (): Persona => {
  const pop = "VOUCHEE_OK";
  const es: EventInput[] = [];
  es.push(staked(pop));

  // 1 small vouch received — +20 front-loaded.
  es.push(vouchOpened(pop, 200));

  // 10 gov votes — +50 (meets the ≥50 in-window success threshold).
  for (let i = 0; i < 10; i++) es.push(voted(pop));

  // Voucher on the other side gets VouchResolvedSuccess for them, but that's
  // credited to the *voucher's* pop, not this one. No further delta here.
  // Total: 100 + 20 + 50 = 170. score(170) = 100 + 70*3/2 = 205.
  return {
    id: pop,
    summary: "vouchee who hits the +50 threshold; front-load stays, voucher will earn on-resolve",
    events: es,
    currentBlock: es[es.length - 1].block_number + BLOCKS_PER_DAY,
    expectedPoints: 170,
    expectedScore: 205,
  };
};

const makeVoucheeFail = (): Persona => {
  const pop = "VOUCHEE_FAIL";
  const es: EventInput[] = [];
  es.push(staked(pop));

  // Received 1 medium vouch: +40 front-load.
  es.push(vouchOpened(pop, 1_000));

  // Never reaches +50 in-window → listener emits VouchResolvedFail_vouchee
  // with creditedAmount=40, which is the -1× front-load clawback.
  es.push(vouchResolvedFailVouchee(pop, 40));

  // Total: 100 + 40 - 40 = 100. score(100) = 100.
  return {
    id: pop,
    summary: "vouchee who fails the +50 threshold; front-load clawed back at -1×",
    events: es,
    currentBlock: es[es.length - 1].block_number + BLOCKS_PER_DAY,
    expectedPoints: 100,
    expectedScore: 100,
  };
};

const makeDefaulter = (): Persona => {
  const pop = "DEFAULTER";
  const es: EventInput[] = [];
  es.push(staked(pop));

  // Received 1 medium vouch: +40 front-load.
  es.push(vouchOpened(pop, 1_000));

  // Repaid a $10K loan earlier (so they had real score): +10 + +20 = +30.
  for (const b of [1_000, 10_000]) es.push(loanRepaid(pop, b));

  // Then defaults on a bigger loan: -100 flat.
  es.push(loanDefault(pop));

  // Active-vouch clawback (front-load clawed from defaulter): -40.
  es.push(vouchResolvedFailVouchee(pop, 40));

  // Total: 100 + 40 + 30 - 100 - 40 = 30. score(30) = 30.
  return {
    id: pop,
    summary: "stake + front-load + small repaid loan + self-default + active-vouch clawback",
    events: es,
    currentBlock: es[es.length - 1].block_number + BLOCKS_PER_DAY,
    expectedPoints: 30,
    expectedScore: 30,
  };
};

const makeIdle = (): Persona => {
  const pop = "IDLE";
  const stakeBlock = nextBlock();
  const es: EventInput[] = [
    ev({ source: "polkacredit", event_type: "Staked", account: pop, block_number: stakeBlock }),
  ];
  // currentBlock = stake + 125 days → 90-day grace + 35 days → floor(35/7) = 5 weeks.
  const currentBlock = stakeBlock + 125 * BLOCKS_PER_DAY;

  // Total: 100 - 5*5 = 75. score(75) = 75.
  return {
    id: pop,
    summary: "stake and vanish; 125 days of silence → 5 inactivity weeks past grace",
    events: es,
    currentBlock,
    expectedPoints: 75,
    expectedScore: 75,
  };
};

// ─────────────────────── vulnerability probes ───────────────────────

type Probe = {
  id: string;
  description: string;
  run: () => { got: number; expect: number };
  /// For "known limitation" probes: marks the behaviour as a vulnerability
  /// whose mitigation lives upstream of the calculator (contract / listener).
  limitation?: string;
};

const freshCtx = (): ScoringContext => ({ counters: {} });

const runOne = (events: EventInput[], ctx: ScoringContext) => {
  let total = 0;
  for (const e of events.sort((a, b) => a.block_number - b.block_number)) {
    const award = scoreSingleEvent(e, ctx);
    if (award) total += award.amount;
  }
  return total;
};

const probes: Probe[] = [
  {
    id: "double-stake",
    description: "two Staked events → only the first grants +100",
    run: () => {
      const pop = "P";
      const es = [staked(pop), staked(pop)];
      return { got: runOne(es, freshCtx()), expect: 100 };
    },
  },
  {
    id: "vouch-received-cap",
    description: "4 vouchers (all whale) → 3×80=240 cap, 4th ignored",
    run: () => {
      const pop = "P";
      const es = Array.from({ length: 4 }, () => vouchOpened(pop, 10_000));
      return { got: runOne(es, freshCtx()), expect: 240 };
    },
  },
  {
    id: "vouch-given-truncation",
    description: "3 whale vouches resolved → 80+80+40 = 200 cap (not 240)",
    run: () => {
      const pop = "P";
      const es = Array.from({ length: 3 }, () => vouchResolvedOk(pop, 10_000));
      return { got: runOne(es, freshCtx()), expect: 200 };
    },
  },
  {
    id: "gov-vote-cap",
    description: "11 votes → cap at 10 × 5 = 50, 11th ignored",
    run: () => {
      const pop = "P";
      const es = Array.from({ length: 11 }, () => voted(pop));
      return { got: runOne(es, freshCtx()), expect: 50 };
    },
  },
  {
    id: "gov-subthreshold",
    description: "votes below conviction/DOT thresholds award nothing",
    run: () => {
      const pop = "P";
      const es = [voted(pop, 0, 5), voted(pop, 1, 4), voted(pop, 0, 0)];
      return { got: runOne(es, freshCtx()), expect: 0 };
    },
  },
  {
    id: "loan-tier-double-claim",
    description: "two $10K loan repayments → only one tier credit",
    run: () => {
      const pop = "P";
      const es = [loanRepaid(pop, 10_000), loanRepaid(pop, 10_000)];
      return { got: runOne(es, freshCtx()), expect: 20 };
    },
  },
  {
    id: "transfer-band-double-claim",
    description: "two $1K transfer crossings → only one band credit",
    run: () => {
      const pop = "P";
      const es = [transferBand(pop, 1_000), transferBand(pop, 1_000)];
      return { got: runOne(es, freshCtx()), expect: 10 };
    },
  },
  {
    id: "negative-clamp-score",
    description: "points can go negative; score clamps to 0",
    run: () => {
      const pop = "P";
      const es = [staked(pop), loanDefault(pop), loanDefault(pop)]; // 100 - 200 = -100
      const pts = runOne(es, freshCtx());
      // Assert on score, not points — the clamp is a score-curve behaviour.
      return { got: computeScore(pts), expect: 0 };
    },
  },
  {
    id: "clawback-uses-credited-not-sticker",
    description: "failed vouch after truncation: clawback is 2× credited (40), not 2× sticker (80)",
    run: () => {
      // Whale voucher at cap: 80 + 80 + 40(trunc) = 200. Then the 3rd vouch fails.
      // The listener would emit VouchResolvedFail_voucher with creditedAmount=40.
      const pop = "P";
      const es = [
        vouchResolvedOk(pop, 10_000),
        vouchResolvedOk(pop, 10_000),
        vouchResolvedOk(pop, 10_000), // credited as +40 (truncated)
        vouchResolvedFailVoucher(pop, 40), // clawback: -2 * 40 = -80
      ];
      // 80 + 80 + 40 - 80 = 120.
      return { got: runOne(es, freshCtx()), expect: 120 };
    },
  },
  {
    id: "re-vouch-same-pair-passthrough",
    description:
      "calculator does NOT enforce (voucher,vouchee) lifetime uniqueness — duplicate resolve events credit twice",
    run: () => {
      // Two VouchResolvedSuccess_voucher events with same tier: calculator
      // credits +40 × 2 = +80. Uniqueness must be enforced upstream.
      const pop = "P";
      const es = [vouchResolvedOk(pop, 1_000), vouchResolvedOk(pop, 1_000)];
      return { got: runOne(es, freshCtx()), expect: 80 };
    },
    limitation:
      "SPEC.md §2.2 per-pair-once rule is not enforced here. Must be enforced by VouchRegistry (contract) or the listener that emits synthetic events.",
  },
];

// ─────────────────────── run ───────────────────────

function fmtRow(cells: string[], widths: number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i])).join(" │ ");
}

function hr(widths: number[]): string {
  return widths.map((w) => "─".repeat(w)).join("─┼─");
}

const personas: Persona[] = [
  makeWhale(),
  makeNormal(),
  makeVoucheeSuccess(),
  makeVoucheeFail(),
  makeDefaulter(),
  makeIdle(),
];

let failures = 0;

console.log("\n=== Persona scenarios ===\n");

const W = [14, 6, 6, 6, 6, 60];
console.log(fmtRow(["persona", "pts", "exp", "score", "exp", "summary"], W));
console.log(hr(W));

for (const p of personas) {
  const pts = computePoints(p.events, p.currentBlock);
  const score = computeScore(pts);
  const ok = pts === p.expectedPoints && score === p.expectedScore;
  const mark = ok ? "✓" : "✗";
  console.log(
    `${mark} ` +
      fmtRow(
        [
          p.id,
          String(pts),
          String(p.expectedPoints),
          String(score),
          String(p.expectedScore),
          p.summary,
        ],
        W
      )
  );
  if (!ok) {
    failures++;
    console.log(
      `  └─ MISMATCH — got points=${pts} score=${score}; expected points=${p.expectedPoints} score=${p.expectedScore}`
    );
  }
}

console.log("\n=== Vulnerability / invariant probes ===\n");

const PW = [30, 8, 8, 60];
console.log(fmtRow(["probe", "got", "expect", "description"], PW));
console.log(hr(PW));

for (const probe of probes) {
  const { got, expect } = probe.run();
  const ok = got === expect;
  const mark = ok ? "✓" : "✗";
  const tag = probe.limitation ? " [known upstream requirement]" : "";
  console.log(
    `${mark} ` +
      fmtRow(
        [probe.id, String(got), String(expect), probe.description + tag],
        PW
      )
  );
  if (!ok) {
    failures++;
    console.log(`  └─ MISMATCH`);
  }
  if (probe.limitation) {
    console.log(`    note: ${probe.limitation}`);
  }
}

// Hard-fail on any mismatch so CI / the verifier pipeline catches it.
if (failures > 0) {
  console.error(`\n✘ ${failures} failing scenario${failures === 1 ? "" : "s"}`);
  process.exit(1);
} else {
  console.log("\n✓ all scenarios and probes passed");
}

// Also run a structural invariant assertion as a belt-and-braces check.
assert.equal(
  computePoints(makeWhale().events, makeWhale().currentBlock) +
    computePoints(makeIdle().events, makeIdle().currentBlock),
  1200 + 75,
  "scenario totals must compose additively when events are disjoint"
);
