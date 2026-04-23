import { CHAIN_ID, NETWORKS } from "../lib/contracts";

/**
 * Full-viewport split-screen (per DESIGN §6.1): left pane communicates what
 * the product is, right pane is a wallet list. No card wrap, no auto-connect.
 */
export function Connect({
  wcEnabled,
  injectedAvailable,
  onConnectInjected,
  onConnectWalletConnect,
  err,
}: {
  wcEnabled: boolean;
  injectedAvailable: boolean;
  onConnectInjected: () => void;
  onConnectWalletConnect: () => void;
  err: string | null;
}) {
  const network = NETWORKS[CHAIN_ID]?.name ?? `chain ${CHAIN_ID}`;

  return (
    <div className="connect">
      <div className="left">
        <div className="brand">
          <span style={{
            width: 10, height: 10, borderRadius: 999,
            background: "var(--text)",
            boxShadow: "0 0 0 3px color-mix(in oklch, var(--accent) 18%, transparent)",
          }} />
          PolkaCredit
        </div>
        <h1 className="headline">
          Your on-chain <b>credit</b>, portable across Polkadot.
        </h1>
        <div className="by">
          Soulbound · optimistic verification · on {network}
        </div>
      </div>

      <div className="right">
        <div className="title">Sign in</div>
        <div className="lede">
          Connect a wallet to stake, vouch, and view your credit score. Nothing happens until you explicitly approve a transaction.
        </div>
        <div className="walletList">
          <button
            className="walletRow"
            disabled={!injectedAvailable}
            onClick={onConnectInjected}
          >
            <span className="label">Browser wallet</span>
            <span className="kind">{injectedAvailable ? "Talisman · SubWallet · MetaMask" : "Not detected"}</span>
          </button>
          <button
            className="walletRow"
            disabled={!wcEnabled}
            onClick={onConnectWalletConnect}
          >
            <span className="label">WalletConnect</span>
            <span className="kind">{wcEnabled ? "QR · Mobile wallet" : "Project ID not set"}</span>
          </button>
        </div>
        {err && <div className="err">{err}</div>}
      </div>
    </div>
  );
}
