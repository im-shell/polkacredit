import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import type { ContractBundle } from "../lib/contracts";

type Tier = "10k" | "30k" | "60k";

const TIERS: Array<{
  id: Tier;
  amountUsd: number;
  points: number;
}> = [
  { id: "10k", amountUsd: 10_000, points: 40 },
  { id: "30k", amountUsd: 30_000, points: 70 },
  { id: "60k", amountUsd: 60_000, points: 100 },
];

export function StakeCard({
  bundle,
  account,
  onChange,
}: {
  bundle: ContractBundle;
  account: string;
  onChange: () => void;
}) {
  const [selected, setSelected] = useState<Tier>("10k");
  const [stake, setStake] = useState<{ amount: bigint; lockUntil: bigint; isLocked: boolean } | null>(
    null
  );
  const [stableBal, setStableBal] = useState<bigint>(0n);
  const [allowance, setAllowance] = useState<bigint>(0n);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [head, setHead] = useState<bigint>(0n);

  useEffect(() => {
    let stop = false;
    async function load() {
      try {
        const rec = await bundle.vault.getStake(account);
        const bal: bigint = await bundle.stable.balanceOf(account);
        const allow: bigint = await bundle.stable.allowance(account, bundle.vault.target);
        const block = await bundle.provider.getBlockNumber();
        if (stop) return;
        setStake({ amount: rec.amount, lockUntil: rec.lockUntil, isLocked: rec.isLocked });
        setStableBal(bal);
        setAllowance(allow);
        setHead(BigInt(block));
      } catch {}
    }
    load();
    const h = setInterval(load, 15_000);
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [bundle, account]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await fn();
      onChange();
    } catch (e: any) {
      setErr(e.shortMessage ?? e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const selectedTier = useMemo(
    () => TIERS.find((t) => t.id === selected)!,
    [selected]
  );
  const wei = useMemo(
    () => ethers.parseUnits(String(selectedTier.amountUsd), 18),
    [selectedTier]
  );

  const needsApproval = allowance < wei;
  const hasStake = stake && stake.amount > 0n;
  const canUnstake = hasStake && head >= stake!.lockUntil && !stake!.isLocked;
  const insufficient = stableBal < wei;

  function fmtTierLabel(amount: bigint): string {
    const n = Number(ethers.formatUnits(amount, 18));
    if (n >= 60_000) return "$60,000 (+100 pts)";
    if (n >= 30_000) return "$30,000 (+70 pts)";
    if (n >= 10_000) return "$10,000 (+40 pts)";
    return `$${n}`;
  }

  return (
    <div className="card">
      <h2>Staking</h2>
      {hasStake ? (
        <>
          <div className="row">
            <span className="k">Tier</span>
            <span className="v">{fmtTierLabel(stake!.amount)}</span>
          </div>
          <div className="row">
            <span className="k">Staked</span>
            <span className="v">{ethers.formatUnits(stake!.amount, 18)} mUSD</span>
          </div>
          <div className="row">
            <span className="k">Locked until</span>
            <span className="v">block {stake!.lockUntil.toString()}</span>
          </div>
          <div className="row">
            <span className="k">Vouch lock</span>
            <span className="v">{stake!.isLocked ? "active" : "none"}</span>
          </div>
          <div className="row-actions">
            <button
              disabled={!canUnstake || busy}
              onClick={() =>
                run(async () => {
                  const tx = await bundle.vault.unstake();
                  await tx.wait();
                  setMsg("Unstaked.");
                })
              }
            >
              Unstake
            </button>
            {!canUnstake && (
              <span style={{ fontSize: 12, color: "var(--muted)", alignSelf: "center" }}>
                {stake!.isLocked
                  ? "has active vouches"
                  : head < stake!.lockUntil
                  ? `unlocks in ${(stake!.lockUntil - head).toString()} blocks`
                  : ""}
              </span>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="row">
            <span className="k">Your mUSD balance</span>
            <span className="v">{ethers.formatUnits(stableBal, 18)}</span>
          </div>
          <div className="field">
            <label>Stake tier</label>
            <div style={{ display: "grid", gap: 8 }}>
              {TIERS.map((t) => (
                <label
                  key={t.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    border: "1px solid var(--line, #2a2a2a)",
                    borderRadius: 8,
                    padding: "10px 12px",
                    cursor: "pointer",
                    background:
                      selected === t.id ? "var(--accent-bg, rgba(230,0,122,0.08))" : "transparent",
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <input
                      type="radio"
                      name="stake-tier"
                      value={t.id}
                      checked={selected === t.id}
                      onChange={() => setSelected(t.id)}
                    />
                    <strong>${t.amountUsd.toLocaleString()}</strong>
                  </span>
                  <span style={{ fontSize: 13, color: "var(--muted)" }}>
                    +{t.points} pts · 6-month lock
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
            Tier is fixed at first stake — your vouch tier will match it.
          </div>
          <div className="row-actions">
            {needsApproval ? (
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const tx = await bundle.stable.approve(bundle.vault.target, ethers.MaxUint256);
                    await tx.wait();
                    setMsg("Approved.");
                  })
                }
              >
                Approve mUSD
              </button>
            ) : (
              <button
                disabled={busy || insufficient}
                onClick={() =>
                  run(async () => {
                    const tx = await bundle.vault.stake(wei);
                    await tx.wait();
                    setMsg(`Staked $${selectedTier.amountUsd.toLocaleString()}.`);
                  })
                }
              >
                Stake ${selectedTier.amountUsd.toLocaleString()}
              </button>
            )}
            {insufficient && !needsApproval && (
              <span style={{ fontSize: 12, color: "var(--muted)", alignSelf: "center" }}>
                insufficient mUSD — use the faucet
              </span>
            )}
          </div>
        </>
      )}
      {msg && <div className="banner ok" style={{ marginTop: 12 }}>{msg}</div>}
      {err && <div className="banner err" style={{ marginTop: 12 }}>{err}</div>}
    </div>
  );
}
