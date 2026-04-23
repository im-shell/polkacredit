import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import type { ContractBundle } from "../lib/contracts";
import { Section } from "./Section";

type Tier = "10k" | "30k" | "60k";

const TIERS: Array<{ id: Tier; amountUsd: number; points: number; perks: string }> = [
  { id: "10k", amountUsd: 10_000, points: 40,  perks: "Base stake · +40 points · $10k vouch tier." },
  { id: "30k", amountUsd: 30_000, points: 70,  perks: "Solvency signal · +70 points · up to $30k vouch tier." },
  { id: "60k", amountUsd: 60_000, points: 100, perks: "Whale tier · +100 points · 20-week decay buffer." },
];

function fmtUsd(n: number): string {
  return `$${n.toLocaleString()}`;
}

function formatTierLabel(amount: bigint): string {
  const n = Number(ethers.formatUnits(amount, 18));
  if (n >= 60_000) return "$60,000 · +100 pts";
  if (n >= 30_000) return "$30,000 · +70 pts";
  if (n >= 10_000) return "$10,000 · +40 pts";
  return `$${n.toLocaleString()}`;
}

export function StakeSection({
  bundle,
  account,
  onChange,
}: {
  bundle: ContractBundle;
  account: string;
  onChange: () => void;
}) {
  const [selected, setSelected] = useState<Tier>("10k");
  const [stake, setStake] = useState<{ amount: bigint; lockUntil: bigint; isLocked: boolean } | null>(null);
  const [stableBal, setStableBal] = useState<bigint>(0n);
  const [allowance, setAllowance] = useState<bigint>(0n);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "bad"; msg: string } | null>(null);
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

  async function run(fn: () => Promise<string | void>) {
    setBusy(true);
    setFlash(null);
    try {
      const msg = await fn();
      if (msg) setFlash({ kind: "ok", msg });
      onChange();
    } catch (e: any) {
      setFlash({ kind: "bad", msg: e.shortMessage ?? e.message ?? String(e) });
    } finally {
      setBusy(false);
    }
  }

  const selectedTier = useMemo(() => TIERS.find((t) => t.id === selected)!, [selected]);
  const wei = useMemo(() => ethers.parseUnits(String(selectedTier.amountUsd), 18), [selectedTier]);

  const needsApproval = allowance < wei;
  const hasStake = stake && stake.amount > 0n;
  const canUnstake = hasStake && head >= stake!.lockUntil && !stake!.isLocked;
  const insufficient = stableBal < wei;

  return (
    <Section num="01" title="Staking position" sub={hasStake ? "active" : "open"}>
      {hasStake ? (
        <div className="two">
          <div>
            <div className="kv">
              <span className="k">Tier</span>
              <span className="v big">{formatTierLabel(stake!.amount)}</span>
            </div>
            <div className="kv">
              <span className="k">Staked</span>
              <span className="v">{Number(ethers.formatUnits(stake!.amount, 18)).toLocaleString()} mUSD</span>
            </div>
            <div className="kv">
              <span className="k">Locked until</span>
              <span className="v">block {stake!.lockUntil.toLocaleString()}</span>
            </div>
            <div className="kv">
              <span className="k">Vouch lock</span>
              <span className="v">{stake!.isLocked ? "active" : "none"}</span>
            </div>
            <div className="rowActions">
              <button
                className="btn ghost"
                disabled={!canUnstake || busy}
                onClick={() =>
                  run(async () => {
                    const tx = await bundle.vault.unstake();
                    await tx.wait();
                    return "Unstaked.";
                  })
                }
              >
                Unstake
              </button>
              {!canUnstake && (
                <span className="hint">
                  {stake!.isLocked
                    ? "has active vouches"
                    : head < stake!.lockUntil
                    ? `unlocks in ${(stake!.lockUntil - head).toLocaleString()} blocks`
                    : ""}
                </span>
              )}
            </div>
          </div>
          <div style={{ fontSize: 13, color: "var(--text-2)" }}>
            Tier is fixed at first stake. Upgrading requires a full unstake after the 6-month lock.
            Vouches reserve committed slices of this stake - slashed to treasury on vouch failure.
          </div>
        </div>
      ) : (
        <>
          <div className="tierRow">
            {TIERS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`tierCell${selected === t.id ? " active" : ""}`}
                onClick={() => setSelected(t.id)}
              >
                <div className="amt">{fmtUsd(t.amountUsd)}</div>
                <div className="lbl">+{t.points} pts · 6-mo lock</div>
                <div className="perks">{t.perks}</div>
              </button>
            ))}
          </div>

          <div className="two">
            <div>
              <div className="kv">
                <span className="k">Your mUSD balance</span>
                <span className="v">{Number(ethers.formatUnits(stableBal, 18)).toLocaleString()}</span>
              </div>
              <div className="kv">
                <span className="k">Selected commit</span>
                <span className="v">{fmtUsd(selectedTier.amountUsd)} · +{selectedTier.points} pts</span>
              </div>
              <div className="rowActions">
                {needsApproval ? (
                  <button
                    className="btn primary"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const tx = await bundle.stable.approve(bundle.vault.target, ethers.MaxUint256);
                        await tx.wait();
                        return "mUSD approved.";
                      })
                    }
                  >
                    Approve mUSD
                  </button>
                ) : (
                  <button
                    className="btn primary arrow"
                    disabled={busy || insufficient}
                    onClick={() =>
                      run(async () => {
                        const tx = await bundle.vault.stake(wei);
                        await tx.wait();
                        return `Staked ${fmtUsd(selectedTier.amountUsd)}.`;
                      })
                    }
                  >
                    Stake {fmtUsd(selectedTier.amountUsd)}
                  </button>
                )}
                {insufficient && !needsApproval && (
                  <span className="hint">insufficient mUSD — use the faucet below</span>
                )}
              </div>
            </div>
            <div style={{ fontSize: 13, color: "var(--text-2)" }}>
              The base stake is an honour-system gate — only staked accounts can vouch for peers (SPEC §2.2).
              Tier points are one-time; the 6-month lock is enforced by <code>StakingVault.LOCK_DURATION</code>.
            </div>
          </div>
        </>
      )}

      {flash && <div className={`flash ${flash.kind}`}>{flash.msg}</div>}
    </Section>
  );
}
