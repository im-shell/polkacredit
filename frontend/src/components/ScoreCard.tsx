import { useEffect, useState } from "react";
import type { ContractBundle } from "../lib/contracts";

/**
 * Score hero + micro-stats + optional proposal bar (DESIGN §3.2, §3.3, §3.4).
 *
 * The big numeral is the on-chain *finalized* score — 0 until the indexer
 * proposes, the 10-block (local) / 7200-block (testnet/mainnet) challenge
 * window passes, and someone calls `finalizeScore`. That mechanic is
 * surfaced by the proposal bar when `getPendingProposal` returns Pending.
 */

const CHALLENGE_WINDOW = 7200; // blocks, mirrors ScoreRegistry default

enum ProposalStatus {
  None = 0,
  Pending = 1,
  Finalized = 2,
  Disputed = 3,
  Rejected = 4,
  Superseded = 5,
}

/**
 * Points → score per SPEC §4 (piecewise linear, clamp to [0, 850]).
 * Mirrors contracts/lib/ScoreMath.sol + indexer/src/calculators/scoreCalculator.ts.
 */
function mapScore(pts: number): number {
  if (pts <= 0) return 0;
  if (pts >= 1000) return 850;
  if (pts <= 100) return pts;
  if (pts <= 300) return 100 + Math.floor(((pts - 100) * 3) / 2);
  if (pts <= 700) return 400 + Math.floor(((pts - 300) * 3) / 4);
  return 700 + Math.floor((pts - 700) / 2);
}

function band(score: number): { label: string; color: "ok" | "warn" | "faint" } {
  if (score >= 720) return { label: "Prime", color: "ok" };
  if (score >= 580) return { label: "Strong", color: "ok" };
  if (score >= 400) return { label: "Building", color: "ok" };
  if (score >= 200) return { label: "Emerging", color: "warn" };
  if (score > 0)    return { label: "Nascent",  color: "warn" };
  return { label: "Unscored", color: "faint" };
}

export function Overview({ bundle, account }: { bundle: ContractBundle; account: string }) {
  const [finalized, setFinalized]     = useState<number | null>(null);
  const [finalizedAt, setFinalizedAt] = useState<number | null>(null);
  const [total, setTotal]             = useState<number | null>(null);
  const [locked, setLocked]           = useState<number | null>(null);
  const [available, setAvailable]     = useState<number | null>(null);
  const [eventCount, setEventCount]   = useState<number | null>(null);
  const [head, setHead]               = useState<number>(0);
  const [pending, setPending]         = useState<null | {
    status: ProposalStatus;
    id: bigint;
    score: number;
    proposedAt: number;
    sourceBlockHeight: number;
  }>(null);

  useEffect(() => {
    let stop = false;
    async function load() {
      try {
        const [score, updated] = await bundle.score.getScore(account);
        const bal = await bundle.ledger.getBalance(account);
        const p = (await bundle.score.getPendingProposal(account)) as any;
        const len = await bundle.ledger.historyLength(account);
        const blockNumber = await bundle.provider.getBlockNumber();
        if (stop) return;
        setFinalized(Number(score));
        setFinalizedAt(Number(updated));
        setTotal(Number(bal.total));
        setLocked(Number(bal.locked));
        setAvailable(Number(bal.available));
        setEventCount(Number(len));
        setHead(blockNumber);
        setPending({
          status: Number(p.status) as ProposalStatus,
          id: BigInt(p.id ?? 0),
          score: Number(p.score),
          proposedAt: Number(p.proposedAt),
          sourceBlockHeight: Number(p.sourceBlockHeight),
        });
      } catch {}
    }
    load();
    const h = setInterval(load, 15_000);
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [bundle, account]);

  const score = finalized ?? 0;
  const projected = total == null ? 0 : mapScore(total);
  const pct = Math.min(100, (score / 850) * 100);
  const { label: bandLabel } = band(score);

  const isPending = pending && pending.status === ProposalStatus.Pending;
  const blocksLeft = isPending && head > 0
    ? Math.max(0, pending.proposedAt + CHALLENGE_WINDOW - head)
    : 0;
  const canFinalize = isPending && blocksLeft === 0;

  async function doFinalize() {
    try {
      const tx = await bundle.score.finalizeScore(account);
      await tx.wait();
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <>
      {/* ── Hero ─────────────────────────────────────────── */}
      <div className="hero">
        <div>
          <div className="num">
            {score}
            <span className="max"> / 850</span>
          </div>
        </div>
        <div className="meta">
          <span className="label">Soulbound</span>
          <span className="band">
            {score > 0 && <span className="pip" />}
            {bandLabel}
          </span>
          <span className="sub">
            {finalizedAt && finalizedAt > 0
              ? `finalized · block ${finalizedAt.toLocaleString()}`
              : "not yet finalized"}
          </span>
        </div>
      </div>

      <div className="scoreScale" style={{ marginTop: -20, marginBottom: 48 }}>
        <div className="rule">
          <div className="fill" style={{ width: `${pct}%` }} />
          <div className="marker" style={{ left: `calc(${pct}% - 1px)` }} />
        </div>
        <div className="ticks">
          <span>0</span><span>200</span><span>400</span><span>600</span><span>850</span>
        </div>
      </div>

      {/* ── Micro-stats ───────────────────────────────── */}
      <div className="micros">
        <div className="cell">
          <div className="label">Points</div>
          <div className="val">{total ?? "—"}</div>
        </div>
        <div className="cell">
          <div className="label">Projected</div>
          <div className="val">{projected}<span className="unit">/ 850</span></div>
        </div>
        <div className="cell">
          <div className="label">Ledger events</div>
          <div className="val">{eventCount ?? "—"}</div>
        </div>
        <div className="cell">
          <div className="label">Locked / avail</div>
          <div className="val">{locked ?? "—"}<span className="unit">/ {available ?? "—"}</span></div>
        </div>
      </div>

      {/* ── Proposal bar ───────────────────────────────── */}
      {isPending && (
        <div className="proposalBar">
          <svg className="ring" viewBox="0 0 48 48" aria-hidden="true">
            {(() => {
              const r = 20;
              const c = 2 * Math.PI * r;
              const elapsed = Math.max(0, head - pending.proposedAt);
              const frac = Math.min(1, elapsed / CHALLENGE_WINDOW);
              const stroke = canFinalize ? "var(--accent)" : "var(--text)";
              return (
                <>
                  <circle cx="24" cy="24" r={r} fill="none" stroke="var(--rule)" strokeWidth="2" />
                  <circle
                    cx="24" cy="24" r={r}
                    fill="none" stroke={stroke} strokeWidth="2"
                    strokeDasharray={`${c * frac} ${c}`}
                    transform="rotate(-90 24 24)"
                    style={{ transition: "stroke-dasharray 0.4s ease" }}
                  />
                </>
              );
            })()}
          </svg>
          <div className="body">
            <div className="head">Proposal #{pending.id.toString()} · pending</div>
            <div className="msg">
              Proposed score {pending.score} at block {pending.proposedAt.toLocaleString()}.
              {canFinalize
                ? " Challenge window closed — ready to finalize."
                : ` ${blocksLeft.toLocaleString()} blocks left in challenge window.`}
            </div>
            <div className="sub">anchored to block {pending.sourceBlockHeight.toLocaleString()}</div>
          </div>
          <button
            className={`btn ${canFinalize ? "primary" : "ghost"}`}
            onClick={doFinalize}
            disabled={!canFinalize}
          >
            Finalize
          </button>
        </div>
      )}
    </>
  );
}
