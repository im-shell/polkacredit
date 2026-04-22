import { useState } from "react";
import { ethers } from "ethers";
import type { ContractBundle } from "../lib/contracts";

/// The MockStablecoin on testnet/local exposes a permissionless `mint`. This
/// card gives the user a one-click way to grab some mUSD so they can stake.
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
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function drip() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const tx = await bundle.stable.mint(address, ethers.parseUnits("1000", 18));
      await tx.wait();
      setMsg("Minted 1000 mUSD.");
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
      <button disabled={busy} onClick={drip}>
        Mint 1000 mUSD
      </button>
      {msg && <div className="banner ok" style={{ marginTop: 12 }}>{msg}</div>}
      {err && <div className="banner err" style={{ marginTop: 12 }}>{err}</div>}
    </div>
  );
}
