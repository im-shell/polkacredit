import { useEffect, useState } from "react";
import { ethers } from "ethers";
import type { ContractBundle } from "../lib/contracts";

/**
 * Vouch tier is read from the user's base stake (SPEC §2.2: committed tier
 * must be ≤ voucher's base stake tier). We default to matching their stake
 * tier exactly so the UI stays single-purpose — no dropdown, no amount field.
 */
export function VouchCard({
  bundle,
  account,
  onChange,
}: {
  bundle: ContractBundle;
  account: string;
  onChange: () => void;
}) {
  const [addr, setAddr] = useState("");
  const [stakeAmount, setStakeAmount] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    async function load() {
      try {
        const rec = await bundle.vault.getStake(account);
        if (!stop) setStakeAmount(rec.amount);
      } catch {
        if (!stop) setStakeAmount(0n);
      }
    }
    load();
    const h = setInterval(load, 15_000);
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [bundle, account]);

  const tierInfo = (() => {
    if (stakeAmount === null) return null;
    const n = Number(ethers.formatUnits(stakeAmount, 18));
    if (n >= 60_000) return { label: "$60,000", points: 70 };
    if (n >= 30_000) return { label: "$30,000", points: 50 };
    if (n >= 10_000) return { label: "$10,000", points: 30 };
    return null;
  })();

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const m = await fn();
      setMsg(m);
      onChange();
    } catch (e: any) {
      setErr(e.shortMessage ?? e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const noStake = stakeAmount !== null && stakeAmount === 0n;

  return (
    <div className="card">
      <h2>Vouch</h2>

      {tierInfo ? (
        <div className="row">
          <span className="k">Your vouch tier</span>
          <span className="v">
            {tierInfo.label} → +{tierInfo.points} pts each on success
          </span>
        </div>
      ) : noStake ? (
        <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>
          Stake first to unlock vouching — your stake tier determines your vouch tier.
        </div>
      ) : (
        <div style={{ fontSize: 13, color: "var(--muted)" }}>Loading stake…</div>
      )}

      <div className="field">
        <label>Vouchee EVM address</label>
        <input
          placeholder="0x…"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          disabled={!tierInfo}
        />
      </div>

      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
        Escrows your stake amount against this vouch for 6 months and snapshots
        the vouchee's score. No points are minted at vouch-open — reward is
        deferred. After the window (plus a brief grace period) the indexer
        automatically resolves: if the vouchee's score grew by ≥50 during the
        window, both sides are credited and your stake returns. Otherwise your
        committed stake is slashed to treasury.
      </div>

      <button
        disabled={busy || !addr || !tierInfo || !stakeAmount}
        onClick={() =>
          run(async () => {
            const vouchee = ethers.getAddress(addr);
            const tx = await bundle.vouch.vouch(vouchee, stakeAmount!);
            const r = await tx.wait();
            return `Vouch created in tx ${r.hash.slice(0, 10)}…`;
          })
        }
      >
        Vouch
      </button>

      {msg && <div className="banner ok" style={{ marginTop: 12 }}>{msg}</div>}
      {err && <div className="banner err" style={{ marginTop: 12 }}>{err}</div>}
    </div>
  );
}
