import { useEffect, useState } from "react";
import { ethers } from "ethers";
import type { ContractBundle } from "../lib/contracts";
import { short } from "../lib/address";

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

interface Progress {
  total: number;
  nonGov: number;
}

/// Reasons excluded from the non-gov subgate. Mirrors VouchRegistry._inWindowDeltas.
const NON_GOV_EXCLUDED = new Set([
  "opengov_vote",
  "stake_deposit",
  "stake_first",
  "vouch_received",
  "vouch_given",
]);

function statusLabel(s: VouchStatus): string {
  return ["—", "active", "succeeded", "failed", "defaulted"][s] ?? "unknown";
}

function statusClass(s: VouchStatus): string {
  if (s === VouchStatus.Succeeded) return "ok";
  if (s === VouchStatus.Failed || s === VouchStatus.Defaulted) return "err";
  return "";
}

function tierLabel(committed: bigint): string {
  const n = Number(ethers.formatUnits(committed, 18));
  if (n >= 60_000) return "$60k";
  if (n >= 30_000) return "$30k";
  if (n >= 10_000) return "$10k";
  return `$${n}`;
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
  const [err, setErr] = useState<string | null>(null);

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

    /// Same computation the contract runs in resolveVouch: scan the vouchee's
    /// ledger from historyAnchor onward, summing all deltas for the total
    /// gate and all non-excluded deltas for the non-gov subgate.
    async function progressFor(v: Vouch): Promise<Progress> {
      const len: bigint = await bundle.ledger.historyLength(v.vouchee);
      const n = Number(len);
      if (n <= v.historyAnchor) return { total: 0, nonGov: 0 };
      const entries = await Promise.all(
        Array.from({ length: n - v.historyAnchor }, (_, i) =>
          bundle.ledger.historyAt(v.vouchee, v.historyAnchor + i)
        )
      );
      let total = 0;
      let nonGov = 0;
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
        // newest first
        setGiven(g.sort((a, b) => b.id - a.id));
        setReceived(r.sort((a, b) => b.id - a.id));
        setHead(blockNumber);

        // Progress is only meaningful for active vouches. Dedupe by vouchee —
        // multiple vouches on the same vouchee share the same history range
        // only when historyAnchor coincides, so keep the per-vouch granularity
        // but parallelize the fetches.
        const active = [...g, ...r].filter((v) => v.status === VouchStatus.Active);
        const pairs = await Promise.all(
          active.map(async (v) => [v.id, await progressFor(v)] as const)
        );
        if (stop) return;
        setProgress(Object.fromEntries(pairs));
      } catch (e: any) {
        if (!stop) setErr(e.shortMessage ?? e.message ?? String(e));
      }
    }
    load();
    const h = setInterval(load, 15_000);
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [bundle, account]);

  return (
    <div className="card" style={{ gridColumn: "span 2" }}>
      <h2>Vouch relationships</h2>
      {err && <div className="banner err" style={{ marginBottom: 10 }}>{err}</div>}

      <Section
        title={`You vouched for (${given.length})`}
        rows={given}
        side="vouchee"
        head={head}
        progress={progress}
        empty="No vouches given yet."
      />
      <div style={{ height: 14 }} />
      <Section
        title={`Vouches you received (${received.length})`}
        rows={received}
        side="voucher"
        head={head}
        progress={progress}
        empty="No vouches received yet."
      />
    </div>
  );
}

function Section({
  title,
  rows,
  side,
  head,
  progress,
  empty,
}: {
  title: string;
  rows: Vouch[];
  side: "voucher" | "vouchee";
  head: number;
  progress: Record<number, Progress>;
  empty: string;
}) {
  return (
    <div>
      <div className="kv" style={{ marginBottom: 8 }}>
        {title}
      </div>
      {rows.length === 0 ? (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>{empty}</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((v) => (
            <VouchRow key={v.id} v={v} side={side} head={head} progress={progress[v.id]} />
          ))}
        </div>
      )}
    </div>
  );
}

function VouchRow({
  v,
  side,
  head,
  progress,
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

  return (
    <div
      style={{
        border: "1px solid var(--line, #2a2a2a)",
        borderRadius: 8,
        padding: "10px 12px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontFamily: "var(--mono, ui-monospace, monospace)", fontSize: 13 }}>
          <span style={{ color: "var(--muted)" }}>#{v.id}</span>{" "}
          {rel} <span title={counterparty}>{short(counterparty)}</span>
        </div>
        <span className={`badge ${statusClass(v.status)}`} style={{ fontSize: 12 }}>
          {statusLabel(v.status)}
        </span>
      </div>

      <div className="row" style={{ marginTop: 6 }}>
        <span className="k">Tier</span>
        <span className="v">
          {tierLabel(v.committedStake)} · +{v.tierPoints} pts
        </span>
      </div>

      {isActive && (
        <>
          <div className="row">
            <span className="k">Window</span>
            <span className="v">
              {pastExpiry
                ? `closed — awaiting resolve (grace 10 blocks)`
                : `${blocksLeft} blocks left`}
            </span>
          </div>
          <div className="row">
            <span className="k">Progress</span>
            <span className="v">
              {progress
                ? (() => {
                    const totalOk = progress.total >= v.successThreshold;
                    const nonGovOk = progress.nonGov >= v.nonGovThreshold;
                    const clearing = totalOk && nonGovOk;
                    return (
                      <>
                        total {progress.total}/{v.successThreshold} · non-gov{" "}
                        {progress.nonGov}/{v.nonGovThreshold}
                        <span
                          style={{
                            marginLeft: 6,
                            color: clearing ? "var(--ok, #1db954)" : "var(--muted)",
                          }}
                        >
                          {clearing ? "· clearing" : ""}
                        </span>
                      </>
                    );
                  })()
                : `total ≥ ${v.successThreshold} · non-gov ≥ ${v.nonGovThreshold}`}
            </span>
          </div>
        </>
      )}

      {v.status === VouchStatus.Succeeded && (
        <div className="row">
          <span className="k">Credited</span>
          <span className="v">
            voucher +{v.creditedToVoucher} · vouchee +{v.creditedToVouchee}
          </span>
        </div>
      )}

      {(v.status === VouchStatus.Failed || v.status === VouchStatus.Defaulted) && (
        <div className="row">
          <span className="k">Outcome</span>
          <span className="v">
            commit slashed to treasury ({ethers.formatUnits(v.committedStake, 18)} mUSD)
          </span>
        </div>
      )}
    </div>
  );
}
