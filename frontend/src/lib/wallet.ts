import { ethers } from "ethers";
import { CHAIN_ID, NETWORKS } from "./contracts";
import {
  getWalletConnectProvider,
  disconnectWalletConnect,
  hasWalletConnect,
} from "./walletconnect";

/**
 * Minimal EIP-1193 shape the app consumes. Both `window.ethereum` (browser
 * extensions) and the WalletConnect v2 provider conform to it, so the rest
 * of the UI can be agnostic about which transport signed a tx.
 */
export type Eip1193 = {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: any[]) => void): void;
  removeListener?(event: string, handler: (...args: any[]) => void): void;
};

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

export type WalletKind = "injected" | "walletconnect";

export interface Connection {
  kind: WalletKind;
  provider: ethers.BrowserProvider;
  signer: ethers.JsonRpcSigner;
  address: string;
  chainId: number;
  eip1193: Eip1193;
}

export function hasInjectedProvider(): boolean {
  return typeof window !== "undefined" && !!window.ethereum;
}

export { hasWalletConnect };

/// True if at least one connection method is available in this environment.
export function hasAnyProvider(): boolean {
  return hasInjectedProvider() || hasWalletConnect();
}

async function finalizeConnect(eip: Eip1193, kind: WalletKind): Promise<Connection> {
  const provider = new ethers.BrowserProvider(eip as any, "any");
  const accounts = (await eip.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.length) throw new Error("No accounts returned by wallet");
  const address = ethers.getAddress(accounts[0]);
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const signer = await provider.getSigner();
  return { kind, provider, signer, address, chainId, eip1193: eip };
}

/// Connect via a browser-injected wallet (MetaMask / Talisman extension /
/// SubWallet extension, anything that exposes `window.ethereum`).
export async function connectInjected(): Promise<Connection> {
  if (!hasInjectedProvider()) throw new Error("No EVM wallet detected");
  return finalizeConnect(window.ethereum!, "injected");
}

/// Silent reconnect to an injected wallet if the user has previously
/// authorized this origin. Uses `eth_accounts` (passive) instead of
/// `eth_requestAccounts` (which always prompts). Returns null if no
/// pre-approved account is available.
export async function silentConnectInjected(): Promise<Connection | null> {
  if (!hasInjectedProvider()) return null;
  const eip = window.ethereum!;
  let accounts: string[] = [];
  try {
    accounts = ((await eip.request({ method: "eth_accounts" })) as string[]) ?? [];
  } catch {
    return null;
  }
  if (!accounts.length) return null;
  const provider = new ethers.BrowserProvider(eip as any, "any");
  const address = ethers.getAddress(accounts[0]);
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const signer = await provider.getSigner();
  return { kind: "injected", provider, signer, address, chainId, eip1193: eip };
}

/// Silent reconnect to a WalletConnect session if one is still alive in
/// localStorage. `EthereumProvider.init` rehydrates the session from
/// storage; we just need to check whether a session is present and, if
/// so, rebuild the Connection object without re-opening the QR modal.
export async function silentConnectWalletConnect(): Promise<Connection | null> {
  if (!hasWalletConnect()) return null;
  try {
    const wc = await getWalletConnectProvider();
    if (!wc.session) return null;
    return finalizeConnect(wc as unknown as Eip1193, "walletconnect");
  } catch {
    return null;
  }
}

/// Connect via WalletConnect v2. Shows the library's built-in QR modal for
/// mobile wallets (Nova, Talisman mobile, SubWallet mobile, MetaMask mobile,
/// Rainbow, etc). Reuses an active session if one exists.
export async function connectWalletConnect(): Promise<Connection> {
  if (!hasWalletConnect()) {
    throw new Error(
      "WalletConnect not configured — set VITE_WALLETCONNECT_PROJECT_ID in .env.local"
    );
  }
  const wc = await getWalletConnectProvider();
  // `session` is truthy once a pairing is active. First-time: open modal.
  if (!wc.session) await wc.connect();
  return finalizeConnect(wc as unknown as Eip1193, "walletconnect");
}

/// Clear UI-side connection state, and if this was a WalletConnect session
/// tear down the pairing server-side too. Injected wallets can't be
/// programmatically disconnected — the user has to revoke in the wallet
/// itself. The app forgets the connection regardless.
export async function disconnect(kind: WalletKind): Promise<void> {
  if (kind === "walletconnect") {
    await disconnectWalletConnect();
  }
}

/// Try to move the wallet to the target chain. If the wallet hasn't heard of
/// the chain yet (code 4902), attempt to add it using our NETWORKS registry.
export async function switchChain(eip: Eip1193, targetChainId: number): Promise<void> {
  const hex = "0x" + targetChainId.toString(16);
  try {
    await eip.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hex }],
    });
  } catch (err: any) {
    if (err?.code === 4902 && NETWORKS[targetChainId]) {
      const n = NETWORKS[targetChainId];
      await eip.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hex,
            chainName: n.name,
            nativeCurrency: { name: n.currency, symbol: n.currency, decimals: 18 },
            rpcUrls: [n.rpc],
            blockExplorerUrls: n.explorer ? [n.explorer] : [],
          },
        ],
      });
    } else {
      throw err;
    }
  }
}

/// Bind `accountsChanged` + `chainChanged` listeners to a specific provider.
/// Returns an unsubscribe function. Use in a React effect keyed on the
/// active provider so re-connects re-attach correctly.
export function bindEvents(
  eip: Eip1193,
  cbs: {
    onAccounts: (accounts: string[]) => void;
    onChain: (chainId: number) => void;
    onDisconnect?: () => void;
  }
): () => void {
  if (!eip.on) return () => {};
  const accs = (a: string[]) => cbs.onAccounts(a);
  const ch = (hex: string | number) => cbs.onChain(Number(hex));
  const dc = () => cbs.onDisconnect?.();
  eip.on("accountsChanged", accs);
  eip.on("chainChanged", ch);
  if (cbs.onDisconnect) eip.on("disconnect", dc);
  return () => {
    eip.removeListener?.("accountsChanged", accs);
    eip.removeListener?.("chainChanged", ch);
    if (cbs.onDisconnect) eip.removeListener?.("disconnect", dc);
  };
}

export { CHAIN_ID };
