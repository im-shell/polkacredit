import { useEffect, useState } from "react";
import { CHAIN_ID, NETWORKS, buildContracts, type ContractBundle } from "./lib/contracts";
import {
  bindEvents,
  connectInjected,
  connectWalletConnect,
  disconnect,
  hasAnyProvider,
  hasInjectedProvider,
  hasWalletConnect,
  switchChain,
  type Connection,
  type Eip1193,
  type WalletKind,
} from "./lib/wallet";
import { short } from "./lib/address";
import { Connect } from "./components/Connect";
import { ScoreCard } from "./components/ScoreCard";
import { StakeCard } from "./components/StakeCard";
import { VouchCard } from "./components/VouchCard";
import { PointsHistoryCard } from "./components/PointsHistoryCard";
import { FaucetCard } from "./components/FaucetCard";

export default function App() {
  const [conn, setConn] = useState<Connection | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [bundle, setBundle] = useState<ContractBundle | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // One-shot per session: try auto-switching to the target chain. If the
  // user rejects or the wallet throws, we set this true so we don't spam
  // the prompt. The "Switch network" banner stays as a manual fallback.
  const [autoSwitchTried, setAutoSwitchTried] = useState(false);

  const netName = chainId ? NETWORKS[chainId]?.name ?? `chain ${chainId}` : null;
  const onRightChain = chainId === CHAIN_ID;
  const wcEnabled = hasWalletConnect();

  // Subscribe to account / chain / disconnect events on the currently active
  // EIP-1193 provider. Re-runs when the connection changes so switching
  // between injected and WalletConnect re-binds cleanly.
  useEffect(() => {
    if (!conn) return;
    return bindEvents(conn.eip1193 as Eip1193, {
      onAccounts: (accs) => {
        if (!accs.length) {
          // User disconnected from the wallet side — mirror that locally.
          handleDisconnect();
        } else {
          setAddress(accs[0]);
        }
      },
      onChain: (cid) => setChainId(cid),
      onDisconnect: () => handleDisconnect(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn]);

  // Build the contract bundle once we have both an address and the right chain.
  useEffect(() => {
    if (!conn || !address || !onRightChain) {
      setBundle(null);
      return;
    }
    (async () => {
      try {
        const b = await buildContracts(conn.provider, conn.signer);
        setBundle(b);
      } catch (e: any) {
        setErr(e.message ?? String(e));
      }
    })();
  }, [conn, address, onRightChain, reloadKey]);

  // Auto-switch to the target chain once per session when connected but on
  // the wrong chain. First-time Talisman users who already have Passet Hub
  // added get a near-silent switch; otherwise the wallet prompts to add it.
  useEffect(() => {
    if (!conn || !address || onRightChain || autoSwitchTried) return;
    setAutoSwitchTried(true);
    (async () => {
      try {
        await switchChain(conn.eip1193, CHAIN_ID);
        setChainId(CHAIN_ID);
      } catch {
        // user declined or chain not addable — manual banner remains
      }
    })();
  }, [conn, address, onRightChain, autoSwitchTried]);

  async function doConnect(kind: WalletKind) {
    try {
      setErr(null);
      const c = kind === "walletconnect" ? await connectWalletConnect() : await connectInjected();
      setConn(c);
      setAddress(c.address);
      setChainId(c.chainId);
      setAutoSwitchTried(false); // fresh connect → allow one auto-switch attempt
    } catch (e: any) {
      setErr(e.message ?? String(e));
    }
  }

  async function handleDisconnect() {
    const kind = conn?.kind;
    setConn(null);
    setAddress(null);
    setChainId(null);
    setBundle(null);
    setAutoSwitchTried(false);
    if (kind) {
      try {
        await disconnect(kind);
      } catch {
        // best-effort — session may already be gone
      }
    }
  }

  async function handleSwitch() {
    if (!conn) return;
    try {
      await switchChain(conn.eip1193, CHAIN_ID);
      setChainId(CHAIN_ID);
    } catch (e: any) {
      setErr(e.message ?? String(e));
    }
  }

  const refresh = () => setReloadKey((k) => k + 1);

  return (
    <div className="shell">
      <header className="top">
        <h1>
          <span className="logo-dot" />
          PolkaCredit
        </h1>
        <Connect
          address={address}
          netName={netName}
          onRightChain={onRightChain}
          walletKind={conn?.kind ?? null}
          wcEnabled={wcEnabled}
          injectedAvailable={hasInjectedProvider()}
          onConnectInjected={() => doConnect("injected")}
          onConnectWalletConnect={() => doConnect("walletconnect")}
          onSwitch={handleSwitch}
          onDisconnect={handleDisconnect}
        />
      </header>

      {!hasAnyProvider() && (
        <div className="banner err">
          No EVM wallet detected. Install a Polkadot-Hub-compatible wallet such
          as{" "}
          <a href="https://talisman.xyz" target="_blank" rel="noreferrer">
            Talisman
          </a>
          ,{" "}
          <a href="https://subwallet.app" target="_blank" rel="noreferrer">
            SubWallet
          </a>
          , or{" "}
          <a href="https://metamask.io" target="_blank" rel="noreferrer">
            MetaMask
          </a>
          , or set <code>VITE_WALLETCONNECT_PROJECT_ID</code> to enable QR-code
          login from a mobile wallet.
        </div>
      )}

      {address && !onRightChain && (
        <div className="banner err">
          Connected to {netName}. PolkaCredit lives on{" "}
          <strong>{NETWORKS[CHAIN_ID]?.name ?? `chain ${CHAIN_ID}`}</strong>.{" "}
          <a onClick={handleSwitch} style={{ cursor: "pointer" }}>
            Switch network.
          </a>
        </div>
      )}

      {err && <div className="banner err">{err}</div>}

      {!address && (
        <div className="card" style={{ textAlign: "center", padding: "48px 20px" }}>
          <p style={{ color: "var(--muted)" }}>
            Connect your wallet to stake, vouch, and view your on-chain credit score.
          </p>
          <div
            style={{
              marginTop: 16,
              display: "flex",
              gap: 10,
              justifyContent: "center",
              flexWrap: "wrap",
            }}
          >
            {hasInjectedProvider() && (
              <button onClick={() => doConnect("injected")}>Browser wallet</button>
            )}
            {wcEnabled && (
              <button className="ghost" onClick={() => doConnect("walletconnect")}>
                WalletConnect (QR)
              </button>
            )}
          </div>
          {!wcEnabled && (
            <div style={{ marginTop: 12, fontSize: 12, color: "var(--muted)" }}>
              Mobile QR login is disabled — set{" "}
              <code>VITE_WALLETCONNECT_PROJECT_ID</code> in{" "}
              <code>frontend/.env.local</code> to turn it on.
            </div>
          )}
        </div>
      )}

      {address && onRightChain && bundle && (
        <>
          <div style={{ marginBottom: 14 }} className="kv">
            account: {address}
            {conn?.kind === "walletconnect" && (
              <span style={{ marginLeft: 8, color: "var(--muted)" }}>· via WalletConnect</span>
            )}
          </div>
          <div className="cards">
            <ScoreCard bundle={bundle} account={address} key={`score-${reloadKey}`} />
            <StakeCard bundle={bundle} account={address} onChange={refresh} key={`stake-${reloadKey}`} />
            <VouchCard bundle={bundle} onChange={refresh} />
            <FaucetCard bundle={bundle} address={address} onChange={refresh} />
            <PointsHistoryCard bundle={bundle} account={address} key={`hist-${reloadKey}`} />
          </div>
        </>
      )}

      <div className="footer">
        PolkaCredit · {NETWORKS[CHAIN_ID]?.name ?? `chain ${CHAIN_ID}`}
        {bundle && (
          <>
            {" · "}
            <span className="kv">vault {short(bundle.deployment.contracts.StakingVault)}</span>
          </>
        )}
      </div>
    </div>
  );
}
