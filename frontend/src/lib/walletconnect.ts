import { EthereumProvider } from "@walletconnect/ethereum-provider";
import { CHAIN_ID, NETWORKS } from "./contracts";

/**
 * WalletConnect v2 integration.
 *
 * Returns an EIP-1193 provider that the rest of the app can wrap with
 * `ethers.BrowserProvider` exactly like a browser-injected `window.ethereum`.
 * The library handles its own QR modal, session persistence (localStorage),
 * and pairing lifecycle.
 *
 * Requires `VITE_WALLETCONNECT_PROJECT_ID` from cloud.reown.com
 * (formerly cloud.walletconnect.com). If unset, `hasWalletConnect()`
 * returns false and the UI hides the WalletConnect button.
 */

export function walletConnectProjectId(): string | undefined {
  const id = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;
  return id && id.length > 0 ? id : undefined;
}

export function hasWalletConnect(): boolean {
  return !!walletConnectProjectId();
}

let cachedProvider: Awaited<ReturnType<typeof EthereumProvider.init>> | null = null;
let initPromise: Promise<Awaited<ReturnType<typeof EthereumProvider.init>>> | null = null;

/// Lazily initialize a singleton EthereumProvider for our target chain.
/// Callers should invoke `.connect()` on the returned provider to open the
/// QR modal and obtain a session; subsequent calls reuse the same instance,
/// preserving any active session across re-renders.
export async function getWalletConnectProvider() {
  if (cachedProvider) return cachedProvider;
  if (initPromise) return initPromise;

  const projectId = walletConnectProjectId();
  if (!projectId) throw new Error("VITE_WALLETCONNECT_PROJECT_ID is not set");

  const net = NETWORKS[CHAIN_ID];
  if (!net) throw new Error(`No network metadata for chainId ${CHAIN_ID}`);

  initPromise = EthereumProvider.init({
    projectId,
    // Required chains: the wallet must support these to pair.
    chains: [CHAIN_ID],
    // Optional chains can be switched to post-pairing without re-pairing.
    optionalChains: [],
    rpcMap: { [CHAIN_ID]: net.rpc },
    showQrModal: true,
    // Metadata surfaced to the user in their mobile wallet UI.
    metadata: {
      name: "Sampo",
      description: "On-chain credit scoring on Polkadot Hub",
      url: typeof window !== "undefined" ? window.location.origin : "https://sampo.app",
      icons: [],
    },
  }).then((p) => {
    cachedProvider = p;
    return p;
  });

  return initPromise;
}

/// Tear down the WalletConnect session and clear the cached provider so a
/// subsequent `connect()` starts a fresh pairing. Safe to call even if never
/// connected — no-op in that case.
export async function disconnectWalletConnect() {
  const p = cachedProvider;
  cachedProvider = null;
  initPromise = null;
  if (!p) return;
  try {
    await p.disconnect();
  } catch {
    // Already disconnected or session missing — harmless.
  }
}
