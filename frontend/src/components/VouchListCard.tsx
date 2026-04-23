import { useEffect, useState } from "react";
import { ethers } from "ethers";
import type { ContractBundle } from "../lib/contracts";
import { short } from "../lib/address";
import { Section } from "./Section";

enum VouchStatus {
  None = 0,
  Active = 1,
  Succeeded = 2,
  Failed = 3,
  Defaulted = 4,
}

interface Vouch {
  id: number;
  voucher: string;
  vouchee: string;
  committedStake: bigint;
  tierPoints: number;
  successThreshold: number;
  nonGovThreshold: number;
  creditedToVoucher: number;
  creditedToVouchee: number;
  historyAnchor: number;
  createdAt: number;
  expiresAt: number;
  status: VouchStatus;
}

interface Progress { total: number; nonGov: number; }

const NON_GOV_EXCLUDED = new Set([
  "opengov_vote", "stake_deposit", "stake_first", "vouch_received", "vouch_given",
]);

function statusLabel(s: VouchStatus): string {
  return ["—", "active", "succeeded", "failed", "defaulted"][s] ?? "unknown";
}
function statusPip(s: VouchStatus): string | null {
  if (s === VouchStatus.Succeeded) return "pip";
  if (s === VouchStatus.Active)    return "pip warn";
  if (s === VouchStatus.Failed || s === VouchStatus.Defaulted) return "pip bad";
  return null;
}
function tierLabel(committed: bigint): string {
  const n = Number(ethers.formatUnits(committed, 18));
  if (n >= 60_000) return "$60k";
  if (n >= 30_000) return "$30k";
  if (n >= 10_000) return "$10k";
  return `$${n.toLocaleString()}`;
}

export function VouchListCard({
  bundle,
  account,
}: {
  bundle: ContractBundle;
  account: string;
}) {
  const [given, setGiven] = useState<Vouch[]>([]);
  const [received, setReceived] = useState<Vouch[]>([]);
  const [progress, setProgress] = useState<Record<number, Progress>>({});
  const [head, setHead] = useState<number>(0);

  useEffect(() => {
    let stop = false;

    async function hydrate(ids: bigint[]): Promise<Vouch[]> {
      if (ids.length === 0) return [];
      const recs = await Promise.all(ids.map((id) => bundle.vouch.getVouch(id)));
      return recs.map((r: any) => ({
        id: Number(r.id),
        voucher: r.voucher,
        vouchee: r.vouchee,
        committedStake: BigInt(r.committedStake),
        tierPoints: Number(r.tierPoints),
        successThreshold: Number(r.successThreshold),
        nonGovThreshold: Number(r.nonGovThreshold),
        creditedToVoucher: Number(r.creditedToVoucher),
        creditedToVouchee: Number(r.creditedToVouchee),
        historyAnchor: Number(r.historyAnchor),
        createdAt: Number(r.createdAt),
        expiresAt: Number(r.expiresAt),
        status: Number(r.status) as VouchStatus,
      }));
    }

    async function progressFor(v: Vouch): Promise<Progress> {
      const len: bigint = await bundle.ledger.historyLength(v.vouchee);
      const n = Number(len);
      if (n <= v.historyAnchor) return { total: 0, nonGov: 0 };
      const entries = await Promise.all(
        Array.from({ length: n - v.historyAnchor }, (_, i) =>
          bundle.ledger.historyAt(v.vouchee, v.historyAnchor + i)
        )
      );
      let total = 0, nonGov = 0;
      for (const e of entries as any[]) {
        const amt = Number(e.amount);
        total += amt;
        if (!NON_GOV_EXCLUDED.has(e.reason)) nonGov += amt;
      }
      return { total, nonGov };
    }

    async function load() {
      try {
        const [madeIds, rcvdIds, blockNumber] = await Promise.all([
          bundle.vouch.vouchesMadeBy(account) as Promise<bigint[]>,
          bundle.vouch.vouchesReceivedBy(account) as Promise<bigint[]>,
          bundle.provider.getBlockNumber(),
        ]);
        const [g, r] = await Promise.all([hydrate(madeIds), hydrate(rcvdIds)]);
        if (stop) return;
        setGiven(g.sort((a, b) => b.id - a.id));
        setReceived(r.sort((a, b) => b.id - a.id));
        setHead(blockNumber);

        const active = [...g, ...r].filter((v) => v.status === VouchStatus.Active);
        const pairs = await Promise.all(active.map(async (v) => [v.id, await progressFor(v)] as const));
        if (!stop) setProgress(Object.fromEntries(pairs));
      } catch {}
    }
    load();
    const h = setInterval(load, 15_000);
    return () => { stop = true; clearInterval(h); };
  }, [bundle, account]);

  if (given.length === 0 && received.length === 0) {
    // Per DESIGN §6.4: no invented empty-state art; the section is quietly absent.
    return null;
  }

  return (
    <Section num="∞" title="Vouch relationships" sub={`${given.length} given · ${received.length} received`}>
      {given.length > 0 && (
        <>
          <div className="kv"><span className="k">You vouched for</span><span className="v">{given.length}</span></div>
          <div className="vouchList" style={{ marginBottom: 24 }}>
            {given.map((v) => (
              <VouchRow key={`g-${v.id}`} v={v} side="vouchee" head={head} progress={progress[v.id]} />
            ))}
          </div>
        </>
      )}
      {received.length > 0 && (
        <>
          <div className="kv"><span className="k">Vouches received</span><span className="v">{received.length}</span></div>
          <div className="vouchList">
            {received.map((v) => (
              <VouchRow key={`r-${v.id}`} v={v} side="voucher" head={head} progress={progress[v.id]} />
            ))}
          </div>
        </>
      )}
    </Section>
  );
}

