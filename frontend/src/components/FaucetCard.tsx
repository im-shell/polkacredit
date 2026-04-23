import { useMemo, useState } from "react";
import { ethers } from "ethers";
import type { ContractBundle } from "../lib/contracts";

/// The MockStablecoin on testnet/local exposes a permissionless `mint`. This
/// card gives the user a quick way to grab some mUSD so they can stake.
/// On a real deployment this card should be removed.
export function FaucetCard({
  bundle,
  address,
  onChange,
}: {
  bundle: ContractBundle;
  address: string;
  onChange: () => void;
}) {
  const [amount, setAmount] = useState("1000");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const wei = useMemo(() => {
    try {
      return ethers.parseUnits(amount.trim() || "0", 18);
    } catch {
      return 0n;
    }
  }, [amount]);
  const isValid = wei > 0n;

  async function drip() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const tx = await bundle.stable.mint(address, wei);
      await tx.wait();
      setMsg(`Minted ${amount.trim()} mUSD.`);
      onChange();
    } catch (e: any) {
      setErr(e.shortMessage ?? e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>mUSD faucet</h2>
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
        MockStablecoin has a permissionless <code>mint</code> function. Use it to fund your test
        wallet. This will not exist on a production deployment.
      </div>
      <div className="field">
        <label>Amount (mUSD)</label>
        <input
          type="text"
          inputMode="decimal"
          placeholder="1000"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="row-actions">
        <button disabled={busy || !isValid} onClick={drip}>
          Mint{isValid ? ` ${amount.trim()} mUSD` : " mUSD"}
        </button>
      </div>
      {msg && <div className="banner ok" style={{ marginTop: 12 }}>{msg}</div>}
      {err && <div className="banner err" style={{ marginTop: 12 }}>{err}</div>}
    </div>
  );
}
