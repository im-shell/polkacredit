import { useEffect, useState } from "react";
import { ethers } from "ethers";
import type { ContractBundle } from "../lib/contracts";
import { Section } from "./Section";

/**
 * Section 02 — Vouch form only. The vouch-relationship list (given + received)
 * is rendered by <VouchListCard> below this section in the page flow, so
 * the form stays focused and the list is browsable independently.
 */
export function VouchSection({
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
  const [flash, setFlash] = useState<{ kind: "ok" | "bad"; msg: string } | null>(null);

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
    return () => { stop = true; clearInterval(h); };
  }, [bundle, account]);

  const tierInfo = (() => {
    if (stakeAmount === null) return null;
    const n = Number(ethers.formatUnits(stakeAmount, 18));
    if (n >= 60_000) return { label: "$60,000", points: 70, threshold: "+150 total · +40 non-gov" };
    if (n >= 30_000) return { label: "$30,000", points: 50, threshold: "+100 total · +30 non-gov" };
    if (n >= 10_000) return { label: "$10,000", points: 30, threshold: "+50 total · +20 non-gov" };
    return null;
  })();
  const noStake = stakeAmount !== null && stakeAmount === 0n;

  async function submit() {
    setBusy(true);
    setFlash(null);
    try {
      const vouchee = ethers.getAddress(addr);
      const tx = await bundle.vouch.vouch(vouchee, stakeAmount!);
      const r = await tx.wait();
      setFlash({ kind: "ok", msg: `Vouch created · tx ${r.hash.slice(0, 10)}…` });
      setAddr("");
      onChange();
    } catch (e: any) {
      setFlash({ kind: "bad", msg: e.shortMessage ?? e.message ?? String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      num="02"
      title="Vouch for a peer"
      sub={tierInfo ? `${tierInfo.label} tier` : noStake ? "stake required" : ""}
    >
      <div className="field">
        <label>
          Vouchee address
          <span className="hint">EIP-55 · 0x…</span>
        </label>
        <div className="input">
          <span className="prefix">0x</span>
          <input
            placeholder="bdc78d99…58c3"
            value={addr.startsWith("0x") ? addr.slice(2) : addr}
            onChange={(e) => setAddr("0x" + e.target.value.replace(/^0x/i, ""))}
            disabled={!tierInfo}
            spellCheck={false}
          />
        </div>
      </div>

      <div className="kv">
        <span className="k">Tier</span>
        <span className="v">
          {tierInfo ? `${tierInfo.label} · +${tierInfo.points} pts each side` : "—"}
        </span>
      </div>
      <div className="kv">
        <span className="k">Success gate</span>
        <span className="v">{tierInfo?.threshold ?? "—"}</span>
      </div>
      <div className="kv">
        <span className="k">Window</span>
        <span className="v">6 months · indexer auto-resolves</span>
      </div>

      <div className="rowActions">
        <button
          className="btn primary arrow"
          disabled={busy || !addr || !tierInfo}
          onClick={submit}
        >
          Open vouch
        </button>
        {noStake && <span className="hint">stake first to unlock vouching</span>}
      </div>

      {flash && <div className={`flash ${flash.kind}`}>{flash.msg}</div>}
    </Section>
  );
}