function VouchRow({
  v, side, head, progress,
}: {
  v: Vouch;
  side: "voucher" | "vouchee";
  head: number;
  progress: Progress | undefined;
}) {
  const counterparty = side === "vouchee" ? v.vouchee : v.voucher;
  const rel = side === "vouchee" ? "→" : "←";
  const isActive = v.status === VouchStatus.Active;
  const blocksLeft = isActive ? Math.max(0, v.expiresAt - head) : 0;
  const pastExpiry = isActive && head >= v.expiresAt;

  // Progress fill combines both gates: show the more-lagging of the two so
  // a "full bar" actually means both gates clear.
  const fracTotal  = progress ? Math.min(1, progress.total  / Math.max(1, v.successThreshold)) : 0;
  const fracNonGov = progress ? Math.min(1, progress.nonGov / Math.max(1, v.nonGovThreshold))  : 0;
  const frac = Math.min(fracTotal, fracNonGov);
  const clearing = progress
    ? progress.total >= v.successThreshold && progress.nonGov >= v.nonGovThreshold
    : false;

  const pipClass = statusPip(v.status);

  return (
    <div className="vouchRow">
      <div className="top">
        <div className="left">
          <span className="id">#{v.id}</span>
          <span>{rel}</span>
          <span className="addr" title={counterparty}>{short(counterparty)}</span>
          <span className="meta">· {tierLabel(v.committedStake)} · +{v.tierPoints} pts</span>
        </div>
        <div className="right">
          <span className="status">
            {pipClass && <span className={pipClass} />}
            {statusLabel(v.status)}
          </span>
        </div>
      </div>

      {isActive && (
        <>
          <div className="progress">
            <div className={`fill${clearing ? "" : " warn"}`} style={{ width: `${frac * 100}%` }} />
          </div>
          <div className="detail">
            {progress ? (
              <>
                total {progress.total}/{v.successThreshold}
                <span className="sep">·</span>
                non-gov {progress.nonGov}/{v.nonGovThreshold}
                <span className="sep">·</span>
                {pastExpiry
                  ? "window closed — awaiting resolve"
                  : `${blocksLeft.toLocaleString()} blocks left`}
                {clearing && <><span className="sep">·</span>clearing</>}
              </>
            ) : (
              <>total ≥ {v.successThreshold} · non-gov ≥ {v.nonGovThreshold}</>
            )}
          </div>
        </>
      )}

      {v.status === VouchStatus.Succeeded && (
        <div className="detail">
          voucher +{v.creditedToVoucher}<span className="sep">·</span>vouchee +{v.creditedToVouchee}
        </div>
      )}
      {(v.status === VouchStatus.Failed || v.status === VouchStatus.Defaulted) && (
        <div className="detail">
          commit slashed · {Number(ethers.formatUnits(v.committedStake, 18)).toLocaleString()} mUSD → treasury
        </div>
      )}
    </div>
  );
}
