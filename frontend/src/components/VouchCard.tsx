import { useState } from "react";
import { ethers } from "ethers";
import type { ContractBundle } from "../lib/contracts";

export function VouchCard({ bundle, onChange }: { bundle: ContractBundle; onChange: () => void }) {
  const [addr, setAddr] = useState("");
  const [tier, setTier] = useState<"1k" | "5k" | "10k">("1k");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const tierAmount = (t: typeof tier): bigint =>
    t === "10k" ? ethers.parseUnits("10000", 18)
    : t === "5k" ? ethers.parseUnits("5000", 18)
    : ethers.parseUnits("1000", 18);

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

  return (
    <div className="card">
      <h2>Vouch</h2>
      <div className="field">
        <label>Vouchee EVM address</label>
        <input placeholder="0x…" value={addr} onChange={(e) => setAddr(e.target.value)} />
      </div>
      <div className="field">
        <label>Committed stake tier</label>
        <select value={tier} onChange={(e) => setTier(e.target.value as typeof tier)}>
          <option value="1k">$1,000 → +40 each on success</option>
          <option value="5k">$5,000 → +60 each on success</option>
          <option value="10k">$10,000 → +80 each on success</option>
        </select>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
        Escrows a tiered slice of your base stake for 6 months and snapshots the
        vouchee's current score. No points are minted at vouch-open — reward is
        deferred. After the window (plus a brief grace period) the indexer
        automatically resolves the vouch: if the vouchee's score grew by ≥50
        during the window, both sides are credited the tier amount and your
        stake returns. Otherwise your committed stake is slashed to treasury.
        You don't need to trigger anything manually.
      </div>
      <button
        disabled={busy || !addr}
        onClick={() =>
          run(async () => {
            const vouchee = ethers.getAddress(addr);
            const tx = await bundle.vouch.vouch(vouchee, tierAmount(tier));
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
