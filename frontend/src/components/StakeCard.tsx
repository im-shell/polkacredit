import { useEffect, useState } from "react";
import { ethers } from "ethers";
import type { ContractBundle } from "../lib/contracts";

export function StakeCard({
  bundle,
  account,
  onChange,
}: {
  bundle: ContractBundle;
  account: string;
  onChange: () => void;
}) {
  const [amount, setAmount] = useState("100");
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

  const wei = (() => {
    try {
      return ethers.parseUnits(amount || "0", 18);
    } catch {
      return 0n;
    }
  })();

  const needsApproval = wei > 0n && allowance < wei;
  const hasStake = stake && stake.amount > 0n;
  const canUnstake = hasStake && head >= stake!.lockUntil && !stake!.isLocked;

  return (
    <div className="card">
      <h2>Staking</h2>
      {hasStake ? (
        <>
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
            <label>Amount (mUSD, min 50)</label>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="row-actions">
            {needsApproval ? (
              <button
                disabled={busy || wei === 0n}
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
                disabled={busy || wei < ethers.parseUnits("50", 18)}
                onClick={() =>
                  run(async () => {
                    const tx = await bundle.vault.stake(wei);
                    await tx.wait();
                    setMsg("Staked.");
                  })
                }
              >
                Stake
              </button>
            )}
          </div>
        </>
      )}
      {msg && <div className="banner ok" style={{ marginTop: 12 }}>{msg}</div>}
      {err && <div className="banner err" style={{ marginTop: 12 }}>{err}</div>}
    </div>
  );
}
