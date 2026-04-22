import { useEffect, useState } from "react";
import type { ContractBundle } from "../lib/contracts";

function mapScore(points: number): number {
  if (points <= 0) return 0;
  if (points >= 500) return 850;
  if (points < 50) return Math.floor((points * 100) / 50);
  if (points < 100) return 100 + Math.floor(((points - 50) * 100) / 50);
  if (points < 250) return 200 + Math.floor(((points - 100) * 300) / 150);
  return 500 + Math.floor(((points - 250) * 350) / 250);
}

const CHALLENGE_WINDOW = 7200; // blocks

enum ProposalStatus {
  None = 0,
  Pending = 1,
  Finalized = 2,
  Disputed = 3,
  Rejected = 4,
  Superseded = 5,
}

function statusLabel(s: ProposalStatus): string {
  return ["none", "pending", "finalized", "disputed", "rejected", "superseded"][s] ?? "unknown";
}

export function ScoreCard({ bundle, account }: { bundle: ContractBundle; account: string }) {
  const [finalized, setFinalized] = useState<number | null>(null);
  const [finalizedAt, setFinalizedAt] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [locked, setLocked] = useState<number | null>(null);
  const [available, setAvailable] = useState<number | null>(null);

  const [pending, setPending] = useState<null | {
    status: ProposalStatus;
    id: bigint;
    score: number;
    totalPoints: number;
    sourceBlockHeight: number;
    proposedAt: number;
  }>(null);
  const [head, setHead] = useState<number>(0);

  useEffect(() => {
    let stop = false;
    async function load() {
      try {
        const [score, updated] = await bundle.score.getScore(account);
        const bal = await bundle.ledger.getBalance(account);
        const p = (await bundle.score.getPendingProposal(account)) as any;
        const blockNumber = await bundle.provider.getBlockNumber();
        if (stop) return;
        setFinalized(Number(score));
        setFinalizedAt(Number(updated));
        setTotal(Number(bal.total));
        setLocked(Number(bal.locked));
        setAvailable(Number(bal.available));
        setHead(blockNumber);
        setPending({
          status: Number(p.status) as ProposalStatus,
          id: BigInt(p.id ?? 0),
          score: Number(p.score),
          totalPoints: Number(p.totalPoints),
          sourceBlockHeight: Number(p.sourceBlockHeight),
          proposedAt: Number(p.proposedAt),
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

  const projected = total == null ? null : mapScore(total);
  const display = finalized ?? 0;
  const pct = Math.min(100, (display / 850) * 100);

  const isPending = pending && pending.status === ProposalStatus.Pending;
  const isDisputed = pending && pending.status === ProposalStatus.Disputed;
  const blocksLeft =
    isPending && head > 0 ? Math.max(0, pending.proposedAt + CHALLENGE_WINDOW - head) : 0;
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
    <div className="card" style={{ gridColumn: "span 2" }}>
      <h2>Credit score</h2>
      <div className="score-big">{display}</div>
      <div className="score-bar">
        <div style={{ width: `${pct}%` }} />
      </div>
      <div className="row">
        <span className="k">Finalized score</span>
        <span className="v">
          {finalized ?? 0}
          {finalizedAt ? ` (block ${finalizedAt})` : ""}
        </span>
      </div>
      <div className="row">
        <span className="k">Projected from points</span>
        <span className="v">{projected ?? "—"}</span>
      </div>
      <div className="row">
        <span className="k">Total points</span>
        <span className="v">{total ?? "—"}</span>
      </div>
      <div className="row">
        <span className="k">Available / locked</span>
        <span className="v">
          {available ?? "—"} / {locked ?? "—"}
        </span>
      </div>

      {pending && pending.status !== ProposalStatus.None && (
        <div
          className={isDisputed ? "banner err" : "banner"}
          style={{ marginTop: 14 }}
        >
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <strong>Proposal #{pending.id.toString()}</strong>
            <span className="kv">{statusLabel(pending.status)}</span>
          </div>
          <div className="row">
            <span className="k">Proposed score</span>
            <span className="v">{pending.score}</span>
          </div>
          <div className="row">
            <span className="k">Proposed at</span>
            <span className="v">block {pending.proposedAt}</span>
          </div>
          {isPending && (
            <>
              <div className="row">
                <span className="k">Challenge window</span>
                <span className="v">
                  {blocksLeft > 0 ? `${blocksLeft} blocks left` : "closed"}
                </span>
              </div>
              <div className="kv" style={{ marginTop: 6 }}>
                anchored at block {pending.sourceBlockHeight}
              </div>
              {canFinalize && (
                <div className="row-actions" style={{ marginTop: 10 }}>
                  <button onClick={doFinalize}>Finalize on-chain</button>
                </div>
              )}
            </>
          )}
          {isDisputed && (
            <div style={{ marginTop: 8, fontSize: 13 }}>
              This proposal is under dispute. Once governance resolves it the
              final score will be visible.
            </div>
          )}
        </div>
      )}

      <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 10 }}>
        Scores are proposed by the indexer anchored to a specific source
        block. After a 24-hour challenge window with no dispute, anyone can
        call <code>finalizeScore</code> to publish.
      </div>
    </div>
  );
}
