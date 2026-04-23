import { short } from "../lib/address";
import type { WalletKind } from "../lib/wallet";

export function Connect({
  address,
  netName,
  onRightChain,
  walletKind,
  wcEnabled,
  injectedAvailable,
  onConnectInjected,
  onConnectWalletConnect,
  onSwitch,
  onDisconnect,
}: {
  address: string | null;
  netName: string | null;
  onRightChain: boolean;
  walletKind: WalletKind | null;
  wcEnabled: boolean;
  injectedAvailable: boolean;
  onConnectInjected: () => void;
  onConnectWalletConnect: () => void;
  onSwitch: () => void;
  onDisconnect: () => void;
}) {
  if (!address) {
    // Not connected. Show whichever transports are actually available.
    // Most users land here with the browser extension path; WalletConnect
    // appears as a secondary option for mobile-wallet users.
    return (
      <div style={{ display: "flex", gap: 8 }}>
        {injectedAvailable && <button onClick={onConnectInjected}>Connect Wallet</button>}
        {wcEnabled && (
          <button className="ghost" onClick={onConnectWalletConnect}>
            QR
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span className="kv">{netName}</span>
      {!onRightChain && (
        <button className="ghost" onClick={onSwitch}>
          Switch network
        </button>
      )}
      <span className="addr" style={{ color: "var(--muted)" }}>
        {short(address)}
        {walletKind === "walletconnect" && <span style={{ marginLeft: 4 }}>·WC</span>}
      </span>
      <button className="ghost" onClick={onDisconnect} title="Disconnect wallet">
        Disconnect
      </button>
    </div>
  );
}
