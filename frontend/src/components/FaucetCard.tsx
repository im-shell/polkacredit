import { useMemo, useState } from "react";
import { ethers } from "ethers";
import type { ContractBundle } from "../lib/contracts";
import { Section } from "./Section";

/**
 * Dev-only: MockStablecoin exposes a permissionless `mint`. This section
 * doesn't exist on a production deployment.
 */
export function FaucetSection({
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
  const [flash, setFlash] = useState<{ kind: "ok" | "bad"; msg: string } | null>(null);

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
    setFlash(null);
    try {
      const tx = await bundle.stable.mint(address, wei);
      await tx.wait();
      setFlash({ kind: "ok", msg: `Minted ${amount.trim()} mUSD.` });
      onChange();
    } catch (e: any) {
      setFlash({ kind: "bad", msg: e.shortMessage ?? e.message ?? String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section num="∞" title="mUSD faucet" sub="dev only">
      <div className="two">
        <div>
          <div className="field">
            <label>
              Amount
              <span className="hint">mUSD · permissionless mint</span>
            </label>
            <div className="input">
              <input
                type="text"
                inputMode="decimal"
                placeholder="1000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={busy}
              />
              <span className="prefix">mUSD</span>
            </div>
          </div>
          <div className="rowActions">
            <button className="btn ghost" disabled={busy || !isValid} onClick={drip}>
              Mint{isValid ? ` ${amount.trim()} mUSD` : " mUSD"}
            </button>
          </div>
          {flash && <div className={`flash ${flash.kind}`}>{flash.msg}</div>}
        </div>
        <div style={{ fontSize: 13, color: "var(--text-2)" }}>
          <code>MockStablecoin.mint(address,uint256)</code> is gated by nothing - any address can
          mint. Present on local / testnet only. A real deployment swaps in a regulated stablecoin
          (USDC or Polkadot USD token) and drops this component entirely.
        </div>
      </div>
    </Section>
  );
}
